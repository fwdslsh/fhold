import { lstatSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultStackConfig, readStackConfig } from './stack-config.js';
import {
	defaultRecoverySettings,
	directoryRecoveryDestination,
	recoveryDirectory,
	recoveryEnvironment
} from './recovery-config.js';
import { createFholdState, writeFileAtomic } from './foundation.js';
import { buildComposeOptions } from './compose.js';
import { composeConfigJson, runDocker } from './docker.js';
import { installHome } from './install.js';
import { classifyInstall } from './state.js';
import { runRecoveryOperation } from './recovery.js';
import { assertSafePortablePath } from './provider-files.js';
import type {
	CheckpointPackageImportRequest,
	CheckpointPackageImportResult,
	CheckpointPackagePlan
} from '../dto/recovery.js';

function plan(value: string): CheckpointPackagePlan {
	const result = JSON.parse(value) as CheckpointPackagePlan;
	if (
		result?.product !== 'fhold' ||
		result.scope !== 'assistant-checkpoint' ||
		!/^[a-z0-9][a-z0-9-]{0,62}$/.test(result.instanceId) ||
		!['generation', 'previewDigest'].every((key) =>
			/^[a-f0-9]{64}$/.test(String(result[key as keyof typeof result]))
		) ||
		!Number.isSafeInteger(result.files) ||
		result.files < 0 ||
		!Number.isSafeInteger(result.totalBytes) ||
		result.totalBytes < 0 ||
		!result.selection ||
		!Array.isArray(result.warnings)
	)
		throw new Error('The Assistant returned an invalid checkpoint package result.');
	return result;
}

export async function exportCheckpointPackage(
	homeDir: string,
	directory: string
): Promise<CheckpointPackagePlan> {
	return plan(await runRecoveryOperation(homeDir, 'export-package', false, directory));
}

export async function previewCheckpointPackage(
	homeDir: string,
	directory: string
): Promise<CheckpointPackagePlan> {
	directoryRecoveryDestination(directory);
	assertSafePortablePath('/', directory.slice(1));
	if (!lstatSync(directory).isDirectory())
		throw new Error('Choose a checkpoint package directory.');
	const image = await packageImage(homeDir);
	const operator = `fhold-checkpoint-preview-${randomUUID()}`;
	const uid = process.getuid?.(),
		gid = process.getgid?.();
	if (!uid || !gid) throw new Error('Run checkpoint recovery as a non-root user.');
	const result = await runDocker(
		[
			'run',
			'--rm',
			'--pull',
			'never',
			'--name',
			operator,
			'--network',
			'none',
			'--user',
			`${uid}:${gid}`,
			'--entrypoint',
			'fhold-recovery',
			'--mount',
			bindMount(directory, '/run/fhold-package', true),
			image,
			'preview-package',
			'/run/fhold-package'
		],
		{ timeoutMs: 150_000, maxOutputBytes: 4 * 1024 * 1024 }
	);
	if (!result.ok) {
		await runDocker(['rm', '--force', operator], { timeoutMs: 15_000 });
		throw new Error(
			'Checkpoint package validation failed. Check package integrity and use a matching Assistant image that supports checkpoint packages.'
		);
	}
	return plan(result.stdout);
}

function bindMount(source: string, target: string, readonly = false): string {
	return `type=bind,"source=${source.replaceAll('"', '""')}",target=${target}${readonly ? ',readonly' : ''}`;
}

async function packageImage(homeDir: string): Promise<string> {
	if (['installed', 'setup_incomplete'].includes(classifyInstall(homeDir))) {
		const resolved = await composeConfigJson(buildComposeOptions(createFholdState(homeDir)));
		if (!resolved.ok) throw new Error('Could not resolve the selected Assistant image.');
		const image = (resolved.config as { services?: { assistant?: { image?: string } } }).services
			?.assistant?.image;
		if (!image) throw new Error('The selected Assistant image is unavailable.');
		return image;
	}
	const config = defaultStackConfig(homeDir);
	return `${config.deployment.imageNamespace}/fhold-assistant:${config.deployment.images.assistant}`;
}

export function assertCheckpointImportPaths(
	homeDir: string,
	input: CheckpointPackageImportRequest
): void {
	const paths = [
		...(['installed', 'setup_incomplete'].includes(classifyInstall(homeDir)) ? [homeDir] : []),
		input.directory,
		input.destinationHome,
		input.backupDirectory
	];
	for (const directory of paths) {
		directoryRecoveryDestination(directory);
		if (resolve(directory) !== directory)
			throw new Error('Choose canonical absolute checkpoint import paths.');
		assertSafePortablePath('/', directory.slice(1), true);
	}
	for (const [index, directory] of paths.entries())
		for (const other of paths.slice(index + 1))
			if (
				directory === other ||
				directory.startsWith(`${other}/`) ||
				other.startsWith(`${directory}/`)
			)
				throw new Error('Source, package, new home and new backup destination must be separate.');
}

/** Import Assistant state before normal host seeding, without a fabricated native receipt. */
export async function importCheckpointPackage(
	homeDir: string,
	input: CheckpointPackageImportRequest,
	confirmed = false
): Promise<CheckpointPackageImportResult> {
	if (!confirmed)
		throw new Error(
			'Confirm stopped original writers and the private same-Assistant restore before importing.'
		);
	assertCheckpointImportPaths(homeDir, input);
	const reviewed = await previewCheckpointPackage(homeDir, input.directory);
	if (reviewed.previewDigest !== input.previewDigest)
		throw new Error('The checkpoint changed. Preview it again.');
	if (
		!isAbsolute(input.destinationHome) ||
		resolve(input.destinationHome) !== input.destinationHome
	)
		throw new Error('Choose an absolute empty destination home.');
	const source = readStackConfig(homeDir);
	const sourceConfig = source.ok ? source.config : defaultStackConfig(homeDir);
	const config = defaultStackConfig(input.destinationHome);
	config.deployment.projectName = reviewed.instanceId;
	config.deployment.imageNamespace = sourceConfig.deployment.imageNamespace;
	config.deployment.images = { ...sourceConfig.deployment.images };
	config.recovery = {
		...defaultRecoverySettings(reviewed.instanceId),
		enabled: true,
		destination: directoryRecoveryDestination(input.backupDirectory)
	};
	const backup = recoveryDirectory(input.destinationHome, config.recovery);
	if (lstatSync(backup, { throwIfNoEntry: false }) && readdirSync(backup).length)
		throw new Error('Checkpoint import needs an unused backup destination.');
	for (const project of new Set([
		...(source.ok ? [sourceConfig.deployment.projectName] : []),
		reviewed.instanceId
	])) {
		const writers = await runDocker([
			'ps',
			'-a',
			'--filter',
			`label=com.docker.compose.project=${project}`,
			'--format',
			'{{.State}}'
		]);
		if (
			!writers.ok ||
			writers.stdout
				.trim()
				.split(/\s+/)
				.filter(Boolean)
				.some((value) => !['exited', 'dead'].includes(value))
		)
			throw new Error(
				'Stop the original Assistant and all project writers before importing. Nothing was stopped automatically.'
			);
	}
	const image = await packageImage(homeDir);
	let marker: string | undefined;
	const imported = await installHome(
		{ homeDir: input.destinationHome, config, automaticPorts: true },
		async (state) => {
			marker = join(state.homeDir, 'data/.instance-restore.json');
			writeFileAtomic(
				marker,
				JSON.stringify({
					product: 'fhold',
					scope: 'assistant-checkpoint',
					phase: 'restoring',
					generation: reviewed.generation
				})
			);
			writeFileAtomic(
				join(state.homeDir, 'config/recovery/include.json'),
				JSON.stringify(reviewed.selection)
			);
			mkdirSync(backup, { recursive: true, mode: 0o700 });
			const owner = lstatSync(state.homeDir);
			if (!owner.uid || !owner.gid)
				throw new Error('Restore as a non-root user, as required for normal fhold containers.');
			const operator = `fhold-checkpoint-import-${randomUUID()}`;
			const mount = (sourcePath: string, target: string, readonly = false) => [
				'--mount',
				bindMount(sourcePath, target, readonly)
			];
			const mounts = [
				['data/assistant', '/home/fhold'],
				['config/assistant', '/home/fhold/.config/opencode'],
				['knowledge', '/stash'],
				['workspace', '/work'],
				['data/akm/data', '/opt/akm/data'],
				['config/akm', '/etc/akm'],
				['data/recovery', '/run/fhold-recovery-state']
			];
			const result = await runDocker(
				[
					'run',
					'--rm',
					'--pull',
					'never',
					'--name',
					operator,
					'--network',
					'none',
					'--user',
					`${owner.uid}:${owner.gid}`,
					'--entrypoint',
					'fhold-recovery',
					...mounts.flatMap(([from, to]) => mount(join(state.homeDir, from), to)),
					...mount(backup, '/recovery'),
					...mount(input.directory, '/run/fhold-package', true),
					...mount(
						join(state.homeDir, 'config/recovery/include.json'),
						'/run/fhold-recovery/include.json',
						true
					),
					...Object.entries(recoveryEnvironment(config.recovery)).flatMap(([key, value]) => [
						'--env',
						`${key}=${value}`
					]),
					image,
					'import-package',
					'/run/fhold-package',
					'--confirm-stopped',
					'--preview-digest',
					reviewed.previewDigest
				],
				{ timeoutMs: 390_000, maxOutputBytes: 4 * 1024 * 1024 }
			);
			if (!result.ok) {
				await runDocker(['rm', '--force', operator], { timeoutMs: 15_000 });
				const remaining = await runDocker(
					['ps', '-a', '--filter', `name=^/${operator}$`, '--format', '{{.ID}}'],
					{ timeoutMs: 15_000 }
				);
				if (!remaining.ok || remaining.stdout.trim())
					throw new Error(
						`Could not confirm import operator cleanup. Stop only ${operator} before retrying. The partial target remains blocked and original state was preserved.`
					);
				throw new Error(
					'Checkpoint import failed. The partial target remains blocked; original state and backups were preserved. Inspect the retained target before retrying in a new empty home.'
				);
			}
			const restored = plan(result.stdout);
			if (restored.generation !== reviewed.generation)
				throw new Error('Imported checkpoint generation did not match the preview.');
		}
	);
	if (marker) unlinkSync(marker);
	return { ...reviewed, homeDir: imported, restored: true };
}

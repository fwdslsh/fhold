import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	normalizeSelection,
	type RecoverySelection
} from '../../../../containers/assistant/recovery/selection.mjs';
import {
	createFholdState,
	managedComposeFile,
	stateSecretFile,
	writeFileAtomic
} from './foundation.js';
import { assertSafePortablePath } from './provider-files.js';
import {
	parseRecoverySettings,
	recoveryDirectory,
	type RecoverySettings
} from './recovery-config.js';
import { readStackConfig, writeStackConfig } from './stack-config.js';
import { mutateStack } from './operations.js';
import { ensureRuntime, requireInstall } from './state.js';
import { buildComposeCliArgs, buildComposeOptions } from './compose.js';
import {
	assertProjectOwnership,
	composeConfigJson,
	composeProcessEnvironment,
	composePs,
	parseComposePsRows,
	runDocker
} from './docker.js';
import { acquireStackLock, releaseStackLock } from './lock.js';
import { auditCompose } from './secret-audit.js';
import { assertManagedHarnessImage } from './activation.js';

export type { RecoverySettings, RecoverySelection };
export const RECOVERY_POLICY_FILE = 'config/recovery/include.json';
const MAX_POLICY_BYTES = 4 * 1024 * 1024;

export function readRecoverySelection(homeDir: string): RecoverySelection {
	assertSafePortablePath(homeDir, RECOVERY_POLICY_FILE, true);
	const path = join(homeDir, RECOVERY_POLICY_FILE);
	if (!existsSync(path)) return normalizeSelection({ version: 1 });
	if (lstatSync(path).size > MAX_POLICY_BYTES)
		throw new Error('Recovery selection file exceeds 4 MiB.');
	return normalizeSelection(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

function recoveryDigest(settings: RecoverySettings, selection: RecoverySelection): string {
	return createHash('sha256')
		.update(JSON.stringify([settings, selection]))
		.digest('hex');
}

export function recoverySnapshot(homeDir: string) {
	const read = readStackConfig(homeDir);
	if (!read.ok) throw new Error(read.error);
	const selection = readRecoverySelection(homeDir);
	const path = stateSecretFile(homeDir, 'fhold_recovery_connection_string');
	assertSafePortablePath(homeDir, 'state/secrets/fhold_recovery_connection_string', true);
	return {
		settings: read.config.recovery,
		selection,
		digest: recoveryDigest(read.config.recovery, selection),
		credentialConfigured: existsSync(path) && readFileSync(path, 'utf8').trim().length > 0,
		policyPath: join(homeDir, RECOVERY_POLICY_FILE)
	};
}

/** Save only; the native engine validates files, databases and checkpoint identity. */
export function saveRecoverySettings(
	homeDir: string,
	value: { settings: unknown; selection: unknown; baselineDigest: string }
) {
	return mutateStack(homeDir, (config) => {
		const current = recoverySnapshot(homeDir);
		if (current.digest !== value.baselineDigest)
			throw new Error('Recovery settings changed. Refresh and review before saving.');
		const settings = parseRecoverySettings(value.settings, config.deployment.projectName);
		recoveryDirectory(homeDir, settings);
		const selection = normalizeSelection(value.selection);
		const bytes = `${JSON.stringify(selection, null, 2)}\n`;
		if (Buffer.byteLength(bytes) > MAX_POLICY_BYTES)
			throw new Error('Recovery selection file exceeds 4 MiB.');
		if (
			!readFileSync(managedComposeFile(homeDir), 'utf8').includes(
				'/run/fhold-recovery/include.json'
			)
		)
			throw new Error(
				'Update this instance with the current fhold CLI before configuring managed recovery. Its running containers were not changed.'
			);
		assertSafePortablePath(homeDir, RECOVERY_POLICY_FILE, true);
		writeFileAtomic(join(homeDir, RECOVERY_POLICY_FILE), bytes);
		config.recovery = settings;
		writeStackConfig(homeDir, config);
		ensureRuntime(createFholdState(homeDir));
		return recoverySnapshot(homeDir);
	});
}

export function saveRecoveryCredential(homeDir: string, value: unknown): void {
	if (
		typeof value !== 'string' ||
		!value.trim() ||
		Buffer.byteLength(value) > 16_384 ||
		/[\r\n\0]/.test(value.trim())
	)
		throw new Error('Enter a single-line standard Blob connection string (at most 16 KiB).');
	mutateStack(homeDir, () => {
		assertSafePortablePath(homeDir, 'state/secrets/fhold_recovery_connection_string', true);
		writeFileAtomic(
			stateSecretFile(homeDir, 'fhold_recovery_connection_string'),
			`${value.trim()}\n`,
			0o600
		);
	});
}

/** Read-only running durability status. No namespace initialization or takeover. */
export async function recoveryStatus(homeDir: string): Promise<Record<string, unknown>> {
	const state = createFholdState(homeDir);
	requireInstall(homeDir);
	const read = readStackConfig(homeDir);
	if (!read.ok) throw new Error(read.error);
	if (!read.config.recovery.enabled) return { state: 'disabled', healthy: false };
	const options = buildComposeOptions(state);
	const ps = await composePs(options);
	if (!ps.ok)
		throw new Error('Could not read recovery status. Check Docker and the instance logs.');
	if (
		!parseComposePsRows(ps.stdout).some(
			(row) => row.service === 'assistant' && row.state === 'running'
		)
	)
		return { state: 'stopped', healthy: false };
	await assertProjectOwnership(read.config.deployment.projectName, state.stackDir);
	const result = await runDocker(
		[
			'compose',
			...buildComposeCliArgs(state),
			'exec',
			'-T',
			'assistant',
			'fhold-recovery',
			'status'
		],
		{ env: composeProcessEnvironment(options.envFiles), timeoutMs: 15_000 }
	);
	try {
		const status: unknown = JSON.parse(result.stdout);
		if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error();
		return {
			...status,
			state: (status as { healthy?: unknown }).healthy === true ? 'ready' : 'not-ready'
		};
	} catch {
		return {
			state: 'not-ready',
			healthy: false,
			failure:
				'No valid checkpoint status is available. Apply saved settings or check private instance logs.'
		};
	}
}

/** All operator runs use the exact audited Compose mounts/user/image, never a custom startup. */
export async function runRecoveryOperation(
	homeDir: string,
	action: 'inspect' | 'init' | 'restore',
	confirmed = false
): Promise<string> {
	if (!['inspect', 'init', 'restore'].includes(action))
		throw new Error('Invalid recovery operation.');
	if (action !== 'inspect' && !confirmed) throw new Error('Confirm this recovery operation first.');
	const state = createFholdState(homeDir);
	requireInstall(homeDir);
	const lock = acquireStackLock(state.dataDir);
	if (!lock) throw new Error('lifecycle_in_progress: Another stack operation is running.');
	try {
		const read = readStackConfig(homeDir);
		if (!read.ok) throw new Error(read.error);
		if (!read.config.recovery.enabled) throw new Error('Enable and save recovery settings first.');
		await assertProjectOwnership(read.config.deployment.projectName, state.stackDir);
		const options = buildComposeOptions(state);
		if (action !== 'inspect') {
			// Include one-off containers and paused/restarting writers, not just services.
			const writers = await runDocker([
				'ps',
				'-a',
				'--filter',
				`label=com.docker.compose.project=${read.config.deployment.projectName}`,
				'--format',
				'{{.State}}'
			]);
			if (!writers.ok)
				throw new Error('Could not verify stopped writers. Check Docker before retrying.');
			if (
				writers.stdout
					.trim()
					.split(/\s+/)
					.filter(Boolean)
					.some((status) => !['exited', 'dead'].includes(status))
			)
				throw new Error(
					'Stop this instance before initialization or offline restore. fhold will not stop it automatically.'
				);
		}
		const resolved = await composeConfigJson(options);
		if (!resolved.ok) throw new Error('Could not validate the recovery Compose configuration.');
		const issues = auditCompose(resolved.config, homeDir);
		if (issues.length)
			throw new Error(`Recovery configuration failed validation:\n${issues.join('\n')}`);
		await assertManagedHarnessImage(resolved.config);
		const args =
			action === 'init'
				? ['init', '--confirm-new-instance']
				: action === 'restore'
					? ['restore', '--confirm-stopped']
					: ['inspect'];
		const operatorName = `${read.config.deployment.projectName}-recovery-${randomUUID()}`;
		const result = await runDocker(
			[
				'compose',
				...buildComposeCliArgs(state),
				'run',
				'--rm',
				'--name',
				operatorName,
				'--no-deps',
				'-T',
				'--entrypoint',
				'fhold-recovery',
				'assistant',
				...args
			],
			{
				env: composeProcessEnvironment(options.envFiles),
				timeoutMs: (read.config.recovery.operationTimeoutSeconds + 30) * 1_000,
				maxOutputBytes: 4 * MAX_POLICY_BYTES
			}
		);
		if (!result.ok) {
			// Killing a Docker client does not stop its container. Contain only this
			// uniquely named operator run before releasing the host lifecycle lock.
			await runDocker(['rm', '--force', operatorName], { timeoutMs: 15_000 });
			const remaining = await runDocker(
				['ps', '-a', '--filter', `name=^/${operatorName}$`, '--format', '{{.ID}}'],
				{ timeoutMs: 10_000 }
			);
			if (!remaining.ok || remaining.stdout.trim())
				throw new Error(
					`Could not confirm recovery operator cleanup. Stop only ${operatorName} before retrying; existing data/checkpoints were kept.`
				);
			// The image executable already emits an allowlisted reason, never raw SDK errors.
			const reason =
				/fhold recovery: ([a-zA-Z0-9 ;_-]+); check private recovery status and destination access\./.exec(
					result.stderr
				)?.[1];
			throw new Error(
				`Recovery operation failed${reason ? `: ${reason}` : ''}. Existing data/checkpoints were kept. Review the saved configuration; never reinitialize or unlock an old owner as a workaround.`
			);
		}
		return result.stdout.trim();
	} finally {
		releaseStackLock(lock);
	}
}

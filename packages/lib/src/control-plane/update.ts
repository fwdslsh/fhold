import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFholdState, customComposeFile, mergeEnvContent, stackEnvFile, writeFileAtomic } from './foundation.js';
import { acquireStackLock, releaseStackLock } from './lock.js';
import { applyHomeSeed, MANAGED_FILES, preflightHomeSeed, readSeedFile } from './seed.js';
import { readStackConfig, stackConfigEnv } from './stack-config.js';
import { ensureRuntime, requireInstall } from './state.js';
import { buildComposeArgs, composeConfigJson, composeProjectName, ensureDockerReady, runComposeStreaming, runDocker } from './docker.js';
import { buildComposeOptions } from './compose.js';
import { auditCompose } from './secret-audit.js';
import { activateComposeCommand, assertManagedHarnessImage } from './activation.js';
import { FH_RELEASE_VERSION } from './release.js';
import { parseStackConfig, writeStackConfig } from './stack-config.js';
import { assertSafePortablePath, nativePreferencesFile } from './provider-files.js';
import { recordAppliedRuntime, rememberRuntimeBeforeChange } from './runtime-revision.js';

/** Ordinary managed-file update, not native-data rollback or a migration engine. */
export async function updateHome(options: { homeDir?: string; start: boolean; pull?: boolean }): Promise<{ receipt: string; activated: boolean }> {
	const state = createFholdState(options.homeDir);
	requireInstall(state.homeDir);
	const lock = acquireStackLock(state.dataDir);
	if (!lock) throw new Error('lifecycle_in_progress: Another stack operation is running.');
	let staging: string | undefined;
	let receipt: string | undefined;
	let phase = 'preflight';
	let evidence: Record<string, unknown> = {};
	const selectedImages: { service: string; imageReference: string; imageId: string }[] = [];
	const record = () => {
		if (receipt) writeFileAtomic(receipt, `${JSON.stringify({ ...evidence, phase, recordedAt: new Date().toISOString() }, null, 2)}\n`, 0o600);
	};
	try {
		const read = readStackConfig(state.homeDir);
		if (!read.ok) throw new Error(read.error);
		const localImages = read.config.deployment.imageNamespace === 'fhold';
		if (localImages && options.pull === true) throw new Error('This installation uses locally built images. Build the reviewed images locally; --pull is unavailable for this namespace.');
		const shouldPull = options.pull ?? !localImages;
		const installationPath = join(state.homeDir, 'state', 'installation.json');
		for (const path of ['state/stack.env', 'state/installation.json', 'state/update-receipts']) assertSafePortablePath(state.homeDir, path, true);
		let managedImages: Record<string, string> = {};
		if (existsSync(installationPath)) {
			const installation = JSON.parse(readFileSync(installationPath, 'utf8')) as { product?: unknown; homeDir?: unknown; managedImages?: Record<string, string> };
			if (installation.product !== 'fhold' || installation.homeDir !== state.homeDir || !installation.managedImages || typeof installation.managedImages !== 'object' || Array.isArray(installation.managedImages) || Object.entries(installation.managedImages).some(([component, tag]) => !['assistant', 'guardian', 'portal'].includes(component) || typeof tag !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag))) throw new Error('Installation receipt is invalid for this fhold home');
			managedImages = installation.managedImages;
		}
		const candidateConfig = structuredClone(read.config);
		for (const component of ['assistant', 'guardian', 'portal'] as const) {
			if (candidateConfig.deployment.images[component] === managedImages[component]) candidateConfig.deployment.images[component] = FH_RELEASE_VERSION;
		}
		const parsedCandidate = parseStackConfig(candidateConfig);
		if (!parsedCandidate.ok) throw new Error(parsedCandidate.error);
		preflightHomeSeed(state.homeDir);
		staging = mkdtempSync(join(tmpdir(), 'fhold-update-candidate-'));
		const candidateCompose = join(staging, 'stack.compose.yml');
		const candidateEnv = join(staging, 'stack.env');
		writeFileAtomic(candidateCompose, readSeedFile('system/stack/stack.compose.yml'));
		writeFileAtomic(candidateEnv, mergeEnvContent(readFileSync(stackEnvFile(state.homeDir), 'utf8'), {
			...stackConfigEnv(candidateConfig),
			FH_OPENCODE_PREFERENCES_FILE: nativePreferencesFile(state.homeDir)
		}));
		const existing = buildComposeOptions(state);
		const candidate = { ...existing, files: [candidateCompose, ...(existsSync(customComposeFile(state.homeDir)) ? [customComposeFile(state.homeDir)] : [])], envFiles: [candidateEnv] };
		// Compose config is a local CLI operation and does not contact the daemon.
		const resolved = await composeConfigJson(candidate);
		if (!resolved.ok) throw new Error(`Candidate Compose configuration failed: ${resolved.stderr}`);
		const issues = auditCompose(resolved.config, state.homeDir, composeProjectName(candidate), candidateConfig);
		if (issues.length) throw new Error(`Refusing candidate Compose configuration:\n${issues.join('\n')}`);
		if (options.start) {
			const docker = await ensureDockerReady();
			if (!docker.ok) throw new Error(docker.message);
			if (shouldPull) await runComposeStreaming([...buildComposeArgs(candidate), 'pull'], { envFiles: candidate.envFiles });
			const services = (resolved.config as { services?: Record<string, { image?: unknown; profiles?: unknown }> }).services;
			if (!services) throw new Error('Candidate Compose services are missing');
			for (const [service, definition] of Object.entries(services)) {
				if (Array.isArray(definition.profiles) && !definition.profiles.some((profile) => candidate.profiles?.includes(String(profile)))) continue;
				if (typeof definition.image !== 'string') throw new Error(`Candidate service image is missing: ${service}`);
				const image = await runDocker(['image', 'inspect', '--format', '{{.Id}}', definition.image]);
				if (!image.ok || !/^sha256:[a-f0-9]{64}$/.test(image.stdout.trim())) throw new Error(`Candidate image identity could not be verified: ${service}`);
				selectedImages.push({ service, imageReference: definition.image, imageId: image.stdout.trim() });
			}
			await assertManagedHarnessImage(resolved.config);
		}
		const id = `${Date.now()}-${crypto.randomUUID()}`;
		const checkpoint = join(state.homeDir, 'state', 'update-receipts', id);
		receipt = join(checkpoint, 'receipt.json');
		evidence = { product: 'fhold', homeDir: state.homeDir, projectName: candidateConfig.deployment.projectName, targetRelease: FH_RELEASE_VERSION, deployment: candidateConfig.deployment, selectedImages, scope: 'control-plane-only', runningContainersUpgraded: false, nativeDataRollbackAvailable: false };
		phase = 'checkpoint'; record();
		for (const path of [...MANAGED_FILES, 'state/stack.json', 'state/stack.env', 'state/installation.json']) {
			const source = join(state.homeDir, path);
			if (existsSync(source)) writeFileAtomic(join(checkpoint, 'before', path), readFileSync(source), 0o600);
		}
		phase = 'applying-assets'; record();
		rememberRuntimeBeforeChange(state.homeDir);
		await applyHomeSeed(state.homeDir);
		writeStackConfig(state.homeDir, candidateConfig);
		phase = 'reconciling'; record();
		ensureRuntime(state);
		if (options.start) {
			phase = 'activating'; record();
			const revision = await activateComposeCommand(state, ['up', '-d', '--pull', 'never', '--force-recreate', '--remove-orphans', '--wait'], { lock, deferAppliedReceipt: true });
			phase = 'verifying-images'; record();
			const selected = buildComposeOptions(state);
			const ps = await runDocker(['compose', ...buildComposeArgs(selected), 'ps', '-q']);
			if (!ps.ok || !ps.stdout.trim()) throw new Error('Running container identities could not be verified');
			const identities = await runDocker(['inspect', '--format', '{{json .}}', ...ps.stdout.trim().split(/\s+/)]);
			if (!identities.ok) throw new Error('Running image identities could not be verified');
			const rows = identities.stdout.trim().split(/\r?\n/).map((line) => {
				const value = JSON.parse(line) as { Id?: string; Image?: string; Config?: { Image?: string; Labels?: Record<string, string> } };
				const service = value.Config?.Labels?.['com.docker.compose.service'];
				if (!value.Id || !value.Image || !service || value.Config?.Labels?.['com.docker.compose.project'] !== read.config.deployment.projectName) throw new Error('Container identity does not match the selected project');
				return { service, containerId: value.Id, imageId: value.Image, imageReference: value.Config.Image };
			});
			evidence = { ...evidence, runningImages: rows };
			if (rows.length !== selectedImages.length || selectedImages.some((selected) => {
				const matches = rows.filter((row) => row.service === selected.service);
				return matches.length !== 1 || matches[0]?.imageId !== selected.imageId || matches[0]?.imageReference !== selected.imageReference;
			})) throw new Error('Running containers do not match the preflight-selected image identities');
			evidence = { ...evidence, runningContainersUpgraded: true, runningImages: rows };
			recordAppliedRuntime(state.homeDir, revision);
		}
		writeFileAtomic(installationPath, `${JSON.stringify({ product: 'fhold', homeDir: state.homeDir, release: FH_RELEASE_VERSION, managedImages: Object.fromEntries(Object.entries(candidateConfig.deployment.images).filter(([component, tag]) => tag === FH_RELEASE_VERSION && Object.hasOwn(managedImages, component))) }, null, 2)}\n`);
		phase = options.start ? 'completed' : 'files-refreshed-not-activated'; record();
		return { receipt, activated: options.start };
	} catch (error) {
		evidence = { ...evidence, failedPhase: phase, recovery: 'Checkpoint retained. Re-preview/retry explicitly; native databases were not rolled back.' };
		phase = 'failed'; record();
		throw error;
	} finally {
		if (staging) rmSync(staging, { recursive: true, force: true });
		releaseStackLock(lock);
	}
}

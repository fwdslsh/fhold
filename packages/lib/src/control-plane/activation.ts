import { buildComposeCliArgs, buildComposeOptions } from './compose.js';
import { composeConfigJson, runComposeStreaming, runDocker } from './docker.js';
import type { FholdState } from './foundation.js';
import { acquireStackLock, releaseStackLock, type StackLock } from './lock.js';
import { ensureRuntime } from './state.js';
import { readStackConfig } from './stack-config.js';
import {
	recordAppliedRuntime,
	recordRuntimeActivation,
	restartStatus,
	runtimeRevision
} from './runtime-revision.js';

/** Recovery capability protects actual checkpoint semantics, not task policy. */
export async function assertRecoveryImage(resolved: unknown, prepareMissing?: () => Promise<void>): Promise<void> {
	const assistant = (resolved as { services?: { assistant?: { image?: string; environment?: Record<string, unknown> } } }).services?.assistant;
	if (!assistant?.environment?.FH_RECOVERY_URL) return;
	if (!assistant.image) throw new Error('Assistant image is missing from the resolved configuration.');
	const args = ['image', 'inspect', '--format', '{{index .Config.Labels "dev.fwdslsh.fhold.recovery-partial-resume"}}', assistant.image];
	let image = await runDocker(args);
	if (!image.ok && prepareMissing) { await prepareMissing(); image = await runDocker(args); }
	if (!image.ok || image.stdout.trim() !== '1')
		throw new Error('Assistant image does not support managed mixed-storage recovery. Select the matching release image before enabling recovery. Existing containers and checkpoints were not changed.');
}

export async function activateComposeCommand(
	state: FholdState,
	composeArgs: string[],
	options: { lock?: StackLock | null; deferAppliedReceipt?: boolean } = {}
): Promise<string> {
	const lock = options.lock ?? acquireStackLock(state.dataDir);
	if (!lock) throw new Error('lifecycle_in_progress: Another stack operation is running.');
	const ownsLock = options.lock == null;
	try {
		const read = readStackConfig(state.homeDir);
		if (!read.ok) throw new Error(read.error);
		const selectedArgs = [...composeArgs];
		if (read.config.deployment.imageNamespace === 'fhold' && selectedArgs[0] === 'up') {
			// Local tags are not a Docker Hub namespace. Do not silently fetch an
			// unrelated image when a reviewed local build is absent.
			let hasPull = false;
			for (const [index, arg] of selectedArgs.entries()) {
				if (arg !== '--pull' && !arg.startsWith('--pull=')) continue;
				hasPull = true;
				const policy = arg === '--pull' ? selectedArgs[index + 1] : arg.slice('--pull='.length);
				if (policy !== 'never') throw new Error('This installation uses locally built images; activation requires --pull never. Build the reviewed images locally.');
			}
			if (!hasPull) selectedArgs.push('--pull', 'never');
		}
		ensureRuntime(state);
		const revision = runtimeRevision(state.homeDir);
		// Compose does not detect changed bind-mounted file contents. A pending
		// configuration therefore needs recreation, not merely `docker restart`.
		if (selectedArgs[0] === 'up' && restartStatus(state.homeDir).required) {
			if (!selectedArgs.includes('--force-recreate')) selectedArgs.push('--force-recreate');
			if (!selectedArgs.includes('--remove-orphans')) selectedArgs.push('--remove-orphans');
		}
		const composeOptions = buildComposeOptions(state);
		const resolved = await composeConfigJson(composeOptions);
		if (!resolved.ok) {
			throw new Error(`Compose configuration failed: ${resolved.stderr || 'unknown error'}`);
		}
		if (selectedArgs[0] === 'up') {
			if (selectedArgs.includes('--build'))
				await runComposeStreaming([...buildComposeCliArgs(state), 'build', 'assistant'], { envFiles: composeOptions.envFiles });
			const noPull = selectedArgs.includes('--pull=never') || selectedArgs.some((arg, i) => arg === '--pull' && selectedArgs[i + 1] === 'never');
			await assertRecoveryImage(resolved.config, !noPull && read.config.deployment.imageNamespace !== 'fhold'
				? () => runComposeStreaming([...buildComposeCliArgs(state), 'pull', 'assistant'], { envFiles: composeOptions.envFiles })
				: undefined);
		}
		if (selectedArgs[0] === 'up') recordRuntimeActivation(state.homeDir, revision);
		await runComposeStreaming([...buildComposeCliArgs(state), ...selectedArgs], {
			envFiles: composeOptions.envFiles
		});
		if (selectedArgs[0] === 'up' && selectedArgs.includes('--wait') && !options.deferAppliedReceipt)
			recordAppliedRuntime(state.homeDir, revision);
		return revision;
	} finally {
		if (ownsLock) releaseStackLock(lock);
	}
}

/** Stop the current project without making an unsafe override impossible to contain. */
export async function deactivateComposeCommand(
	state: FholdState,
	options: { lock?: StackLock | null } = {}
): Promise<void> {
	const lock = options.lock ?? acquireStackLock(state.dataDir);
	if (!lock) throw new Error('lifecycle_in_progress: Another stack operation is running.');
	const ownsLock = options.lock == null;
	try {
		const composeOptions = buildComposeOptions(state);
		await runComposeStreaming([...buildComposeCliArgs(state), 'down'], {
			envFiles: composeOptions.envFiles
		});
	} finally {
		if (ownsLock) releaseStackLock(lock);
	}
}

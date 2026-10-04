import { buildComposeCliArgs, buildComposeOptions } from './compose.js';
import { composeConfigJson, composeProjectName, runComposeStreaming, runDocker } from './docker.js';
import type { FholdState } from './foundation.js';
import { acquireStackLock, releaseStackLock, type StackLock } from './lock.js';
import { auditCompose } from './secret-audit.js';
import { ensureRuntime } from './state.js';
import { readStackConfig } from './stack-config.js';

/** Older images must not receive a policy that disables their only hook source. */
export async function assertManagedHarnessImage(resolved: unknown, prepareMissing?: () => Promise<void>): Promise<void> {
	const assistant = (resolved as { services?: { assistant?: { image?: string; volumes?: { target?: string }[] } } }).services?.assistant;
	// Older installed Compose files keep their original unmanaged hook workflow.
	if (!assistant?.volumes?.some((mount) => mount.target === '/etc/codex/requirements.toml')) return;
	if (!assistant.image) throw new Error('Assistant image is missing from the resolved configuration.');
	const args = ['image', 'inspect', '--format', '{{index .Config.Labels "dev.fwdslsh.fhold.managed-harness-policy"}}', assistant.image];
	let image = await runDocker(args);
	if (!image.ok && prepareMissing) {
		await prepareMissing();
		image = await runDocker(args);
	}
	if (!image.ok) throw new Error(`Assistant image ${assistant.image} is not available. Pull or build the matching image before starting this instance.`);
	if (image.stdout.trim() !== '1')
		throw new Error(`Assistant image ${assistant.image} does not support managed harness policy. Select the matching fhold release image (or rebuild your local image) before updating or starting this instance. Existing containers have not been restarted.`);
}

export async function activateComposeCommand(
	state: FholdState,
	composeArgs: string[],
	options: { lock?: StackLock | null } = {}
): Promise<void> {
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
		const composeOptions = buildComposeOptions(state);
		const resolved = await composeConfigJson(composeOptions);
		if (!resolved.ok) {
			throw new Error(`Compose configuration failed: ${resolved.stderr || 'unknown error'}`);
		}
		const issues = auditCompose(resolved.config, state.homeDir, composeProjectName(composeOptions));
		if (issues.length > 0) {
			throw new Error(`Refusing Compose activation:\n${issues.join('\n')}`);
		}
		if (selectedArgs[0] === 'up') {
			if (selectedArgs.includes('--build'))
				await runComposeStreaming([...buildComposeCliArgs(state), 'build', 'assistant'], { envFiles: composeOptions.envFiles });
			const noPull = selectedArgs.includes('--pull=never') || selectedArgs.some((arg, i) => arg === '--pull' && selectedArgs[i + 1] === 'never');
			await assertManagedHarnessImage(resolved.config, !noPull && read.config.deployment.imageNamespace !== 'fhold'
				? () => runComposeStreaming([...buildComposeCliArgs(state), 'pull', 'assistant'], { envFiles: composeOptions.envFiles })
				: undefined);
		}
		await runComposeStreaming([...buildComposeCliArgs(state), ...selectedArgs], {
			envFiles: composeOptions.envFiles
		});
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

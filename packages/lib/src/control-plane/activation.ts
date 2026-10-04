import { buildComposeCliArgs, buildComposeOptions } from './compose.js';
import { composeConfigJson, composeProjectName, runComposeStreaming } from './docker.js';
import type { FholdState } from './foundation.js';
import { acquireStackLock, releaseStackLock, type StackLock } from './lock.js';
import { auditCompose } from './secret-audit.js';
import { ensureRuntime } from './state.js';
import { readStackConfig } from './stack-config.js';

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

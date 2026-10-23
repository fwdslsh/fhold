import { createFholdState } from './foundation.js';
import { classifyInstall, requireInstall } from './state.js';
import { defaultStackConfig, readStackConfig } from './stack-config.js';
import { restartStatus } from './runtime-revision.js';
import { buildComposeOptions } from './compose.js';
import {
	composeLogs,
	composePs,
	completeContainerImages,
	containerWarnings,
	ensureDockerReady,
	parseComposePsRows
} from './docker.js';
import { activateComposeCommand, deactivateComposeCommand } from './activation.js';
import { assistantEndpoint } from './opencode.js';
import type { HostingAction, HostingLogOptions, HostingSnapshot } from '../dto/hosting.js';
import { capabilities } from '../dto/hosting.js';

/**
 * Concrete Docker-home operations shared by the local hosting adapter and the
 * native management server. The home directory is captured at construction;
 * no request can substitute a different target after parsing.
 */
export async function inspectLocalInstance(homeDir: string): Promise<HostingSnapshot> {
	const state = createFholdState(homeDir);
	if (classifyInstall(state.homeDir) === 'not_installed') {
		return {
			ref: { kind: 'local-docker', connectionId: 'local', homeDir: state.homeDir },
			name: defaultStackConfig(state.homeDir).deployment.projectName,
			location: state.homeDir,
			capabilities: capabilities([], 'Install this instance before changing its deployment.'),
			services: [],
			warnings: []
		};
	}
	requireInstall(state.homeDir);
	const config = readStackConfig(state.homeDir);
	if (!config.ok) throw new Error(config.error);
	const result = await composePs(buildComposeOptions(state));
	return {
		ref: { kind: 'local-docker', connectionId: 'local', homeDir: state.homeDir },
		name: config.config.deployment.projectName,
		location: state.homeDir,
		capabilities: capabilities(['start', 'stop', 'restart', 'settings', 'transfer']),
		config: config.config,
		pendingRestart: restartStatus(state.homeDir),
		clientUrl: assistantEndpoint(state.homeDir),
		warnings: result.ok ? [] : [result.stderr || 'Docker status is unavailable.'],
		...(!result.ok ? { serviceError: result.stderr || 'Docker status is unavailable.' } : {}),
		services: result.ok
			? await Promise.all(
					(await completeContainerImages(parseComposePsRows(result.stdout))).map(async (row) => ({
						name: row.service,
						image: row.image,
						state: row.state,
						health: row.health,
						id: row.id,
						exitCode: row.exitCode,
						...(row.service === 'assistant' && row.state === 'running' && row.id
							? { warnings: await containerWarnings(row.id) }
							: {})
					}))
				)
			: []
	};
}

export async function operateLocalInstance(homeDir: string, action: HostingAction): Promise<void> {
	const docker = await ensureDockerReady();
	if (!docker.ok) throw new Error(docker.message);
	const state = createFholdState(homeDir);
	requireInstall(state.homeDir);
	// The existing activation path owns locking, recovery drain and pending intent.
	if (action === 'stop') await deactivateComposeCommand(state);
	else
		await activateComposeCommand(state, [
			'up',
			'-d',
			...(action === 'restart' ? ['--force-recreate'] : []),
			'--remove-orphans',
			'--wait'
		]);
}

export async function localInstanceLogs(
	homeDir: string,
	options: HostingLogOptions = {}
): Promise<string> {
	if (Object.entries(options).some(([key, value]) => key !== 'tail' && value !== undefined))
		throw new Error(
			'Docker logs support --tail; deployment revision/replica selection is not available.'
		);
	const state = createFholdState(homeDir);
	requireInstall(state.homeDir);
	const result = await composeLogs(buildComposeOptions(state), options.tail ?? 100);
	if (!result.ok) throw new Error(result.stderr || 'Could not read Docker logs.');
	return result.stdout;
}

/** A bound local port prevents a parsed RPC request from retargeting its host calls. */
export function localDockerManagementHost(homeDir: string) {
	return {
		inspect: () => inspectLocalInstance(homeDir),
		operate: (action: HostingAction) => operateLocalInstance(homeDir, action),
		logs: (options?: HostingLogOptions) => localInstanceLogs(homeDir, options)
	};
}

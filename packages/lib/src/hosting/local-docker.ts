import { existsSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
	createFholdState,
	defaultFholdHome,
	resolveFholdHome
} from '../control-plane/foundation.js';
import { classifyInstall, requireInstall } from '../control-plane/state.js';
import { readStackConfig } from '../control-plane/stack-config.js';
import { restartStatus } from '../control-plane/runtime-revision.js';
import { buildComposeOptions } from '../control-plane/compose.js';
import {
	composeLogs,
	composePs,
	containerWarnings,
	ensureDockerReady,
	parseComposePsRows
} from '../control-plane/docker.js';
import { activateComposeCommand, deactivateComposeCommand } from '../control-plane/activation.js';
import { assistantEndpoint } from '../control-plane/opencode.js';
import {
	capabilities,
	type HostingAction,
	type HostingLogOptions,
	type HostingProvider,
	type HostingSnapshot,
	type InstanceSummary
} from './types.js';

/** Bounded one-level discovery: no recursive scan of user files or secret trees. */
export function listLocalInstances(roots = [dirname(defaultFholdHome())]): InstanceSummary[] {
	const found = new Map<string, InstanceSummary>();
	for (const root of roots) {
		const paths = [root];
		try {
			paths.push(
				...readdirSync(root, { withFileTypes: true })
					.filter((item) => item.isDirectory())
					.map((item) => join(root, item.name))
			);
		} catch {
			continue;
		}
		for (const path of paths) {
			if (
				!existsSync(join(path, 'state', 'stack.json')) ||
				classifyInstall(path) === 'incompatible_home'
			)
				continue;
			const config = readStackConfig(path);
			if (!config.ok) continue;
			const homeDir = createFholdState(path).homeDir;
			found.set(homeDir, {
				ref: { kind: 'local-docker', connectionId: 'local', homeDir },
				name: config.config.deployment.projectName,
				location: homeDir
			});
		}
	}
	return [...found.values()];
}

export async function inspectLocalInstance(homeDir: string): Promise<HostingSnapshot> {
	const state = createFholdState(homeDir);
	requireInstall(state.homeDir);
	const config = readStackConfig(state.homeDir);
	if (!config.ok) throw new Error(config.error);
	const result = await composePs(buildComposeOptions(state));
	return {
		ref: { kind: 'local-docker', connectionId: 'local', homeDir: state.homeDir },
		name: config.config.deployment.projectName,
		location: state.homeDir,
		capabilities: capabilities(true, true),
		config: config.config,
		pendingRestart: restartStatus(state.homeDir),
		clientUrl: assistantEndpoint(state.homeDir),
		warnings: result.ok ? [] : [result.stderr || 'Docker status is unavailable.'],
		services: result.ok
			? await Promise.all(
					parseComposePsRows(result.stdout).map(async (row) => ({
						name: row.service,
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
	const state = createFholdState(homeDir);
	requireInstall(state.homeDir);
	const result = await composeLogs(buildComposeOptions(state), options.tail ?? 100);
	if (!result.ok) throw new Error(result.stderr || 'Could not read Docker logs.');
	return result.stdout;
}
export const localDockerProvider: HostingProvider = {
	listInstances: async () => listLocalInstances(),
	async selectInstance(selector) {
		return {
			kind: 'local-docker',
			connectionId: 'local',
			homeDir: resolveFholdHome(isAbsolute(selector) ? selector : defaultFholdHome(selector))
		};
	},
	open(ref) {
		if (ref.kind !== 'local-docker') throw new Error('Select a local Docker instance.');
		return {
			ref,
			inspect: () => inspectLocalInstance(ref.homeDir),
			logs: (options) => localInstanceLogs(ref.homeDir, options),
			async operate(action, confirmed) {
				if (!confirmed)
					throw new Error('Confirm this lifecycle operation before changing containers.');
				await operateLocalInstance(ref.homeDir, action);
				return { snapshot: await inspectLocalInstance(ref.homeDir) };
			}
		};
	}
};

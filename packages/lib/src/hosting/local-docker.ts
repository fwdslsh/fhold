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
import { runDocker } from '../control-plane/docker.js';
import { activateComposeCommand, deactivateComposeCommand } from '../control-plane/activation.js';
import { assistantEndpoint } from '../control-plane/opencode.js';
import type { HostingProcess } from './process.js';
import {
	capabilities,
	type HostingAction,
	type HostingLogOptions,
	type HostingProvider,
	type HostingSnapshot,
	type InstanceSummary
} from './types.js';

/** Managed Compose labels plus bounded roots: never recursively scan user trees. */
export async function listLocalInstances(
	roots = [dirname(defaultFholdHome())],
	run: HostingProcess = async (_binary, args, options) => {
		const result = await runDocker(args, { timeoutMs: options?.timeoutMs });
		if (!result.ok) throw new Error(result.stderr);
		return result.stdout;
	}
): Promise<InstanceSummary[]> {
	const found = new Map<string, InstanceSummary>();
	const candidates = new Set<string>();
	for (const root of roots) {
		candidates.add(root);
		try {
			for (const item of readdirSync(root, { withFileTypes: true }).filter((item) =>
				item.isDirectory()
			)) {
				candidates.add(join(root, item.name));
				candidates.add(join(root, item.name, 'home'));
			}
		} catch {
			continue;
		}
	}
	try {
		const labels = await run(
			'docker',
			['ps', '-a', '--format', '{{.Label "com.docker.compose.project.working_dir"}}'],
			{ timeoutMs: 10_000 }
		);
		for (const path of labels.trim().split('\n')) {
			if (isAbsolute(path) && path.endsWith('/system/stack'))
				candidates.add(dirname(dirname(path)));
		}
	} catch {
		/* Root discovery remains useful when Docker is stopped/unavailable. */
	}
	for (const path of candidates) {
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

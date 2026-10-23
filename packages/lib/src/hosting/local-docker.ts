import { existsSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
	createFholdState,
	defaultFholdHome,
	resolveFholdHome
} from '../control-plane/foundation.js';
import { classifyInstall } from '../control-plane/state.js';
import { readStackConfig } from '../control-plane/stack-config.js';
import { runDocker } from '../control-plane/docker.js';
import {
	inspectLocalInstance,
	localDockerManagementHost,
	localInstanceLogs,
	operateLocalInstance
} from '../control-plane/local-instance-host.js';
import { localInstanceManagement } from '../management/instance.js';
import { rpcManagementBindings } from '../management/instance-session.js';
import type { HostingProcess } from '../control-plane/process.js';
import { type HostingProvider, type InstanceSummary } from './types.js';

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

export { inspectLocalInstance, localInstanceLogs, operateLocalInstance };
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
			actionEffects: {
				start: 'reconcile-deployment',
				stop: 'reconcile-deployment',
				restart: 'reconcile-deployment'
			},
			inspect: () => inspectLocalInstance(ref.homeDir),
			logs: (options) => localInstanceLogs(ref.homeDir, options),
			applicationBindings(options) {
				const management = localInstanceManagement(ref.homeDir, {
					...options,
					host: localDockerManagementHost(ref.homeDir)
				});
				return rpcManagementBindings(management, { credentialPolicy: () => true });
			},
			async operate(action, confirmed, options) {
				if (options?.revision !== undefined)
					throw new Error('This instance has no deployment revision selector.');
				if (!confirmed)
					throw new Error('Confirm this lifecycle operation before changing containers.');
				await operateLocalInstance(ref.homeDir, action);
				return { snapshot: await inspectLocalInstance(ref.homeDir) };
			}
		};
	}
};

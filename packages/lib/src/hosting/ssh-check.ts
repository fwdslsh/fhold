import { sshArgs, HOSTING_WIRE_VERSION } from '../control-plane/ssh-native.js';
import { createSshHelperResolver, type SshHelperResolver } from '../control-plane/ssh-helper.js';
import type { HostingProcess } from '../control-plane/process.js';
import type { HostingConnection, ConnectionCheck, InstanceSummary } from './types.js';

/** Diagnostics belong to this adapter, not a growing vendor switch in CLI/Admin. */
export async function checkSshConnection(
	connection: Extract<HostingConnection, { kind: 'ssh-docker' }>,
	run: HostingProcess,
	list: () => Promise<InstanceSummary[]>,
	helper: SshHelperResolver = createSshHelperResolver(connection, run)
): Promise<ConnectionCheck> {
	const result: ConnectionCheck = { ok: false, checks: [], instances: [] };
	async function request(action: string) {
		const raw = await run('ssh', [...sshArgs(connection), await helper('rpc')], {
			input: JSON.stringify({
				version: HOSTING_WIRE_VERSION,
				action,
				...(action === 'diagnose' && connection.roots.length ? { roots: connection.roots } : {})
			})
		});
		try {
			return JSON.parse(raw) as {
				version?: number;
				ok?: boolean;
				value?: {
					actions?: string[];
					release?: string;
					management?: string[];
					docker?: { ok: boolean; message?: string };
				};
			};
		} catch {
			throw new Error(
				'The management helper returned unexpected output. Keep SSH shell startup messages off stdout and reinstall this local tooling if the issue persists.'
			);
		}
	}
	try {
		const platform = (await run('ssh', [...sshArgs(connection), 'uname -sm'])).trim();
		result.checks.push({
			name: 'SSH',
			ok: true,
			detail: `Connected to ${connection.host} (${platform}).`
		});
		const hello = await request('hello');
		if (
			hello.version !== HOSTING_WIRE_VERSION ||
			hello.ok !== true ||
			!hello.value?.actions?.includes('list')
		)
			throw new Error(
				'This distribution’s management helper lacks compatible hosting support. Rebuild or reinstall local tooling.'
			);
		result.checks.push({
			name: 'Management helper',
			ok: true,
			detail: hello.value.release || 'Compatible hosting protocol.'
		});
		const management = hello.value.management?.includes('snapshot') === true;
		result.checks.push({
			name: 'Instance management',
			ok: management,
			detail: management
				? 'Settings, apps, updates and import/export are available.'
				: 'This management helper lacks full management support. Rebuild or reinstall local tooling.'
		});
		if (hello.value.actions.includes('diagnose')) {
			const response = await request('diagnose');
			if (response.ok && response.value?.docker)
				result.checks.push({
					name: 'Docker',
					ok: response.value.docker.ok,
					detail: response.value.docker.message || 'Docker and Compose are ready.'
				});
		}
		result.instances = await list();
		result.checks.push({
			name: 'Discovery',
			ok: true,
			detail: result.instances.length
				? `Found ${result.instances.length} instance(s).`
				: 'No instances found. Add the exact home or its parent to Instance roots; stopped installations are supported.'
		});
		result.ok = result.checks.every((item) => item.ok);
	} catch (error) {
		result.checks.push({
			name: result.checks.length ? 'Management helper / discovery' : 'Connection',
			ok: false,
			detail: error instanceof Error ? error.message : 'Connection check failed.'
		});
	}
	return result;
}

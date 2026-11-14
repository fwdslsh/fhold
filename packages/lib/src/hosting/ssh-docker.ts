import { parseInstanceRef } from './preferences.js';
import { SshInstanceManagement } from '../management/ssh.js';
import { rpcManagementBindings } from '../management/instance-session.js';
import { runHostingProcess, type HostingProcess } from '../control-plane/process.js';
import { checkSshConnection } from './ssh-check.js';
import { createSshHelperResolver } from '../control-plane/ssh-helper.js';
import {
	HOSTING_WIRE_VERSION,
	sshArgs,
	type MachineRequest,
	type MachineResponse
} from '../control-plane/ssh-native.js';
import {
	capabilities,
	selectListedInstance,
	type HostingConnection,
	type HostingProvider,
	type HostingSnapshot,
	type InstanceSummary
} from './types.js';

export function sshDockerProvider(
	connection: Extract<HostingConnection, { kind: 'ssh-docker' }>,
	run: HostingProcess = runHostingProcess
): HostingProvider {
	const helper = createSshHelperResolver(connection, run);
	async function request(payload: Omit<MachineRequest, 'version'>): Promise<unknown> {
		// OpenSSH passes remote commands through a shell. The command is fixed;
		// directories, actions and options travel only in typed JSON stdin.
		const stdout = await run('ssh', [...sshArgs(connection), await helper('rpc')], {
			input: `${JSON.stringify({ version: HOSTING_WIRE_VERSION, ...payload })}\n`,
			timeoutMs: ['start', 'stop', 'restart'].includes(payload.action) ? 600_000 : 45_000
		});
		let response: MachineResponse;
		try {
			response = JSON.parse(stdout) as MachineResponse;
		} catch {
			throw new Error(
				'The management helper did not return hosting protocol JSON. Keep SSH shell startup output off stdout and check the local tooling distribution.'
			);
		}
		if (!response || response.version !== HOSTING_WIRE_VERSION || typeof response.ok !== 'boolean')
			throw new Error(
				'This distribution’s management helper uses an unsupported hosting wire version. Rebuild or reinstall local tooling.'
			);
		if (!response.ok)
			throw new Error(
				typeof response.error === 'string' ? response.error : 'Remote operation failed.'
			);
		return response.value;
	}
	function summary(value: unknown): InstanceSummary {
		if (
			!value ||
			typeof value !== 'object' ||
			!('name' in value) ||
			typeof value.name !== 'string' ||
			!('ref' in value)
		)
			throw new Error('The management helper returned an invalid instance summary.');
		const ref = parseInstanceRef(value.ref);
		if (ref.kind !== 'local-docker')
			throw new Error('The remote host returned a non-Docker target.');
		return {
			name: value.name,
			location: ref.homeDir,
			ref: { kind: 'ssh-docker', connectionId: connection.id, remoteHome: ref.homeDir }
		};
	}
	const provider: HostingProvider = {
		check: () => checkSshConnection(connection, run, () => provider.listInstances(), helper),
		installation: {
			async info() {
				const value = (await request({ action: 'hello' })) as { instancesDirectory?: unknown };
				if (typeof value?.instancesDirectory !== 'string')
					throw new Error(
						'Check the host connection and local tooling distribution before managing this computer.'
					);
				return {
					instancesDirectory: value.instancesDirectory,
					defaultHome: `${value.instancesDirectory}/default`
				};
			},
			async directory(path) {
				const info = await provider.installation!.info();
				const manager = new SshInstanceManagement(connection, info.defaultHome, { helper });
				try {
					return await manager.call('docker.directory', { path: path ?? info.instancesDirectory });
				} finally {
					await manager.close();
				}
			}
		},
		async listInstances() {
			const values = await request({
				action: 'list',
				roots: connection.roots.length ? connection.roots : undefined
			});
			if (!Array.isArray(values))
				throw new Error('The management helper returned an invalid instance list.');
			return values.map(summary);
		},
		async selectInstance(selector) {
			if (selector.startsWith('/'))
				return parseInstanceRef({
					kind: 'ssh-docker',
					connectionId: connection.id,
					remoteHome: selector
				});
			return selectListedInstance(provider, selector);
		},
		open(ref) {
			if (ref.kind !== 'ssh-docker' || ref.connectionId !== connection.id)
				throw new Error('Choose an instance on this SSH connection.');
			let manager: SshInstanceManagement | undefined;
			async function inspect(): Promise<HostingSnapshot> {
				const value = await request({
					action: 'inspect',
					homeDir: ref.kind === 'ssh-docker' ? ref.remoteHome : undefined
				});
				const identity = summary(value);
				const snapshot = value as HostingSnapshot;
				if (!Array.isArray(snapshot.services) || !Array.isArray(snapshot.warnings))
					throw new Error('The management helper returned an invalid status snapshot.');
				// Return only the public hosting contract, not unknown future fields or
				// an unusable remote loopback URL. Native credentials never cross here.
				return {
					...identity,
					ref,
					services: snapshot.services,
					warnings: snapshot.warnings,
					...(typeof snapshot.serviceError === 'string'
						? { serviceError: snapshot.serviceError }
						: {}),
					pendingRestart: snapshot.pendingRestart,
					capabilities: capabilities(['start', 'stop', 'restart', 'settings', 'transfer'])
				};
			}
			return {
				ref,
				actionEffects: {
					start: 'reconcile-deployment',
					stop: 'reconcile-deployment',
					restart: 'reconcile-deployment'
				},
				inspect,
				async logs(options = {}) {
					if (Object.entries(options).some(([key, value]) => key !== 'tail' && value !== undefined))
						throw new Error(
							'Docker logs support --tail; deployment revision/replica selection is not available.'
						);
					return String(
						await request({ action: 'logs', homeDir: ref.remoteHome, tail: options.tail })
					);
				},
				applicationBindings(options) {
					manager ??= new SshInstanceManagement(connection, ref.remoteHome, { ...options, helper });
					return rpcManagementBindings(manager, {
						passiveSnapshot: () => manager!.inspectPassive(),
						acquireSnapshot: () => manager!.acquireForward()
					});
				},
				async operate(action, confirmed, options) {
					if (options?.revision !== undefined)
						throw new Error('This instance has no deployment revision selector.');
					if (!confirmed)
						throw new Error('Confirm this lifecycle operation before changing containers.');
					await request({ action, homeDir: ref.remoteHome, confirmed });
					try {
						return { snapshot: await inspect() };
					} catch {
						throw new Error(
							`Remote ${action} completed, but status could not be refreshed. Run status rather than repeating the lifecycle operation.`
						);
					}
				}
			};
		}
	};
	return provider;
}

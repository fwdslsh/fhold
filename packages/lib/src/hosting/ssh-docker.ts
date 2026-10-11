import { parseInstanceRef } from './preferences.js';
import { runHostingProcess, type HostingProcess } from './process.js';
import {
	capabilities,
	selectListedInstance,
	type HostingConnection,
	type HostingProvider,
	type HostingSnapshot,
	type InstanceSummary
} from './types.js';

export const HOSTING_WIRE_VERSION = 1;
export type MachineRequest = {
	version: 1;
	action: 'hello' | 'list' | 'inspect' | 'logs' | 'start' | 'stop' | 'restart';
	homeDir?: string;
	roots?: string[];
	tail?: number;
	confirmed?: boolean;
};
export type MachineResponse =
	| { version: 1; ok: true; value: unknown }
	| { version: 1; ok: false; error: string };

export function sshDockerProvider(
	connection: Extract<HostingConnection, { kind: 'ssh-docker' }>,
	run: HostingProcess = runHostingProcess
): HostingProvider {
	async function request(payload: Omit<MachineRequest, 'version'>): Promise<unknown> {
		// OpenSSH passes remote commands through a shell. The command is fixed;
		// directories, actions and options travel only in typed JSON stdin.
		const stdout = await run(
			'ssh',
			[
				'-o',
				'BatchMode=yes',
				'-o',
				'ConnectTimeout=10',
				...(connection.port ? ['-p', String(connection.port)] : []),
				connection.host,
				'fhold hosting rpc'
			],
			{
				input: `${JSON.stringify({ version: HOSTING_WIRE_VERSION, ...payload })}\n`,
				timeoutMs: ['start', 'stop', 'restart'].includes(payload.action) ? 600_000 : 45_000
			}
		);
		let response: MachineResponse;
		try {
			response = JSON.parse(stdout) as MachineResponse;
		} catch {
			throw new Error(
				'The remote fhold CLI did not return hosting protocol JSON. Install a CLI with hosting support and keep shell startup output off stdout.'
			);
		}
		if (!response || response.version !== HOSTING_WIRE_VERSION || typeof response.ok !== 'boolean')
			throw new Error(
				'The remote CLI uses an unsupported hosting wire version. Update its CLI; identical release versions are not required.'
			);
		if (!response.ok)
			throw new Error(
				typeof response.error === 'string' ? response.error : 'Remote operation failed.'
			);
		return response.value;
	}
	async function hello(action: string) {
		const result = (await request({ action: 'hello' })) as { actions?: string[] };
		if (!result || !Array.isArray(result.actions) || !result.actions.includes(action))
			throw new Error(
				`The remote CLI does not support hosting ${action}. Other supported read operations remain available.`
			);
	}
	function summary(value: unknown): InstanceSummary {
		if (
			!value ||
			typeof value !== 'object' ||
			!('name' in value) ||
			typeof value.name !== 'string' ||
			!('ref' in value)
		)
			throw new Error('The remote CLI returned an invalid instance summary.');
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
		async listInstances() {
			await hello('list');
			const values = await request({
				action: 'list',
				roots: connection.roots.length ? connection.roots : undefined
			});
			if (!Array.isArray(values))
				throw new Error('The remote CLI returned an invalid instance list.');
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
			async function inspect(): Promise<HostingSnapshot> {
				const value = await request({
					action: 'inspect',
					homeDir: ref.kind === 'ssh-docker' ? ref.remoteHome : undefined
				});
				const identity = summary(value);
				const snapshot = value as HostingSnapshot;
				if (!Array.isArray(snapshot.services) || !Array.isArray(snapshot.warnings))
					throw new Error('The remote CLI returned an invalid status snapshot.');
				// Return only the public hosting contract, not unknown future fields or
				// an unusable remote loopback URL. Native credentials never cross here.
				return {
					...identity,
					ref,
					services: snapshot.services,
					warnings: snapshot.warnings,
					pendingRestart: snapshot.pendingRestart,
					capabilities: capabilities()
				};
			}
			return {
				ref,
				inspect,
				async logs(options = {}) {
					return String(
						await request({ action: 'logs', homeDir: ref.remoteHome, tail: options.tail })
					);
				},
				async operate(action, confirmed) {
					if (!confirmed)
						throw new Error('Confirm this lifecycle operation before changing containers.');
					await hello(action);
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

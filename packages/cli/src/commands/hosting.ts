import { defineCommand } from 'citty';
import {
	HostingPreferencesStore,
	LOCAL_CONNECTION,
	hostingProvider,
	hostingMachineRequest,
	openHostingInstance
} from '@fhold/lib';
import { checkHostingConnection, repairSshCli, connectionEndpoint } from '@fhold/lib';

const store = () => new HostingPreferencesStore();
export const hostingCommand = defineCommand({
	meta: { name: 'hosting', description: 'Manage host connections and discover their instances' },
	subCommands: {
		edit: defineCommand({
			meta: {
				name: 'edit',
				description: 'Edit saved host metadata; never changes running instances'
			},
			args: {
				id: { type: 'positional', required: true },
				label: { type: 'string' },
				host: { type: 'string' },
				port: { type: 'string', description: 'SSH port, or default to use native SSH config' },
				roots: { type: 'string', description: 'JSON array of remote roots' },
				subscription: { type: 'string' },
				group: { type: 'string' },
				confirm: { type: 'boolean', default: false }
			},
			run({ args }) {
				const preferences = store();
				const previous = preferences.connection(args.id);
				const next = {
					...previous,
					...(args.label !== undefined ? { label: args.label } : {}),
					...(args.host !== undefined ? { host: args.host } : {}),
					...(args.port !== undefined
						? { port: args.port === 'default' ? undefined : Number(args.port) }
						: {}),
					...(args.roots !== undefined ? { roots: JSON.parse(args.roots) } : {}),
					...(args.subscription !== undefined ? { subscriptionId: args.subscription } : {}),
					...(args.group !== undefined ? { resourceGroup: args.group } : {})
				};
				if (connectionEndpoint(previous) !== connectionEndpoint(next) && !args.confirm)
					throw new Error(
						'Changing the host/scope clears saved recent instances for this connection. Repeat with --confirm. Containers and instance data are not changed.'
					);
				console.log(JSON.stringify(preferences.updateConnection(args.id, next), null, 2));
			}
		}),
		remove: defineCommand({
			meta: {
				name: 'remove',
				description: 'Forget a connection and its recents; no instances are stopped or deleted'
			},
			args: {
				id: { type: 'positional', required: true },
				confirm: { type: 'boolean', default: false }
			},
			run({ args }) {
				if (!args.confirm)
					throw new Error('Repeat with --confirm to remove connection metadata only.');
				store().removeConnection(args.id);
				console.log('Connection removed. Running instances and their data were not changed.');
			}
		}),
		check: defineCommand({
			meta: {
				name: 'check',
				description: 'Check native sign-in, CLI, Docker and discovery without instance changes'
			},
			args: { id: { type: 'positional', required: true } },
			async run({ args }) {
				const result = await checkHostingConnection(store().connection(args.id));
				console.log(JSON.stringify(result, null, 2));
				if (!result.ok) process.exitCode = 1;
			}
		}),
		repair: defineCommand({
			meta: {
				name: 'repair',
				description: 'Install/update only the remote Linux CLI in ~/.local/bin/fhold'
			},
			args: {
				id: { type: 'positional', required: true },
				confirm: { type: 'boolean', default: false },
				'cli-file': {
					type: 'string',
					description:
						'Trusted offline Linux CLI artifact; otherwise download this published tooling release'
				}
			},
			async run({ args }) {
				console.log(
					await repairSshCli(store().connection(args.id), {
						confirmed: args.confirm,
						cliFile: args['cli-file']
					})
				);
			}
		}),
		list: defineCommand({
			meta: {
				name: 'list',
				description: 'List saved connections (no authentication or instance writes)'
			},
			run() {
				console.log(
					JSON.stringify(
						[
							LOCAL_CONNECTION,
							...store()
								.read()
								.connections.filter((item) => item.id !== 'local')
						],
						null,
						2
					)
				);
			}
		}),
		add: defineCommand({
			meta: {
				name: 'add',
				description: 'Save an SSH or ACA connection; native credentials stay with ssh or az'
			},
			args: {
				id: { type: 'positional', required: true },
				provider: { type: 'string', required: true },
				host: { type: 'string' },
				port: { type: 'string' },
				roots: {
					type: 'string',
					description:
						'JSON array of absolute remote instance roots; omitted uses the remote default'
				},
				subscription: { type: 'string' },
				group: { type: 'string' },
				label: { type: 'string' }
			},
			run({ args }) {
				const connection = store().saveConnection({
					id: args.id,
					kind: args.provider,
					label: args.label || args.id,
					host: args.host,
					port: args.port ? Number(args.port) : undefined,
					roots: args.roots ? JSON.parse(args.roots) : [],
					subscriptionId: args.subscription,
					resourceGroup: args.group
				});
				console.log(
					`Saved ${connection.label}. Native sign-in is not changed. Run fhold hosting instances --connection ${connection.id}.`
				);
			}
		}),
		instances: defineCommand({
			meta: { name: 'instances', description: 'Discover compatible instances for a connection' },
			args: { connection: { type: 'string', default: 'local' } },
			async run({ args }) {
				console.log(
					JSON.stringify(
						await hostingProvider(store().connection(String(args.connection))).listInstances(),
						null,
						2
					)
				);
			}
		}),
		rpc: defineCommand({
			meta: {
				name: 'rpc',
				description: 'One typed JSON hosting request on stdin for native SSH transport'
			},
			async run() {
				let input = '';
				for await (const chunk of process.stdin) {
					input += String(chunk);
					if (Buffer.byteLength(input) > 1024 * 1024)
						throw new Error('Hosting request exceeds 1 MiB.');
				}
				let value: unknown;
				try {
					value = JSON.parse(input);
				} catch {
					value = null;
				}
				console.log(JSON.stringify(await hostingMachineRequest(value)));
			}
		})
	}
});

export async function runHostedCommand(
	connectionId: string,
	instance: string | undefined,
	argv: string[]
): Promise<void> {
	const connection = store().connection(connectionId);
	const action = argv[0] || 'status';
	if (!['status', 'logs', 'start', 'stop', 'restart'].includes(action))
		throw new Error(
			'Remote connections support status, logs and their available lifecycle actions. Manage other operations using the Docker-host CLI or your deployment tooling. No local instance was changed.'
		);
	if (!instance)
		throw new Error(
			'Choose an instance with --name/-n. Use fhold hosting instances --connection <name> to discover it.'
		);
	if (argv.slice(1).some((value) => value !== '--confirm'))
		throw new Error(
			'Remote lifecycle accepts only --confirm. Other options must be configured on the owning host or deployment tooling.'
		);
	const ref = await hostingProvider(connection).selectInstance(instance);
	const session = openHostingInstance(connection, ref);
	if (action === 'status') console.log(JSON.stringify(await session.inspect(), null, 2));
	else if (action === 'logs') console.log(await session.logs());
	else {
		if (!argv.includes('--confirm'))
			throw new Error(
				'This changes remote containers and can interrupt work. Repeat with --confirm when ready.'
			);
		console.log(
			JSON.stringify(await session.operate(action as 'start' | 'stop' | 'restart', true), null, 2)
		);
	}
	// Observation should not fail because optional recent-target persistence failed.
	try {
		store().remember(ref);
	} catch {
		console.warn(
			'The operation completed, but recent connections could not be saved. Review hosting.json.'
		);
	}
}
export default hostingCommand;

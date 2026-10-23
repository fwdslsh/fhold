import { defineCommand } from 'citty';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	HostingPreferencesStore,
	hostingConnectionSetup,
	LOCAL_CONNECTION,
	hostingProvider,
	hostingMachineRequest,
	openInstanceSession
} from '@fhold/lib';
import { checkHostingConnection, connectionEndpoint } from '@fhold/lib';
import { serveManagementSession } from '@fhold/lib';
import {
	serveHostingCommand,
	runSshCommand,
	createSshCommandFiles,
	type SshCommandFiles
} from '@fhold/lib';
import { main } from '../main.js';
import { sshHelperCommand, sshArgs } from '@fhold/lib';
import { runHostingProcess } from '@fhold/lib';
import { seedSkeletonFromEmbedded } from '../lib/embedded-assets.js';
import { runSessionCommand } from '../lib/hosting-command.js';

const store = () => new HostingPreferencesStore();
export const hostingCommand = defineCommand({
	meta: { name: 'hosting', description: 'Manage host connections and discover their instances' },
	subCommands: {
		login: defineCommand({
			meta: {
				name: 'login',
				description: 'Sign in using the hosting provider’s native browser flow'
			},
			args: { provider: { type: 'positional', required: true } },
			async run({ args }) {
				const setup = hostingConnectionSetup(args.provider);
				if (!setup)
					throw new Error(
						'This provider uses native host setup; for SSH, connect in a terminal first.'
					);
				await setup.signIn();
				console.log('Hosting sign-in completed. Existing instances were not changed.');
			}
		}),
		scopes: defineCommand({
			meta: { name: 'scopes', description: 'List account scopes for a hosting connection' },
			args: { provider: { type: 'positional', required: true }, subscription: { type: 'string' } },
			async run({ args }) {
				const setup = hostingConnectionSetup(args.provider);
				if (!setup) throw new Error('This provider has no account-scope picker.');
				console.log(
					JSON.stringify(
						await setup.choices(
							args.subscription ? 'resourceGroup' : 'subscriptionId',
							args.subscription ? { subscriptionId: args.subscription } : {}
						),
						null,
						2
					)
				);
			}
		}),
		command: defineCommand({
			meta: { name: 'command', description: 'Ordinary instance CLI commands over native SSH' },
			run: () => serveHostingCommand(main)
		}),
		session: defineCommand({
			meta: {
				name: 'session',
				description: 'Target-bound management over native SSH stdin/stdout'
			},
			run: () => seedSkeletonFromEmbedded(() => serveManagementSession(), process.cwd())
		}),
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
	const composedAction =
		['status', 'logs', 'start', 'stop', 'restart', 'console', 'backup', 'restore'].includes(
			action
		) ||
		(action === 'connect' && argv[1] !== 'remote');
	if (connection.kind === 'ssh-docker' && !composedAction) {
		if (!instance) throw Error('Choose a remote instance with --name/-n.');
		const listed =
			action === 'install' ? await hostingProvider(connection).listInstances() : undefined;
		const ref =
			listed?.find((item) => item.name === instance)?.ref ??
			(action === 'install'
				? undefined
				: await hostingProvider(connection).selectInstance(instance));
		const name = ref?.kind === 'ssh-docker' ? ref.remoteHome : instance;
		let uploader: SshCommandFiles | undefined;
		let stdinFile: string | undefined;
		try {
			const forwarded = [...argv];
			const inputFlags = new Set([
				'--config',
				'--key-file',
				'--bot-token-file',
				'--app-token-file',
				'--selection-file',
				'--directory-map'
			]);
			if (action === 'recovery' && argv[1] === 'credential') inputFlags.add('--from');
			const fileFlags = new Set(
				[...inputFlags].map((flag) => flag.replaceAll('-', '').toLowerCase())
			);
			for (let index = 0; index < forwarded.length; index++) {
				const argument = forwarded[index]!;
				const flag = argument.split('=')[0]!;
				const adopted = action === 'task' && argv[1] === 'adopt' && index === 2;
				if (!fileFlags.has(flag.replaceAll('-', '').toLowerCase()) && !adopted) continue;
				const file = adopted
					? argument
					: argument.includes('=')
						? argument.slice(argument.indexOf('=') + 1)
						: forwarded[index + 1];
				if (!file) throw Error(`Choose an input file for ${flag}.`);
				let localFile = file;
				if (file === '-') {
					if (!stdinFile) {
						stdinFile = mkdtempSync(join(tmpdir(), 'fhold-command-input-'));
						writeFileSync(join(stdinFile, 'input'), readFileSync(0), { mode: 0o600 });
					}
					localFile = join(stdinFile, 'input');
				}
				if (!uploader) {
					const hello = JSON.parse(
						await runHostingProcess('ssh', [...sshArgs(connection), await sshHelperCommand(connection, 'rpc')], {
							input: JSON.stringify({ version: 1, action: 'hello' })
						})
					) as { value: { instancesDirectory: string } };
					const home = name.startsWith('/') ? name : `${hello.value.instancesDirectory}/${name}`;
					uploader = createSshCommandFiles(connection, home);
				}
				const remote = await uploader.uploadFile(localFile);
				if (adopted) forwarded[index] = remote;
				else if (argument.includes('=')) forwarded[index] = `${flag}=${remote}`;
				else forwarded[++index] = remote;
			}
			await runSshCommand(connection, name, forwarded);
		} finally {
			await uploader?.close();
			if (stdinFile) rmSync(stdinFile, { recursive: true, force: true });
		}
		return;
	}
	if (!instance)
		throw new Error(
			'Choose an instance with --name/-n. Use fhold hosting instances --connection <name> to discover it.'
		);
	const ref = await hostingProvider(connection).selectInstance(instance);
	const session = openInstanceSession(connection, ref);
	try {
		await runSessionCommand(session, argv);
	} finally {
		await session.close();
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

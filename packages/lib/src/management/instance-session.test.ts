import { expect, test } from 'bun:test';
import { composeInstanceSession, rpcManagementBindings } from './instance-session.js';
import type { InstanceManagement, ManagedSnapshot } from './types.js';
import { defaultStackConfig } from '../control-plane/stack-config.js';
import { operationDescription, supportedOperation, unsupportedOperation } from './contracts.js';
import type { HostingSnapshot } from '../hosting/types.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openInstanceSession } from '../hosting/provider.js';
import { LOCAL_CONNECTION } from '../hosting/types.js';

const ref = {
	kind: 'azure-container-apps' as const,
	connectionId: 'aca',
	resourceId: '/subscriptions/s/resourceGroups/g/providers/Microsoft.App/containerApps/a'
};
const hosting: HostingSnapshot = {
	ref,
	name: 'agent',
	location: ref.resourceId,
	capabilities: {
		start: { supported: true },
		stop: { supported: true },
		restart: { supported: true },
		settings: { supported: false, reason: 'External deployment ownership.' },
		transfer: { supported: false, reason: 'External deployment ownership.' }
	},
	services: [],
	warnings: []
};

test('knowledge opens only through the selected manager and stays out of snapshots', async () => {
	const calls: string[] = [];
	const manager: InstanceManagement = {
		call: (async (method: string) => {
			calls.push(method);
			if (method === 'data.knowledgeUi') return { url: 'http://127.0.0.1:43210/?token=synthetic-private' };
			throw new Error('Unexpected operation');
		}) as InstanceManagement['call'],
		busy: () => false,
		close: async () => { calls.push('close'); }
	};
	const bindings = rpcManagementBindings(manager);
	expect(calls).toEqual([]);
	const operation = bindings.data!.knowledgeUi;
	if (operation.support !== 'supported') throw new Error('Missing Knowledge operation');
	expect(await operation.invoke(undefined, {})).toEqual({ url: 'http://127.0.0.1:43210/?token=synthetic-private' });
	expect(calls).toEqual(['data.knowledgeUi']);
	await bindings.close!();
	await expect(operation.invoke(undefined, {})).rejects.toThrow();
	expect(calls).toEqual(['data.knowledgeUi', 'close']);
});

test.skipIf(process.env.FH_SOCKET_TESTS !== '1')(
	'local and SSH browser links use the selected acquired route and private credential',
	async () => {
		const calls: string[] = [];
		const requests: string[] = [];
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch(request) {
				requests.push(new URL(request.url).pathname);
				expect(request.method).toBe('POST');
				expect(request.headers.get('authorization')).toBe(
					`Basic ${Buffer.from('opencode:fixture-password').toString('base64')}`
				);
				return Response.json({ code: 'private-one-use-code', expires_in: 300 });
			}
		});
		const endpoint = `http://127.0.0.1:${server.port}`;
		const snapshot = (url: string) =>
			({
				homeDir: '/synthetic/home',
				config: defaultStackConfig('/synthetic/home'),
				phase: 'ready',
				portalMappings: {},
				portalSecrets: {},
				connectionDetails: {
					opencode: { type: 'opencode', url, username: 'opencode', note: 'Native' }
				}
			}) as ManagedSnapshot;
		try {
			for (const remote of [false, true]) {
				const manager: InstanceManagement = {
					call: (async (method: string) => {
						calls.push(method);
						if (method === 'agent.assistantPassword') return { password: 'fixture-password' };
						if (method === 'snapshot') return snapshot(endpoint);
						throw new Error(`Unexpected call ${method}`);
					}) as InstanceManagement['call'],
					busy: () => false,
					close: async () => {}
				};
				const bindings = rpcManagementBindings(
					manager,
					remote
						? {
								passiveSnapshot: async () => snapshot('http://remote-only.invalid:3810'),
								acquireSnapshot: async () => {
									calls.push('forward');
									return snapshot(endpoint);
								}
							}
						: {}
				);
				const before = calls.length;
				await bindings.inspectApplication!();
				expect(calls.slice(before)).not.toContain('agent.assistantPassword');
				expect(calls.slice(before)).not.toContain('forward');
				const link = bindings.agent!.browserLink!;
				if (link.support !== 'supported') throw new Error('Expected browser pairing');
				expect(await link.invoke(undefined, {})).toEqual({
					url: `${endpoint}/auth/connect/private-one-use-code`
				});
				const observations = JSON.stringify(await bindings.inspectApplication!());
				expect(observations).not.toContain('fixture-password');
				expect(observations).not.toContain('private-one-use-code');
				await bindings.close!();
				await expect(link.invoke(undefined, {})).rejects.toThrow();
			}
			expect(requests).toEqual(['/api/pair', '/api/pair']);
			expect(calls.filter((call) => call === 'forward')).toHaveLength(1);
		} finally {
			await server.stop(true);
		}
	}
);

test('checkpoint inspection stays an engine operation rather than a saved-settings query', async () => {
	const calls: unknown[] = [];
	const manager: InstanceManagement = {
		call: (async (method: string, value: unknown) => {
			calls.push([method, value]);
			return 'Accepted checkpoint: synthetic-generation';
		}) as InstanceManagement['call'],
		busy: () => false,
		close: async () => {}
	};
	const inspect = rpcManagementBindings(manager).data?.recovery.inspect;
	if (inspect?.support !== 'supported') throw new Error('Expected recovery inspection.');
	await expect(inspect.invoke(undefined, {})).resolves.toBe(
		'Accepted checkpoint: synthetic-generation'
	);
	expect(calls).toEqual([['data.recovery.inspect', undefined]]);
});

test.each([true, false])('a new local folder reaches the shared install view with Docker available=%s', async (dockerReady) => {
	const root = mkdtempSync(join(tmpdir(), 'fhold-session-install-'));
	const homeDir = join(root, 'new-agent');
	const calls = join(root, 'docker-calls');
	const docker = join(root, 'docker');
	// This composition test observes installation readiness, not the runner's
	// Docker daemon/context. Keep both host states deterministic and read-only.
	writeFileSync(docker, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'info') {
  if (!${dockerReady}) { console.error('Docker daemon unavailable (synthetic)'); process.exit(1); }
  console.log('"fixture-version"');
} else if (JSON.stringify(args) === JSON.stringify(['compose', 'version'])) console.log('Docker Compose fixture');
else throw Error('Unexpected Docker operation');
`, { mode: 0o700 });
	const previousDocker = process.env.FH_DOCKER_BIN;
	process.env.FH_DOCKER_BIN = docker;
	const session = openInstanceSession(
		LOCAL_CONNECTION,
		{ kind: 'local-docker', connectionId: 'local', homeDir },
		{ setupName: 'new-agent' }
	);
	try {
		const snapshot = await session.inspect();
		expect(snapshot.lifecycle).toMatchObject({ state: 'known', value: 'not-installed' });
		expect(snapshot.docker?.config.deployment.projectName).toBe('new-agent');
		expect(snapshot.docker?.installationReadiness).toMatchObject({ ok: dockerReady });
		expect(existsSync(homeDir)).toBe(false);
		expect(readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line))).toEqual([
			['info', '--format', '{{json .ServerVersion}}'], ...(dockerReady ? [['compose', 'version']] : [])
		]);
		expect(snapshot.operations['docker.install']).toMatchObject({
			support: 'supported',
			availability: { state: 'ready' }
		});
		expect(snapshot.operations['host.start']).toEqual(operationDescription(session.host.start));
		expect(snapshot.deployment).toMatchObject({
			state: 'known',
			value: { lifecycleCapabilities: { start: { state: 'unavailable' } } }
		});
	} finally {
		try { await session.close(); }
		finally {
			if (previousDocker === undefined) delete process.env.FH_DOCKER_BIN;
			else process.env.FH_DOCKER_BIN = previousDocker;
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test('normalized inspection preserves host facts when an optional app observation fails', async () => {
	const session = composeInstanceSession({
		ref,
		inspectHost: async () => hosting,
		host: {
			inspect: supportedOperation(async () => hosting),
			start: unsupportedOperation('External deployment ownership.'),
			stop: unsupportedOperation('External deployment ownership.'),
			restart: unsupportedOperation('External deployment ownership.'),
			logs: supportedOperation(async () => ''),
			console: unsupportedOperation('No console.')
		},
		inspectApplication: async () => {
			throw new Error('optional metadata unavailable');
		}
	});
	const snapshot = await session.inspect();
	expect(snapshot.identity.ref).toEqual(ref);
	expect(snapshot.services).toMatchObject({ state: 'known', value: [] });
	expect(snapshot.apps.config).toMatchObject({ state: 'unavailable' });
	expect(snapshot.operations['host.start']).toEqual({
		support: 'unsupported',
		reason: 'External deployment ownership.'
	});
	expect(snapshot.docker).toBeUndefined();
	expect(snapshot.lifecycle).toMatchObject({ state: 'unavailable' });
});

test('failed service inspection is unavailable, not a known empty service inventory', async () => {
	const session = composeInstanceSession({
		ref,
		inspectHost: async () => ({ ...hosting, serviceError: 'Host daemon unavailable.' }),
		host: {
			inspect: supportedOperation(async () => hosting),
			start: unsupportedOperation('No lifecycle.'),
			stop: unsupportedOperation('No lifecycle.'),
			restart: unsupportedOperation('No lifecycle.'),
			logs: supportedOperation(async () => ''),
			console: unsupportedOperation('No console.')
		}
	});
	expect((await session.inspect()).services).toEqual({
		state: 'unavailable',
		reason: 'Host daemon unavailable.'
	});
});

test('passive inspection does not invoke an agent operation', async () => {
	let connected = 0;
	const session = composeInstanceSession({
		ref,
		inspectHost: async () => hosting,
		host: {
			inspect: supportedOperation(async () => hosting),
			start: unsupportedOperation('No lifecycle.'),
			stop: unsupportedOperation('No lifecycle.'),
			restart: unsupportedOperation('No lifecycle.'),
			logs: supportedOperation(async () => ''),
			console: unsupportedOperation('No console.')
		},
		agent: {
			connect: supportedOperation(async () => {
				connected += 1;
				return { endpoint: 'https://agent.example' };
			})
		}
	});
	await session.inspect();
	expect(connected).toBe(0);
	await session.agent.connect.invoke({}, {});
	expect(connected).toBe(1);
});

test('published addresses are not acquired access and SSH links retain only an explicit private forward', async () => {
	let origin = 'http://127.0.0.1:4096';
	let calls = 0;
	const managed = (url: string): ManagedSnapshot => ({
		phase: 'ready',
		homeDir: '/synthetic/home',
		configPath: '/synthetic/home/state/stack.json',
		config: defaultStackConfig(),
		services: [],
		portalMappings: {},
		portalSecrets: {},
		connectionDetails: {
			opencode: {
				type: 'opencode',
				url,
				username: 'opencode',
				note: 'Native',
				passwordFile: '/private/password',
				password: 'must-not-leak'
			},
			mcp: {
				type: 'mcp',
				url: `${url}/mcp`,
				note: 'MCP',
				credentialKeyFile: '/private/key',
				credentialKey: 'must-not-leak'
			},
			claude: { type: 'claude', url: `${url}/mcp`, note: 'Claude' }
		}
	});
	const manager: InstanceManagement = {
		call: async () => {
			calls++;
			return managed('http://127.0.0.1:54321') as never;
		},
		busy: () => false,
		close: async () => {}
	};
	const bindings = rpcManagementBindings(manager, {
		passiveSnapshot: async () => managed(origin),
		acquireSnapshot: async () => {
			calls++;
			return managed('http://127.0.0.1:54321');
		}
	});
	const inspect = bindings.inspectApplication!;
	expect((await inspect()).agent.access).toMatchObject({ state: 'not-inspected' });
	expect((await inspect()).apps.connections).toMatchObject({ state: 'not-inspected' });
	expect(calls).toBe(0);
	const connect = bindings.agent!.connect!;
	if (connect.support !== 'supported') throw new Error('fixture');
	await connect.invoke({}, {});
	const snapshot = await inspect();
	expect(snapshot.agent.access).toMatchObject({
		state: 'known',
		value: { endpoint: 'http://127.0.0.1:54321' }
	});
	expect(snapshot.apps.connections).toMatchObject({
		state: 'known',
		value: { mcp: { url: 'http://127.0.0.1:54321/mcp' } }
	});
	expect(JSON.stringify(snapshot.apps.connections)).not.toContain('must-not-leak');
	expect(JSON.stringify(snapshot.apps.connections)).not.toContain('/private/');
	origin = 'http://127.0.0.1:4097';
	expect((await inspect()).agent.access).toMatchObject({ state: 'not-inspected' });
	expect(calls).toBe(1);
	await bindings.close!();
});

test('a failed passive management snapshot is not retried by individual panes', async () => {
	let snapshots = 0;
	const session = composeInstanceSession({
		ref,
		inspectHost: async () => hosting,
		host: {
			inspect: supportedOperation(async () => hosting),
			start: unsupportedOperation('No lifecycle.'),
			stop: unsupportedOperation('No lifecycle.'),
			restart: unsupportedOperation('No lifecycle.'),
			logs: supportedOperation(async () => ''),
			console: unsupportedOperation('No console.')
		},
		inspectApplication: async () => {
			snapshots += 1;
			throw new Error('remote snapshot unavailable');
		}
	});
	const snapshot = await session.inspect();
	expect(snapshots).toBe(1);
	expect(snapshot.apps.config).toMatchObject({ state: 'unavailable' });
	expect(snapshot.lifecycle).toMatchObject({ state: 'unavailable' });
});

test('named operations reach the management session with input and confirmation separated', async () => {
	const calls: Array<[string, unknown, unknown]> = [];
	const manager: InstanceManagement = {
		call: async (operation, input, context) => {
			calls.push([operation, input, context]);
			return {} as never;
		},
		busy: () => false,
		close: async () => {}
	};
	const bindings = rpcManagementBindings(manager);
	const { backup, restoreInstance } = bindings.data!;
	const { remote } = bindings.agent!;
	const { updatePolicy } = bindings.apps!.credentials;
	for (const operation of [backup, restoreInstance, remote, updatePolicy])
		if (operation.support !== 'supported') throw new Error('fixture');
	await backup.invoke({ destination: '/operator/export', full: true }, { confirmed: true });
	await restoreInstance.invoke(
		{ sourceHome: '/operator/export', apply: true, previewDigest: 'reviewed-preview' },
		{ confirmed: true }
	);
	await remote.invoke({ action: 'enable', tool: 'codex', trusted: true }, { confirmed: true });
	await updatePolicy.invoke({ username: 'owner', policy: 'read', previousPolicy: 'chat' }, {});
	expect(calls).toEqual([
		['data.backup', { destination: '/operator/export', full: true }, { confirmed: true }],
		[
			'data.restoreInstance',
			{ sourceHome: '/operator/export', apply: true, previewDigest: 'reviewed-preview' },
			{ confirmed: true }
		],
		['agent.remote', { action: 'enable', tool: 'codex', trusted: true }, { confirmed: true }],
		[
			'apps.credentials.updatePolicy',
			{ username: 'owner', policy: 'read', previousPolicy: 'chat' },
			{}
		]
	]);
});

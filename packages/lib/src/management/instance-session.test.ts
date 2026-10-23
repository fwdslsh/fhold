import { expect, test } from 'bun:test';
import { composeInstanceSession, rpcManagementBindings } from './instance-session.js';
import type { InstanceManagement, ManagedSnapshot } from './types.js';
import { defaultStackConfig } from '../control-plane/stack-config.js';
import { supportedOperation, unsupportedOperation } from './contracts.js';
import type { HostingSnapshot } from '../hosting/types.js';
import { mkdtempSync } from 'node:fs';
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
	expect(calls).toEqual([['recovery', { action: 'inspect' }]]);
});

test('a new local folder reaches the shared install view without requiring an installed host', async () => {
	const homeDir = join(mkdtempSync(join(tmpdir(), 'fhold-session-install-')), 'new-agent');
	const session = openInstanceSession(
		LOCAL_CONNECTION,
		{ kind: 'local-docker', connectionId: 'local', homeDir },
		{ setupName: 'new-agent' }
	);
	try {
		const snapshot = await session.inspect();
		expect(snapshot.lifecycle).toMatchObject({ state: 'known', value: 'not-installed' });
		expect(snapshot.docker?.config.deployment.projectName).toBe('new-agent');
		expect(snapshot.operations['docker.install']).toMatchObject({
			support: 'supported',
			availability: { state: 'ready' }
		});
		expect(snapshot.operations['host.start']).toMatchObject({
			support: 'supported',
			availability: { state: 'unavailable' }
		});
	} finally {
		await session.close();
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

test('an app-policy operation preserves unrelated host intent behind the retained SSH wire adapter', async () => {
	const config = defaultStackConfig();
	const writes: unknown[] = [];
	const manager: InstanceManagement = {
		call: async (method, value) => {
			if (method !== 'credential') throw new Error('Unexpected fixture operation.');
			writes.push(value);
			return undefined as never;
		},
		busy: () => false,
		close: async () => {}
	};
	const operation = rpcManagementBindings(manager, { credentialPolicy: true }).apps!.credentials
		.updatePolicy;
	if (operation.support !== 'supported') throw new Error('fixture');
	await operation.invoke(
		{ username: 'owner', policy: 'read', previousPolicy: config.credentials.owner.policy },
		{}
	);
	expect(writes).toHaveLength(1);
	expect(writes[0]).toEqual({
		action: 'policy',
		username: 'owner',
		policy: 'read',
		previousPolicy: config.credentials.owner.policy
	});
});

test('the retained RPC boundary translates canonical confirmation only for legacy wire calls', async () => {
	const calls: Array<[string, unknown]> = [];
	const manager: InstanceManagement = {
		call: async (method, value) => {
			calls.push([method, value]);
			return {} as never;
		},
		busy: () => false,
		close: async () => {}
	};
	const bindings = rpcManagementBindings(manager);
	const { backup, restoreInstance } = bindings.data!;
	const { remote, codexRecall } = bindings.agent!;
	for (const operation of [backup, restoreInstance, remote, codexRecall])
		if (operation.support !== 'supported') throw new Error('fixture');
	await backup.invoke({ destination: '/operator/export', full: true }, { confirmed: true });
	await restoreInstance.invoke(
		{ sourceHome: '/operator/export', apply: true, previewDigest: 'reviewed-preview' },
		{ confirmed: true }
	);
	await remote.invoke({ action: 'enable', tool: 'codex', trusted: true }, { confirmed: true });
	await codexRecall.invoke({ action: 'approve', digest: 'reviewed-hooks' }, { confirmed: true });
	expect(calls).toEqual([
		['backup', { destination: '/operator/export', full: true, confirmed: true }],
		[
			'restoreInstance',
			{
				sourceHome: '/operator/export',
				apply: true,
				previewDigest: 'reviewed-preview',
				confirmed: true
			}
		],
		['remote', { action: 'enable', tool: 'codex', trusted: true, restartConfirmed: true }],
		['codexRecall', { action: 'approve', digest: 'reviewed-hooks', confirmed: true }]
	]);
});

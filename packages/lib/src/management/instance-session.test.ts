import { expect, test } from 'bun:test';
import { composeInstanceSession, legacyManagementBindings } from './instance-session.js';
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
		inspectApps: async () => {
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
	expect(snapshot.lifecycle).toMatchObject({ state: 'known', value: 'externally-managed' });
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
	const bindings = legacyManagementBindings(manager, {
		passiveSnapshot: async () => managed(origin)
	});
	const inspect = bindings.inspectManagement!;
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
		inspectManagement: async () => {
			snapshots += 1;
			throw new Error('remote snapshot unavailable');
		},
		inspectAgent: async () => {
			snapshots += 1;
			return {};
		},
		inspectLifecycle: async () => {
			snapshots += 1;
			return { state: 'known', value: 'ready', observedAt: 'synthetic' };
		},
		inspectApps: async () => {
			snapshots += 1;
			return {
				config: { state: 'not-inspected', reason: 'not needed' },
				status: { state: 'not-inspected', reason: 'not needed' }
			};
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
			if (method === 'snapshot') return { config } as never;
			if (method !== 'saveConfig') throw new Error('Unexpected fixture operation.');
			writes.push(value);
			return undefined as never;
		},
		busy: () => false,
		close: async () => {}
	};
	const operation = legacyManagementBindings(manager).apps!.credentials.updatePolicy;
	if (operation.support !== 'supported') throw new Error('fixture');
	const original = structuredClone(config);
	await operation.invoke(
		{ username: 'owner', policy: 'read', previousPolicy: config.credentials.owner.policy },
		{}
	);
	expect(writes).toHaveLength(1);
	expect(writes[0]).toEqual({
		config: {
			...original,
			credentials: {
				...original.credentials,
				owner: { ...original.credentials.owner, policy: 'read' }
			}
		},
		baseConfig: original
	});
	await expect(
		operation.invoke({ username: 'owner', policy: 'chat', previousPolicy: 'read' }, {})
	).rejects.toThrow('permissions changed');
	expect(writes).toHaveLength(1);
});

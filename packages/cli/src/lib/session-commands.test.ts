import { expect, test } from 'bun:test';
import {
	capabilities,
	composeInstanceSession,
	supportedOperation,
	unsupportedOperation,
	type HostingSnapshot
} from '@fhold/lib';
import { runSessionConnectCommand } from './session-connect-command.js';
import { runSessionDataCommand } from './session-data-command.js';

function fixture() {
	const observed: HostingSnapshot = {
		ref: { kind: 'azure-container-apps', connectionId: 'cloud', resourceId: '/resource' },
		name: 'agent',
		location: '/resource',
		services: [],
		warnings: [],
		capabilities: capabilities([]),
		clientUrl: 'https://agent.example.test'
	};
	let inspections = 0;
	const inspect = async () => {
		inspections++;
		return observed;
	};
	const session = composeInstanceSession({
		ref: observed.ref,
		host: {
			inspect: supportedOperation(inspect),
			start: unsupportedOperation('no lifecycle'),
			stop: unsupportedOperation('no lifecycle'),
			restart: unsupportedOperation('no lifecycle'),
			logs: unsupportedOperation('no logs'),
			console: unsupportedOperation('no console')
		},
		inspectHost: inspect
	});
	return { session, observed, inspections: () => inspections };
}

test('a public link prints without native sign-in, waking, or a session lifetime', async () => {
	const f = fixture();
	f.session.agent.connect = supportedOperation(
		async () => {
			throw Error('must not acquire native access');
		},
		undefined,
		{ requiresPassword: true }
	);
	const output: string[] = [];
	await runSessionConnectCommand(
		f.session,
		['opencode', '--json'],
		(text) => output.push(text),
		async () => {
			throw Error('must not wait');
		}
	);
	expect(JSON.parse(output[0]!)).toMatchObject({ url: 'https://agent.example.test' });
	expect(f.inspections()).toBe(1);
});

test('explicit route acquisition retains the composed session and uses observed connection details', async () => {
	const f = fixture();
	delete f.observed.clientUrl;
	let acquired = false,
		waited = false;
	f.session.agent.connect = supportedOperation(async () => {
		acquired = true;
		return { endpoint: 'http://127.0.0.1:40001', sessionBound: true };
	});
	const inspect = f.session.inspect.bind(f.session);
	f.session.inspect = async () => ({
		...(await inspect()),
		apps: {
			config: { state: 'not-inspected', reason: 'not used' },
			status: { state: 'not-inspected', reason: 'not used' },
			connections: {
				state: 'known',
				observedAt: '2026-10-22T00:00:00Z',
				value: acquired
					? {
							opencode: {
								url: 'http://127.0.0.1:40001',
								username: 'custom-user',
								note: 'native route'
							}
						}
					: {}
			}
		}
	});
	const output: string[] = [];
	await runSessionConnectCommand(
		f.session,
		['opencode', '--json'],
		(text) => output.push(text),
		async () => {
			waited = true;
		}
	);
	expect(acquired).toBe(true);
	expect(waited).toBe(true);
	expect(JSON.parse(output[0]!)).toMatchObject({
		url: 'http://127.0.0.1:40001',
		username: 'custom-user'
	});
});

test('an already public passwordless link does not acquire a native route either', async () => {
	const f = fixture();
	f.session.agent.connect = supportedOperation(async () => {
		throw Error('must not acquire');
	});
	await runSessionConnectCommand(
		f.session,
		['opencode', '--json'],
		() => {},
		async () => {
			throw Error('must not retain');
		}
	);
	expect(f.inspections()).toBe(1);
});

test('native connection results remain usable before optional public-link observations refresh', async () => {
	const f = fixture();
	delete f.observed.clientUrl;
	f.session.agent.connect = supportedOperation(async () => ({
		endpoint: 'http://127.0.0.1:40002',
		username: 'native-user'
	}));
	const output: string[] = [];
	await runSessionConnectCommand(f.session, ['opencode', '--json'], (text) => output.push(text));
	expect(JSON.parse(output[0]!)).toMatchObject({
		url: 'http://127.0.0.1:40002',
		username: 'native-user'
	});
});

test('shared archive operations receive caller paths and confirmation only in context', async () => {
	const f = fixture();
	const calls: unknown[] = [];
	f.session.data.backup = supportedOperation(async (input, context) => {
		calls.push([input, context]);
		return {
			product: 'fhold',
			version: 1,
			scope: 'instance',
			createdAt: '2026-10-22',
			sourceHome: '/remote/agent',
			projectName: 'agent',
			files: [],
			totalBytes: 0,
			omittedPaths: [],
			warnings: []
		};
	});
	await runSessionDataCommand(
		f.session,
		['backup', '--to=/local/export', '--full', '--confirm-stopped', '--includeProviderAuth'],
		() => {}
	);
	expect(calls).toEqual([
		[
			{
				destination: '/local/export',
				full: true,
				includeProviderAuth: true,
				includeUserEnv: false,
				includePortalMaps: false,
				includeOAuth: false
			},
			{ confirmed: true }
		]
	]);
	expect(f.inspections()).toBe(1);
});

test('shared full restore applies exactly its preview digest through the same operation', async () => {
	const f = fixture();
	const calls: unknown[] = [];
	f.session.data.restoreInstance = supportedOperation(async (input, context) => {
		calls.push([input, context]);
		return {
			scope: 'instance',
			sourceHome: input.sourceHome,
			destinationHome: '/remote/agent',
			projectName: 'agent',
			copyCount: 0,
			totalBytes: 0,
			warnings: [],
			omittedPaths: [],
			digest: 'verified-preview'
		};
	});
	await runSessionDataCommand(
		f.session,
		['restore', '--from', '/local/export', '--full', '--apply', '--confirm-stopped'],
		() => {}
	);
	expect(calls).toHaveLength(2);
	expect(calls[1]).toEqual([
		{
			sourceHome: '/local/export',
			includeProviderAuth: false,
			includeUserEnv: false,
			includePortalMaps: false,
			includeOAuth: false,
			acknowledgeUnrestored: false,
			apply: true,
			previewDigest: 'verified-preview'
		},
		{ confirmed: true }
	]);
});

test('unsupported operations and malformed archive arguments never run a data adapter', async () => {
	const f = fixture();
	await expect(
		runSessionDataCommand(f.session, ['backup', '--to', '/unused'], () => {})
	).rejects.toThrow('not configured');
	for (const args of [
		['backup', '--to', '/unused', '--typo'],
		['restore', '--from', '/unused', 'extra'],
		['backup']
	])
		await expect(runSessionDataCommand(f.session, args, () => {})).rejects.toThrow();
});

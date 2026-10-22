import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	composeInstanceSession,
	capabilities,
	supportedOperation,
	unsupportedOperation,
	type AgentOperations
} from '@fhold/lib';
import { runSessionProviderCommand } from './session-provider-command.js';

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'fhold-provider-command-'));
	const password = join(root, 'password');
	writeFileSync(password, 'synthetic-native-password\n', { mode: 0o600 });
	const key = join(root, 'key');
	writeFileSync(key, 'synthetic-provider-key\n', { mode: 0o600 });
	const calls: unknown[] = [],
		output: string[] = [];
	const ref = {
		kind: 'azure-container-apps' as const,
		connectionId: 'cloud',
		resourceId: '/synthetic/agent'
	};
	const inspect = async () => ({
		ref,
		name: 'agent',
		location: '/synthetic/agent',
		capabilities: capabilities([]),
		services: [],
		warnings: []
	});
	const agent: Partial<AgentOperations> = {
		connect: supportedOperation(
			async (input) => {
				calls.push(['connect', input]);
				return { endpoint: 'https://agent.example.test' };
			},
			undefined,
			{ requiresPassword: true }
		),
		providers: supportedOperation(async () => ({
			providers: [
				{
					id: 'example',
					name: 'Example',
					source: 'native',
					modelCount: 1,
					connected: true,
					authenticated: true,
					authMethods: [{ index: 2, type: 'oauth', label: 'Sign in' }]
				}
			]
		})),
		setKey: supportedOperation(async (input) => {
			calls.push(['key', input]);
		}),
		oauthStart: supportedOperation(async (input) => {
			calls.push(['start', input]);
			return {
				attemptID: 'private-attempt',
				url: 'https://provider.example.test/login',
				method: 'code',
				instructions: 'Complete sign-in'
			};
		}),
		oauthFinish: supportedOperation(async (input) => {
			calls.push(['finish', input]);
		}),
		readiness: supportedOperation(async () => ({ ok: true, response: 'FH_READY' }))
	};
	const unavailable = () => unsupportedOperation<void, never>('Not configured.');
	const session = composeInstanceSession({
		ref,
		inspectHost: inspect,
		agent,
		host: {
			inspect: supportedOperation(inspect),
			start: unavailable(),
			stop: unavailable(),
			restart: unavailable(),
			logs: supportedOperation(async () => ''),
			console: unavailable()
		}
	});
	return {
		session,
		password,
		key,
		calls,
		output,
		run: (args: string[]) =>
			runSessionProviderCommand(
				session,
				args,
				(text) => output.push(text),
				async () => 'code#state'
			)
	};
}
test('native account commands require explicit access and never print private inputs', async () => {
	const f = fixture();
	await expect(f.run(['list'])).rejects.toThrow('--password-file');
	expect(f.calls).toEqual([]);
	await f.run(['key', 'example', '--password-file', f.password, '--key-file', f.key]);
	expect(f.calls).toEqual([
		['connect', { password: 'synthetic-native-password' }],
		['key', { provider: 'example', key: 'synthetic-provider-key' }]
	]);
	expect(f.output.join('\n')).not.toContain('synthetic-');
	await f.session.close();
});
test('OAuth stays in one selected session and preserves the whole code', async () => {
	const f = fixture();
	await f.run(['login', 'example', '--password-file', f.password]);
	expect(f.calls.slice(1)).toEqual([
		['start', { provider: 'example', method: 2 }],
		['finish', { provider: 'example', method: 2, code: 'code#state' }]
	]);
	expect(f.output.join('\n')).not.toContain('code#state');
	await f.session.close();
});
test('invalid inputs do not wake or mutate the selected agent', async () => {
	const f = fixture();
	for (const args of [
		['list', 'unexpected'],
		['key', 'example'],
		['test', '--model', 'missing-provider'],
		['key', 'example', '--password-file', '-', '--key-file', '-'],
		['login', 'example', '--method', 'bad']
	])
		await expect(f.run(args)).rejects.toThrow();
	expect(f.calls).toEqual([]);
	await f.session.close();
});

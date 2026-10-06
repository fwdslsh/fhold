import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	beginProviderOAuth,
	completeProviderOAuth,
	configureGuardianModeratorModel,
	listProviders,
	removeProviderAuth,
	setProviderApiKey,
	testAssistantReadiness
} from './opencode.js';
import { defaultStackConfig, writeStackConfig } from './stack-config.js';

const homes: string[] = [];

const agentModel = {
	id: 'sonnet',
	capabilities: {
		toolcall: true,
		input: { text: true },
		output: { text: true }
	}
};

function home(): string {
	const root = mkdtempSync(join(tmpdir(), 'fhold-opencode-'));
	homes.push(root);
	mkdirSync(join(root, 'state', 'secrets'), { recursive: true });
	mkdirSync(join(root, 'knowledge', 'secrets'), { recursive: true });
	mkdirSync(join(root, 'config', 'guardian'), { recursive: true });
	writeStackConfig(root, defaultStackConfig());
	writeFileSync(join(root, 'state', 'secrets', 'fhold_opencode_password'), 'password\n');
	writeFileSync(
		join(root, 'knowledge', 'secrets', 'auth.json'),
		'{"anthropic":{"type":"api","key":"synthetic-test-key"}}\n'
	);
	writeFileSync(
		join(root, 'config', 'guardian', 'opencode.json'),
		'{\n  "$schema": "https://opencode.ai/config.json",\n  "model": "opencode/big-pickle"\n}\n'
	);
	return root;
}

afterEach(() => {
	for (const root of homes.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('OpenCode setup client', () => {
	it('lists providers without exposing credential values', async () => {
		const root = home();
		const fakeFetch = (async (input: RequestInfo | URL) => {
			const path = new URL(String(input)).pathname;
			if (path === '/provider') {
				return Response.json({
					all: [{ id: 'anthropic', name: 'Anthropic', source: 'api', models: { sonnet: {} } }],
					default: { anthropic: 'sonnet' },
					connected: ['anthropic']
				});
			}
			if (path === '/provider/auth') {
				return Response.json({
					anthropic: [
						{ type: 'api', label: 'API key' },
						{
							type: 'oauth',
							label: 'Browser',
							prompts: [
								{
									type: 'select',
									key: 'account',
									message: 'Choose account',
									options: [{ label: 'Personal', value: 'personal' }]
								}
							]
						}
					]
				});
			}
			throw new Error(`unexpected ${path}`);
		}) as typeof fetch;
		expect(await listProviders(root, { fetch: fakeFetch })).toEqual([
			{
				id: 'anthropic',
				name: 'Anthropic',
				source: 'api',
				modelCount: 1,
				defaultModel: 'sonnet',
				connected: true,
				authenticated: true,
				authMethods: [
					{ index: 0, type: 'api', label: 'API key' },
					{
						index: 1,
						type: 'oauth',
						label: 'Browser',
						prompts: [
							{
								type: 'select',
								key: 'account',
								message: 'Choose account',
								options: [{ label: 'Personal', value: 'personal' }]
							}
						]
					}
				]
			}
		]);
	});

	it('offers native API-key auth for catalog providers without a custom auth plugin', async () => {
		const root = home();
		const fakeFetch = (async (input: RequestInfo | URL) => {
			if (new URL(String(input)).pathname === '/provider/auth') return Response.json({});
			return Response.json({
				all: [{ id: 'opencode-go', name: 'OpenCode Go', models: { 'glm-5': {} } }],
				default: { 'opencode-go': 'glm-5' },
				connected: []
			});
		}) as typeof fetch;
		expect((await listProviders(root, { fetch: fakeFetch }))[0]?.authMethods).toEqual([
			{ index: 0, type: 'api', label: 'API key' }
		]);
	});

	it('keeps native catalog availability separate from a stored account sign-in', async () => {
		const root = home();
		const fakeFetch = (async (input: RequestInfo | URL) => {
			if (new URL(String(input)).pathname === '/provider/auth') return Response.json({});
			return Response.json({
				all: [
					{ id: 'opencode', name: 'OpenCode', source: 'custom', models: { free: agentModel } },
					{
						id: 'environment-only',
						name: 'Environment only',
						source: 'env',
						models: { text: agentModel }
					},
					{ id: 'anthropic', name: 'Anthropic', source: 'api', models: { sonnet: agentModel } }
				],
				connected: ['opencode', 'environment-only', 'anthropic']
			});
		}) as typeof fetch;
		const summaries = await listProviders(root, { fetch: fakeFetch });
		for (const id of ['opencode', 'environment-only']) {
			expect(summaries.find((provider) => provider.id === id)).toMatchObject({
				connected: true,
				authenticated: false
			});
		}
		expect(summaries.find((provider) => provider.id === 'anthropic')?.authenticated).toBe(true);
		expect(JSON.stringify(summaries)).not.toContain('synthetic-test-key');
	});

	it('does not treat malformed or empty native auth entries as saved sign-ins', async () => {
		const root = home();
		const auth = {
			'api-empty': { type: 'api', key: '' },
			'api-missing': { type: 'api' },
			'oauth-empty': { type: 'oauth', access: '', refresh: '' },
			'unknown-type': { type: 'custom', key: 'synthetic-unknown-key' },
			'api-valid': { type: 'api', key: 'synthetic-api-key' },
			'oauth-valid': {
				type: 'oauth',
				access: 'synthetic-access-token',
				refresh: 'synthetic-refresh-token',
				expires: 1
			}
		};
		writeFileSync(join(root, 'knowledge', 'secrets', 'auth.json'), JSON.stringify(auth));
		const fakeFetch = (async (input: RequestInfo | URL) => {
			if (new URL(String(input)).pathname === '/provider/auth') return Response.json({});
			return Response.json({
				all: Object.keys(auth).map((id) => ({ id, name: id, models: {} })),
				connected: Object.keys(auth)
			});
		}) as typeof fetch;
		const summaries = await listProviders(root, { fetch: fakeFetch });
		expect(
			summaries.filter((provider) => provider.authenticated).map((provider) => provider.id)
		).toEqual(['api-valid', 'oauth-valid']);
		expect(JSON.stringify(summaries)).not.toContain('synthetic-');
	});

	it('starts and completes the native OpenCode OAuth flow', async () => {
		const root = home();
		const calls: Array<{ path: string; body: unknown }> = [];
		const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			const path = new URL(request.url).pathname;
			calls.push({ path, body: init?.body ? await request.json() : undefined });
			if (path.endsWith('/oauth/authorize')) {
				return Response.json({
					url: 'https://provider.example/sign-in',
					method: 'code',
					instructions: 'Paste the code after signing in.'
				});
			}
			if (path.endsWith('/oauth/callback')) return Response.json(true);
			if (path === '/instance/dispose') return Response.json(true);
			throw new Error(`unexpected ${path}`);
		}) as typeof fetch;

		expect(
			await beginProviderOAuth(root, 'anthropic', 1, { account: 'personal' }, { fetch: fakeFetch })
		).toEqual({
			url: 'https://provider.example/sign-in',
			method: 'code',
			instructions: 'Paste the code after signing in.'
		});
		await completeProviderOAuth(root, 'anthropic', 1, 'oauth-code', { fetch: fakeFetch });
		expect(calls).toEqual([
			{
				path: '/provider/anthropic/oauth/authorize',
				body: { method: 1, inputs: { account: 'personal' } }
			},
			{
				path: '/provider/anthropic/oauth/callback',
				body: { method: 1, code: 'oauth-code' }
			},
			{ path: '/instance/dispose', body: undefined }
		]);
	});

	it('accepts the current large provider catalog without relaxing other response limits', async () => {
		const root = home();
		const largeValue = 'x'.repeat(3 * 1024 * 1024);
		const providerFetch = (async (input: RequestInfo | URL) => {
			const path = new URL(String(input)).pathname;
			if (path === '/provider') {
				return Response.json({
					all: [{ id: 'large', name: 'Large', source: 'api', models: { model: { largeValue } } }],
					connected: []
				});
			}
			if (path === '/provider/auth') return Response.json({});
			throw new Error(`unexpected ${path}`);
		}) as typeof fetch;
		expect((await listProviders(root, { fetch: providerFetch }))[0]?.id).toBe('large');

		const oversizedAuthFetch = (async () => Response.json({ largeValue })) as typeof fetch;
		await expect(
			setProviderApiKey(root, 'anthropic', 'secret-value', { fetch: oversizedAuthFetch })
		).rejects.toThrow('size limit');
	});

	it('sets an API key through authenticated OpenCode without logging it', async () => {
		const root = home();
		const requests: Request[] = [];
		const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push(new Request(input, init));
			return Response.json(true);
		}) as typeof fetch;
		await setProviderApiKey(root, 'anthropic', 'secret-value', { fetch: fakeFetch });
		const request = requests[0];
		expect(request?.url).toEndWith('/auth/anthropic');
		expect(request?.headers.get('authorization')).toStartWith('Basic ');
		expect(await request?.json()).toEqual({ type: 'api', key: 'secret-value' });
		expect(requests[1]?.url).toEndWith('/instance/dispose');
	});

	it('removes only the selected native account and refreshes its provider instance', async () => {
		const root = home();
		const calls: Array<{ method: string; path: string; body?: string }> = [];
		const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			calls.push({ method: request.method, path: new URL(request.url).pathname });
			expect(request.headers.get('authorization')).toStartWith('Basic ');
			return Response.json(true);
		}) as typeof fetch;
		await removeProviderAuth(root, 'anthropic', { fetch: fakeFetch });
		expect(calls).toEqual([
			{ method: 'DELETE', path: '/auth/anthropic' },
			{ method: 'POST', path: '/instance/dispose' }
		]);
		expect(readFileSync(join(root, 'knowledge', 'secrets', 'auth.json'), 'utf8')).toContain(
			'synthetic-test-key'
		);
		await expect(
			removeProviderAuth(root, '../another-account', { fetch: fakeFetch })
		).rejects.toThrow('Invalid provider');
		expect(calls).toHaveLength(2);
	});

	it('performs a targeted no-tool request and retains the tested model when response metadata is absent', async () => {
		const root = home();
		const calls: string[] = [];
		const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			const path = new URL(request.url).pathname;
			calls.push(`${request.method} ${path}`);
			if (path === '/config') return Response.json({});
			if (path === '/provider') {
				return Response.json({
					default: { anthropic: 'sonnet' },
					all: [{ id: 'anthropic', models: { sonnet: agentModel } }]
				});
			}
			if (path === '/session' && request.method === 'POST') return Response.json({ id: 'ready-1' });
			if (path === '/session/ready-1/message') {
				expect(await request.json()).toMatchObject({
					model: { providerID: 'anthropic', modelID: 'sonnet' }
				});
				return Response.json({ parts: [{ type: 'text', text: 'FH_READY' }] });
			}
			if (path === '/session/ready-1' && request.method === 'DELETE') return Response.json(true);
			throw new Error(`unexpected ${request.method} ${path}`);
		}) as typeof fetch;

		expect(await testAssistantReadiness(root, { fetch: fakeFetch, provider: 'anthropic' })).toEqual(
			{
				ok: true,
				response: 'FH_READY',
				provider: 'anthropic',
				model: 'sonnet'
			}
		);
		expect(calls).toContain('DELETE /session/ready-1');
	});

	for (const [defaultId, incompatible] of [
		[
			'whisper',
			{
				id: 'whisper',
				capabilities: { toolcall: false, input: { audio: true }, output: { text: true } }
			}
		],
		[
			'embedding',
			{
				id: 'embedding',
				capabilities: { toolcall: false, input: { text: true }, output: { text: false } }
			}
		],
		[
			'plain-text',
			{
				id: 'plain-text',
				capabilities: { toolcall: false, input: { text: true }, output: { text: true } }
			}
		]
	] as const) {
		it(`does not use the native ${defaultId} default for agent readiness`, async () => {
			const root = home();
			const calls: string[] = [];
			const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init);
				const path = new URL(request.url).pathname;
				calls.push(`${request.method} ${path}`);
				if (path === '/config') return Response.json({});
				if (path === '/provider')
					return Response.json({
						default: { anthropic: defaultId },
						all: [{ id: 'anthropic', models: { [defaultId]: incompatible, sonnet: agentModel } }]
					});
				if (path === '/session') return Response.json({ id: 'compatible' });
				if (path === '/session/compatible/message') {
					const body = await request.json();
					expect(body.model).toEqual({ providerID: 'anthropic', modelID: 'sonnet' });
					expect(body.agent).toBe('remote');
					expect(body.system).toContain('Do not use tools');
					return Response.json({ parts: [{ type: 'text', text: 'FH_READY' }] });
				}
				if (path === '/session/compatible' && request.method === 'DELETE')
					return Response.json(true);
				throw new Error(`unexpected ${request.method} ${path}`);
			}) as typeof fetch;
			expect(
				await testAssistantReadiness(root, { fetch: fakeFetch, provider: 'anthropic' })
			).toMatchObject({
				ok: true,
				provider: 'anthropic',
				model: 'sonnet'
			});
			expect(calls).toContain('DELETE /session/compatible');
		});
	}

	it('fails without creating a session when the account has no agent-capable text model', async () => {
		const root = home();
		const calls: string[] = [];
		const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			const path = new URL(request.url).pathname;
			calls.push(`${request.method} ${path}`);
			if (path === '/config') return Response.json({});
			if (path === '/provider')
				return Response.json({
					default: { anthropic: 'whisper' },
					all: [
						{
							id: 'anthropic',
							models: {
								whisper: {
									capabilities: { toolcall: false, input: { audio: true }, output: { text: true } }
								}
							}
						}
					]
				});
			throw new Error(`readiness must not send ${request.method} ${path}`);
		}) as typeof fetch;
		const result = await testAssistantReadiness(root, { fetch: fakeFetch, provider: 'anthropic' });
		expect(result.ok).toBe(false);
		expect(calls).not.toContain('POST /session');
	});

	it('refuses an explicitly incompatible model before creating or billing a readiness session', async () => {
		const root = home();
		const calls: string[] = [];
		const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			const path = new URL(request.url).pathname;
			calls.push(`${request.method} ${path}`);
			if (path === '/config') return Response.json({ model: 'anthropic/sonnet' });
			if (path === '/provider')
				return Response.json({
					default: { anthropic: 'sonnet' },
					all: [
						{
							id: 'anthropic',
							models: {
								whisper: {
									capabilities: { toolcall: false, input: { audio: true }, output: { text: true } }
								},
								sonnet: agentModel
							}
						}
					]
				});
			throw new Error(`must not send ${request.method} ${path}`);
		}) as typeof fetch;
		const result = await testAssistantReadiness(root, {
			fetch: fakeFetch,
			provider: 'anthropic',
			model: 'whisper'
		});
		expect(result.ok).toBe(false);
		expect(calls).not.toContain('POST /session');
	});

	it('prefers the configured compatible model over the catalog default without provider-name heuristics', async () => {
		const root = home();
		const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			const path = new URL(request.url).pathname;
			if (path === '/config') return Response.json({ model: 'anthropic/private/team/model' });
			if (path === '/provider')
				return Response.json({
					default: { anthropic: 'sonnet' },
					all: [
						{
							id: 'anthropic',
							models: {
								sonnet: agentModel,
								'private/team/model': { ...agentModel, id: 'private/team/model' }
							}
						}
					]
				});
			if (path === '/session') return Response.json({ id: 'configured-model' });
			if (path === '/session/configured-model/message') {
				expect((await request.json()).model).toEqual({
					providerID: 'anthropic',
					modelID: 'private/team/model'
				});
				return Response.json({ parts: [{ type: 'text', text: 'FH_READY' }] });
			}
			if (path === '/session/configured-model' && request.method === 'DELETE')
				return Response.json(true);
			throw new Error(`unexpected ${request.method} ${path}`);
		}) as typeof fetch;
		expect(
			await testAssistantReadiness(root, { fetch: fakeFetch, provider: 'anthropic' })
		).toMatchObject({ ok: true, provider: 'anthropic', model: 'private/team/model' });
	});

	it('reports a structured provider failure instead of a missing readiness token', async () => {
		const root = home();
		const calls: string[] = [];
		const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			const path = new URL(request.url).pathname;
			calls.push(`${request.method} ${path}`);
			if (path === '/config') return Response.json({});
			if (path === '/session' && request.method === 'POST')
				return Response.json({ id: 'failed-1' });
			if (path === '/session/failed-1/message') {
				return Response.json({
					info: {
						providerID: 'example',
						modelID: 'example-model',
						error: {
							name: 'APIError',
							data: { message: 'Provider authentication is required', statusCode: 401 }
						}
					},
					parts: []
				});
			}
			if (path === '/session/failed-1' && request.method === 'DELETE') return Response.json(true);
			throw new Error(`unexpected ${request.method} ${path}`);
		}) as typeof fetch;

		expect(await testAssistantReadiness(root, { fetch: fakeFetch })).toEqual({
			ok: false,
			error: 'Provider authentication is required'
		});
		expect(calls).toContain('DELETE /session/failed-1');
	});

	it('pins only the untouched Guardian moderator default to the verified model', () => {
		const root = home();
		const path = join(root, 'config', 'guardian', 'opencode.json');

		expect(configureGuardianModeratorModel(root, 'anthropic', 'claude-sonnet')).toBe(true);
		expect(readFileSync(path, 'utf8')).toContain('"model": "anthropic/claude-sonnet"');
		expect(configureGuardianModeratorModel(root, 'anthropic', 'claude-opus')).toBe(false);
		expect(readFileSync(path, 'utf8')).toContain('"model": "anthropic/claude-sonnet"');
	});
});

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
	testAssistantReadiness,
	updateAssistantGlobalConfig
} from './opencode.js';
import { defaultStackConfig, writeStackConfig } from './stack-config.js';

const homes: string[] = [];
const agentModel = {
	id: 'sonnet',
	providerID: 'anthropic',
	name: 'Sonnet',
	capabilities: { tools: true, input: ['text'], output: ['text'] }
};

function home(): string {
	const root = mkdtempSync(join(tmpdir(), 'fhold-opencode-'));
	homes.push(root);
	for (const directory of ['state/secrets', 'config/guardian', 'config/assistant', 'knowledge/secrets'])
		mkdirSync(join(root, directory), { recursive: true });
	writeStackConfig(root, defaultStackConfig());
	writeFileSync(join(root, 'state/secrets/fhold_opencode_password'), 'synthetic-password\n');
	writeFileSync(join(root, 'config/assistant/opencode.json'), '{}\n');
	writeFileSync(join(root, 'config/guardian/opencode.json'), '{ "model": "opencode/big-pickle" }\n');
	return root;
}

afterEach(() => {
	for (const root of homes.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Public v2 response shapes. These unit fixtures do not claim vendor readiness.
function nativeFixture() {
	const calls: Array<{ request: Request; body: unknown }> = [];
	const providers: Record<string, unknown>[] = [{ id: 'anthropic', name: 'Anthropic' }];
	const integrations: Record<string, unknown>[] = [{
		id: 'anthropic', name: 'Anthropic',
		methods: [{ type: 'key', label: 'API key' }, {
			type: 'oauth', id: 'browser', label: 'Browser',
			form: [{ type: 'string', key: 'account', title: 'Choose account', options: [{ label: 'Personal', value: 'personal' }] }]
		}],
		connections: [{ type: 'credential', id: 'cred-anthropic', label: 'Saved account', method: 'key' }]
	}];
	const models: Record<string, unknown>[] = [agentModel];
	const credentials: Record<string, unknown>[] = [{
		id: 'cred-anthropic', integrationID: 'anthropic', value: { type: 'key', key: 'synthetic-secret' }
	}];
	const state = {
		providers, integrations, models, credentials,
		preferred: { providerID: 'anthropic', id: 'sonnet' } as Record<string, unknown> | null,
		generation: new Response(JSON.stringify({ data: { text: 'FH_READY' } }), { headers: { 'content-type': 'application/json' } }),
		modelReads: 0,
		activationDelay: 0
	};
	const responses = new Map<string, () => Response>();
	const nativeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		const body: unknown = request.body ? await request.clone().json() : undefined;
		calls.push({ request, body });
		expect(request.headers.get('authorization')).toBe('Basic ' + Buffer.from('opencode:synthetic-password').toString('base64'));
		if (/^\/api\/(?:model|provider|integration|config)(?:\/|$)/.test(url.pathname))
			expect(url.searchParams.get('location[directory]')).toBe('/etc/opencode');
		const response = responses.get(url.pathname);
		if (response) return response();
		const data = (value: unknown) => Response.json({ data: value });
		if (url.pathname === '/api/info') return Response.json({ version: '2.0.26' });
		if (url.pathname === '/api/provider') return data(state.providers);
		if (url.pathname === '/api/integration') return data(state.integrations);
		if (url.pathname === '/api/integration/anthropic') return data(state.integrations[0]);
		if (url.pathname === '/api/model/default') return data(state.preferred);
		if (url.pathname === '/api/model') {
			state.modelReads++;
			return data(state.modelReads <= state.activationDelay ? [] : state.models);
		}
		if (url.pathname === '/api/credential') return data(state.credentials);
		if (url.pathname.startsWith('/api/credential/') && request.method === 'DELETE') return new Response(null, { status: 204 });
		if (url.pathname === '/api/integration/anthropic/connect/key') return new Response(null, { status: 204 });
		if (url.pathname === '/api/integration/anthropic/connect/oauth') return data({
			attemptID: 'attempt-1', url: 'https://provider.example/sign-in',
			mode: 'code', instructions: 'Paste the code after signing in.'
		});
		if (url.pathname === '/api/integration/anthropic/connect/oauth/attempt-1/complete')
			return new Response(null, { status: 204 });
		if (url.pathname === '/api/experimental/generate') return state.generation.clone();
		throw new Error('Unexpected native request: ' + request.method + ' ' + url.pathname);
	}) as typeof fetch;
	return { fetch: nativeFetch, calls, state, responses };
}

describe('Native OpenCode v2 setup', () => {
	it('lists native models and sign-in methods without exposing native credential values', async () => {
		const root = home();
		writeFileSync(join(root, 'knowledge/secrets/auth.json'), '{invalid legacy file');
		const native = nativeFixture();
		expect(await listProviders(root, native)).toEqual([{
			id: 'anthropic', name: 'Anthropic', source: 'native', configured: false,
			modelCount: 1, models: [{ id: 'sonnet', name: 'Sonnet' }],
			defaultModel: 'sonnet', disabled: false, connected: true, authenticated: true,
			authMethods: [
				{ index: 0, type: 'api', label: 'API key' },
				{ index: 1, type: 'oauth', label: 'Browser', prompts: [{
					type: 'select', key: 'account', message: 'Choose account', options: [{ label: 'Personal', value: 'personal' }]
				}] }
			]
		}]);
		expect(native.calls.every(({ request }) => request.method === 'GET')).toBe(true);
		expect(JSON.stringify(await listProviders(root, native))).not.toContain('synthetic-secret');
	});

	it('keeps catalog, ambient access and saved account status distinct', async () => {
		const root = home();
		const native = nativeFixture();
		native.state.providers.push({ id: 'ambient', name: 'Environment only' });
		native.state.integrations.push(
			{ id: 'catalog-only', name: 'Catalog only', methods: [{ type: 'key' }], connections: [] },
			{ id: 'ambient', name: 'Environment only', methods: [], connections: [{ type: 'env', name: 'AMBIENT_KEY' }] },
			{ id: 'expired', name: 'Expired saved account', methods: [], connections: [{ type: 'credential', id: 'old', status: { type: 'invalid' } }] }
		);
		const summaries = await listProviders(root, native);
		expect(summaries.find(item => item.id === 'catalog-only')).toMatchObject({ source: 'catalog', configured: false, connected: false, authenticated: false });
		expect(summaries.find(item => item.id === 'ambient')).toMatchObject({ connected: true, authenticated: false });
		expect(summaries.find(item => item.id === 'expired')).toMatchObject({ connected: false, authenticated: true });
		expect(summaries.find(item => item.id === 'catalog-only')?.authMethods).toEqual([{ index: 0, type: 'api', label: 'API key' }]);
	});

	it('uses native integration IDs for providers sharing an account', async () => {
		const root = home();
		const native = nativeFixture();
		native.state.providers[0] = { id: 'team-models', name: 'Team models', integrationID: 'anthropic' };
		await setProviderApiKey(root, 'team-models', 'synthetic-new-key', native);
		const post = native.calls.find(({ request }) => request.method === 'POST');
		expect(new URL(post?.request.url ?? '').pathname).toBe('/api/integration/anthropic/connect/key');
		expect(post?.body).toEqual({ key: 'synthetic-new-key' });
		expect(native.calls.some(({ request }) => /reload|dispose/.test(request.url))).toBe(false);
	});

	it('binds OAuth completion to its native attempt, not a method index', async () => {
		const root = home();
		const native = nativeFixture();
		expect(await beginProviderOAuth(root, 'anthropic', 1, { account: 'personal' }, native)).toEqual({
			attemptID: 'attempt-1', url: 'https://provider.example/sign-in',
			method: 'code', instructions: 'Paste the code after signing in.'
		});
		await completeProviderOAuth(root, 'anthropic', 'attempt-1', 'oauth-code', native);
		expect(native.calls.filter(({ request }) => request.method === 'POST').map(({ request, body }) => ({
			path: new URL(request.url).pathname, body
		}))).toEqual([
			{ path: '/api/integration/anthropic/connect/oauth', body: { methodID: 'browser', answer: { account: 'personal' } } },
			{ path: '/api/integration/anthropic/connect/oauth/attempt-1/complete', body: { code: 'oauth-code' } }
		]);
	});

	it('removes only credentials owned by the selected integration', async () => {
		const root = home();
		const native = nativeFixture();
		native.state.credentials.push({ id: 'cred-other', integrationID: 'other', value: { type: 'oauth', access: 'synthetic-other' } });
		await removeProviderAuth(root, 'anthropic', native);
		expect(native.calls.filter(({ request }) => request.method === 'DELETE').map(({ request }) => new URL(request.url).pathname)).toEqual(['/api/credential/cred-anthropic']);
		expect(native.calls.some(({ request }) => /reload|dispose/.test(request.url))).toBe(false);
		await expect(removeProviderAuth(root, '../other', native)).rejects.toThrow('Invalid provider');
	});

	it('bounds ordinary responses while accepting the native large catalog', async () => {
		const root = home();
		const native = nativeFixture();
		native.state.providers[0].metadata = { catalog: 'x'.repeat(3 * 1024 * 1024) };
		expect((await listProviders(root, native)).some(item => item.id === 'anthropic')).toBe(true);
		native.responses.set('/api/integration/anthropic/connect/key', () => Response.json({ message: 'x'.repeat(3 * 1024 * 1024) }));
		await expect(setProviderApiKey(root, 'anthropic', 'synthetic-new-key', native)).rejects.toThrow('size limit');
	});

	it('patches native JSONC fields without losing comments or unrelated settings', async () => {
		const root = home();
		const path = join(root, 'config/assistant/opencode.json');
		writeFileSync(path, '// Keep this comment\n{"shell":"/bin/bash","providers":{"team":{"settings":{"baseURL":"http://example/v1","headers":{"X-Team":"preserve"}}}}}\n');
		await updateAssistantGlobalConfig(root, { providers: { team: { settings: { baseURL: 'http://edited/v1' } } }, model: 'team/exact/model' });
		const text = readFileSync(path, 'utf8');
		expect(text).toContain('// Keep this comment');
		expect(text).toContain('X-Team');
		expect(text).toContain('/bin/bash');
		expect(text).toContain('http://edited/v1');
	});

	it('tests the exact selected model without tools, a session, reload, or default change', async () => {
		const root = home();
		const native = nativeFixture();
		native.state.models.push({ ...agentModel, id: 'team/exact/model' });
		expect(await testAssistantReadiness(root, { ...native, provider: 'anthropic', model: 'team/exact/model' })).toEqual({
			ok: true, response: 'FH_READY', provider: 'anthropic', model: 'team/exact/model'
		});
		expect(native.calls.filter(({ request }) => request.method !== 'GET').map(({ request, body }) => ({
			path: new URL(request.url).pathname, body
		}))).toEqual([{ path: '/api/experimental/generate', body: {
			prompt: 'Reply with exactly FH_READY.', model: { providerID: 'anthropic', id: 'team/exact/model' }
		} }]);
		expect(readFileSync(join(root, 'config/assistant/opencode.json'), 'utf8')).toBe('{}\n');
	});

	it('waits for native model activation without retrying an inference request', async () => {
		const root = home();
		const native = nativeFixture();
		native.state.activationDelay = 1;
		expect(await testAssistantReadiness(root, { ...native, provider: 'anthropic' })).toMatchObject({ ok: true });
		expect(native.state.modelReads).toBe(2);
		expect(native.calls.filter(({ request }) => request.method === 'POST')).toHaveLength(1);
	});

	for (const incompatible of [
		{ id: 'whisper', capabilities: { tools: false, input: ['audio'], output: ['text'] } },
		{ id: 'embedding', capabilities: { tools: false, input: ['text'], output: [] } },
		{ id: 'plain-text', capabilities: { tools: false, input: ['text'], output: ['text'] } },
		{ ...agentModel, id: 'retired', status: 'deprecated' }
	]) {
		it('excludes the incompatible ' + incompatible.id + ' model without guessing from its name', async () => {
			const root = home();
			const native = nativeFixture();
			native.state.models.push({ ...incompatible, providerID: 'anthropic' });
			native.state.preferred = { providerID: 'anthropic', id: incompatible.id };
			const providers = await listProviders(root, native);
			expect(providers[0].models?.map(model => model.id)).toEqual(['sonnet']);
			expect(await testAssistantReadiness(root, { ...native, provider: 'anthropic' })).toMatchObject({ ok: true, model: 'sonnet' });
			const before = native.calls.length;
			expect(await testAssistantReadiness(root, { ...native, provider: 'anthropic', model: incompatible.id, timeoutMs: 1 })).toMatchObject({ ok: false });
			expect(native.calls.slice(before).some(({ request }) => request.method !== 'GET')).toBe(false);
		});
	}

	it('reports native provider failures and never retries a billed request', async () => {
		const root = home();
		const native = nativeFixture();
		native.state.generation = Response.json({ message: 'Provider authentication is required' }, { status: 503 });
		expect(await testAssistantReadiness(root, native)).toEqual({ ok: false, error: 'Provider authentication is required' });
		expect(native.calls.filter(({ request }) => request.method === 'POST')).toHaveLength(1);
	});

	it('reports a missing readiness token honestly', async () => {
		const root = home();
		const native = nativeFixture();
		native.state.generation = Response.json({ data: { text: 'A different response' } });
		expect(await testAssistantReadiness(root, native)).toEqual({ ok: false, error: 'The provider responded, but the readiness token was missing' });
	});

	it('pins only the untouched Guardian placeholder to the verified model', () => {
		const root = home();
		const path = join(root, 'config/guardian/opencode.json');
		expect(configureGuardianModeratorModel(root, 'anthropic', 'team/exact/model')).toBe(true);
		expect(readFileSync(path, 'utf8')).toContain('"anthropic/team/exact/model"');
		expect(configureGuardianModeratorModel(root, 'anthropic', 'different')).toBe(false);
	});
});

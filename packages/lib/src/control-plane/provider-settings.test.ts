import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEdits, modify, parse } from 'jsonc-parser';

import { defaultStackConfig, writeStackConfig } from './stack-config.js';
import {
	listProviderSettings,
	discoverProviderModels,
	removeProviderSetup,
	saveProviderEndpoint,
	useProviderModel
} from './provider-settings.js';
import { testAssistantReadiness } from './opencode.js';

// Synthetic native HTTP contracts, not vendor readiness. Fixtures are retained:
// even a disposable home may acquire provider state during further qualification.
function fixture() {
	const home = mkdtempSync(join(tmpdir(), 'fhold-provider-settings-'));
	mkdirSync(join(home, 'state', 'secrets'), { recursive: true });
	mkdirSync(join(home, 'knowledge', 'secrets'), { recursive: true });
	mkdirSync(join(home, 'config', 'opencode'), { recursive: true });
	mkdirSync(join(home, 'config', 'assistant'), { recursive: true });
	mkdirSync(join(home, 'system', 'stack'), { recursive: true });
	writeFileSync(
		join(home, 'system', 'stack', 'stack.compose.yml'),
		readFileSync(
			join(import.meta.dir, '..', '..', '..', 'skeleton', 'system', 'stack', 'stack.compose.yml')
		)
	);
	writeStackConfig(home, defaultStackConfig());
	writeFileSync(join(home, 'state', 'secrets', 'fhold_opencode_password'), 'synthetic-password\n');
	writeFileSync(join(home, 'knowledge', 'secrets', 'auth.json'), '{}\n');
	const configPath = join(home, 'config', 'assistant', 'opencode.json');
	const configuration = {
		$schema: 'https://opencode.ai/config.json',
		model: 'existing/team/model',
		small_model: 'existing/small',
		permission: { '*': 'ask', read: 'allow' },
		plugin: ['operator-plugin'],
		provider: {
			existing: {
				npm: '@ai-sdk/openai-compatible',
				name: 'Existing operator provider',
				options: { baseURL: 'http://192.0.2.20:8080/v1', headers: { 'X-Operator': 'preserve' } },
				models: { 'team/model': { name: 'Existing model' }, small: {} }
			}
		}
	};
	writeFileSync(configPath, `${JSON.stringify(configuration, null, 2)}\n`);
	writeFileSync(join(home, 'config', 'opencode', 'opencode.json'), '{}\n');
	return { home, configPath, configuration };
}

const textModel = {
	id: 'text-model',
	name: 'Native text model',
	capabilities: { toolcall: true, input: { text: true }, output: { text: true } }
};

function readConfiguration(path: string): Record<string, unknown> {
	return parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function nativeFixture(home: string, configPath: string, override: Record<string, unknown> = {}) {
	const calls: Array<{ path: string; method: string; body?: unknown }> = [];
	const modelRequests: Array<{ model?: { providerID: string; modelID: string } }> = [];
	const authPath = join(home, 'knowledge', 'secrets', 'auth.json');
	// Match the native infinite global cache: host edits do not refresh it.
	// Only its settings API owns writing, invalidation and reloading.
	let cachedGlobal = readConfiguration(configPath);
	function patchJsonc(text: string, patch: Record<string, unknown>, path: string[] = []): string {
		for (const [key, value] of Object.entries(patch)) {
			if (value && typeof value === 'object' && !Array.isArray(value))
				text = patchJsonc(text, value as Record<string, unknown>, [...path, key]);
			else text = applyEdits(text, modify(text, [...path, key], value, {}));
		}
		return text;
	}
	const fetchNative = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const path = new URL(request.url).pathname;
		const body: unknown = init?.body ? await request.json() : undefined;
		calls.push({ path, method: request.method, ...(body === undefined ? {} : { body }) });
		if (path === '/global/config') {
			if (request.method === 'PATCH') {
				const text = patchJsonc(readFileSync(configPath, 'utf8'), body as Record<string, unknown>);
				writeFileSync(configPath, text);
				cachedGlobal = readConfiguration(configPath);
			}
			return Response.json(cachedGlobal);
		}
		const configuration = {
			...cachedGlobal,
			...readConfiguration(join(home, 'config', 'opencode', 'opencode.json')),
			...override
		};
		if (path === '/config') return Response.json(configuration);
		if (path === '/provider/auth') return Response.json({});
		if (path === '/provider') {
			const providers = configuration.provider as Record<
				string,
				{ name?: string; models?: Record<string, { name?: string }> }
			>;
			const disabled = configuration.disabled_providers as string[] | undefined;
			return Response.json({
				all: [
					{
						id: 'native-catalog',
						name: 'Native catalog',
						source: 'custom',
						models: {
							'text-model': textModel,
							whisper: {
								...textModel,
								capabilities: { ...textModel.capabilities, input: { audio: true } }
							},
							'deprecated-text': { ...textModel, status: 'deprecated' }
						}
					},
					...Object.entries(providers ?? {}).map(([id, provider]) => ({
						id,
						name: provider.name ?? id,
						source: 'config',
						models: Object.fromEntries(
							Object.entries(provider.models ?? {}).map(([model, value]) => [
								model,
								{ ...textModel, id: model, name: value.name ?? model }
							])
						)
					}))
				].filter((provider) => !disabled?.includes(provider.id)),
				connected: ['native-catalog', ...Object.keys(providers ?? {})].filter((id) => !disabled?.includes(id)),
				default: { 'native-catalog': 'whisper' }
			});
		}
		if (path.startsWith('/auth/')) {
			const id = decodeURIComponent(path.slice('/auth/'.length));
			const auth = readConfiguration(authPath);
			if (request.method === 'PUT') auth[id] = body;
			else if (request.method === 'DELETE') delete auth[id];
			else throw new Error(`Unexpected auth method ${request.method}`);
			writeFileSync(authPath, JSON.stringify(auth));
			return Response.json(true);
		}
		if (path === '/instance/dispose' && request.method === 'POST') return Response.json(true);
		if (path === '/session' && request.method === 'POST') return Response.json({ id: 'qa-check' });
		if (path === '/session/qa-check/message' && request.method === 'POST') {
			const message = body as { model?: { providerID: string; modelID: string } };
			modelRequests.push(message);
			return Response.json({
				info: { providerID: message.model?.providerID, modelID: message.model?.modelID },
				parts: [{ type: 'text', text: 'FH_READY' }]
			});
		}
		if (path === '/session/qa-check' && request.method === 'DELETE') return Response.json(true);
		throw new Error(`Unexpected native API request ${request.method} ${path}`);
	}) as typeof fetch;
	return { calls, modelRequests, fetch: fetchNative };
}

describe('Native provider manager settings', () => {
	it('reports the effective default and orphan saved credentials without calling models', async () => {
		const current = fixture();
		writeFileSync(
			join(current.home, 'knowledge', 'secrets', 'auth.json'),
			JSON.stringify({
				orphan: { type: 'api', key: 'synthetic-orphan-key' }
			})
		);
		const native = nativeFixture(current.home, current.configPath);
		const settings = await listProviderSettings(current.home, native);
		expect(settings.currentModel).toEqual({ provider: 'existing', model: 'team/model' });
		expect(settings.providers.find((provider) => provider.id === 'orphan')).toMatchObject({
			authenticated: true,
			models: [],
			connected: false
		});
		expect(settings.providers.find((provider) => provider.id === 'native-catalog')?.models).toEqual(
			[{ id: 'text-model', name: 'Native text model' }]
		);
		expect(settings.providers.find((provider) => provider.id === 'existing')).toMatchObject({
			configured: true,
			endpoint: { url: 'http://192.0.2.20:8080/v1', editable: true }
		});
		expect(native.modelRequests).toHaveLength(0);
		expect(JSON.stringify(settings)).not.toContain('synthetic-orphan-key');
	});

	for (const provider of ['ollama', 'lmstudio', 'llama.cpp', 'arbitrary-company']) {
		it(`saves ${provider} through native compatible configuration without testing or switching default`, async () => {
			const current = fixture();
			const native = nativeFixture(current.home, current.configPath);
			const settings = await saveProviderEndpoint(
				current.home,
				{
					provider,
					name: `${provider} endpoint`,
					url: 'http://192.0.2.30:1234/v1',
					model: 'team/selected-model'
				},
				native
			);
			const config = readConfiguration(current.configPath);
			expect(config.model).toBe(current.configuration.model);
			expect(config.permission).toEqual(current.configuration.permission);
			expect(config.plugin).toEqual(current.configuration.plugin);
			expect((config.provider as Record<string, unknown>).existing).toEqual(
				current.configuration.provider.existing
			);
			expect((config.provider as Record<string, unknown>)[provider]).toMatchObject({
				options: { baseURL: 'http://192.0.2.30:1234/v1' },
				models: { 'team/selected-model': {} }
			});
			expect(
				settings.providers.find((item) => item.id === provider)?.models?.map((item) => item.id)
			).toContain('team/selected-model');
			expect(native.modelRequests).toHaveLength(0);
			expect(native.calls.some((call) => call.path === '/session')).toBe(false);
			expect(native.calls.filter((call) => call.path === '/global/config' && call.method === 'PATCH')).toHaveLength(1);
			expect(native.calls.some((call) => call.path.includes('/dispose'))).toBe(false);
		});
	}

	it('updates one endpoint while preserving its unrelated native models/options and all other providers', async () => {
		const current = fixture();
		const native = nativeFixture(current.home, current.configPath);
		await saveProviderEndpoint(
			current.home,
			{
				provider: 'existing',
				name: 'Edited name',
				url: 'http://192.0.2.21:8090/v1',
				model: 'new/model'
			},
			native
		);
		const provider = (
			readConfiguration(current.configPath).provider as Record<string, Record<string, unknown>>
		).existing;
		expect(provider.options).toEqual({
			baseURL: 'http://192.0.2.21:8090/v1',
			headers: { 'X-Operator': 'preserve' }
		});
		expect(provider.models).toMatchObject({
			'team/model': { name: 'Existing model' },
			small: {},
			'new/model': {}
		});
		expect(readConfiguration(current.configPath).model).toBe('existing/team/model');
		expect(native.modelRequests).toHaveLength(0);
	});

	it('stores an optional endpoint key only through native auth, never inline in operator config', async () => {
		const current = fixture();
		const native = nativeFixture(current.home, current.configPath);
		await saveProviderEndpoint(
			current.home,
			{
				provider: 'keyed-custom',
				name: 'Keyed custom',
				url: 'http://192.0.2.30:1234/v1',
				model: 'text-model',
				key: 'synthetic-endpoint-key'
			},
			native
		);
		expect(readFileSync(current.configPath, 'utf8')).not.toContain('synthetic-endpoint-key');
		expect(
			readConfiguration(join(current.home, 'knowledge', 'secrets', 'auth.json'))['keyed-custom']
		).toEqual({ type: 'api', key: 'synthetic-endpoint-key' });
		expect(native.calls.find((call) => call.path === '/auth/keyed-custom')).toMatchObject({
			method: 'PUT'
		});
		expect(native.modelRequests).toHaveLength(0);
	});

	it('changes the default only through explicit Use and retains unrelated operator intent', async () => {
		const current = fixture();
		const native = nativeFixture(current.home, current.configPath);
		const settings = await useProviderModel(current.home, 'native-catalog', 'text-model', native);
		expect(settings.currentModel).toEqual({ provider: 'native-catalog', model: 'text-model' });
		expect(readConfiguration(current.configPath)).toEqual({
			...current.configuration,
			model: 'native-catalog/text-model'
		});
		expect(native.modelRequests).toHaveLength(0);
	});

	it('tests the exact chosen model without changing the active default', async () => {
		const current = fixture();
		const native = nativeFixture(current.home, current.configPath);
		expect(
			await testAssistantReadiness(current.home, {
				...native,
				provider: 'existing',
				model: 'small'
			})
		).toMatchObject({ ok: true, provider: 'existing', model: 'small' });
		expect(native.modelRequests.map((request) => request.model)).toEqual([
			{ providerID: 'existing', modelID: 'small' }
		]);
		expect(readConfiguration(current.configPath)).toEqual(current.configuration);
		expect(native.calls.at(-1)).toMatchObject({ path: '/session/qa-check', method: 'DELETE' });
	});

	it('removes only selected saved auth, preserving endpoint, default, and another account', async () => {
		const current = fixture();
		current.configuration.model = 'native-catalog/text-model';
		writeFileSync(current.configPath, JSON.stringify(current.configuration));
		const authPath = join(current.home, 'knowledge', 'secrets', 'auth.json');
		const other = {
			type: 'oauth',
			access: 'synthetic-other-access',
			refresh: 'synthetic-other-refresh'
		};
		writeFileSync(
			authPath,
			JSON.stringify({ existing: { type: 'api', key: 'synthetic-existing' }, other })
		);
		const native = nativeFixture(current.home, current.configPath);
		await removeProviderSetup(current.home, 'existing', native);
		expect(readConfiguration(authPath)).toEqual({ other });
		expect(readConfiguration(current.configPath)).toEqual(current.configuration);
		expect(
			native.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)
		).toEqual(['/auth/existing']);
		expect(native.modelRequests).toHaveLength(0);
	});

	it('disables one custom endpoint without deleting its definition or altering another provider/default', async () => {
		const current = fixture();
		const native = nativeFixture(current.home, current.configPath);
		await saveProviderEndpoint(
			current.home,
			{
				provider: 'remove-me',
				name: 'Remove me',
				url: 'http://192.0.2.50:1234/v1',
				model: 'text-model'
			},
			native
		);
		const saved = readConfiguration(current.configPath);
		const settings = await removeProviderSetup(current.home, 'remove-me', { ...native, endpoint: true });
		expect(readConfiguration(current.configPath)).toEqual({ ...saved, disabled_providers: ['remove-me'] });
		expect(settings.providers.find((provider) => provider.id === 'remove-me')).toMatchObject({
			disabled: true, connected: false, models: [], endpoint: { editable: true }
		});
		expect(native.modelRequests).toHaveLength(0);
	});

	it('does not remove a current default setup before the operator chooses another model', async () => {
		const current = fixture();
		const native = nativeFixture(current.home, current.configPath);
		await expect(
			removeProviderSetup(current.home, 'existing', { ...native, endpoint: true })
		).rejects.toThrow(/another model/i);
		expect(readConfiguration(current.configPath)).toEqual(current.configuration);
		expect(native.calls.some((call) => call.method === 'DELETE')).toBe(false);
	});

	it('disabling an endpoint preserves its definition and separate saved sign-in', async () => {
		const current = fixture();
		const native = nativeFixture(current.home, current.configPath);
		const authPath = join(current.home, 'knowledge', 'secrets', 'auth.json');
		await saveProviderEndpoint(
			current.home,
			{
				provider: 'endpoint-only',
				name: 'Endpoint only',
				url: 'http://192.0.2.50:1234/v1',
				model: 'text-model'
			},
			native
		);
		const account = { type: 'api', key: 'synthetic-preserved-account' };
		writeFileSync(authPath, JSON.stringify({ 'endpoint-only': account }));
		const saved = readConfiguration(current.configPath);
		await removeProviderSetup(current.home, 'endpoint-only', { ...native, endpoint: true });
		expect(readConfiguration(authPath)).toEqual({ 'endpoint-only': account });
		expect(readConfiguration(current.configPath)).toEqual({ ...saved, disabled_providers: ['endpoint-only'] });
	});

	it('refuses an incompatible explicit default before writing or invoking a model', async () => {
		const current = fixture();
		const native = nativeFixture(current.home, current.configPath);
		await expect(
			useProviderModel(current.home, 'native-catalog', 'whisper', native)
		).rejects.toThrow();
		expect(readConfiguration(current.configPath)).toEqual(current.configuration);
		expect(native.modelRequests).toHaveLength(0);
	});

	it('reports operator policy overrides instead of silently overwriting them', async () => {
		const current = fixture();
		const native = nativeFixture(current.home, current.configPath);
		const operatorPath = join(current.home, 'config', 'opencode', 'opencode.json');
		const operator = { model: 'existing/team/model', permission: { '*': 'deny' } };
		writeFileSync(operatorPath, JSON.stringify(operator));
		await expect(
			useProviderModel(current.home, 'native-catalog', 'text-model', native)
		).rejects.toThrow();
		expect(readConfiguration(operatorPath)).toEqual(operator);
		expect(readConfiguration(current.configPath)).toEqual(current.configuration);
		expect(native.modelRequests).toHaveLength(0);
	});

	it('preserves native JSONC comments and unrelated values when changing only the model', async () => {
		const current = fixture();
		current.configPath = join(current.home, 'config/assistant/opencode.jsonc');
		const original = `// Operator comment must survive\n${JSON.stringify(current.configuration, null, 2)}\n`;
		writeFileSync(current.configPath, original);
		const native = nativeFixture(current.home, current.configPath);
		await useProviderModel(current.home, 'native-catalog', 'text-model', native);
		expect(readFileSync(current.configPath, 'utf8')).toContain('// Operator comment must survive');
		expect(readConfiguration(current.configPath)).toEqual({
			...current.configuration,
			model: 'native-catalog/text-model'
		});
	});

	it('reports unconfirmed effective settings honestly without rolling back or overwriting native preferences', async () => {
		const current = fixture();
		const original = readFileSync(current.configPath, 'utf8');
		const native = nativeFixture(current.home, current.configPath, {
			model: 'existing/team/model'
		});
		await expect(
			useProviderModel(current.home, 'native-catalog', 'text-model', native)
		).rejects.toThrow(/saved.*could not be confirmed/i);
		expect(readFileSync(current.configPath, 'utf8')).not.toBe(original);
		expect(readConfiguration(current.configPath).model).toBe('native-catalog/text-model');
		expect(native.calls.filter((call) => call.path === '/global/config' && call.method === 'PATCH')).toHaveLength(1);
		expect(native.calls.some((call) => call.path.includes('/dispose'))).toBe(false);
		expect(native.modelRequests).toHaveLength(0);
	}, 15_000);

	it('reports an overridden endpoint without destructive client-side rollback', async () => {
		const current = fixture();
		const original = readFileSync(current.configPath, 'utf8');
		const native = nativeFixture(current.home, current.configPath, {
			provider: current.configuration.provider
		});
		await expect(
			saveProviderEndpoint(
				current.home,
				{
					provider: 'existing',
					name: 'Changed',
					url: 'http://192.0.2.22:9999/v1',
					model: 'new-model'
				},
				native
			)
		).rejects.toThrow(/saved.*could not be confirmed/i);
		expect(readFileSync(current.configPath, 'utf8')).not.toBe(original);
		expect(native.modelRequests).toHaveLength(0);
	}, 15_000);

	it('re-enables exactly the chosen endpoint and preserves other disabled IDs and auth', async () => {
		const current = fixture();
		writeFileSync(current.configPath, JSON.stringify({ ...current.configuration, disabled_providers: ['existing', 'another'] }));
		const authPath = join(current.home, 'knowledge/secrets/auth.json');
		writeFileSync(authPath, JSON.stringify({ existing: { type: 'api', key: 'synthetic-preserved' } }));
		const native = nativeFixture(current.home, current.configPath);
		const settings = await saveProviderEndpoint(current.home, {
			provider: 'existing', name: 'Existing operator provider', url: 'http://192.0.2.20:8080/v1', model: 'team/model'
		}, native);
		expect(readConfiguration(current.configPath).disabled_providers).toEqual(['another']);
		expect(settings.providers.find((provider) => provider.id === 'existing')?.disabled).toBe(false);
		expect(readConfiguration(authPath)).toEqual({ existing: { type: 'api', key: 'synthetic-preserved' } });
		expect(native.modelRequests).toHaveLength(0);
	});

	it('discovers model IDs inside Assistant without putting a key in command args or making an inference request', async () => {
		const current = fixture();
		const commands: string[][] = [];
		const inputs: string[] = [];
		const models = await discoverProviderModels(
			current.home,
			{ url: 'http://192.0.2.30:1234/v1', key: 'synthetic-discovery-key' },
			{
				run: async (args, options) => {
					commands.push(args);
					inputs.push(options?.input ?? '');
					return {
						ok: true,
						stdout: JSON.stringify({ models: ['team/model', 'qwen:latest'] }),
						stderr: '',
						code: 0
					};
				}
			}
		);
		expect(models).toEqual(['team/model', 'qwen:latest']);
		expect(commands[0]).toContain('assistant');
		expect(commands[0]).toContain('node');
		expect(commands[0].join(' ')).not.toContain('synthetic-discovery-key');
		expect(JSON.parse(inputs[0])).toEqual({
			url: 'http://192.0.2.30:1234/v1',
			key: 'synthetic-discovery-key'
		});
		expect(readConfiguration(current.configPath)).toEqual(current.configuration);
	});

	for (const url of ['file:///etc/passwd', 'http://user:pass@192.0.2.1/v1', 'relative-path']) {
		it(`rejects invalid endpoint ${url} before changing native configuration`, async () => {
			const current = fixture();
			const native = nativeFixture(current.home, current.configPath);
			await expect(
				saveProviderEndpoint(
					current.home,
					{ provider: 'invalid', name: 'Invalid', url, model: 'text-model' },
					native
				)
			).rejects.toThrow();
			expect(readConfiguration(current.configPath)).toEqual(current.configuration);
			expect(native.modelRequests).toHaveLength(0);
		});
	}
});

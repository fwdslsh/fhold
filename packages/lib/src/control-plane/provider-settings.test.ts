import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';

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
	writeFileSync(join(home, 'synthetic-native-credentials.json'), '{}\n');
	const configPath = join(home, 'config', 'assistant', 'opencode.json');
	const configuration = {
		$schema: 'https://opencode.ai/config.json',
		model: 'existing/team/model',
		small_model: 'existing/small',
		permissions: [{ action: '*', resource: '*', effect: 'ask' }],
		plugins: ['operator-plugin'],
		providers: {
			existing: {
				package: '@opencode/ai/providers/openai-compatible',
				name: 'Existing operator provider',
				settings: { baseURL: 'http://192.0.2.20:8080/v1', headers: { 'X-Operator': 'preserve' } },
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
	capabilities: { tools: true, input: ['text'], output: ['text'] }
};

function readConfiguration(path: string): Record<string, unknown> {
	return parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function nativeFixture(home: string, configPath: string, override: Record<string, unknown> = {}) {
	const calls: Array<{ path: string; method: string; body?: unknown }> = [];
	const modelRequests: Array<{ model?: { providerID: string; id: string } }> = [];
	const authPath = join(home, 'synthetic-native-credentials.json');
	const fetchNative = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const path = new URL(request.url).pathname;
		const body: unknown = request.body ? await request.json() : undefined;
		calls.push({ path, method: request.method, ...(body === undefined ? {} : { body }) });
		// Simulate the public watcher contract, not a made-up writable settings API.
		const configuration = {
			...readConfiguration(configPath),
			...readConfiguration(join(home, 'config/opencode/opencode.json')),
			...override
		};
		const definitions = configuration.providers as Record<
			string,
			{
				name?: string;
				models?: Record<string, { name?: string }>;
			}
		>;
		const auth = readConfiguration(authPath);
		const policy = (configuration.policies ??
			(configuration.experimental as { policies?: unknown } | undefined)?.policies ??
			[]) as Array<{ action: string; resource: string; effect: string }>;
		const disabled = (provider: string) =>
			policy.filter((rule) => rule.action === 'provider.use' && rule.resource === provider).at(-1)
				?.effect === 'deny';
		const providerIds = ['native-catalog', ...Object.keys(definitions ?? {})];
		const nativeModel = configuration.model as { providerID?: string; model?: string } | undefined;
		const selection =
			typeof configuration.model === 'string'
				? configuration.model
				: nativeModel?.providerID && nativeModel.model
					? `${nativeModel.providerID}/${nativeModel.model}`
					: '';
		const separator = selection.indexOf('/');
		const preferred =
			separator > 0
				? { providerID: selection.slice(0, separator), id: selection.slice(separator + 1) }
				: null;
		const data = (value: unknown) => Response.json({ data: value });
		if (path === '/api/info') return Response.json({ version: '2.0.29' });
		if (path === '/api/config')
			return Response.json([
				{
					type: 'document',
					info: {
						...configuration,
						// 2.0.29 normalizes both accepted input forms to top-level policies.
						experimental: undefined,
						policies: policy,
						...(preferred
							? { model: { providerID: preferred.providerID, model: preferred.id } }
							: {})
					}
				}
			]);
		if (path === '/api/model/default') return data(preferred);
		if (path === '/api/provider')
			return data(
				providerIds.map((id) => ({
					id,
					name: definitions?.[id]?.name ?? id,
					activation: disabled(id) ? 'disabled' : 'enabled'
				}))
			);
		if (path === '/api/integration')
			return data(
				[...new Set([...providerIds, ...Object.keys(auth)])].map((id) => ({
					id,
					name: id,
					methods: [{ type: 'key', label: 'API key' }],
					connections: auth[id]
						? [{ type: 'credential', id: 'cred-' + id, method: 'key' }]
						: id === 'native-catalog'
							? [{ type: 'env', name: 'FREE_NATIVE_FIXTURE' }]
							: []
				}))
			);
		if (path === '/api/model')
			return data(
				[
					{ ...textModel, providerID: 'native-catalog' },
					{
						...textModel,
						id: 'whisper',
						providerID: 'native-catalog',
						capabilities: { tools: false, input: ['audio'], output: ['text'] }
					},
					{
						...textModel,
						id: 'deprecated-text',
						providerID: 'native-catalog',
						status: 'deprecated'
					},
					...Object.entries(definitions ?? {}).flatMap(([id, provider]) =>
						Object.entries(provider.models ?? {}).map(([model, value]) => ({
							...textModel,
							id: model,
							providerID: id,
							name: value.name ?? model
						}))
					)
				].filter((model) => !disabled(model.providerID))
			);
		if (path === '/api/credential')
			return data(
				Object.entries(auth).map(([integrationID, value]) => ({
					id: 'cred-' + integrationID,
					integrationID,
					value
				}))
			);
		const connect = /^\/api\/integration\/([^/]+)\/connect\/key$/.exec(path);
		if (connect && request.method === 'POST') {
			auth[decodeURIComponent(connect[1])] = { type: 'key', key: (body as { key: string }).key };
			writeFileSync(authPath, JSON.stringify(auth));
			return new Response(null, { status: 204 });
		}
		if (path.startsWith('/api/credential/cred-') && request.method === 'DELETE') {
			delete auth[decodeURIComponent(path.slice('/api/credential/cred-'.length))];
			writeFileSync(authPath, JSON.stringify(auth));
			return new Response(null, { status: 204 });
		}
		if (path === '/api/experimental/generate' && request.method === 'POST') {
			modelRequests.push(body as { model?: { providerID: string; id: string } });
			return data({ text: 'FH_READY' });
		}
		throw new Error('Unexpected native API request ' + request.method + ' ' + path);
	}) as typeof fetch;
	return { calls, modelRequests, fetch: fetchNative };
}

describe('Native provider manager settings', () => {
	it('reports the effective default and orphan saved credentials without calling models', async () => {
		const current = fixture();
		writeFileSync(
			join(current.home, 'synthetic-native-credentials.json'),
			JSON.stringify({
				orphan: { type: 'key', key: 'synthetic-orphan-key' }
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
			expect(config.permissions).toEqual(current.configuration.permissions);
			expect(config.plugins).toEqual(current.configuration.plugins);
			expect((config.providers as Record<string, unknown>).existing).toEqual(
				current.configuration.providers.existing
			);
			expect((config.providers as Record<string, unknown>)[provider]).toMatchObject({
				settings: { baseURL: 'http://192.0.2.30:1234/v1' },
				models: { 'team/selected-model': {} }
			});
			expect(
				settings.providers.find((item) => item.id === provider)?.models?.map((item) => item.id)
			).toContain('team/selected-model');
			expect(native.modelRequests).toHaveLength(0);
			expect(native.calls.some((call) => call.path === '/session')).toBe(false);
			expect(native.calls.every((call) => call.method === 'GET')).toBe(true);
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
			readConfiguration(current.configPath).providers as Record<string, Record<string, unknown>>
		).existing;
		expect(provider.settings).toEqual({
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
			readConfiguration(join(current.home, 'synthetic-native-credentials.json'))['keyed-custom']
		).toEqual({ type: 'key', key: 'synthetic-endpoint-key' });
		expect(
			native.calls.find((call) => call.path === '/api/integration/keyed-custom/connect/key')
		).toMatchObject({
			method: 'POST'
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

	it('accepts the same native structured managed model without bypassing a different managed choice', async () => {
		const current = fixture();
		const policyPath = join(current.home, 'config/opencode/opencode.json');
		const policy = { model: { providerID: 'native-catalog', model: 'text-model' } };
		writeFileSync(policyPath, JSON.stringify(policy));
		const native = nativeFixture(current.home, current.configPath);
		expect(
			(await useProviderModel(current.home, 'native-catalog', 'text-model', native)).currentModel
		).toEqual({ provider: 'native-catalog', model: 'text-model' });
		expect(readConfiguration(policyPath)).toEqual(policy);
		await expect(useProviderModel(current.home, 'existing', 'team/model', native)).rejects.toThrow(
			'default model is controlled'
		);
		expect(readConfiguration(current.configPath).model).toBe('native-catalog/text-model');
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
			{ providerID: 'existing', id: 'small' }
		]);
		expect(readConfiguration(current.configPath)).toEqual(current.configuration);
		expect(native.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
	});

	it('removes only selected saved auth, preserving endpoint, default, and another account', async () => {
		const current = fixture();
		current.configuration.model = 'native-catalog/text-model';
		writeFileSync(current.configPath, JSON.stringify(current.configuration));
		const authPath = join(current.home, 'synthetic-native-credentials.json');
		const other = {
			type: 'oauth',
			access: 'synthetic-other-access',
			refresh: 'synthetic-other-refresh'
		};
		writeFileSync(
			authPath,
			JSON.stringify({ existing: { type: 'key', key: 'synthetic-existing' }, other })
		);
		const native = nativeFixture(current.home, current.configPath);
		await removeProviderSetup(current.home, 'existing', native);
		expect(readConfiguration(authPath)).toEqual({ other });
		expect(readConfiguration(current.configPath)).toEqual(current.configuration);
		expect(
			native.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)
		).toEqual(['/api/credential/cred-existing']);
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
		const settings = await removeProviderSetup(current.home, 'remove-me', {
			...native,
			endpoint: true
		});
		expect(readConfiguration(current.configPath)).toEqual({
			...saved,
			policies: [{ action: 'provider.use', resource: 'remove-me', effect: 'deny' }]
		});
		expect(settings.providers.find((provider) => provider.id === 'remove-me')).toMatchObject({
			disabled: true,
			connected: false,
			models: [],
			endpoint: { editable: true }
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
		const authPath = join(current.home, 'synthetic-native-credentials.json');
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
		const account = { type: 'key', key: 'synthetic-preserved-account' };
		writeFileSync(authPath, JSON.stringify({ 'endpoint-only': account }));
		const saved = readConfiguration(current.configPath);
		await removeProviderSetup(current.home, 'endpoint-only', { ...native, endpoint: true });
		expect(readConfiguration(authPath)).toEqual({ 'endpoint-only': account });
		expect(readConfiguration(current.configPath)).toEqual({
			...saved,
			policies: [{ action: 'provider.use', resource: 'endpoint-only', effect: 'deny' }]
		});
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
		const result = await useProviderModel(current.home, 'native-catalog', 'text-model', {
			...native,
			timeoutMs: 1
		});
		expect(result.write).toMatchObject({
			saved: true,
			effective: 'unconfirmed',
			activation: 'none'
		});
		expect(result.currentModel).toEqual({ provider: 'existing', model: 'team/model' });
		expect(readFileSync(current.configPath, 'utf8')).not.toBe(original);
		expect(readConfiguration(current.configPath).model).toBe('native-catalog/text-model');
		expect(native.calls.every((call) => call.method === 'GET')).toBe(true);
		expect(native.calls.some((call) => call.path.includes('/dispose'))).toBe(false);
		expect(native.modelRequests).toHaveLength(0);
	}, 15_000);

	it('reports an overridden endpoint without destructive client-side rollback', async () => {
		const current = fixture();
		const original = readFileSync(current.configPath, 'utf8');
		const native = nativeFixture(current.home, current.configPath, {
			providers: current.configuration.providers
		});
		const result = await saveProviderEndpoint(
			current.home,
			{
				provider: 'existing',
				name: 'Changed',
				url: 'http://192.0.2.22:9999/v1',
				model: 'new-model'
			},
			{ ...native, timeoutMs: 1 }
		);
		expect(result.write).toMatchObject({
			saved: true,
			effective: 'unconfirmed',
			activation: 'none'
		});
		expect(readFileSync(current.configPath, 'utf8')).not.toBe(original);
		expect(native.modelRequests).toHaveLength(0);
	}, 15_000);

	it('retains a successful preference save when the agent becomes unreachable during read-back', async () => {
		const current = fixture();
		const native = nativeFixture(current.home, current.configPath);
		const result = await useProviderModel(current.home, 'native-catalog', 'text-model', {
			timeoutMs: 1,
			fetch: (async (input, init) => {
				if (
					new URL(String(input)).pathname === '/api/config' &&
					readConfiguration(current.configPath).model === 'native-catalog/text-model'
				)
					throw new Error('Synthetic connection lost');
				return native.fetch(input, init);
			}) as typeof fetch
		});
		expect(result.write).toMatchObject({ saved: true, effective: 'unconfirmed' });
		expect(result.inventoryUnavailable).toBe(true);
		expect(result.currentModel).toBeUndefined();
		expect(readConfiguration(current.configPath).model).toBe('native-catalog/text-model');
		expect(native.modelRequests).toHaveLength(0);
	});

	it.each(['top-level', 'legacy'] as const)(
		're-enables exactly the chosen endpoint and preserves other disabled IDs and auth in %s preferences',
		async (format) => {
			const current = fixture();
			const policies = [
				{ action: 'provider.use', resource: 'existing', effect: 'deny' },
				{ action: 'provider.use', resource: 'another', effect: 'deny' },
				{ action: 'tool.use', resource: 'shell:forbidden', effect: 'deny' }
			];
			writeFileSync(
				current.configPath,
				JSON.stringify({
					...current.configuration,
					...(format === 'legacy' ? { experimental: { policies } } : { policies })
				})
			);
			const authPath = join(current.home, 'synthetic-native-credentials.json');
			writeFileSync(
				authPath,
				JSON.stringify({ existing: { type: 'key', key: 'synthetic-preserved' } })
			);
			const native = nativeFixture(current.home, current.configPath);
			const settings = await saveProviderEndpoint(
				current.home,
				{
					provider: 'existing',
					name: 'Existing operator provider',
					url: 'http://192.0.2.20:8080/v1',
					model: 'team/model'
				},
				native
			);
			const saved = readConfiguration(current.configPath);
			expect(
				format === 'legacy'
					? (saved.experimental as { policies: unknown }).policies
					: saved.policies
			).toEqual([
				policies[1],
				policies[2],
				{ action: 'provider.use', resource: 'existing', effect: 'allow' }
			]);
			expect(settings.providers.find((provider) => provider.id === 'existing')?.disabled).toBe(
				false
			);
			expect(readConfiguration(authPath)).toEqual({
				existing: { type: 'key', key: 'synthetic-preserved' }
			});
			expect(native.modelRequests).toHaveLength(0);
		}
	);

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

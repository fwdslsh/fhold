/**
 * Explicit access to an already selected native OpenCode runtime.
 *
 * This port deliberately contains no home path, Docker command, provider
 * connection, or deployment lifecycle behavior. A host adapter acquires it
 * only for an explicit connect/auth/readiness action and drops it on close.
 */
import type {
	AssistantReadiness,
	ProviderOAuthAuthorization,
	ProviderAuthMethod,
	ProviderAuthPrompt,
	ProviderSummary
} from '../dto/agent.js';
export type {
	AssistantReadiness,
	ProviderAuthMethod,
	ProviderAuthPrompt,
	ProviderOAuthAuthorization,
	ProviderSummary
} from '../dto/agent.js';

export type NativeAgentAccess = {
	endpoint: string;
	authorization: () => string | Promise<string>;
};
export type NativeAgentRequestOptions = {
	fetch?: typeof fetch;
	timeoutMs?: number;
	maxResponseBytes?: number;
	signal?: AbortSignal;
};
export type NativeAgentService = {
	/** Native one-use browser sign-in; never returns the server password. */
	browserLink(options?: NativeAgentRequestOptions): Promise<{ url: string }>;
	listProviders(options?: NativeAgentRequestOptions): Promise<ProviderSummary[]>;
	setProviderApiKey(
		provider: string,
		key: string,
		options?: NativeAgentRequestOptions
	): Promise<void>;
	readConfig(options?: NativeAgentRequestOptions): Promise<Record<string, unknown>>;
	beginProviderOAuth(
		provider: string,
		method: number,
		inputs?: Record<string, string>,
		options?: NativeAgentRequestOptions
	): Promise<ProviderOAuthAuthorization>;
	completeProviderOAuth(
		provider: string,
		attemptID: string,
		code?: string,
		options?: NativeAgentRequestOptions
	): Promise<void>;
	removeProviderAuth(provider: string, options?: NativeAgentRequestOptions): Promise<void>;
	waitForReady(options?: NativeAgentRequestOptions & { intervalMs?: number }): Promise<void>;
	testReadiness(
		options?: NativeAgentRequestOptions & { provider?: string; model?: string }
	): Promise<AssistantReadiness>;
};
export type HttpsNativeAgentServiceOptions = {
	endpoint: string;
	password: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
	signal?: AbortSignal;
};

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 16 * 1024 * 1024;
const READY_TOKEN = 'FH_READY';

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function dataList(value: unknown): Record<string, unknown>[] {
	const data = record(value)?.data;
	return Array.isArray(data)
		? data.flatMap((item) => {
				const entry = record(item);
				return entry ? [entry] : [];
			})
		: [];
}
function providerId(value: string): string {
	if (
		!/^[A-Za-z0-9._-]{1,128}$/.test(value) ||
		['__proto__', 'constructor', 'prototype'].includes(value)
	)
		throw new Error('Invalid provider id');
	return value;
}
function modelId(value: unknown): string | undefined {
	return typeof value === 'string' &&
		value.length > 0 &&
		value.length <= 512 &&
		![...value].some((character) => character.charCodeAt(0) < 32)
		? value
		: undefined;
}
function validateEndpoint(value: string, httpsOnly: boolean): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error('Native agent endpoint must be an absolute HTTP URL.');
	}
	if (
		(httpsOnly && url.protocol !== 'https:') ||
		(!httpsOnly && !['http:', 'https:'].includes(url.protocol)) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.pathname !== '/' && url.pathname !== '')
	)
		throw new Error(
			httpsOnly
				? 'Native agent endpoint must be an HTTPS origin without credentials.'
				: 'Native agent endpoint must be an HTTP(S) origin without credentials.'
		);
	return url.origin;
}
function merge(
	target: Record<string, unknown>,
	patch: Record<string, unknown>
): Record<string, unknown> {
	for (const [key, value] of Object.entries(patch)) {
		if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
		const nested = record(value);
		target[key] = nested ? merge(record(target[key]) ?? {}, nested) : value;
	}
	return target;
}
function authMethods(integration: Record<string, unknown> | undefined): ProviderAuthMethod[] {
	const methods = Array.isArray(integration?.methods) ? integration.methods : [];
	return methods.flatMap((raw, index) => {
		const method = record(raw);
		if (method?.type !== 'key' && method?.type !== 'oauth') return [];
		const prompts: ProviderAuthPrompt[] = [];
		for (const rawField of Array.isArray(method.form) ? method.form : []) {
			const field = record(rawField);
			if (field?.hidden || field?.type !== 'string' || typeof field.key !== 'string') continue;
			const message = typeof field.title === 'string' ? field.title : field.key;
			const choices = Array.isArray(field.options)
				? field.options.flatMap((item) => {
						const option = record(item);
						return typeof option?.label === 'string' && typeof option.value === 'string'
							? [
									{
										label: option.label,
										value: option.value,
										...(typeof option.hint === 'string' ? { hint: option.hint } : {})
									}
								]
							: [];
					})
				: [];
			const condition = record(field.when);
			const when: ProviderAuthPrompt['when'] =
				typeof condition?.key === 'string' &&
				(condition.op === 'eq' || condition.op === 'neq') &&
				typeof condition.value === 'string'
					? { key: condition.key, op: condition.op, value: condition.value }
					: undefined;
			prompts.push(
				choices.length
					? { type: 'select', key: field.key, message, options: choices, ...(when ? { when } : {}) }
					: {
							type: 'text',
							key: field.key,
							message,
							...(typeof field.placeholder === 'string' ? { placeholder: field.placeholder } : {}),
							...(when ? { when } : {})
						}
			);
		}
		return [
			{
				index,
				type: method.type === 'key' ? ('api' as const) : ('oauth' as const),
				label: typeof method.label === 'string' ? method.label : 'API key',
				...(prompts.length ? { prompts } : {})
			}
		];
	});
}
function eligibleModel(model: Record<string, unknown>): boolean {
	const capabilities = record(model.capabilities);
	return Boolean(
		modelId(model.id) &&
			model.enabled !== false &&
			model.status !== 'deprecated' &&
			capabilities?.tools === true &&
			Array.isArray(capabilities.input) &&
			capabilities.input.includes('text') &&
			Array.isArray(capabilities.output) &&
			capabilities.output.includes('text')
	);
}

/** Create native API operations over a host-supplied, private authenticated route. */
export function createNativeAgentService(
	access: NativeAgentAccess,
	defaults: NativeAgentRequestOptions = {}
): NativeAgentService {
	const endpoint = validateEndpoint(access.endpoint, false);
	async function request(
		path: string,
		init: RequestInit = {},
		options: NativeAgentRequestOptions = {}
	): Promise<unknown> {
		const headers = new Headers(init.headers);
		const authorization = await access.authorization();
		if (!authorization || /[\r\n]/.test(authorization))
			throw new Error('Native agent authorization is unavailable.');
		headers.set('authorization', authorization);
		if (init.body !== undefined) headers.set('content-type', 'application/json');
		const url = new URL(`/api${path}`, endpoint);
		if (/^\/(?:config|provider|integration|model)(?:\/|$)/.test(path))
			url.searchParams.set('location[directory]', '/etc/opencode');
		const timeout = AbortSignal.timeout(options.timeoutMs ?? defaults.timeoutMs ?? 30_000);
		const signals = [init.signal, options.signal, defaults.signal, timeout].filter(
			(value): value is AbortSignal => value instanceof AbortSignal
		);
		const response = await (options.fetch ?? defaults.fetch ?? fetch)(url, {
			...init,
			headers,
			redirect: 'error',
			signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals)
		});
		const maximum = options.maxResponseBytes ?? defaults.maxResponseBytes ?? MAX_RESPONSE_BYTES;
		if (Number(response.headers.get('content-length') ?? 0) > maximum)
			throw new Error('OpenCode response exceeded the size limit');
		const reader = response.body?.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (reader) {
				const next = await reader.read();
				if (next.done) break;
				size += next.value.length;
				if (size > maximum) throw new Error('OpenCode response exceeded the size limit');
				chunks.push(next.value);
			}
		} finally {
			await reader?.cancel().catch(() => {});
		}
		let body: unknown;
		try {
			body = size ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) : undefined;
		} catch {
			throw new Error('OpenCode returned an invalid response');
		}
		if (!response.ok) {
			const message = record(body)?.message;
			throw new Error(
				typeof message === 'string'
					? message.slice(0, 500)
					: `OpenCode returned HTTP ${response.status}`
			);
		}
		return body;
	}
	async function integrationId(
		provider: string,
		options: NativeAgentRequestOptions
	): Promise<string> {
		const native = dataList(await request('/provider', {}, options)).find(
			(entry) => entry.id === provider
		);
		return typeof native?.integrationID === 'string' ? native.integrationID : provider;
	}
	async function listProviders(
		options: NativeAgentRequestOptions = {}
	): Promise<ProviderSummary[]> {
		const large = { ...options, maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES };
		const [providerValue, integrationValue, modelValue, defaultValue] = await Promise.all([
			request('/provider', {}, large),
			request('/integration', {}, large),
			request('/model', {}, large),
			request('/model/default', {}, options)
		]);
		const providers = dataList(providerValue),
			integrations = dataList(integrationValue),
			models = dataList(modelValue);
		const preferred = record(record(defaultValue)?.data);
		const summaries = new Map<string, ProviderSummary>();
		for (const item of [...integrations, ...providers]) {
			if (
				typeof item.id !== 'string' ||
				item.id.startsWith('mcp_') ||
				record(item.metadata)?.source === 'mcp'
			)
				continue;
			const provider = providers.find((entry) => entry.id === item.id);
			const integration = integrations.find(
				(entry) => entry.id === (provider?.integrationID ?? item.id)
			);
			const connections = Array.isArray(integration?.connections)
				? integration.connections.map(record)
				: [];
			const available = models.filter(
				(entry) => entry.providerID === item.id && eligibleModel(entry)
			);
			summaries.set(item.id, {
				id: item.id,
				name: typeof item.name === 'string' ? item.name : item.id,
				source: provider ? 'native' : 'catalog',
				configured: false,
				modelCount: available.length,
				models: available.map((entry) => ({
					id: String(entry.id),
					name: typeof entry.name === 'string' ? entry.name : String(entry.id)
				})),
				...(preferred?.providerID === item.id && modelId(preferred.id)
					? { defaultModel: String(preferred.id) }
					: {}),
				disabled: provider?.activation === 'disabled',
				connected: Boolean(provider) && connections.some((entry) => entry && !entry.status),
				authenticated: connections.some((entry) => entry?.type === 'credential'),
				authMethods: authMethods(integration)
			});
		}
		return [...summaries.values()].sort((a, b) => a.name.localeCompare(b.name));
	}
	function throwIfSessionAborted(options: NativeAgentRequestOptions = {}): void {
		options.signal?.throwIfAborted();
		defaults.signal?.throwIfAborted();
	}
	async function waitForReady(
		options: NativeAgentRequestOptions & { intervalMs?: number } = {}
	): Promise<void> {
		const deadline = Date.now() + (options.timeoutMs ?? defaults.timeoutMs ?? 60_000);
		let error = 'Assistant is not reachable';
		do {
			throwIfSessionAborted(options);
			try {
				await request('/info', {}, { ...options, timeoutMs: 2_000 });
				return;
			} catch (failure) {
				throwIfSessionAborted(options);
				error = failure instanceof Error ? failure.message : String(failure);
			}
			throwIfSessionAborted(options);
			await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 500));
		} while (Date.now() < deadline);
		throw new Error(`Assistant did not become ready: ${error}`);
	}
	async function testReadiness(
		options: NativeAgentRequestOptions & { provider?: string; model?: string } = {}
	): Promise<AssistantReadiness> {
		try {
			await waitForReady({
				...options,
				timeoutMs: Math.min(options.timeoutMs ?? 10_000, 10_000),
				intervalMs: 100
			});
			if (options.model && !options.provider)
				throw new Error('A readiness model requires a provider.');
			let provider = options.provider ? providerId(options.provider) : '';
			let model: string | undefined;
			const deadline =
				Date.now() + Math.min(5_000, options.timeoutMs ?? defaults.timeoutMs ?? 5_000);
			do {
				throwIfSessionAborted(options);
				const providers = await listProviders(options);
				if (!options.provider)
					provider = String(
						record(record(await request('/model/default', {}, options))?.data)?.providerID ?? ''
					);
				const summary = providers.find((item) => item.id === provider);
				const selected =
					options.model ??
					summary?.models?.find((entry) => entry.id === summary.defaultModel)?.id ??
					summary?.models?.[0]?.id;
				if (selected && summary?.models?.some((item) => item.id === selected)) {
					model = selected;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			} while (Date.now() < deadline);
			if (!model)
				throw new Error(
					'The selected provider has no available model that supports text conversations and agent tools.'
				);
			const value = record(
				record(
					await request(
						'/experimental/generate',
						{
							method: 'POST',
							body: JSON.stringify({
								prompt: `Reply with exactly ${READY_TOKEN}.`,
								model: { providerID: provider, id: model }
							})
						},
						{ ...options, timeoutMs: options.timeoutMs ?? 120_000 }
					)
				)?.data
			);
			const response = typeof value?.text === 'string' ? value.text.trim() : '';
			return response.includes(READY_TOKEN)
				? { ok: true, response, provider, model }
				: { ok: false, error: 'The provider responded, but the readiness token was missing' };
		} catch (error) {
			throwIfSessionAborted(options);
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}
	return {
		async browserLink(options = {}) {
			const pairing = record(await request('/pair', { method: 'POST' }, options));
			if (typeof pairing?.code !== 'string' || !/^[A-Za-z0-9_-]+$/.test(pairing.code))
				throw new Error(
					'OpenCode did not return a browser sign-in link. Check its version and retry.'
				);
			return { url: new URL(`/auth/connect/${pairing.code}`, endpoint).href };
		},
		listProviders,
		async setProviderApiKey(provider, key, options = {}) {
			provider = providerId(provider);
			if (!key || key.length > 16_384 || /[\r\n]/.test(key))
				throw new Error('Provider key must be one non-empty line');
			await request(
				`/integration/${encodeURIComponent(await integrationId(provider, options))}/connect/key`,
				{ method: 'POST', body: JSON.stringify({ key }) },
				options
			);
		},
		async readConfig(options = {}) {
			const value = await request('/config', {}, options);
			if (!Array.isArray(value)) throw new Error('OpenCode returned invalid configuration.');
			return value.reduce<Record<string, unknown>>((result, item: unknown) => {
				const entry = record(item);
				const info = record(entry?.info);
				return entry?.type === 'document' && info ? merge(result, info) : result;
			}, {});
		},
		async beginProviderOAuth(provider, method, inputs, options = {}) {
			provider = providerId(provider);
			if (!Number.isSafeInteger(method) || method < 0 || method > 1_024)
				throw new Error('Invalid provider authentication method.');
			if (
				inputs &&
				(Object.keys(inputs).length > 32 ||
					Object.entries(inputs).some(
						([key, value]) =>
							!/^[A-Za-z0-9._-]{1,128}$/.test(key) ||
							typeof value !== 'string' ||
							value.length > 4_096
					))
			)
				throw new Error('Invalid provider sign-in field.');
			const integration = await integrationId(provider, options);
			const native = record(
				record(await request(`/integration/${encodeURIComponent(integration)}`, {}, options))?.data
			);
			const selected = record(Array.isArray(native?.methods) ? native.methods[method] : undefined);
			if (selected?.type !== 'oauth' || typeof selected.id !== 'string')
				throw new Error('This provider sign-in method is unavailable.');
			const value = record(
				record(
					await request(
						`/integration/${encodeURIComponent(integration)}/connect/oauth`,
						{
							method: 'POST',
							body: JSON.stringify({ methodID: selected.id, ...(inputs ? { answer: inputs } : {}) })
						},
						options
					)
				)?.data
			);
			if (
				typeof value?.attemptID !== 'string' ||
				typeof value.url !== 'string' ||
				(value.mode !== 'auto' && value.mode !== 'code') ||
				typeof value.instructions !== 'string'
			)
				throw new Error('OpenCode returned an invalid provider sign-in response.');
			return {
				attemptID: value.attemptID,
				url: value.url,
				method: value.mode,
				instructions: value.instructions
			};
		},
		async completeProviderOAuth(provider, attemptID, code, options = {}) {
			provider = providerId(provider);
			if (
				!/^[A-Za-z0-9_-]{1,256}$/.test(attemptID) ||
				(code !== undefined && (!code.trim() || code.length > 10_000))
			)
				throw new Error('Provider authorization code or attempt is invalid.');
			await request(
				`/integration/${encodeURIComponent(await integrationId(provider, options))}/connect/oauth/${encodeURIComponent(attemptID)}/complete`,
				{ method: 'POST', body: JSON.stringify(code === undefined ? {} : { code: code.trim() }) },
				options
			);
		},
		async removeProviderAuth(provider, options = {}) {
			const integration = await integrationId(providerId(provider), options);
			for (const credential of dataList(await request('/credential', {}, options)))
				if (credential.integrationID === integration && typeof credential.id === 'string')
					await request(
						`/credential/${encodeURIComponent(credential.id)}`,
						{ method: 'DELETE' },
						options
					);
		},
		waitForReady,
		testReadiness
	};
}

/** Session-only HTTPS access for an explicitly selected, authenticated cloud runtime. */
export function createHttpsNativeAgentService(
	options: HttpsNativeAgentServiceOptions
): NativeAgentService {
	const endpoint = validateEndpoint(options.endpoint, true);
	if (!options.password || options.password.length > 16_384 || /[\r\n]/.test(options.password))
		throw new Error('Native agent password must be one non-empty line.');
	const authorization = `Basic ${Buffer.from(`opencode:${options.password}`).toString('base64')}`;
	return createNativeAgentService(
		{ endpoint, authorization: () => authorization },
		{ fetch: options.fetch, timeoutMs: options.timeoutMs, signal: options.signal }
	);
}

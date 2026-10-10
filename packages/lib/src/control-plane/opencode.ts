import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyEdits, modify } from 'jsonc-parser/lib/esm/main.js';
import { readStackConfig } from './stack-config.js';
import { stateSecretFile, writeFileAtomic } from './foundation.js';
import { readNativePreferences } from './provider-files.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 16 * 1024 * 1024;
const READY_TOKEN = 'FH_READY';
const FRESH_GUARDIAN_MODEL = '"model": "opencode/big-pickle"';

export type ProviderAuthPrompt =
	| {
			type: 'text';
			key: string;
			message: string;
			placeholder?: string;
			when?: { key: string; op: 'eq' | 'neq'; value: string };
	  }
	| {
			type: 'select';
			key: string;
			message: string;
			options: Array<{ label: string; value: string; hint?: string }>;
			when?: { key: string; op: 'eq' | 'neq'; value: string };
	  };
export type ProviderAuthMethod = {
	index: number;
	type: 'oauth' | 'api';
	label: string;
	prompts?: ProviderAuthPrompt[];
};
export type ProviderOAuthAuthorization = {
	attemptID: string;
	url: string;
	method: 'auto' | 'code';
	instructions: string;
};
export type ProviderSummary = {
	id: string;
	name: string;
	source: string;
	modelCount: number;
	models?: Array<{ id: string; name: string }>;
	configured?: boolean;
	disabled?: boolean;
	endpoint?: { url: string; name: string; models: string[]; editable: boolean };
	defaultModel?: string;
	connected: boolean;
	authenticated: boolean;
	authMethods: ProviderAuthMethod[];
};
export type AssistantReadiness =
	| { ok: true; response: string; provider?: string; model?: string }
	| { ok: false; error: string };
type Options = { fetch?: typeof fetch; timeoutMs?: number; maxResponseBytes?: number };

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
function id(value: string): string {
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
export function assistantEndpoint(home: string): string {
	const result = readStackConfig(home);
	if (!result.ok) throw new Error(result.error);
	const bind = result.config.assistant.bindAddress;
	const address = bind === '0.0.0.0' ? '127.0.0.1' : bind === '::' ? '::1' : bind;
	return `http://${address.includes(':') ? `[${address}]` : address}:${result.config.assistant.port}`;
}
function authorization(home: string): string {
	const path = stateSecretFile(home, 'fhold_opencode_password');
	if (!existsSync(path)) throw new Error(`OpenCode password is missing: ${path}`);
	const password = readFileSync(path, 'utf8').replace(/[\r\n]+$/, '');
	if (!password) throw new Error('OpenCode password is empty');
	return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}
async function request(
	home: string,
	path: string,
	init: RequestInit = {},
	options: Options = {}
): Promise<unknown> {
	const headers = new Headers(init.headers);
	headers.set('authorization', authorization(home));
	if (init.body !== undefined) headers.set('content-type', 'application/json');
	const url = new URL(`${assistantEndpoint(home)}/api${path}`);
	// These are global AI preferences, not a workspace's overrides. Native
	// stateless generation resolves the same image-owned configuration scope.
	if (/^\/(?:config|provider|integration|model)(?:\/|$)/.test(path)) {
		url.searchParams.set('location[directory]', '/etc/opencode');
	}
	const response = await (options.fetch ?? fetch)(url, {
		...init,
		headers,
		signal: AbortSignal.timeout(options.timeoutMs ?? 30_000)
	});
	const maximum = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
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
							? [{ label: option.label, value: option.value }]
							: [];
					})
				: [];
			prompts.push(
				choices.length
					? { type: 'select', key: field.key, message, options: choices }
					: { type: 'text', key: field.key, message }
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
/** Native capabilities exclude speech/embedding-only models without name heuristics. */
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
export async function listProviders(
	home: string,
	options: Options = {}
): Promise<ProviderSummary[]> {
	const large = { ...options, maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES };
	const [providerValue, integrationValue, modelValue, defaultValue] = await Promise.all([
		request(home, '/provider', {}, large),
		request(home, '/integration', {}, large),
		request(home, '/model', {}, large),
		request(home, '/model/default', {}, options)
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
async function integrationId(home: string, provider: string, options: Options): Promise<string> {
	const native = dataList(await request(home, '/provider', {}, options)).find(
		(entry) => entry.id === provider
	);
	return typeof native?.integrationID === 'string' ? native.integrationID : provider;
}
export async function setProviderApiKey(
	home: string,
	provider: string,
	key: string,
	options: Options = {}
): Promise<void> {
	provider = id(provider);
	if (!key || key.length > 16_384 || /[\r\n]/.test(key))
		throw new Error('Provider key must be one non-empty line');
	const integration = await integrationId(home, provider, options);
	await request(
		home,
		`/integration/${encodeURIComponent(integration)}/connect/key`,
		{ method: 'POST', body: JSON.stringify({ key }) },
		options
	);
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
/** Native normalized documents in precedence order; never invent provider configuration. */
export async function readAssistantConfig(
	home: string,
	options: Options = {}
): Promise<Record<string, unknown>> {
	const value = await request(home, '/config', {}, options);
	if (!Array.isArray(value)) throw new Error('OpenCode returned invalid configuration.');
	return value.reduce<Record<string, unknown>>((result, item: unknown) => {
		const entry = record(item);
		const info = record(entry?.info);
		return entry?.type === 'document' && info ? merge(result, info) : result;
	}, {});
}
export async function readAssistantGlobalConfig(
	home: string,
	_options: Options = {}
): Promise<Record<string, unknown>> {
	return readNativePreferences(home).value;
}
/** v2 watches native preferences; its shell-only PATCH is not a generic settings API. */
export async function updateAssistantGlobalConfig(
	home: string,
	patch: Record<string, unknown>,
	_options: Options = {}
): Promise<void> {
	const saved = readNativePreferences(home);
	let text = saved.text;
	function edit(change: Record<string, unknown>, path: string[] = []): void {
		for (const [key, value] of Object.entries(change)) {
			if (['__proto__', 'constructor', 'prototype'].includes(key))
				throw new Error('Invalid preferences field.');
			const nested = record(value);
			if (nested) edit(nested, [...path, key]);
			else
				text = applyEdits(
					text,
					modify(text, [...path, key], value === null ? undefined : value, {
						formattingOptions: { insertSpaces: true, tabSize: 2 }
					})
				);
		}
	}
	edit(patch);
	writeFileAtomic(saved.path, text, 0o600);
}
export async function beginProviderOAuth(
	home: string,
	provider: string,
	method: number,
	inputs?: Record<string, string>,
	options: Options = {}
): Promise<ProviderOAuthAuthorization> {
	provider = id(provider);
	if (!Number.isSafeInteger(method) || method < 0 || method > 1_024)
		throw new Error('Invalid provider authentication method.');
	if (
		inputs &&
		(Object.keys(inputs).length > 32 ||
			Object.entries(inputs).some(
				([key, value]) =>
					!/^[A-Za-z0-9._-]{1,128}$/.test(key) || typeof value !== 'string' || value.length > 4_096
			))
	)
		throw new Error('Invalid provider sign-in field.');
	const integration = await integrationId(home, provider, options);
	const native = record(
		record(await request(home, `/integration/${encodeURIComponent(integration)}`, {}, options))
			?.data
	);
	const selected = record(Array.isArray(native?.methods) ? native.methods[method] : undefined);
	if (selected?.type !== 'oauth' || typeof selected.id !== 'string')
		throw new Error('This provider sign-in method is unavailable.');
	const value = record(
		record(
			await request(
				home,
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
}
export async function completeProviderOAuth(
	home: string,
	provider: string,
	attemptID: string,
	code?: string,
	options: Options = {}
): Promise<void> {
	provider = id(provider);
	if (
		!/^[A-Za-z0-9_-]{1,256}$/.test(attemptID) ||
		(code !== undefined && (!code.trim() || code.length > 10_000))
	)
		throw new Error('Provider authorization code or attempt is invalid.');
	const integration = await integrationId(home, provider, options);
	await request(
		home,
		`/integration/${encodeURIComponent(integration)}/connect/oauth/${encodeURIComponent(attemptID)}/complete`,
		{ method: 'POST', body: JSON.stringify(code === undefined ? {} : { code: code.trim() }) },
		options
	);
}
export async function removeProviderAuth(
	home: string,
	provider: string,
	options: Options = {}
): Promise<void> {
	const integration = await integrationId(home, id(provider), options);
	const credentials = dataList(await request(home, '/credential', {}, options));
	for (const credential of credentials) {
		if (credential.integrationID === integration && typeof credential.id === 'string')
			await request(
				home,
				`/credential/${encodeURIComponent(credential.id)}`,
				{ method: 'DELETE' },
				options
			);
	}
}
export async function waitForAssistant(
	home: string,
	options: Options & { intervalMs?: number } = {}
): Promise<void> {
	const deadline = Date.now() + (options.timeoutMs ?? 60_000);
	let error = 'Assistant is not reachable';
	do {
		try {
			await request(home, '/info', {}, { fetch: options.fetch, timeoutMs: 2_000 });
			return;
		} catch (failure) {
			error = failure instanceof Error ? failure.message : String(failure);
		}
		await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 500));
	} while (Date.now() < deadline);
	throw new Error(`Assistant did not become ready: ${error}`);
}
export async function testAssistantReadiness(
	home: string,
	options: Options & { provider?: string; model?: string } = {}
): Promise<AssistantReadiness> {
	try {
		await waitForAssistant(home, { fetch: options.fetch, timeoutMs: 10_000, intervalMs: 100 });
		if (options.model && !options.provider)
			throw new Error('A readiness model requires a provider.');
		let provider = options.provider ? id(options.provider) : '';
		let model: string | undefined;
		// Domain activation and file watching are asynchronous. Wait for the
		// selected model's native inventory before the ONE inference request;
		// never retry a billed request, reload the server, or create a session.
		const deadline = Date.now() + Math.min(5_000, options.timeoutMs ?? 5_000);
		do {
			const providers = await listProviders(home, { fetch: options.fetch });
			if (!options.provider) {
				const preferred = record(record(await request(home, '/model/default', {}, options))?.data);
				provider = String(preferred?.providerID ?? '');
			}
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
					home,
					'/experimental/generate',
					{
						method: 'POST',
						body: JSON.stringify({
							prompt: `Reply with exactly ${READY_TOKEN}.`,
							model: { providerID: provider, id: model }
						})
					},
					{ fetch: options.fetch, timeoutMs: options.timeoutMs ?? 120_000 }
				)
			)?.data
		);
		const response = typeof value?.text === 'string' ? value.text.trim() : '';
		if (!response.includes(READY_TOKEN))
			return { ok: false, error: 'The provider responded, but the readiness token was missing' };
		return { ok: true, response, provider, model };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
export function configureGuardianModeratorModel(
	home: string,
	provider: string | undefined,
	model: string | undefined
): boolean {
	if (!provider || !model) return false;
	if (
		provider.length > 128 ||
		model.length > 256 ||
		[provider, model].some((value) => [...value].some((character) => character.charCodeAt(0) < 32))
	)
		throw new Error('Provider readiness returned an invalid model identifier.');
	const path = join(home, 'config/guardian/opencode.json');
	if (!existsSync(path)) return false;
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024)
		throw new Error('Guardian configuration must be a regular file smaller than 64 KiB.');
	const text = readFileSync(path, 'utf8');
	const occurrences = text.split(FRESH_GUARDIAN_MODEL).length - 1;
	if (!occurrences) return false;
	if (occurrences !== 1)
		throw new Error('Guardian configuration contains duplicate model settings.');
	writeFileAtomic(
		path,
		text.replace(FRESH_GUARDIAN_MODEL, `"model": ${JSON.stringify(`${provider}/${model}`)}`),
		stat.mode & 0o777
	);
	return true;
}

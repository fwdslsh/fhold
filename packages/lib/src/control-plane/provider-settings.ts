import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// Use the published ESM entry so Node-target bundles include its static imports.
import { parse, type ParseError } from 'jsonc-parser/lib/esm/main.js';

import { buildComposeCliArgs, buildComposeOptions } from './compose.js';
import { composeProcessEnvironment, runDocker } from './docker.js';
import { createFholdState } from './foundation.js';
import { acquireStackLock, releaseStackLock } from './lock.js';
import {
	listProviders,
	readAssistantConfig,
	readAssistantGlobalConfig,
	removeProviderAuth,
	setProviderApiKey,
	updateAssistantGlobalConfig,
	type ProviderSummary
} from './opencode.js';
import { assertSafePortablePath } from './provider-files.js';

export type ProviderSettings = {
	providers: ProviderSummary[];
	currentModel?: { provider: string; model: string };
	configurationIssue?: string;
};
export type ProviderEndpointInput = {
	provider: string;
	name: string;
	url: string;
	model: string;
	key?: string;
};
type Options = { fetch?: typeof fetch };
type ConfigFile = { value: Record<string, unknown> };
const USER_FILES = [
	'config/assistant/config.json',
	'config/assistant/opencode.json',
	'config/assistant/opencode.jsonc'
];
const POLICY_FILE = 'config/opencode/opencode.json';

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function id(value: string): string {
	if (
		!/^[A-Za-z0-9._-]{1,128}$/.test(value) ||
		['__proto__', 'constructor', 'prototype'].includes(value)
	)
		throw new Error('Invalid AI service identifier.');
	return value;
}
function modelId(value: string): string {
	if (
		!value ||
		value.length > 512 ||
		invalidCharacters(value) ||
		['__proto__', 'constructor', 'prototype'].includes(value)
	)
		throw new Error('Enter a valid model ID.');
	return value;
}
function invalidCharacters(value: string, spaces = false): boolean {
	return [...value].some(
		(character) =>
			character.charCodeAt(0) < (spaces ? 33 : 32) ||
			character.charCodeAt(0) === 127 ||
			'{}'.includes(character)
	);
}
function endpointUrl(value: string): string {
	if (value.length > 4_096 || invalidCharacters(value, true))
		throw new Error('Enter a valid server URL.');
	const url = new URL(value);
	if (
		!['http:', 'https:'].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error('Use an HTTP or HTTPS server URL without credentials, query or fragment.');
	return url.href.replace(/\/+$/, '');
}
function readConfig(home: string, relative: string): ConfigFile {
	assertSafePortablePath(home, relative, true);
	const path = join(home, relative);
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (stat && (!stat.isFile() || stat.size > 1024 * 1024))
		throw new Error(
			`Cannot edit ${relative}: expected a regular settings file smaller than 1 MiB.`
		);
	const text = stat ? readFileSync(path, 'utf8') : '{}\n';
	const errors: ParseError[] = [];
	const value = record(parse(text, errors, { allowTrailingComma: true }) as unknown);
	if (errors.length || !value)
		throw new Error(
			`Fix the invalid JSON/JSONC in ${relative} before managing AI settings. No settings were changed.`
		);
	return { value };
}
function configurations(home: string): { users: ConfigFile[]; policy: ConfigFile } {
	const users = USER_FILES.filter((path) => existsSync(join(home, path))).map((path) =>
		readConfig(home, path)
	);
	if (!users.length) users.push(readConfig(home, 'config/assistant/opencode.json'));
	return { users, policy: readConfig(home, POLICY_FILE) };
}
function definition(file: ConfigFile, provider: string): Record<string, unknown> | undefined {
	return record(record(file.value.provider)?.[provider]);
}
function editableEndpoint(value: Record<string, unknown> | undefined, managed: boolean): boolean {
	const options = record(value?.options);
	return (
		Boolean(value) &&
		!managed &&
		(!value?.npm || value.npm === '@ai-sdk/openai-compatible') &&
		!Object.hasOwn(options ?? {}, 'apiKey') &&
		typeof options?.baseURL === 'string' &&
		!/[{}]/.test(options.baseURL)
	);
}

/** Saved sign-ins, resolved native model and operator config; never a connection test. */
export async function listProviderSettings(
	home: string,
	options: Options = {}
): Promise<ProviderSettings> {
	const [providers, resolved] = await Promise.all([
		listProviders(home, options),
		readAssistantConfig(home, options)
	]);
	const disabled = new Set(providerIds(resolved.disabled_providers));
	let configurationIssue: string | undefined;
	try {
		const { users, policy } = configurations(home);
		for (const file of [...users, policy]) {
			for (const [provider, raw] of Object.entries(record(file.value.provider) ?? {})) {
				const value = record(raw);
				if (!value) continue;
				try {
					id(provider);
				} catch {
					continue;
				}
				let summary = providers.find((item) => item.id === provider);
				if (!summary) {
					summary = {
						id: provider,
						name: provider,
						source: 'config',
						modelCount: 0,
						models: [],
						configured: true,
						connected: false,
						authenticated: false,
						authMethods: []
					};
					providers.push(summary);
				}
				summary.configured = true;
				const baseURL = record(value.options)?.baseURL;
				if (typeof baseURL !== 'string' || /[{}]/.test(baseURL)) continue;
				// Never return inline credential fields or URLs with embedded secrets.
				try {
					endpointUrl(baseURL);
				} catch {
					continue;
				}
				summary.endpoint = {
					url: baseURL,
					name: typeof value.name === 'string' ? value.name : summary.name,
					models: Object.keys(record(value.models) ?? {}),
					editable: editableEndpoint(
						value,
						file === policy || Boolean(definition(policy, provider))
					)
				};
			}
		}
	} catch (error) {
		configurationIssue = error instanceof Error ? error.message : 'Cannot read saved AI settings.';
	}
	for (const provider of providers) {
		provider.disabled = disabled.has(provider.id);
		if (provider.disabled) {
			provider.connected = false;
			provider.models = [];
			provider.modelCount = 0;
		}
	}
	const selection = typeof resolved.model === 'string' ? resolved.model : '';
	const separator = selection.indexOf('/');
	return {
		providers: providers.sort((left, right) => left.name.localeCompare(right.name)),
		...(separator > 0 && separator < selection.length - 1
			? {
					currentModel: {
						provider: selection.slice(0, separator),
						model: selection.slice(separator + 1)
					}
				}
			: {}),
		...(configurationIssue ? { configurationIssue } : {})
	};
}

function providerIds(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
async function withSettingsLock<T>(home: string, run: () => Promise<T>): Promise<T> {
	const lock = acquireStackLock(join(home, 'data'));
	if (!lock) throw new Error('Another instance operation is running. Try again when it finishes.');
	try {
		return await run();
	} finally {
		releaseStackLock(lock);
	}
}
async function applyConfigChange(
	home: string,
	patch: Record<string, unknown>,
	options: Options,
	matches: (value: Record<string, unknown>) => boolean
): Promise<void> {
	await updateAssistantGlobalConfig(home, patch, options);
	// Native global updates invalidate the cache and asynchronously dispose instances.
	// Read back the resolved result, tolerating that short native reload window.
	const deadline = Date.now() + 5_000;
	do {
		try {
			if (matches(await readAssistantConfig(home, options))) return;
		} catch {
			/* the native instance may still be reloading */
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	throw new Error(
		'OpenCode saved these preferences, but their effective settings could not be confirmed. Check the agent and higher-priority managed configuration before testing or using this model.'
	);
}

/** Patch native user preferences through OpenCode, never managed policy. */
export async function saveProviderEndpoint(
	home: string,
	input: ProviderEndpointInput,
	options: Options = {}
): Promise<ProviderSettings> {
	const provider = id(input.provider);
	const model = modelId(input.model);
	const url = endpointUrl(input.url);
	if (!input.name.trim() || input.name.length > 128 || invalidCharacters(input.name))
		throw new Error('Enter a service name of up to 128 characters.');
	if (
		input.key !== undefined &&
		(!input.key || input.key.length > 16_384 || /[\r\n]/.test(input.key))
	)
		throw new Error('Enter a valid one-line API key, or leave it blank.');
	return withSettingsLock(home, async () => {
		const { users, policy } = configurations(home);
		if (definition(policy, provider))
			throw new Error(
				'This service is controlled by config/opencode/opencode.json. Edit its managed settings there.'
			);
		const existing = [...users].reverse().find((file) => definition(file, provider));
		const native = (await listProviders(home, options)).find((item) => item.id === provider);
		if (
			(native && !existing) ||
			(existing && !editableEndpoint(definition(existing, provider), false))
		)
			throw new Error(
				'Choose a new service identifier. This existing native or advanced service cannot be replaced by an endpoint form.'
			);
		const global = await readAssistantGlobalConfig(home, options);
		const previous = record(record(record(global.provider)?.[provider])?.models)?.[model];
		const patch = {
			provider: {
				[provider]: {
					name: input.name.trim(),
					options: { baseURL: url },
					models: { [model]: record(previous) ?? { name: model } }
				}
			},
			...(providerIds(global.disabled_providers).includes(provider)
				? { disabled_providers: providerIds(global.disabled_providers).filter((item) => item !== provider) }
				: {})
		};
		await applyConfigChange(home, patch, options, (value) => {
			const effective = record(record(value.provider)?.[provider]);
			return (
				record(effective?.options)?.baseURL === url && Boolean(record(effective?.models)?.[model]) &&
				!providerIds(value.disabled_providers).includes(provider)
			);
		});
		if (input.key !== undefined) await setProviderApiKey(home, provider, input.key, options);
		return listProviderSettings(home, options);
	});
}

export async function useProviderModel(
	home: string,
	providerId: string,
	selectedModel: string,
	options: Options = {}
): Promise<ProviderSettings> {
	const provider = id(providerId);
	const model = modelId(selectedModel);
	return withSettingsLock(home, async () => {
		const native = (await listProviders(home, options)).find((item) => item.id === provider);
		if (!native?.models?.some((item) => item.id === model))
			throw new Error('Choose an available model that supports text and agent tools.');
		const { policy } = configurations(home);
		const selection = `${provider}/${model}`;
		if (policy.value.model !== undefined && policy.value.model !== selection)
			throw new Error(
				'The default model is controlled by config/opencode/opencode.json. Edit its managed model setting there.'
			);
		await applyConfigChange(home, { model: selection }, options, (value) => value.model === selection);
		return listProviderSettings(home, options);
	});
}

export async function removeProviderSetup(
	home: string,
	providerId: string,
	options: Options & { endpoint?: boolean } = {}
): Promise<ProviderSettings> {
	const provider = id(providerId);
	return withSettingsLock(home, async () => {
		const settings = await listProviderSettings(home, options);
		if (settings.currentModel?.provider === provider)
			throw new Error('Choose another model for your agent before removing this setup.');
		if (options.endpoint) {
			const { users, policy } = configurations(home);
			if (definition(policy, provider))
				throw new Error(
					'This endpoint is controlled by managed settings; edit config/opencode/opencode.json instead.'
				);
			const files = users.filter((file) => definition(file, provider));
			if (
				!files.length ||
				files.some((file) => !editableEndpoint(definition(file, provider), false))
			)
				throw new Error('This advanced endpoint cannot be disabled by the simple service form.');
			const global = await readAssistantGlobalConfig(home, options);
			const disabled = [...new Set([...providerIds(global.disabled_providers), provider])];
			await applyConfigChange(home, { disabled_providers: disabled }, options, (value) =>
				providerIds(value.disabled_providers).includes(provider)
			);
		}
		if (!options.endpoint) await removeProviderAuth(home, provider, options);
		return listProviderSettings(home, options);
	});
}

// Run model discovery in the same network namespace as inference. This is an
// ordinary one-shot Node request, not a installed runtime script or new service.
const DISCOVER_MODELS = `import { readFileSync } from 'node:fs';
const {url,key}=JSON.parse(readFileSync(0,'utf8'));
try {
 const response=await fetch(url+'/models',{headers:key?{authorization:'Bearer '+key}:{},signal:AbortSignal.timeout(8000),redirect:'error'});
 if(!response.ok){console.log(JSON.stringify({error:'Server returned HTTP '+response.status+'. Check its URL and API key.'}));process.exit(1);}
 const reader=response.body.getReader();let size=0;const chunks=[];
 for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>1048576){await reader.cancel();throw new Error('Response too large');}chunks.push(Buffer.from(value));}
 const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 const models=Array.isArray(body.data)?body.data.flatMap(item=>typeof item.id==='string'&&item.id.length>0&&item.id.length<=512&&!/[\\x00-\\x1f\\x7f{}]/.test(item.id)?[item.id]:[]).slice(0,1000):[];
 console.log(JSON.stringify({models:[...new Set(models)].sort()}));
} catch { console.log(JSON.stringify({error:'The agent could not read models from this server. Check its address, network access and OpenAI-compatible /models API, or enter a model ID manually.'}));process.exit(1); }`;

export async function discoverProviderModels(
	home: string,
	input: { url: string; key?: string },
	options: { run?: typeof runDocker } = {}
): Promise<string[]> {
	const url = endpointUrl(input.url);
	if (input.key !== undefined && (input.key.length > 16_384 || /[\r\n]/.test(input.key)))
		throw new Error('Invalid API key.');
	const state = createFholdState(home);
	const result = await (options.run ?? runDocker)(
		[
			'compose',
			...buildComposeCliArgs(state),
			'exec',
			'-T',
			'assistant',
			'node',
			'--input-type=module',
			'-e',
			DISCOVER_MODELS
		],
		{
			timeoutMs: 12_000,
			maxOutputBytes: 1024 * 1024,
			env: composeProcessEnvironment(buildComposeOptions(state).envFiles),
			input: JSON.stringify({ url, ...(input.key ? { key: input.key } : {}) })
		}
	);
	let value: Record<string, unknown> | undefined;
	try {
		value = record(JSON.parse(result.stdout) as unknown);
	} catch {
		/* never expose raw server or command output */
	}
	if (!result.ok || !Array.isArray(value?.models))
		throw new Error(
			typeof value?.error === 'string'
				? value.error
				: 'Model discovery could not run. Start the agent and check that the server is reachable from its container.'
		);
	return value.models.filter((item): item is string => typeof item === 'string').map(modelId);
}

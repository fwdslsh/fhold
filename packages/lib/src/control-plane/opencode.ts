import { existsSync, readFileSync } from 'node:fs';
import {
	createNativeAgentService,
	type AssistantReadiness,
	type NativeAgentRequestOptions,
	type ProviderAuthMethod,
	type ProviderAuthPrompt,
	type ProviderOAuthAuthorization,
	type ProviderSummary
} from './native-agent.js';
import { readStackConfig } from './stack-config.js';
import { stateSecretFile } from './foundation.js';

export type {
	AssistantReadiness,
	NativeAgentRequestOptions,
	ProviderAuthMethod,
	ProviderAuthPrompt,
	ProviderOAuthAuthorization,
	ProviderSummary
};

type Options = NativeAgentRequestOptions;
export function assistantEndpoint(home: string): string {
	const result = readStackConfig(home);
	if (!result.ok) throw new Error(result.error);
	const bind = result.config.assistant.bindAddress;
	const address = bind === '0.0.0.0' ? '127.0.0.1' : bind === '::' ? '::1' : bind;
	return `http://${address.includes(':') ? `[${address}]` : address}:${result.config.assistant.port}`;
}
/** Basic authorization for a local home's native OpenCode password file. */
export function localAuthorization(home: string): string {
	const path = stateSecretFile(home, 'fhold_opencode_password');
	if (!existsSync(path)) throw new Error(`OpenCode password is missing: ${path}`);
	const password = readFileSync(path, 'utf8').replace(/[\r\n]+$/, '');
	if (!password) throw new Error('OpenCode password is empty');
	return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}
/** A local home's native agent on its configured loopback route. */
export function localNativeAgent(home: string, options: Options = {}) {
	return createNativeAgentService(
		{ endpoint: assistantEndpoint(home), authorization: () => localAuthorization(home) },
		options
	);
}

export async function listProviders(
	home: string,
	options: Options = {}
): Promise<ProviderSummary[]> {
	return localNativeAgent(home, options).listProviders(options);
}
export async function setProviderApiKey(
	home: string,
	provider: string,
	key: string,
	options: Options = {}
): Promise<void> {
	return localNativeAgent(home, options).setProviderApiKey(provider, key, options);
}
/** Native normalized documents in precedence order; never invent provider configuration. */
export async function readAssistantConfig(
	home: string,
	options: Options = {}
): Promise<Record<string, unknown>> {
	return localNativeAgent(home, options).readConfig(options);
}
export async function removeProviderAuth(
	home: string,
	provider: string,
	options: Options = {}
): Promise<void> {
	return localNativeAgent(home, options).removeProviderAuth(provider, options);
}
export async function waitForAssistant(
	home: string,
	options: Options & { intervalMs?: number } = {}
): Promise<void> {
	return localNativeAgent(home, options).waitForReady(options);
}
export async function testAssistantReadiness(
	home: string,
	options: Options & { provider?: string; model?: string } = {}
): Promise<AssistantReadiness> {
	return localNativeAgent(home, options).testReadiness(options);
}


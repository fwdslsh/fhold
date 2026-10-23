/** Transport-neutral native-agent data transfer objects. */
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
	| { ok: true; response: string; provider?: string; model?: string; warning?: string }
	| { ok: false; error: string };
export type NativeAgentService = {
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

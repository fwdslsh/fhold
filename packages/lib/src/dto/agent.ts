/** Native-agent data transfer objects; HTTP client mechanics live in control-plane/native-agent. */
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

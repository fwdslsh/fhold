// Renderer-only state. Secrets remain transient and are never persisted here.
export function createAdminState() {
	return {
		api: null,
		currentConfig: null,
		currentSnapshot: null,
		currentView: 'overview',
		instancesDirectory: '',
		recentInstances: [],
		snapshotPromise: undefined,
		installationReadiness: undefined,
		setupCheckPromise: undefined,
		providerSummaries: [],
		providersLoaded: false,
		providerLoadPromise: undefined,
		providerCatalogExpanded: false,
		activeOAuth: null,
		operationInFlight: false,
		disabledButtons: [],
		noticeTimer: undefined,
		restorePreviewSignature: null,
		restorePreviewDigest: null,
		instanceRestorePreview: null,
		lastReadiness: null,
		lastReadinessProvider: null,
		lastReadinessAuthSaved: false,
		awaitingSetupFinish: false,
		renderingSnapshot: false,
		dirtyForms: new Set()
	};
}

export const state = createAdminState();

export const managedFormIds = [
	'mcp-connections-form',
	'discord-connections-form',
	'slack-connections-form',
	'discord-token-form',
	'slack-token-form',
	'claude-permissions-form',
	'mcp-permissions-form',
	'permissions-form',
	'opencode-network-form',
	'mcp-network-form',
	'runtime-recovery-form'
];

export const commonProviders = new Set([
	'anthropic',
	'openai',
	'google',
	'github-copilot',
	'github',
	'opencode',
	'openrouter'
]);

export const policyLabels = {
	chat: 'Chat only',
	read: 'Read files',
	full: 'Full access'
};

export const viewMeta = {
	overview: {
		kicker: 'PERSONAL AGENT',
		title: 'Your fhold',
		description: 'Your agent and its connections, at a glance.'
	},
	provider: {
		kicker: 'AI CONNECTION',
		title: 'Agent settings',
		description: 'Connect and check the AI accounts your agent can use.'
	},
	connections: {
		kicker: 'YOUR APPS',
		title: 'Apps',
		description: 'Choose the app you want to use with your agent.'
	},
	system: {
		kicker: 'SYSTEM',
		title: 'System',
		description: 'Installation details, logs, import / export, and ephemeral container support.'
	}
};

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
		automaticReadinessAttempted: false,
		activeOAuth: null,
		operationInFlight: false,
		disabledButtons: [],
		noticeTimer: undefined,
		restorePreviewSignature: null,
		restorePreviewDigest: null,
		instanceRestorePreview: null,
		lastReadiness: null,
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
	'discord-mapping-form',
	'slack-mapping-form',
	'access-form',
	'opencode-network-form',
	'mcp-network-form',
	'runtime-recovery-form',
	'preferences-form'
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
	chat: 'Conversation only',
	read: 'Read files',
	full: 'Full control'
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
		description: 'AI account, memory, and recurring work.'
	},
	connections: {
		kicker: 'YOUR APPS',
		title: 'Connections',
		description: 'Choose the app you want to use with your agent.'
	},
	access: {
		kicker: 'PEOPLE & PERMISSIONS',
		title: 'People & access',
		description: 'Give each person or app its own key and access level.'
	},
	system: {
		kicker: 'SYSTEM',
		title: 'System',
		description: 'Installation details, logs, import / export, and ephemeral container support.'
	}
};

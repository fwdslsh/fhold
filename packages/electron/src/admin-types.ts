import type {
	AssistantReadiness,
	BackupManifest,
	InstanceBackupManifest,
	InstanceRestorePlan,
	ConnectionDetails,
	RestorePlan,
	ProviderOAuthAuthorization,
	ProviderSummary,
	RestartStatus,
	StackConfig
} from '@fhold/lib';
import type { recoverySnapshot } from '@fhold/lib';
import type { RemoteProgress, RemoteTool, CodexSandbox } from '@fhold/lib';
import type { CodexRecallReview } from '@fhold/lib';

export type AdminSnapshot = {
	phase: 'not_installed' | 'setup_incomplete' | 'ready';
	homeDir: string;
	configPath: string;
	config: StackConfig;
	services: Array<{
		name: string;
		state: string;
		health: string;
	}>;
	dockerError?: string;
	installationReadiness?: { ok: boolean; message?: string };
	portalMappings: Record<string, { default: string; users: Record<string, string> }>;
	portalSecrets: Record<string, Record<string, boolean>>;
	connectionDetails?: {
		opencode: ConnectionDetails;
		mcp: ConnectionDetails;
		claude: ConnectionDetails;
	};
	codexRecall?: CodexRecallReview;
	codexRecallError?: string;
	pendingRestart?: RestartStatus;
	recovery?: ReturnType<typeof recoverySnapshot>;
	recoveryError?: string;
};

export type StackAction = 'start' | 'restart' | 'stop';
export type InterruptingAction = StackAction | 'remote-setup' | 'recovery-init' | 'recovery-restore' | 'instance-export' | 'instance-import';

export type AdminInstance = { kind: 'local'; homeDir: string };
export type AdminWelcomeInstance = AdminInstance & { name?: string; available: boolean };
export type AdminWelcome = {
	defaultInstance: AdminWelcomeInstance;
	instancesDirectory: string;
	recentInstances: AdminWelcomeInstance[];
	selectedInstance?: AdminInstance;
	preferenceError?: string;
};

export type AdminApi = {
	welcome(): Promise<AdminWelcome>;
	openInstance(target: AdminInstance): Promise<void>;
	prepareNewInstance(target: AdminInstance & { name?: string }): Promise<void>;
	closeInstance(): Promise<void>;
	installationReadiness(): Promise<NonNullable<AdminSnapshot['installationReadiness']>>;
	codexRecall(value: {
		action: 'review' | 'approve' | 'disable';
		digest?: string;
		confirmed?: boolean;
	}): Promise<CodexRecallReview>;
	remote(value: {
		action: 'enable' | 'progress' | 'input' | 'cancel' | 'disable' | 'connection';
		tool: RemoteTool;
		trusted?: boolean;
		sandbox?: CodexSandbox;
		input?: string;
		restartConfirmed?: boolean;
	}): Promise<RemoteProgress>;
	snapshot(): Promise<AdminSnapshot>;
	selectedHome(): Promise<string>;
	install(config: StackConfig, automaticPorts?: boolean): Promise<AdminSnapshot>;
	saveConfig(value: { config: StackConfig; baseConfig: StackConfig }): Promise<AdminSnapshot>;
	confirmRestart(action: InterruptingAction): Promise<boolean>;
	action(action: StackAction, confirmed?: boolean): Promise<AdminSnapshot>;
	logs(): Promise<string>;
	providers(): Promise<ProviderSummary[]>;
	providerKey(value: { provider: string; key: string }): Promise<AssistantReadiness>;
	providerOAuthStart(value: {
		provider: string;
		method: number;
		inputs?: Record<string, string>;
	}): Promise<ProviderOAuthAuthorization>;
	providerOAuthFinish(value: {
		provider: string;
		method: number;
		code?: string;
	}): Promise<AssistantReadiness>;
	readiness(value?: { provider?: string }): Promise<AssistantReadiness>;
	assistantPassword(): Promise<{ password: string }>;
	copyText(value: string): Promise<void>;
	openExternal(value: string): Promise<void>;
	chooseDirectory(value: {
		purpose: 'backup' | 'restore' | 'instance' | 'new-instance' | 'recovery';
	}): Promise<string | undefined>;
	credential(value: {
		action: 'create' | 'rotate' | 'remove';
		username: string;
		policy?: string;
	}): Promise<AdminSnapshot>;
	credentialKey(username: string): Promise<{ username: string; key: string }>;
	mapPortalUser(value: {
		portal: 'discord' | 'slack';
		userId: string;
		username?: string;
	}): Promise<AdminSnapshot>;
	portalToken(value: {
		portal: 'discord' | 'slack';
		botToken?: string;
		appToken?: string;
	}): Promise<AdminSnapshot>;
	backup(value: {
		destination: string;
		full?: boolean;
		confirmed?: boolean;
		includeProviderAuth?: boolean;
		includeUserEnv?: boolean;
		includePortalMaps?: boolean;
		includeOAuth?: boolean;
	}): Promise<BackupManifest | InstanceBackupManifest>;
	restoreInstance(value: {
		sourceHome: string;
		apply?: boolean;
		previewDigest?: string;
		confirmed?: boolean;
	}): Promise<InstanceRestorePlan>;
	recovery(value: { action: 'save'; settings: unknown; selection: unknown; baselineDigest: string } | { action: 'credential'; connectionString: string } | { action: 'status' | 'inspect' | 'init' | 'restore'; confirmed?: boolean }): Promise<AdminSnapshot | Record<string, unknown> | string>;
	restoreData(value: {
		sourceHome: string;
		apply?: boolean;
		previewDigest?: string;
		acknowledgeUnrestored?: boolean;
		includeProviderAuth?: boolean;
		includeUserEnv?: boolean;
		includePortalMaps?: boolean;
		includeOAuth?: boolean;
	}): Promise<RestorePlan>;
};

export const ADMIN_CHANNELS = {
	welcome: 'admin:welcome',
	openInstance: 'admin:open-instance',
	prepareNewInstance: 'admin:prepare-new-instance',
	closeInstance: 'admin:close-instance',
	installationReadiness: 'admin:installation-readiness',
	codexRecall: 'admin:codex-recall',
	remote: 'admin:remote',
	snapshot: 'admin:snapshot',
	selectedHome: 'admin:selected-home',
	install: 'admin:install',
	saveConfig: 'admin:save-config',
	action: 'admin:action',
	confirmRestart: 'admin:confirm-restart',
	logs: 'admin:logs',
	providers: 'admin:providers',
	providerKey: 'admin:provider-key',
	providerOAuthStart: 'admin:provider-oauth-start',
	providerOAuthFinish: 'admin:provider-oauth-finish',
	readiness: 'admin:readiness',
	assistantPassword: 'admin:assistant-password',
	copyText: 'admin:copy-text',
	openExternal: 'admin:open-external',
	chooseDirectory: 'admin:choose-directory',
	credential: 'admin:credential',
	credentialKey: 'admin:credential-key',
	mapPortalUser: 'admin:map-portal-user',
	portalToken: 'admin:portal-token',
	backup: 'admin:backup',
	restoreInstance: 'admin:restore-instance',
	recovery: 'admin:recovery',
	restoreData: 'admin:restore'
} as const;

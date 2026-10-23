import type {
	AssistantReadiness,
	BackupManifest,
	InstanceBackupManifest,
	InstanceRestorePlan,
	RestorePlan,
	ProviderOAuthAuthorization,
	ProviderSettings,
	ProviderEndpointInput,
	StackConfig
} from '@fhold/lib';
import type { HostingConnection, InstanceRef, InstanceSummary, ConnectionCheck } from '@fhold/lib';
import type { HostingChoice, HostingLogOptions } from '@fhold/lib';
import type { RemoteProgress, RemoteTool, CodexSandbox } from '@fhold/lib';
import type { CodexRecallReview } from '@fhold/lib';
import type { InstanceSnapshot } from '@fhold/lib';
import type { AdminSettings } from './admin-settings.js';
import type { AdminAppSnapshot } from './admin-updates.js';

export type AdminSnapshot = InstanceSnapshot;

export type StackAction = 'start' | 'restart' | 'stop';
export type InterruptingAction =
	| StackAction
	| 'update'
	| 'remote-setup'
	| 'recovery-init'
	| 'recovery-restore'
	| 'instance-export'
	| 'instance-import';

export type AdminInstance = { kind: 'local'; homeDir: string };
export type AdminTarget = AdminInstance | { kind: 'hosted'; ref: InstanceRef };
export type AdminWelcomeInstance = AdminTarget & { name?: string; available: boolean };
export type AdminWelcome = {
	defaultInstance: AdminInstance & { name?: string; available: boolean };
	instancesDirectory: string;
	recentInstances: AdminWelcomeInstance[];
	selectedInstance?: AdminTarget;
	preferenceError?: string;
};

export type AdminApi = {
	appSettings(): Promise<AdminAppSnapshot>;
	saveAppSettings(value: AdminSettings): Promise<AdminAppSnapshot>;
	checkAppUpdate(): Promise<AdminAppSnapshot>;
	downloadAppUpdate(): Promise<AdminAppSnapshot>;
	installAppUpdate(): Promise<void>;
	onAppUpdate(listener: (snapshot: AdminAppSnapshot) => void): () => void;
	hostingFeatures(id: string): Promise<{ installation: boolean; emptyHint?: string }>;
	hostingSetup(value: {
		provider: HostingConnection['kind'];
		action: 'sign-in' | 'choices';
		field?: string;
		values?: Record<string, string>;
	}): Promise<HostingChoice[] | undefined>;
	directory(value?: string): Promise<import('@fhold/lib').DirectoryListing>;
	hostingInfo(id: string): Promise<{ instancesDirectory: string; defaultHome: string }>;
	hostingDirectory(value: {
		connectionId: string;
		path?: string;
	}): Promise<import('@fhold/lib').DirectoryListing>;
	update(value: { confirmed: boolean; pull?: boolean }): Promise<AdminSnapshot>;
	hostingConnections(): Promise<HostingConnection[]>;
	hostingSaveConnection(value: unknown): Promise<HostingConnection>;
	hostingUpdateConnection(id: string, value: unknown): Promise<HostingConnection | undefined>;
	hostingRemoveConnection(id: string): Promise<boolean>;
	hostingCheckConnection(id: string): Promise<ConnectionCheck>;
	hostingRepairConnection(id: string): Promise<string | undefined>;
	hostingInstances(connectionId: string): Promise<InstanceSummary[]>;
	welcome(): Promise<AdminWelcome>;
	openInstance(target: AdminTarget): Promise<void>;
	prepareNewInstance(target: AdminTarget & { name?: string }): Promise<void>;
	closeInstance(): Promise<void>;
	installationReadiness(connectionId?: string): Promise<{ ok: boolean; message?: string }>;
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
		confirmed?: boolean;
	}): Promise<RemoteProgress>;
	snapshot(): Promise<AdminSnapshot>;
	selectedHome(): Promise<string>;
	install(config: StackConfig, automaticPorts?: boolean): Promise<AdminSnapshot>;
	saveConfig(value: { config: StackConfig; baseConfig: StackConfig }): Promise<AdminSnapshot>;
	confirmRestart(action: InterruptingAction): Promise<boolean>;
	action(action: StackAction, confirmed?: boolean): Promise<AdminSnapshot>;
	logs(options?: HostingLogOptions): Promise<string>;
	providers(): Promise<ProviderSettings>;
	providerKey(value: { provider: string; key: string }): Promise<void>;
	providerEndpoint(value: ProviderEndpointInput): Promise<ProviderSettings>;
	providerModels(value: { url: string; key?: string }): Promise<string[]>;
	providerUse(value: { provider: string; model: string }): Promise<ProviderSettings>;
	providerRemove(value: { provider: string; endpoint?: boolean }): Promise<ProviderSettings>;
	providerOAuthStart(value: {
		provider: string;
		method: number;
		inputs?: Record<string, string>;
	}): Promise<ProviderOAuthAuthorization>;
	providerOAuthFinish(value: { provider: string; method: number; code?: string }): Promise<void>;
	readiness(value?: { provider?: string; model?: string }): Promise<AssistantReadiness>;
	connectAgent(value?: { password?: string }): Promise<{ endpoint: string; username?: string }>;
	assistantPassword(): Promise<{ password: string }>;
	copyText(value: string): Promise<void>;
	openExternal(value: string): Promise<void>;
	chooseDirectory(value: {
		purpose: 'backup' | 'restore' | 'instance' | 'new-instance' | 'recovery';
	}): Promise<string | undefined>;
	credential(value: {
		action: 'create' | 'rotate' | 'remove' | 'policy';
		username: string;
		policy?: string;
		previousPolicy?: string;
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
	recovery(
		value:
			| { action: 'save'; settings: unknown; selection: unknown; baselineDigest: string }
			| { action: 'credential'; connectionString: string }
			| { action: 'status' | 'inspect' | 'init' | 'restore'; confirmed?: boolean }
	): Promise<AdminSnapshot | Record<string, unknown> | string>;
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
	appSettings: 'admin:app-settings',
	saveAppSettings: 'admin:save-app-settings',
	checkAppUpdate: 'admin:check-app-update',
	downloadAppUpdate: 'admin:download-app-update',
	installAppUpdate: 'admin:install-app-update',
	appUpdateChanged: 'admin:app-update-changed',
	hostingFeatures: 'admin:hosting-features',
	hostingSetup: 'admin:hosting-setup',
	directory: 'admin:directory',
	hostingInfo: 'admin:hosting-info',
	hostingDirectory: 'admin:hosting-directory',
	update: 'admin:update',
	hostingConnections: 'admin:hosting-connections',
	hostingSaveConnection: 'admin:hosting-save-connection',
	hostingUpdateConnection: 'admin:hosting-update-connection',
	hostingRemoveConnection: 'admin:hosting-remove-connection',
	hostingCheckConnection: 'admin:hosting-check-connection',
	hostingRepairConnection: 'admin:hosting-repair-connection',
	hostingInstances: 'admin:hosting-instances',
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
	providerEndpoint: 'admin:provider-endpoint',
	providerModels: 'admin:provider-models',
	providerUse: 'admin:provider-use',
	providerRemove: 'admin:provider-remove',
	providerOAuthStart: 'admin:provider-oauth-start',
	providerOAuthFinish: 'admin:provider-oauth-finish',
	readiness: 'admin:readiness',
	connectAgent: 'admin:connect-agent',
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

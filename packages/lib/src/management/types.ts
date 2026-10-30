import { type ConnectionDetails } from '../control-plane/connection.js';
import { type RestartStatus } from '../control-plane/runtime-revision.js';
import { type StackConfig } from '../control-plane/stack-config.js';
import type { InstanceRef } from '../hosting/types.js';
import { type recoverySnapshot } from '../control-plane/recovery.js';
import { type CodexRecallReview } from '../control-plane/codex-recall.js';
import type { BackupManifest } from '../control-plane/backup.js';
import type {
	InstanceBackupManifest,
	InstanceRestorePlan
} from '../control-plane/instance-backup.js';
import type { RestorePlan } from '../control-plane/restore.js';
import type { recoveryStatus, runRecoveryOperation } from '../control-plane/recovery.js';
import type {
	ProviderEndpointInput,
	ProviderSettings
} from '../control-plane/provider-settings.js';
import type {
	AssistantReadiness,
	ProviderOAuthAuthorization
} from '../control-plane/native-agent.js';
import type {
	BackupRequest,
	CodexRecallRequest,
	CredentialCreateRequest,
	CredentialMutationRequest,
	CredentialPolicyRequest,
	DirectoryListing,
	PortalTokenRequest,
	PortalUserMappingRequest,
	RecoveryCredentialRequest,
	RecoverySaveRequest,
	RemoteSetupResult,
	RemoteSetupRequest,
	RestoreRequest
} from './contracts.js';
type LegacyBackupRequest = BackupRequest & { confirmed?: boolean };
type LegacyRestoreRequest = RestoreRequest & { confirmed?: boolean };
type LegacyCodexRecallRequest = CodexRecallRequest & { confirmed?: boolean };
type LegacyRemoteSetupRequest = RemoteSetupRequest & { restartConfirmed?: boolean };
type LegacyRecoveryRequest =
	| { action: 'status' }
	| { action: 'inspect' | 'init' | 'restore'; confirmed?: boolean }
	| ({ action: 'save' } & RecoverySaveRequest)
	| ({ action: 'credential' } & RecoveryCredentialRequest);
export type { DirectoryListing } from './contracts.js';
export type ManagedSnapshot = {
	target?: Extract<InstanceRef, { kind: 'ssh-docker' }>;
	connectionLabel?: string;
	connectionError?: string;
	phase: 'not_installed' | 'setup_incomplete' | 'ready';
	homeDir: string;
	configPath: string;
	config: StackConfig;
	/** Runtime image cohort included with the CLI managing this target, not a registry lookup. */
	updateImageTag?: string;
	services: Array<{
		name: string;
		image?: string;
		state: string;
		health: string;
		warnings?: string[];
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
export const MANAGEMENT_METHODS = [
	'directory',
	'codexRecall',
	'remote',
	'snapshot',
	'install',
	'saveConfig',
	'action',
	'logs',
	'providers',
	'providerKey',
	'providerEndpoint',
	'providerModels',
	'providerUse',
	'providerRemove',
	'providerOAuthStart',
	'providerOAuthFinish',
	'readiness',
	'assistantPassword',
	'knowledgeUi',
	'credential',
	'credentialKey',
	'mapPortalUser',
	'portalToken',
	'backup',
	'recovery',
	'restoreData',
	'restoreInstance',
	'update',
	'transferCreate',
	'transferRelease',
	'transferPack',
	'transferUnpack'
] as const;
export type ManagementMethod = (typeof MANAGEMENT_METHODS)[number];

/**
 * The fixed SSH/stdin envelope's compatibility map. Values still arrive as
 * untrusted JSON and are validated by the named domain operation before use.
 * Keep these method names and request shapes while peers advertise them.
 */
export type ManagementRequestMap = {
	directory: { input: string | undefined; result: DirectoryListing; extra: [] };
	codexRecall: { input: LegacyCodexRecallRequest; result: CodexRecallReview; extra: [] };
	remote: { input: LegacyRemoteSetupRequest; result: RemoteSetupResult; extra: [] };
	snapshot: { input: undefined; result: ManagedSnapshot; extra: [] };
	install: { input: StackConfig; result: ManagedSnapshot; extra: [automaticPorts?: boolean] };
	saveConfig: {
		input: { config: StackConfig; baseConfig: StackConfig };
		result: ManagedSnapshot;
		extra: [];
	};
	action: {
		input: { action: StackAction; confirmed: boolean };
		result: ManagedSnapshot;
		extra: [];
	};
	logs: { input: undefined; result: string; extra: [] };
	providers: { input: undefined; result: ProviderSettings; extra: [] };
	providerKey: { input: { provider: string; key: string }; result: void; extra: [] };
	providerEndpoint: { input: ProviderEndpointInput; result: ProviderSettings; extra: [] };
	providerModels: { input: { url: string; key?: string }; result: string[]; extra: [] };
	providerUse: { input: { provider: string; model: string }; result: ProviderSettings; extra: [] };
	providerRemove: {
		input: { provider: string; endpoint?: boolean };
		result: ProviderSettings;
		extra: [];
	};
	providerOAuthStart: {
		input: { provider: string; method: number; inputs?: Record<string, string> };
		result: ProviderOAuthAuthorization;
		extra: [];
	};
	providerOAuthFinish: {
		input: { provider: string; method: number; inputs?: Record<string, string>; code?: string };
		result: void;
		extra: [];
	};
	readiness: {
		input: { provider?: string; model?: string } | undefined;
		result: AssistantReadiness;
		extra: [];
	};
	assistantPassword: { input: undefined; result: { password: string }; extra: [] };
	knowledgeUi: { input: undefined; result: { url: string }; extra: [] };
	credential: {
		input:
			| ({ action: 'create' } & CredentialCreateRequest)
			| ({ action: 'policy' } & CredentialPolicyRequest)
			| ({ action: 'rotate' | 'remove' } & CredentialMutationRequest);
		result: ManagedSnapshot;
		extra: [];
	};
	credentialKey: { input: string; result: { username: string; key: string }; extra: [] };
	mapPortalUser: { input: PortalUserMappingRequest; result: ManagedSnapshot; extra: [] };
	portalToken: { input: PortalTokenRequest; result: ManagedSnapshot; extra: [] };
	backup: {
		input: LegacyBackupRequest;
		result: BackupManifest | InstanceBackupManifest;
		extra: [];
	};
	recovery: {
		input: LegacyRecoveryRequest;
		result:
			| Awaited<ReturnType<typeof recoveryStatus>>
			| Awaited<ReturnType<typeof runRecoveryOperation>>;
		extra: [];
	};
	restoreData: { input: LegacyRestoreRequest; result: RestorePlan; extra: [] };
	restoreInstance: { input: LegacyRestoreRequest; result: InstanceRestorePlan; extra: [] };
	update: { input: { confirmed: boolean; pull?: boolean }; result: ManagedSnapshot; extra: [] };
	transferCreate: { input: undefined; result: string; extra: [] };
	transferRelease: { input: string; result: void; extra: [] };
	transferPack: { input: string; result: string; extra: [] };
	transferUnpack: { input: string; result: string; extra: [] };
};
export type ManagementRequestArgs<M extends ManagementMethod> =
	ManagementRequestMap[M]['input'] extends undefined
		? [value?: ManagementRequestMap[M]['input'], ...extra: ManagementRequestMap[M]['extra']]
		: [value: ManagementRequestMap[M]['input'], ...extra: ManagementRequestMap[M]['extra']];
export interface InstanceManagement {
	call<M extends ManagementMethod>(
		method: M,
		...args: ManagementRequestArgs<M>
	): Promise<ManagementRequestMap[M]['result']>;
	busy(): boolean;
	close(): Promise<void>;
}

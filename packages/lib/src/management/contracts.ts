import type { RestartStatus } from '../control-plane/runtime-revision.js';
import type { StackConfig } from '../control-plane/stack-config.js';
import type { GuardianPolicy } from '../control-plane/stack-config.js';
import type { BackupManifest } from '../control-plane/backup.js';
import type {
	InstanceBackupManifest,
	InstanceRestorePlan
} from '../control-plane/instance-backup.js';
import type { RestorePlan } from '../control-plane/restore.js';
import type { CodexRecallReview } from '../control-plane/codex-recall.js';
import type { RemoteProgress } from '../control-plane/remote.js';
import type {
	recoverySnapshot,
	recoveryStatus,
	runRecoveryOperation
} from '../control-plane/recovery.js';
import type {
	ProviderEndpointInput,
	ProviderSettings
} from '../control-plane/provider-settings.js';
import type {
	AssistantReadiness,
	ProviderOAuthAuthorization,
	ProviderSummary
} from './agent-access.js';
import type {
	HostingAction,
	HostingActionOptions,
	HostingActionEffect,
	HostingLogOptions,
	HostingResult,
	HostingSnapshot,
	InstanceRef
} from '../hosting/types.js';

/** A fact observed without treating an unavailable optional source as absence. */
export type Observation<T> =
	| { state: 'known'; value: T; observedAt: string }
	| { state: 'not-inspected'; reason: string }
	| { state: 'unavailable'; reason: string; lastKnown?: { value: T; observedAt: string } }
	| { state: 'unsupported'; reason: string };

export type Remedy = { label: string; detail?: string };
export type Availability =
	| { state: 'ready' }
	| { state: 'unavailable'; reason: string; remedy?: Remedy };

/**
 * Carries only request lifetime and confirmed user intent. It deliberately has
 * no provider, instance directory, shell command, or arbitrary transport data.
 */
export type RequestContext = {
	signal?: AbortSignal;
	confirmed?: boolean;
};

export type Operation<Input, Output> =
	| { support: 'unsupported'; reason: string }
	| { support: 'unknown'; reason: string }
	| {
			support: 'supported';
			input?: { requiresPassword?: boolean };
			readonly effect?: HostingActionEffect;
			availability(): Availability;
			invoke(input: Input, context: RequestContext): Promise<Output>;
	  };

export type OperationDescription =
	| { support: 'unsupported' | 'unknown'; reason: string }
	| {
			support: 'supported';
			availability: Availability;
			input?: { requiresPassword?: boolean };
			effect?: HostingActionEffect;
	  };

export type InstanceIdentity = {
	ref: InstanceRef;
	name: string;
	location: string;
};

export type DeploymentObservation = {
	state?: string;
	warnings: string[];
	revisions?: Array<{ name: string; active: boolean; replicas?: number; health: string }>;
	providerLabel?: string;
	guidance?: { access?: string; client?: string; restart?: string };
	clientUrl?: string;
	portalUrl?: string;
	logSources?: Array<{ type: 'system' | 'console'; label: string }>;
	containers?: HostingSnapshot['containers'];
};

export type ServiceInventory = HostingSnapshot['services'];

/** Docker-host implementation details; never synthesize this for an ACA target. */
export type DockerInstanceSubview = {
	homeDir: string;
	configPath: string;
	config: StackConfig;
	pendingRestart?: RestartStatus;
	updateImageTag?: string;
	installationReadiness?: { ok: boolean; message?: string };
};

/** Installation is distinct from deployment status and native-agent readiness. */
export type InstanceLifecycle =
	| 'not-installed'
	| 'setup-incomplete'
	| 'ready'
	| 'externally-managed';

export type AgentObservations = {
	access: Observation<{ endpoint: string; username?: string }>;
	account: Observation<{ signedIn: boolean }>;
	models: Observation<{ provider?: string; model?: string }>;
	readiness: Observation<{ ready: boolean; detail?: string }>;
};

export type AppConfiguration = {
	credentials: Record<string, { policy: GuardianPolicy }>;
	portalMappings: Record<string, { default: string; users: Record<string, string> }>;
	portalSecrets: Record<string, Record<string, boolean>>;
};
export type AppObservations = {
	config: Observation<AppConfiguration>;
	status: Observation<Record<string, { configured: boolean; running?: boolean }>>;
	connections: Observation<AppConnections>;
};
/** Public reachable client links only; never keys, passwords or credential-file paths. */
export type AppConnection = {
	url: string;
	username?: string;
	credential?: string;
	extension?: string;
	note: string;
};
export type AppConnections = {
	opencode?: AppConnection;
	mcp?: AppConnection;
	claude?: AppConnection;
	error?: string;
};
export type DataObservations = {
	/** Saved recovery intent, never connection-string material. */
	recovery: Observation<ReturnType<typeof recoverySnapshot>>;
};

/**
 * The provider-neutral page snapshot. The optional Docker subview contains
 * local Compose intent only; it is not a fake universal filesystem contract.
 */
export type InstanceSnapshot = {
	identity: InstanceIdentity;
	lifecycle: Observation<InstanceLifecycle>;
	deployment: Observation<DeploymentObservation>;
	services: Observation<ServiceInventory>;
	operations: Record<string, OperationDescription>;
	pendingChanges: Observation<{ pending: boolean; detail?: string }>;
	agent: AgentObservations;
	apps: AppObservations;
	data: DataObservations;
	docker?: DockerInstanceSubview;
};

export type HostOperations = {
	inspect: Operation<void, HostingSnapshot>;
	start: Operation<void, LifecycleOutcome>;
	stop: Operation<void, LifecycleOutcome>;
	restart: Operation<HostingActionOptions | undefined, LifecycleOutcome>;
	logs: Operation<HostingLogOptions | undefined, string>;
	console: Operation<
		Pick<HostingLogOptions, 'revision' | 'replica' | 'container'> | undefined,
		void
	>;
};

export type LifecycleOutcome =
	| { state: 'accepted'; scope: 'request-accepted'; reference?: string }
	| { state: 'completed'; scope: 'deployment-reconciled'; result: HostingResult }
	| { state: 'failed'; scope: 'request-accepted' | 'deployment-reconciled'; reason: string }
	| { state: 'unknown'; scope: 'request-accepted' | 'deployment-reconciled'; reason: string };

/** Stage-one slots are intentionally narrow; later services fill them one at a time. */
export type AgentOperations = {
	connect: Operation<{ password?: string }, { endpoint: string; username?: string }>;
	providers: Operation<void, ProviderSettings>;
	setKey: Operation<{ provider: string; key: string }, void>;
	saveEndpoint: Operation<ProviderEndpointInput, ProviderSettings>;
	discoverModels: Operation<{ url: string; key?: string }, string[]>;
	selectModel: Operation<{ provider: string; model: string }, ProviderSettings>;
	removeProvider: Operation<{ provider: string; endpoint?: boolean }, ProviderSettings>;
	oauthStart: Operation<
		{ provider: string; method: number; inputs?: Record<string, string> },
		ProviderOAuthAuthorization
	>;
	oauthFinish: Operation<
		{ provider: string; method: number; inputs?: Record<string, string>; code?: string },
		void
	>;
	readiness: Operation<{ provider?: string; model?: string }, AssistantReadiness>;
	assistantPassword: Operation<void, { password: string }>;
	remote: Operation<RemoteSetupRequest, RemoteSetupResult>;
	codexRecall: Operation<CodexRecallRequest, CodexRecallResult>;
	modelInventory: Operation<void, ProviderSummary[]>;
};

export type RemoteSetupRequest = {
	action: 'connection' | 'enable' | 'disable' | 'input' | 'cancel' | 'progress';
	tool: 'claude' | 'codex';
	trusted?: boolean;
	sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
	restartConfirmed?: boolean;
	input?: string;
};
export type RemoteSetupResult = RemoteProgress;
export type CodexRecallRequest =
	| { action: 'review' }
	| { action: 'approve' | 'disable'; digest: string; confirmed?: boolean };
export type CodexRecallResult = CodexRecallReview;

export type CredentialCreateRequest = { username: string; policy: GuardianPolicy };
export type CredentialMutationRequest = { username: string };
export type CredentialPolicyRequest = {
	username: string;
	policy: GuardianPolicy;
	previousPolicy: GuardianPolicy;
};
export type PortalUserMappingRequest = {
	portal: 'discord' | 'slack';
	userId: string;
	username?: string;
};
export type PortalTokenRequest = {
	portal: 'discord' | 'slack';
	botToken?: string;
	appToken?: string;
};
export type AppOperations = {
	credentials: {
		create: Operation<CredentialCreateRequest, void>;
		updatePolicy: Operation<CredentialPolicyRequest, void>;
		rotate: Operation<CredentialMutationRequest, void>;
		remove: Operation<CredentialMutationRequest, void>;
		revealKey: Operation<CredentialMutationRequest, { username: string; key: string }>;
	};
	portal: {
		mapUser: Operation<PortalUserMappingRequest, void>;
		saveToken: Operation<PortalTokenRequest, void>;
	};
};

export type BackupRequest = {
	destination: string;
	full?: boolean;
	confirmed?: boolean;
	includeProviderAuth?: boolean;
	includeUserEnv?: boolean;
	includePortalMaps?: boolean;
	includeOAuth?: boolean;
};
export type RestoreRequest = {
	sourceHome: string;
	apply?: boolean;
	previewDigest?: string;
	confirmed?: boolean;
	acknowledgeUnrestored?: boolean;
	includeProviderAuth?: boolean;
	includeUserEnv?: boolean;
	includePortalMaps?: boolean;
	includeOAuth?: boolean;
};
export type RecoveryRequest =
	| { action: 'status' }
	| { action: 'inspect' | 'init' | 'restore'; confirmed?: boolean }
	| { action: 'save'; baselineDigest: string; settings: unknown; selection: unknown }
	| { action: 'credential'; connectionString: string };
export type DataOperations = {
	backup: Operation<BackupRequest, BackupManifest | InstanceBackupManifest>;
	restoreData: Operation<RestoreRequest, RestorePlan>;
	restoreInstance: Operation<RestoreRequest, InstanceRestorePlan>;
	recovery: Operation<
		RecoveryRequest,
		Awaited<ReturnType<typeof recoveryStatus>> | Awaited<ReturnType<typeof runRecoveryOperation>>
	>;
};

export type DockerOperations = {
	install: Operation<{ config: StackConfig; automaticPorts?: boolean }, void>;
	saveConfig: Operation<{ config: StackConfig; baseConfig: StackConfig }, void>;
	update: Operation<{ pull?: boolean }, void>;
	directory: Operation<{ path?: string }, DirectoryListing>;
};

/** Host-owned Docker functions supplied by a composition/transport boundary. */
export type LocalManagementHostPort = {
	inspect(homeDir: string): Promise<HostingSnapshot>;
	operate(homeDir: string, action: HostingAction): Promise<void>;
	logs(homeDir: string, options?: HostingLogOptions): Promise<string>;
};

export type DirectoryListing = {
	path: string;
	parent: string;
	directories: Array<{ name: string; path: string }>;
};

export type InstanceOperations = {
	host: HostOperations;
	agent: AgentOperations;
	apps: AppOperations;
	data: DataOperations;
	docker?: DockerOperations;
};

export interface ComposedInstanceSession {
	readonly ref: InstanceRef;
	readonly host: HostOperations;
	readonly agent: AgentOperations;
	readonly apps: AppOperations;
	readonly data: DataOperations;
	readonly docker?: DockerOperations;
	inspect(): Promise<InstanceSnapshot>;
	/** Releases only forwarding, temporary auth, and transfer resources. */
	close(): Promise<void>;
}

export function operationDescription<Input, Output>(
	operation: Operation<Input, Output>
): OperationDescription {
	if (operation.support !== 'supported')
		return { support: operation.support, reason: operation.reason };
	return {
		support: 'supported',
		availability: operation.availability(),
		...(operation.effect ? { effect: operation.effect } : {}),
		...(operation.input ? { input: operation.input } : {})
	};
}

export function unsupportedOperation<Input, Output>(reason: string): Operation<Input, Output> {
	return { support: 'unsupported', reason };
}

export function unknownOperation<Input, Output>(reason: string): Operation<Input, Output> {
	return { support: 'unknown', reason };
}

export function supportedOperation<Input, Output>(
	invoke: (input: Input, context: RequestContext) => Promise<Output>,
	availability: () => Availability = () => ({ state: 'ready' }),
	input?: { requiresPassword?: boolean }
): Operation<Input, Output> {
	return { support: 'supported', availability, invoke, ...(input ? { input } : {}) };
}

export function hostActionName(
	action: HostingAction
): keyof Pick<HostOperations, 'start' | 'stop' | 'restart'> {
	return action;
}

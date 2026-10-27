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
	RecoveryCredentialRequest,
	RecoveryOperationResult,
	RecoverySaveRequest,
	RecoverySnapshot,
	RecoveryStatus
} from '../dto/recovery.js';
export type {
	RecoveryCredentialRequest,
	RecoveryOperationResult,
	RecoverySaveRequest,
	RecoverySnapshot,
	RecoveryStatus
} from '../dto/recovery.js';
import type {
	ProviderEndpointInput,
	ProviderSettings
} from '../control-plane/provider-settings.js';
import type {
	AssistantReadiness,
	ProviderOAuthAuthorization,
	ProviderSummary
} from '../dto/agent.js';
import type {
	HostingAction,
	HostingActionOptions,
	HostingActionEffect,
	HostingLogOptions,
	HostingResult,
	HostingSnapshot,
	InstanceRef,
	DirectoryListing
} from '../dto/hosting.js';
export type { DirectoryListing } from '../dto/hosting.js';

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

export type AppClient = 'opencode' | 'mcp' | 'claude';
export type OperationInputMetadata = {
	requiresPassword?: boolean;
	/** Client routes this explicit connection operation can acquire. */
	acquireClients?: readonly AppClient[];
};

export type Operation<Input, Output> =
	| { support: 'unsupported'; reason: string }
	| { support: 'unknown'; reason: string }
	| {
			support: 'supported';
			input?: OperationInputMetadata;
			readonly effect?: HostingActionEffect;
			availability(): Availability;
			invoke(input: Input, context: RequestContext): Promise<Output>;
	  };

export type OperationDescription =
	| { support: 'unsupported' | 'unknown'; reason: string }
	| {
			support: 'supported';
			availability: Availability;
			input?: OperationInputMetadata;
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
	/** Eligibility observed with this deployment snapshot; never an invoke preflight. */
	lifecycleCapabilities?: Partial<Record<HostingAction, Availability>>;
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
	recovery: Observation<RecoverySnapshot>;
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
	/** Acquire a native one-use link on the selected browser-reachable route. */
	browserLink: Operation<void, { url: string }>;
	/** `sessionBound` means the returned endpoint depends on this open session. */
	connect: Operation<
		{ password?: string },
		{ endpoint: string; username?: string; sessionBound?: true }
	>;
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
	input?: string;
};
export type RemoteSetupResult = RemoteProgress;
export type CodexRecallRequest =
	| { action: 'review' }
	| { action: 'approve' | 'disable'; digest: string };
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
	includeProviderAuth?: boolean;
	includeUserEnv?: boolean;
	includePortalMaps?: boolean;
	includeOAuth?: boolean;
};
export type RestoreRequest = {
	sourceHome: string;
	apply?: boolean;
	previewDigest?: string;
	acknowledgeUnrestored?: boolean;
	includeProviderAuth?: boolean;
	includeUserEnv?: boolean;
	includePortalMaps?: boolean;
	includeOAuth?: boolean;
};
export type DataOperations = {
	backup: Operation<BackupRequest, BackupManifest | InstanceBackupManifest>;
	restoreData: Operation<RestoreRequest, RestorePlan>;
	restoreInstance: Operation<RestoreRequest, InstanceRestorePlan>;
	recovery: {
		status: Operation<void, RecoveryStatus>;
		inspect: Operation<void, RecoveryOperationResult>;
		initialize: Operation<void, RecoveryOperationResult>;
		restore: Operation<void, RecoveryOperationResult>;
		save: Operation<RecoverySaveRequest, void>;
		setCredential: Operation<RecoveryCredentialRequest, void>;
	};
};

export type DockerOperations = {
	install: Operation<{ config: StackConfig; automaticPorts?: boolean }, void>;
	saveConfig: Operation<{ config: StackConfig; baseConfig: StackConfig }, void>;
	update: Operation<{ pull?: boolean }, void>;
	directory: Operation<{ path?: string }, DirectoryListing>;
};

/** Host-owned Docker functions supplied by a composition/transport boundary. */
export type LocalManagementHostPort = {
	inspect(): Promise<HostingSnapshot>;
	operate(action: HostingAction): Promise<void>;
	logs(options?: HostingLogOptions): Promise<string>;
};

export type InstanceOperations = {
	host: HostOperations;
	agent: AgentOperations;
	apps: AppOperations;
	data: DataOperations;
	docker?: DockerOperations;
};

/** One passive, target-bound read of optional application state. */
export type ApplicationObservations = {
	agent: Partial<AgentObservations>;
	apps: AppObservations;
	data: DataObservations;
	lifecycle: Observation<InstanceLifecycle>;
	docker?: DockerInstanceSubview;
};

/** Stable composition port contributed by the selected hosting adapter. */
export type InstanceSessionBindings = {
	ref: InstanceRef;
	host: HostOperations;
	inspectHost(): Promise<HostingSnapshot>;
	agent?: Partial<AgentOperations>;
	apps?: AppOperations;
	data?: DataOperations;
	/** Adapter-owned optional capability discovery; never a consumer warm-up requirement. */
	initialize?: () => Promise<void>;
	inspectApplication?: () => Promise<Partial<ApplicationObservations>>;
	docker?: DockerOperations;
	busy?: () => boolean;
	close?: () => Promise<void>;
};

export interface ComposedInstanceSession extends InstanceOperations {
	readonly ref: InstanceRef;
	inspect(): Promise<InstanceSnapshot>;
	/** True only while a selected session owns an interactive native setup flow. */
	busy(): boolean;
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

/** Invoke a named operation consistently at every CLI, IPC and UI boundary. */
export async function invokeOperation<Input, Output>(
	operation: Operation<Input, Output>,
	input: Input,
	context: RequestContext = {}
): Promise<Output> {
	if (operation.support !== 'supported') throw new Error(operation.reason);
	const availability = operation.availability();
	if (availability.state !== 'ready') throw new Error(availability.reason);
	return operation.invoke(input, context);
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
	input?: OperationInputMetadata
): Operation<Input, Output> {
	return { support: 'supported', availability, invoke, ...(input ? { input } : {}) };
}

import type { RestartStatus } from '../control-plane/runtime-revision.js';
import type { StackConfig } from '../control-plane/stack-config.js';
import type { RecoverySettings, RecoverySelection } from './recovery.js';

/** Provider-neutral host DTOs and pure value constructors, shared across layers. */
export type InstanceRef =
	| { kind: 'local-docker'; connectionId: 'local'; homeDir: string }
	| { kind: 'ssh-docker'; connectionId: string; remoteHome: string }
	| { kind: 'azure-container-apps'; connectionId: string; resourceId: string };

export type HostingAction = 'start' | 'stop' | 'restart';
export type HostingActionOptions = { revision?: string };
export type HostingActionEffect =
	| 'reconcile-deployment'
	| 'request-platform-state'
	| 'update-deployment'
	| 'restart-runtime';
export type HostingCapabilities = Record<
	HostingAction | 'settings' | 'transfer',
	{ supported: boolean; reason?: string }
>;
export type InstanceSummary = { ref: InstanceRef; name: string; location: string };
export type HostingLogOptions = {
	tail?: number;
	type?: 'system' | 'console';
	revision?: string;
	replica?: string;
	container?: string;
};
export type HostingSnapshot = InstanceSummary & {
	capabilities: HostingCapabilities;
	serviceError?: string;
	services: Array<{
		name: string;
		image?: string;
		imageProvenance?: {
			configuredReference?: string;
			configuredReferences?: string[];
			observedReferences?: string[];
			digest?: string;
			updateCandidate?: { reference: string; source: string };
		};
		state: string;
		health: string;
		id?: string;
		exitCode?: number | null;
		warnings?: string[];
	}>;
	warnings: string[];
	config?: StackConfig;
	pendingRestart?: RestartStatus;
	platformState?: string;
	revisions?: Array<{ name: string; active: boolean; replicas?: number; health: string }>;
	clientUrl?: string;
	portalUrl?: string;
	containers?: Array<{ name: string; image: string }>;
	logSources?: Array<{ type: 'system' | 'console'; label: string }>;
	providerLabel?: string;
	guidance?: { access?: string; client?: string; restart?: string };
};
export type HostingResult = {
	snapshot: HostingSnapshot;
	message?: string;
	pending?: boolean;
	operation?: DeploymentOutcome;
};

export type DeploymentOutcome = {
	state: 'submitted' | 'in-progress' | 'completed' | 'failed' | 'unknown';
	reference?: string;
	step: string;
	message?: string;
};
/** A narrow user-requested patch, never a replacement cloud template. No secrets. */
export type DeploymentPatch = {
	/** Image/resources target only; native preferences and recovery always address the Assistant. */
	container?: string;
	image?: string;
	availability?: 'always' | 'on-demand';
	environment?: Record<string, string | null>;
	cpu?: number;
	memory?: string;
	recovery?: { settings: RecoverySettings; selection: RecoverySelection };
};
export type DeploymentSettings = {
	containers: Array<{ name: string; image: string }>;
	availability?: 'always' | 'on-demand';
	environment: Record<string, string>;
	/** Field-level reasons; the common form retains unavailable controls in place. */
	unavailable?: Record<string, string>;
	imageHelp?: string;
	pending?: DeploymentPatch;
	operation?: DeploymentOutcome;
};
export type ProvisioningRequest =
	| {
			kind: 'directory';
			name: string;
			directory: string;
			config: StackConfig;
			automaticPorts?: boolean;
	  }
	| {
			kind: 'azure-container-apps';
			name: string;
			location: string;
			environment: { name: string; create: boolean };
			storage: { name: string; create: boolean };
			availability: 'always' | 'on-demand';
			timezone: string;
			cpu?: number;
			memory?: string;
			image?: string;
			/** Existing environment storage; independent Files mounts, never live native databases. */
			mounts?: Array<{ storageName: string; mountPath: string }>;
	  };
export type ProvisioningResult = DeploymentOutcome & {
	ref: InstanceRef;
	previousInitializationExecutions?: string[];
	/** Initial ARM request was definitively rejected; no accepted operation is replayed. */
	initialRejected?: boolean;
	/** Validated non-secret placement allows retry when failed ARM deployments have no outputs. */
	request?: Extract<ProvisioningRequest, { kind: 'azure-container-apps' }>;
};
export type ProvisioningOptions = (
	| { kind: 'directory'; instancesDirectory: string; defaultHome: string; config: StackConfig }
	| {
			kind: 'azure-container-apps';
			location: string;
			image: string;
			timezone: string;
			environments: Array<{ value: string; label: string }>;
			storageAccounts: Array<{ value: string; label: string }>;
	  }
) & { continuations?: ProvisioningResult[] };
export type ProvisioningPreview = {
	ref: InstanceRef;
	image: string;
	summary: string;
	resources: Array<{ name: string; type: string; action: 'create' | 'reuse' }>;
	warnings: string[];
};
export type DirectoryListing = {
	path: string;
	parent: string;
	directories: Array<{ name: string; path: string }>;
};

/** Pure host-capability value construction; no provider or runtime dependency. */
export function capabilities(
	supported: ReadonlyArray<keyof HostingCapabilities>,
	reason = 'This operation is not available for this instance.'
): HostingCapabilities {
	return Object.fromEntries(
		(['start', 'stop', 'restart', 'settings', 'transfer'] as const).map((name) => [
			name,
			supported.includes(name) ? { supported: true } : { supported: false, reason }
		])
	) as HostingCapabilities;
}

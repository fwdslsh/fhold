import type { RestartStatus } from '../control-plane/runtime-revision.js';
import type { StackConfig } from '../control-plane/stack-config.js';

/** Provider-neutral host facts shared by hosting adapters and composed sessions. */
export type InstanceRef =
	| { kind: 'local-docker'; connectionId: 'local'; homeDir: string }
	| { kind: 'ssh-docker'; connectionId: string; remoteHome: string }
	| { kind: 'azure-container-apps'; connectionId: string; resourceId: string };

export type HostingAction = 'start' | 'stop' | 'restart';
export type HostingActionOptions = { revision?: string };
export type HostingActionEffect =
	| 'reconcile-deployment'
	| 'request-platform-state'
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
export type HostingResult = { snapshot: HostingSnapshot; message?: string; pending?: boolean };
export type DirectoryListing = {
	path: string;
	parent: string;
	directories: Array<{ name: string; path: string }>;
};

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

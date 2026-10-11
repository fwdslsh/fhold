import type { StackConfig } from '../control-plane/stack-config.js';
import type { RestartStatus } from '../control-plane/runtime-revision.js';

export type HostingConnection =
	| { kind: 'local-docker'; id: 'local'; label: string }
	| { kind: 'ssh-docker'; id: string; label: string; host: string; port?: number; roots: string[] }
	| {
			kind: 'azure-container-apps';
			id: string;
			label: string;
			subscriptionId: string;
			resourceGroup: string;
	  };

export type InstanceRef =
	| { kind: 'local-docker'; connectionId: 'local'; homeDir: string }
	| { kind: 'ssh-docker'; connectionId: string; remoteHome: string }
	| { kind: 'azure-container-apps'; connectionId: string; resourceId: string };

export type HostingAction = 'start' | 'stop' | 'restart';
export type HostingCapabilities = Record<
	HostingAction | 'settings' | 'transfer',
	{ supported: boolean; reason?: string }
>;
export type InstanceSummary = { ref: InstanceRef; name: string; location: string };
export type HostingSnapshot = InstanceSummary & {
	capabilities: HostingCapabilities;
	services: Array<{
		name: string;
		state: string;
		health: string;
		id?: string;
		exitCode?: number | null;
		warnings?: string[];
	}>;
	warnings: string[];
	// Compose intent exists only on Docker hosts. ACA never fabricates StackConfig.
	config?: StackConfig;
	pendingRestart?: RestartStatus;
	platformState?: string;
	revisions?: Array<{ name: string; active: boolean; replicas: number; health: string }>;
	clientUrl?: string;
};
export type HostingResult = { snapshot: HostingSnapshot; message?: string; pending?: boolean };
export type HostingLogOptions = {
	tail?: number;
	type?: 'system' | 'console';
	revision?: string;
	replica?: string;
	container?: string;
};
export interface InstanceSession {
	readonly ref: InstanceRef;
	inspect(): Promise<HostingSnapshot>;
	operate(action: HostingAction, confirmed: boolean): Promise<HostingResult>;
	logs(options?: HostingLogOptions): Promise<string>;
}
export interface HostingProvider {
	listInstances(): Promise<InstanceSummary[]>;
	selectInstance(selector: string): Promise<InstanceRef>;
	open(ref: InstanceRef): InstanceSession;
}

export async function selectListedInstance(
	provider: HostingProvider,
	selector: string
): Promise<InstanceRef> {
	const matches = (await provider.listInstances()).filter((item) => item.name === selector);
	const matched = matches[0];
	if (matches.length !== 1 || !matched)
		throw new Error(
			'Choose one discovered instance name or its exact host directory/resource ID. Names must be unambiguous.'
		);
	return matched.ref;
}

export const LOCAL_CONNECTION: HostingConnection = {
	kind: 'local-docker',
	id: 'local',
	label: 'This computer'
};

export function instanceKey(ref: InstanceRef): string {
	return JSON.stringify([
		ref.kind,
		ref.connectionId,
		ref.kind === 'local-docker'
			? ref.homeDir
			: ref.kind === 'ssh-docker'
				? ref.remoteHome
				: ref.resourceId
	]);
}

export function capabilities(restart = true, local = false): HostingCapabilities {
	const reason = 'Manage these settings and files on the Docker host with its fhold CLI.';
	return {
		start: { supported: true },
		stop: { supported: true },
		restart: restart
			? { supported: true }
			: {
					supported: false,
					reason:
						'Use the deployment tooling for an ordered stop, drain and replacement. ACA restart is not a Compose recreate.'
				},
		settings: { supported: local, ...(local ? {} : { reason }) },
		transfer: { supported: local, ...(local ? {} : { reason }) }
	};
}

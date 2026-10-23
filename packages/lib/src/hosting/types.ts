import type { InstanceSessionBindings } from '../management/contracts.js';
import type {
	DirectoryListing,
	HostingAction,
	HostingActionEffect,
	HostingActionOptions,
	HostingLogOptions,
	HostingResult,
	HostingSnapshot,
	InstanceRef,
	InstanceSummary
} from '../contracts/hosting.js';
export {
	capabilities,
	type DirectoryListing,
	type HostingAction,
	type HostingActionEffect,
	type HostingActionOptions,
	type HostingCapabilities,
	type HostingLogOptions,
	type HostingResult,
	type HostingSnapshot,
	type InstanceRef,
	type InstanceSummary
} from '../contracts/hosting.js';

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

export type ConnectionCheck = {
	ok: boolean;
	repairable: boolean;
	checks: Array<{ name: string; ok: boolean; detail: string }>;
	instances: InstanceSummary[];
};
export type HostingChoice = { value: string; label: string };
export type ConnectionSetup = {
	/** Native sign-in runs on the management computer, never inside Assistant. */
	signIn(): Promise<void>;
	choices(field: string, values?: Record<string, string>): Promise<HostingChoice[]>;
};
export interface InstanceSession {
	readonly ref: InstanceRef;
	/** Static adapter semantics; they do not depend on a prior status read. */
	readonly actionEffects: Record<HostingAction, HostingActionEffect>;
	inspect(): Promise<HostingSnapshot>;
	operate(
		action: HostingAction,
		confirmed: boolean,
		options?: HostingActionOptions
	): Promise<HostingResult>;
	logs(options?: HostingLogOptions): Promise<string>;
	console?(options?: Pick<HostingLogOptions, 'revision' | 'replica' | 'container'>): Promise<void>;
	/** Adds the selected adapter's agent/app/data bindings without provider switches in consumers. */
	applicationBindings?(options?: {
		setupName?: string;
		openUrl?: (url: string) => void;
	}): Omit<InstanceSessionBindings, 'ref' | 'host' | 'inspectHost'>;
}
export interface HostingProvider {
	/** Provider-specific host setup and diagnostics; discovery itself is read-only. */
	check?(): Promise<ConnectionCheck>;
	readonly emptyHint?: string;
	installation?: {
		info(): Promise<{ instancesDirectory: string; defaultHome: string }>;
		directory(path?: string): Promise<DirectoryListing>;
	};
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

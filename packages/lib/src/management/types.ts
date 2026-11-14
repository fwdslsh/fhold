import { type ConnectionDetails } from '../control-plane/connection.js';
import { type RestartStatus } from '../control-plane/runtime-revision.js';
import { type StackConfig } from '../control-plane/stack-config.js';
import type { InstanceRef } from '../hosting/types.js';
import { type recoverySnapshot } from '../control-plane/recovery.js';
import { type CodexRecallReview } from '../control-plane/codex-recall.js';
import type {
	AgentOperations,
	AppOperations,
	DataOperations,
	DockerOperations,
	RequestContext
} from './contracts.js';
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

/** Input and result of a callable named operation slot. */
type Io<T> = T extends {
	support: 'supported';
	invoke(input: infer Input, context: RequestContext): Promise<infer Output>;
}
	? { input: Input; result: Output }
	: never;

/**
 * Named operations carried by the bounded SSH/stdin JSON-line envelope. Values
 * still arrive as untrusted JSON and are parsed per operation before use.
 */
export type ManagementOperationMap = {
	snapshot: { input: void; result: ManagedSnapshot };
	'agent.providers': Io<AgentOperations['providers']>;
	'agent.setKey': Io<AgentOperations['setKey']>;
	'agent.saveEndpoint': Io<AgentOperations['saveEndpoint']>;
	'agent.discoverModels': Io<AgentOperations['discoverModels']>;
	'agent.selectModel': Io<AgentOperations['selectModel']>;
	'agent.removeProvider': Io<AgentOperations['removeProvider']>;
	'agent.oauthStart': Io<AgentOperations['oauthStart']>;
	'agent.oauthFinish': Io<AgentOperations['oauthFinish']>;
	'agent.readiness': Io<AgentOperations['readiness']>;
	'agent.assistantPassword': Io<AgentOperations['assistantPassword']>;
	'agent.remote': Io<AgentOperations['remote']>;
	'agent.codexRecall': Io<AgentOperations['codexRecall']>;
	'apps.credentials.create': Io<AppOperations['credentials']['create']>;
	'apps.credentials.updatePolicy': Io<AppOperations['credentials']['updatePolicy']>;
	'apps.credentials.rotate': Io<AppOperations['credentials']['rotate']>;
	'apps.credentials.remove': Io<AppOperations['credentials']['remove']>;
	'apps.credentials.revealKey': Io<AppOperations['credentials']['revealKey']>;
	'apps.portal.mapUser': Io<AppOperations['portal']['mapUser']>;
	'apps.portal.saveToken': Io<AppOperations['portal']['saveToken']>;
	/** SSH supplies the loopback port its private forward will use. */
	'data.knowledgeUi': { input: { loopbackPort: number } | void; result: { url: string } };
	'data.backup': Io<DataOperations['backup']>;
	'data.restoreData': Io<DataOperations['restoreData']>;
	'data.restoreInstance': Io<DataOperations['restoreInstance']>;
	'data.recovery.status': Io<DataOperations['recovery']['status']>;
	'data.recovery.inspect': Io<DataOperations['recovery']['inspect']>;
	'data.recovery.initialize': Io<DataOperations['recovery']['initialize']>;
	'data.recovery.restore': Io<DataOperations['recovery']['restore']>;
	'data.recovery.save': Io<DataOperations['recovery']['save']>;
	'data.recovery.setCredential': Io<DataOperations['recovery']['setCredential']>;
	'data.recovery.package': Io<DataOperations['recovery']['package']>;
	'docker.install': Io<DockerOperations['install']>;
	'docker.saveConfig': Io<DockerOperations['saveConfig']>;
	'docker.update': Io<DockerOperations['update']>;
	'docker.directory': Io<DockerOperations['directory']>;
	/** Private staging workspaces for SSH file transfer. */
	'transfer.create': { input: void; result: string };
	'transfer.release': { input: string; result: void };
	'transfer.pack': { input: string; result: string };
	'transfer.unpack': { input: string; result: string };
};
export type ManagementOperation = keyof ManagementOperationMap;
export interface InstanceManagement {
	call<N extends ManagementOperation>(
		operation: N,
		input?: ManagementOperationMap[N]['input'],
		context?: RequestContext
	): Promise<ManagementOperationMap[N]['result']>;
	busy(): boolean;
	close(): Promise<void>;
}

import { type ConnectionDetails } from '../control-plane/connection.js';
import { type RestartStatus } from '../control-plane/runtime-revision.js';
import { type StackConfig } from '../control-plane/stack-config.js';
import type { InstanceRef } from '../hosting/types.js';
import { type recoverySnapshot } from '../control-plane/recovery.js';
import { type CodexRecallReview } from '../control-plane/codex-recall.js';
export type ManagedSnapshot = {
	target?: Extract<InstanceRef, { kind: 'ssh-docker' }>;
	connectionLabel?: string;
	connectionError?: string;
	phase: 'not_installed' | 'setup_incomplete' | 'ready';
	homeDir: string;
	configPath: string;
	config: StackConfig;
	services: Array<{
		name: string;
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
export interface InstanceManagement {
	call<T = unknown>(method: ManagementMethod, value?: unknown, ...extra: unknown[]): Promise<T>;
	busy(): boolean;
	close(): Promise<void>;
}
export type DirectoryListing = {
	path: string;
	parent: string;
	directories: Array<{ name: string; path: string }>;
};

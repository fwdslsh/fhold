import type { InstanceOperations, RequestContext, StackConfig } from '@fhold/lib';
import type { HostingConnection, InstanceRef, InstanceSummary, ConnectionCheck } from '@fhold/lib';
import type { HostingChoice } from '@fhold/lib';
import type { InstanceSnapshot } from '@fhold/lib';
import type {
	ProvisioningOptions,
	ProvisioningRequest,
	ProvisioningPreview,
	ProvisioningResult,
	DeploymentOutcome
} from '@fhold/lib';
import type { AdminSettings } from './admin-settings.js';
import type { AdminAppSnapshot } from './admin-updates.js';
import type { DesktopStatus } from './admin-desktop.js';

export type AdminSnapshot = InstanceSnapshot;

export type StackAction = 'start' | 'restart' | 'stop';
export type InterruptingAction =
	| StackAction
	| 'update'
	| 'apply'
	| 'remote-setup'
	| 'recovery-init'
	| 'recovery-restore'
	| 'checkpoint-import'
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

/**
 * The IPC allowlist of named instance operations the renderer may invoke on the
 * selected session. Composite actions keep their own channels below.
 */
export const ADMIN_OPERATIONS = [
	'host.logs',
	'host.deployment.inspect',
	'host.deployment.prepare',
	'host.deployment.discard',
	'agent.connect',
	'agent.providers',
	'agent.setKey',
	'agent.saveEndpoint',
	'agent.discoverModels',
	'agent.selectModel',
	'agent.removeProvider',
	'agent.oauthStart',
	'agent.oauthFinish',
	'agent.readiness',
	'agent.assistantPassword',
	'agent.remote',
	'agent.codexRecall',
	'apps.credentials.create',
	'apps.credentials.updatePolicy',
	'apps.credentials.rotate',
	'apps.credentials.revealKey',
	'apps.portal.mapUser',
	'apps.portal.saveToken',
	'data.backup',
	'data.restoreData',
	'data.restoreInstance',
	'data.recovery.status',
	'data.recovery.inspect',
	'data.recovery.initialize',
	'data.recovery.restore',
	'data.recovery.save',
	'data.recovery.setCredential',
	'data.recovery.package'
] as const;
export type AdminOperation = (typeof ADMIN_OPERATIONS)[number];
type Slot<T, Path extends string> = Path extends `${infer Head}.${infer Rest}`
	? Head extends keyof T
		? Slot<T[Head], Rest>
		: never
	: Path extends keyof T
		? T[Path]
		: never;
type Callable<N extends AdminOperation> = Extract<
	Slot<InstanceOperations, N>,
	{ support: 'supported' }
>;
export type AdminOperationInput<N extends AdminOperation> = Parameters<Callable<N>['invoke']>[0];
export type AdminOperationResult<N extends AdminOperation> = Awaited<
	ReturnType<Callable<N>['invoke']>
>;

export type AdminApi = {
	operation<N extends AdminOperation>(
		name: N,
		input?: AdminOperationInput<N>,
		context?: Pick<RequestContext, 'confirmed'>
	): Promise<AdminOperationResult<N>>;
	desktopStatus(): Promise<DesktopStatus>;
	installDesktop(): Promise<DesktopStatus>;
	appSettings(): Promise<AdminAppSnapshot>;
	saveAppSettings(value: AdminSettings): Promise<AdminAppSnapshot>;
	checkAppUpdate(): Promise<AdminAppSnapshot>;
	downloadAppUpdate(): Promise<AdminAppSnapshot>;
	installAppUpdate(): Promise<void>;
	onAppUpdate(listener: (snapshot: AdminAppSnapshot) => void): () => void;
	hostingFeatures(
		id: string
	): Promise<{ installation: boolean; directory: boolean; emptyHint?: string }>;
	provisioningOptions(connectionId: string): Promise<ProvisioningOptions>;
	provisioningPreview(value: {
		connectionId: string;
		request: ProvisioningRequest;
	}): Promise<ProvisioningPreview>;
	provisioningInstall(value: {
		connectionId: string;
		request: ProvisioningRequest;
		confirmed: boolean;
	}): Promise<ProvisioningResult>;
	provisioningResume(value: {
		connectionId: string;
		reference: string;
		retryFailedStep?: boolean;
		confirmed: boolean;
	}): Promise<ProvisioningResult>;
	applyDeployment(value: {
		confirmed: boolean;
	}): Promise<{ snapshot: AdminSnapshot; outcome: DeploymentOutcome }>;
	hostingSetup(value: {
		provider: HostingConnection['kind'];
		action: 'sign-in' | 'choices';
		field?: string;
		values?: Record<string, string>;
	}): Promise<HostingChoice[] | undefined>;
	hostingInfo(id: string): Promise<{ instancesDirectory: string; defaultHome: string }>;
	hostingDirectory(value: {
		connectionId: string;
		path?: string;
	}): Promise<import('@fhold/lib').DirectoryListing>;
	update(value: {
		confirmed: boolean;
		pull?: boolean;
		container?: string;
		image?: string;
	}): Promise<{ snapshot: AdminSnapshot; outcome: DeploymentOutcome }>;
	hostingConnections(): Promise<HostingConnection[]>;
	hostingSaveConnection(value: unknown): Promise<HostingConnection>;
	hostingUpdateConnection(id: string, value: unknown): Promise<HostingConnection | undefined>;
	hostingRemoveConnection(id: string): Promise<boolean>;
	hostingCheckConnection(id: string): Promise<ConnectionCheck>;
	hostingInstances(connectionId: string): Promise<InstanceSummary[]>;
	welcome(): Promise<AdminWelcome>;
	openInstance(target: AdminTarget): Promise<void>;
	prepareNewInstance(target: AdminTarget & { name?: string }): Promise<void>;
	closeInstance(): Promise<void>;
	installationReadiness(connectionId?: string): Promise<{ ok: boolean; message?: string }>;
	snapshot(): Promise<AdminSnapshot>;
	selectedHome(): Promise<string>;
	install(config: StackConfig, automaticPorts?: boolean): Promise<AdminSnapshot>;
	saveConfig(value: { config: StackConfig; baseConfig: StackConfig }): Promise<AdminSnapshot>;
	confirmRestart(action: InterruptingAction): Promise<boolean>;
	action(
		action: StackAction,
		confirmed?: boolean
	): Promise<{ snapshot: AdminSnapshot; outcome: DeploymentOutcome }>;
	openOpenCode(): Promise<void>;
	openKnowledge(): Promise<void>;
	syncKnowledge(): Promise<void>;
	copyText(value: string): Promise<void>;
	openExternal(value: string): Promise<void>;
	chooseDirectory(value: {
		purpose: 'backup' | 'restore' | 'instance' | 'new-instance' | 'recovery';
	}): Promise<string | undefined>;
};

export const ADMIN_CHANNELS = {
	operation: 'admin:operation',
	appSettings: 'admin:app-settings',
	desktopStatus: 'admin:desktop-status',
	installDesktop: 'admin:install-desktop',
	saveAppSettings: 'admin:save-app-settings',
	checkAppUpdate: 'admin:check-app-update',
	downloadAppUpdate: 'admin:download-app-update',
	installAppUpdate: 'admin:install-app-update',
	appUpdateChanged: 'admin:app-update-changed',
	hostingFeatures: 'admin:hosting-features',
	provisioningOptions: 'admin:provisioning-options',
	provisioningPreview: 'admin:provisioning-preview',
	provisioningInstall: 'admin:provisioning-install',
	provisioningResume: 'admin:provisioning-resume',
	applyDeployment: 'admin:apply-deployment',
	hostingSetup: 'admin:hosting-setup',
	hostingInfo: 'admin:hosting-info',
	hostingDirectory: 'admin:hosting-directory',
	update: 'admin:update',
	hostingConnections: 'admin:hosting-connections',
	hostingSaveConnection: 'admin:hosting-save-connection',
	hostingUpdateConnection: 'admin:hosting-update-connection',
	hostingRemoveConnection: 'admin:hosting-remove-connection',
	hostingCheckConnection: 'admin:hosting-check-connection',
	hostingInstances: 'admin:hosting-instances',
	welcome: 'admin:welcome',
	openInstance: 'admin:open-instance',
	prepareNewInstance: 'admin:prepare-new-instance',
	closeInstance: 'admin:close-instance',
	installationReadiness: 'admin:installation-readiness',
	snapshot: 'admin:snapshot',
	selectedHome: 'admin:selected-home',
	install: 'admin:install',
	saveConfig: 'admin:save-config',
	action: 'admin:action',
	confirmRestart: 'admin:confirm-restart',
	openOpenCode: 'admin:open-opencode',
	openKnowledge: 'admin:open-knowledge',
	syncKnowledge: 'admin:sync-knowledge',
	copyText: 'admin:copy-text',
	openExternal: 'admin:open-external',
	chooseDirectory: 'admin:choose-directory'
} as const;

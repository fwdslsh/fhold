export type { FholdState } from './control-plane/foundation.js';
export {
	createFholdState,
	defaultFholdHome,
	customComposeFile,
	ensureHomeDirs,
	managedComposeFile,
	readEnvFile,
	resolveFholdHome,
	stackConfigFile,
	stackEnvFile,
	stateSecretFile,
	updateEnvFile,
	writeFileAtomic
} from './control-plane/foundation.js';
export {
	credentialDir,
	credentialKeyFile,
	credentialStoreDir,
	ensureCredentialKeys,
	generateCredentialKey,
	isStrongCredentialKey,
	normalizeCredentialKey,
	readCredentialKey,
	removeCredentialKey,
	writeCredentialKey
} from './control-plane/credential-store.js';
export {
	OAUTH_ALGORITHMS,
	OAUTH_CONFIG_VERSION,
	OAUTH_IDENTITY_MAP_VERSION,
	defaultOAuthConfig,
	defaultOAuthIdentityMap,
	ensureOAuthFiles,
	oauthConfigFile,
	oauthCredentialUsages,
	oauthIdentityMapFile,
	parseOAuthConfig,
	parseOAuthIdentityMap,
	readOAuthConfig,
	readOAuthIdentityMap,
	writeOAuthConfig,
	writeOAuthIdentityMap,
	type OAuthAlgorithm,
	type OAuthConfig,
	type OAuthIdentity,
	type OAuthIdentityMap
} from './control-plane/oauth-store.js';
export {
	PORTAL_CREDENTIAL_BUNDLE_VERSION,
	PORTAL_CREDENTIAL_MAP_VERSION,
	PORTAL_NAMES,
	buildPortalCredentialBundle,
	ensurePortalCredentialMaps,
	isPortalName,
	isPortalUserId,
	parsePortalCredentialMap,
	portalCredentialBundleDir,
	portalCredentialBundleFile,
	portalCredentialMapFile,
	portalCredentialUsages,
	readPortalCredentialMap,
	syncPortalCredentialBundles,
	writePortalCredentialMap,
	type PortalCredentialBundle,
	type PortalCredentialMap,
	type PortalName
} from './control-plane/portal-credential-store.js';
export {
	normalizePortalSecret,
	portalSecretConfigured,
	portalSecretNames,
	writePortalSecret,
	type PortalSecretName
} from './control-plane/portal-settings.js';
export {
	CREDENTIAL_REGISTRY_VERSION,
	GUARDIAN_POLICIES,
	CODEX_SANDBOX_MODES,
	STACK_CONFIG_VERSION,
	createCredentialId,
	credentialRegistryFile,
	defaultStackConfig,
	ensureStackConfig,
	hostTimezone,
	validTimezone,
	isCredentialId,
	isInstanceName,
	isCodexSandbox,
	isCredentialUsername,
	isGuardianPolicy,
	enabledAddons,
	parseStackConfig,
	readStackConfig,
	stackConfigEnv,
	writeStackConfig,
	type CredentialConfig,
	type DiscordPortalAccess,
	type GuardianPolicy,
	type SlackPortalAccess,
	type StackConfig,
	type StackConfigReadResult
} from './control-plane/stack-config.js';
export {
	applyHomeSeed,
	preflightHomeSeed,
	MANAGED_FILES,
	SEEDED_FILES
} from './control-plane/seed.js';
export {
	classifyInstall,
	ensureRuntime,
	markInstalled,
	readStackEnv,
	requireInstall,
	type InstallState
} from './control-plane/state.js';
export { installHome } from './control-plane/install.js';
export { updateHome } from './control-plane/update.js';
export { defaultRecoverySettings, directoryRecoveryDestination, type RecoverySettings } from './control-plane/recovery-config.js';
export { recoverySnapshot, recoveryStatus, readRecoverySelection, saveRecoverySettings, saveRecoveryCredential, runRecoveryOperation, type RecoverySelection } from './control-plane/recovery.js';
export {
	mutateStack,
	createCredential,
	rotateCredential,
	removeCredential,
	setCredentialPolicy,
	mapPortalUser,
	mapOAuthIdentity,
	savePortalTokens,
	saveStackIntent
} from './control-plane/operations.js';
export {
	assistantEndpoint,
	beginProviderOAuth,
	completeProviderOAuth,
	configureGuardianModeratorModel,
	listProviders,
	removeProviderAuth,
	setProviderApiKey,
	refreshAssistantInstance,
	testAssistantReadiness,
	waitForAssistant,
	type AssistantReadiness,
	type ProviderAuthMethod,
	type ProviderAuthPrompt,
	type ProviderOAuthAuthorization,
	type ProviderSummary
} from './control-plane/opencode.js';
export {
	connectionDetails,
	type ConnectionDetailOptions,
	type ConnectionDetails
} from './control-plane/connection.js';
export {
	applyRestore,
	planRestore,
	type RestoreAction,
	type RestoreEntry,
	type RestoreOptions,
	type RestorePlan
} from './control-plane/restore.js';
export {
	createBackup,
	type BackupManifest,
	type BackupOptions
} from './control-plane/backup.js';
export {
	exportHistory,
	restoreHistory,
	validateHistoryDirectories,
	type HistoryExportOptions,
	type HistoryRestoreOptions,
	type HistoryReceipt
} from './control-plane/history.js';
export type { PreservationItem } from './control-plane/preservation.js';
export {
	buildComposeCliArgs,
	buildComposeOptions,
	type ComposeOptions
} from './control-plane/compose.js';
export {
	composeLogs,
	composeConfigJson,
	composePreflight,
	composePs,
	ensureDockerReady,
	assertProjectOwnership,
	parseComposePsRows,
	runDocker,
	runComposeStreaming
} from './control-plane/docker.js';
export { auditCompose } from './control-plane/secret-audit.js';
export {
	beginRemoteEnable,
	disableRemote,
	remoteBrowserUrls,
	remoteConnection,
	remoteTool,
	type RemoteTool,
	type CodexSandbox,
	type RemoteProgress,
	type RemoteEnableSession
} from './control-plane/remote.js';
export { acquireStackLock, releaseStackLock, type StackLock } from './control-plane/lock.js';
export {
	reviewCodexRecall,
	changeCodexRecall,
	type CodexRecallReview
} from './control-plane/codex-recall.js';
export { restartStatus, type RestartStatus } from './control-plane/runtime-revision.js';

export {
	activateComposeCommand,
	deactivateComposeCommand
} from './control-plane/activation.js';

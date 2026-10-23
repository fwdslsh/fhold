/** Recovery DTOs, independent of the settings/checkpoint implementations. */
export type RecoverySettings = {
	enabled: boolean;
	destination: string;
	instanceId: string;
	intervalSeconds: number;
	maxUnsavedSeconds: number;
	operationTimeoutSeconds: number;
	akmIndexCapture: boolean;
	akmIndexRestore: boolean;
	authentication: 'connection-string' | 'managed-identity';
	clientId: string;
};
export type RecoverySelection = {
	version?: 1;
	paths: string[];
	sqlite: string[];
	excludePaths?: string[];
	externalMounts?: string[];
	autoExcludeNetworkMounts?: boolean;
	recoverMounts?: string[];
};
export type RecoverySnapshot = {
	settings: RecoverySettings;
	selection: RecoverySelection;
	digest: string;
	credentialConfigured: boolean;
	policyPath: string;
};
export type RecoveryStatus = Record<string, unknown>;
export type RecoveryOperationResult = string;
export type RecoverySaveRequest = {
	baselineDigest: string;
	settings: RecoverySettings;
	selection: RecoverySelection;
};
export type RecoveryCredentialRequest = { connectionString: string };

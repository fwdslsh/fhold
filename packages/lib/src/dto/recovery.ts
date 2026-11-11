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
export type CheckpointPackagePlan = {
	product: 'fhold';
	scope: 'assistant-checkpoint';
	instanceId: string;
	generation: string;
	previewDigest: string;
	createdAt: number;
	files: number;
	totalBytes: number;
	selection: RecoverySelection;
	warnings: string[];
};
export type CheckpointPackageRequest = { directory: string };
export type CheckpointPackageImportRequest = CheckpointPackageRequest & {
	destinationHome: string;
	backupDirectory: string;
	previewDigest: string;
};
export type CheckpointPackageImportResult = CheckpointPackagePlan & {
	homeDir: string;
	restored: true;
};
export type CheckpointPackageOperation =
	| { operation: 'export'; directory: string }
	| { operation: 'preview'; directory: string }
	| ({ operation: 'import' } & CheckpointPackageImportRequest);

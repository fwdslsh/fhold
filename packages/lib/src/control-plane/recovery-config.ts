import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalPath } from '../../../../containers/assistant/recovery/selection.mjs';

export type RecoverySettings = {
	enabled: boolean;
	destination: string;
	instanceId: string;
	intervalSeconds: number;
	maxUnsavedSeconds: number;
	operationTimeoutSeconds: number;
	authentication: 'connection-string' | 'managed-identity';
	clientId: string;
};

export function defaultRecoverySettings(projectName: string): RecoverySettings {
	return {
		enabled: false,
		destination: '',
		instanceId: projectName.replaceAll('_', '-').slice(0, 63).replace(/-+$/, ''),
		intervalSeconds: 60,
		maxUnsavedSeconds: 300,
		operationTimeoutSeconds: 120,
		authentication: 'connection-string',
		clientId: ''
	};
}

export function directoryRecoveryDestination(value: string): string {
	if (!isAbsolute(value) || !canonicalPath(value))
		throw new Error('Choose an absolute backup directory, not the filesystem root.');
	return pathToFileURL(value).href;
}

export function parseRecoverySettings(value: unknown, projectName: string): RecoverySettings {
	const defaults = defaultRecoverySettings(projectName);
	if (value === undefined) return defaults;
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('recovery must be an object.');
	const source = value as Record<string, unknown>;
	if (Object.keys(source).some((key) => !Object.hasOwn(defaults, key)))
		throw new Error('recovery contains unsupported settings.');
	const result = { ...defaults, ...source };
	if (
		typeof result.enabled !== 'boolean' ||
		typeof result.destination !== 'string' ||
		typeof result.instanceId !== 'string' ||
		!/^[a-z0-9][a-z0-9-]{0,62}$/.test(result.instanceId)
	)
		throw new Error('Recovery needs a stable lowercase instance ID and a boolean enable setting.');
	if (result.enabled && !result.destination)
		throw new Error('Choose a recovery destination before enabling recovery.');
	if (result.destination) {
		if (result.destination.startsWith('file:')) {
			let path: string;
			try {
				path = fileURLToPath(result.destination);
			} catch {
				throw new Error('Invalid directory recovery destination.');
			}
			if (directoryRecoveryDestination(path) !== result.destination)
				throw new Error('Use a canonical file URL for the backup directory.');
		} else if (
			!/^azblob:\/\/[a-z0-9]{3,24}\/[a-z0-9][a-z0-9-]{1,61}[a-z0-9](?:\/[A-Za-z0-9_-]{1,128})*$/.test(
				result.destination
			) ||
			result.destination.split('/')[3]?.includes('--')
		)
			throw new Error(
				'Recovery destination must be an absolute file URL or azblob://account/container/prefix, without credentials.'
			);
	}
	for (const [key, min, max] of [
		['intervalSeconds', 1, 86_400],
		['maxUnsavedSeconds', 5, 604_800],
		['operationTimeoutSeconds', 1, 3_600]
	] as const) {
		if (
			typeof result[key] !== 'number' ||
			!Number.isInteger(result[key]) ||
			result[key] < min ||
			result[key] > max
		)
			throw new Error(`recovery.${key} must be an integer from ${min} to ${max}.`);
	}
	if (
		!['connection-string', 'managed-identity'].includes(String(result.authentication)) ||
		typeof result.clientId !== 'string' ||
		(result.clientId &&
			!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(result.clientId))
	)
		throw new Error(
			'Choose connection-string or managed-identity authentication and a valid optional identity UUID.'
		);
	return result as RecoverySettings;
}

export function recoveryDirectory(homeDir: string, config: RecoverySettings): string {
	const path =
		config.enabled && config.destination.startsWith('file:')
			? fileURLToPath(config.destination)
			: join(homeDir, 'state/recovery-storage');
	if (
		config.enabled &&
		config.destination.startsWith('file:') &&
		(path === homeDir || path.startsWith(`${homeDir}/`) || homeDir.startsWith(`${path}/`))
	)
		throw new Error(
			'Recovery artifacts must live outside the instance home, not in a parent of it.'
		);
	for (let current = path; current !== dirname(current); current = dirname(current)) {
		try {
			const stat = lstatSync(current);
			if (!stat.isDirectory() || stat.isSymbolicLink())
				throw new Error(
					'Recovery backup directory and its parents must be real directories, not links.'
				);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}
	return path;
}

/** The native receipt stays scoped to its destination/identity; no authority is copied on a change. */
export function recoveryEnvironment(config: RecoverySettings): Record<string, string> {
	const namespace = createHash('sha256')
		.update(JSON.stringify([config.destination, config.instanceId]))
		.digest('hex')
		.slice(0, 32);
	return {
		FH_RECOVERY_URL: config.enabled
			? config.destination.startsWith('file:')
				? 'file:///recovery'
				: config.destination
			: '',
		FH_INSTANCE_ID: config.instanceId,
		FH_RECOVERY_INTERVAL_SECONDS: String(config.intervalSeconds),
		FH_RECOVERY_MAX_UNSAVED_SECONDS: String(config.maxUnsavedSeconds),
		FH_RECOVERY_OPERATION_TIMEOUT_SECONDS: String(config.operationTimeoutSeconds),
		FH_RECOVERY_INCLUDE_FILE: '/run/fhold-recovery/include.json',
		FH_RECOVERY_CREDENTIAL_FILE:
			config.enabled &&
			config.destination.startsWith('azblob:') &&
			config.authentication === 'connection-string'
				? '/run/secrets/recovery_connection_string'
				: '',
		FH_RECOVERY_STATE_DIR: `/run/fhold-recovery-state/${namespace}`,
		AZURE_CLIENT_ID: config.authentication === 'managed-identity' ? config.clientId : ''
	};
}

export function recoveryStopGrace(config: RecoverySettings): number {
	return config.enabled ? 25 + 2 + 2 * config.operationTimeoutSeconds + 30 : 30;
}

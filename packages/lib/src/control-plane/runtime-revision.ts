import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEnvFile, writeFileAtomic } from './foundation.js';
import { assertSafePortablePath, nativePreferencesFile } from './provider-files.js';
import { MANAGED_FILES, SEEDED_FILES } from './seed-manifest.js';
import { readStackConfig } from './stack-config.js';

const RECEIPT = 'state/applied-runtime.json';
export type RestartStatus = { required: boolean; error?: string };

/** Hash startup inputs, not mutable agent data or native provider login files. */
export function runtimeRevision(homeDir: string): string {
	const read = readStackConfig(homeDir);
	if (!read.ok) throw new Error(read.error);
	const { credentials: _credentials, ...intent } = read.config;
	assertSafePortablePath(homeDir, 'system/stack/stack.compose.yml', true);
	const managedRecovery = readFileSync(join(homeDir, 'system/stack/stack.compose.yml'), 'utf8').includes('/run/fhold-recovery/include.json');
	// Read-only management of an earlier off instance must not fabricate pending
	// changes from newly introduced defaults or an absent optional seed file.
	const { recovery, ...previousIntent } = intent;
	assertSafePortablePath(homeDir, 'state/stack.env', true);
	const env = readEnvFile(join(homeDir, 'state/stack.env'));
	delete env.FH_SETUP_COMPLETE;
	const hash = createHash('sha256');
	hash.update(JSON.stringify(managedRecovery || recovery.enabled ? intent : previousIntent));
	hash.update(JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))));
	// Native API edits reload in place: content is not a container startup input.
	// A different filename/inode does replace the bind mount and needs activation.
	const preferences = `config/assistant/${nativePreferencesFile(homeDir)}`;
	const preferenceStat = lstatSync(join(homeDir, preferences), { throwIfNoEntry: false });
	hash.update(JSON.stringify([preferences, preferenceStat?.dev ?? null, preferenceStat?.ino ?? null]));
	const files: string[] = [...MANAGED_FILES, ...SEEDED_FILES].filter(
		(path) =>
			!path.endsWith('/.gitignore') &&
			(managedRecovery || !path.startsWith('config/recovery/')) &&
			(read.config.gateway.enabled ||
				(!path.startsWith('config/guardian/') && !path.startsWith('system/guardian/'))) &&
			// These authorization maps are read on each request, without a restart.
			!path.startsWith('config/portal/') &&
			path !== 'config/assistant/opencode.json' &&
			path !== 'config/guardian/oauth-identities.json'
	);
	files.push('state/secrets/fhold_opencode_password', 'state/secrets/fhold_guardian_handle_key');
	if (read.config.recovery.enabled && read.config.recovery.destination.startsWith('azblob:') && read.config.recovery.authentication === 'connection-string') files.push('state/secrets/fhold_recovery_connection_string');
	if (read.config.portals.discord.enabled) files.push('state/secrets/discord_bot_token');
	if (read.config.portals.slack.enabled)
		files.push('state/secrets/slack_bot_token', 'state/secrets/slack_app_token');
	for (const path of files.sort()) {
		assertSafePortablePath(homeDir, path, true);
		const absolute = join(homeDir, path);
		const digest = existsSync(absolute)
			? createHash('sha256').update(readFileSync(absolute)).digest('hex')
			: null;
		hash.update(JSON.stringify([path, digest]));
	}
	return hash.digest('hex');
}

function appliedRevision(homeDir: string): { revision: string; pending?: boolean } | undefined {
	assertSafePortablePath(homeDir, RECEIPT, true);
	const path = join(homeDir, RECEIPT);
	if (!existsSync(path)) return undefined;
	const value = JSON.parse(readFileSync(path, 'utf8')) as {
		version?: unknown;
		revision?: unknown;
		pending?: unknown;
	};
	if (
		value?.version !== 1 ||
		typeof value.revision !== 'string' ||
		!/^[a-f0-9]{64}$/.test(value.revision) ||
		(value.pending !== undefined && typeof value.pending !== 'boolean')
	)
		throw new Error(
			'Saved restart status is invalid. Restart through fhold to verify and apply the current settings.'
		);
	return { revision: value.revision, pending: value.pending };
}

function writeRevision(homeDir: string, revision: string, pending?: boolean): void {
	assertSafePortablePath(homeDir, RECEIPT, true);
	writeFileAtomic(
		join(homeDir, RECEIPT),
		`${JSON.stringify({ version: 1, revision, pending })}\n`,
		0o600
	);
}

/** A failed/interrupted activation must stay pending, even if the files did not change. */
export function recordRuntimeActivation(homeDir: string, revision: string): void {
	writeRevision(homeDir, revision, true);
}

/** Called under the existing lifecycle lock, only after a successful full activation. */
export function recordAppliedRuntime(homeDir: string, revision: string): void {
	writeRevision(homeDir, revision);
}

/** Existing homes acquire their comparison baseline before the first managed edit. */
export function rememberRuntimeBeforeChange(homeDir: string): void {
	assertSafePortablePath(homeDir, RECEIPT, true);
	if (!existsSync(join(homeDir, RECEIPT))) recordAppliedRuntime(homeDir, runtimeRevision(homeDir));
}

/** Read-only and per home: closing Admin or switching instances cannot lose pending changes. */
export function restartStatus(homeDir: string): RestartStatus {
	try {
		const applied = appliedRevision(homeDir);
		return {
			required:
				applied !== undefined &&
				(applied.pending === true || applied.revision !== runtimeRevision(homeDir))
		};
	} catch {
		return {
			required: true,
			error:
				'Restart status could not be verified. Review the saved files, then restart to apply them.'
		};
	}
}

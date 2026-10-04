import { createFholdState } from './foundation.js';
import { acquireStackLock, releaseStackLock } from './lock.js';
import { ensureRuntime, requireInstall } from './state.js';
import { createCredentialId, isCredentialUsername, isGuardianPolicy, readStackConfig, writeStackConfig, type GuardianPolicy, type StackConfig } from './stack-config.js';
import { generateCredentialKey, normalizeCredentialKey, readCredentialKey, removeCredentialKey, writeCredentialKey } from './credential-store.js';
import { oauthCredentialUsages } from './oauth-store.js';
import { readOAuthIdentityMap, writeOAuthIdentityMap } from './oauth-store.js';
import { normalizePortalSecret, writePortalSecret } from './portal-settings.js';
import { isPortalName, isPortalUserId, portalCredentialUsages, readPortalCredentialMap, syncPortalCredentialBundles, writePortalCredentialMap } from './portal-credential-store.js';
import { assertSafePortablePath } from './provider-files.js';

/** All mutations read latest intent only after exclusion is acquired. */
export function mutateStack<T>(homeDir: string, action: (config: StackConfig) => T): T {
	const state = createFholdState(homeDir);
	requireInstall(state.homeDir);
	const lock = acquireStackLock(state.dataDir);
	if (!lock) throw new Error('lifecycle_in_progress: Another stack operation is running.');
	try {
		const result = readStackConfig(state.homeDir);
		if (!result.ok) throw new Error(result.error);
		return action(result.config);
	} finally { releaseStackLock(lock); }
}

function username(value: unknown): string {
	if (!isCredentialUsername(value)) throw new Error('Invalid credential username.');
	return value;
}
function policy(value: unknown): GuardianPolicy {
	if (!isGuardianPolicy(value)) throw new Error('Policy must be chat, read, or full.');
	return value;
}
function uniqueKey(homeDir: string, config: StackConfig, key: string, except?: string): void {
	for (const name of Object.keys(config.credentials)) {
		if (name !== except && readCredentialKey(homeDir, name) === key) throw new Error(`Credential key is already assigned to ${name}.`);
	}
}
export function createCredential(homeDir: string, value: { username: unknown; policy: unknown; key?: string }) {
	const name = username(value.username);
	const selectedPolicy = policy(value.policy);
	const key = value.key === undefined ? generateCredentialKey() : normalizeCredentialKey(value.key);
	return mutateStack(homeDir, (config) => {
		if (Object.hasOwn(config.credentials, name)) throw new Error(`Credential already exists: ${name}`);
		if (Object.keys(config.credentials).length >= 128) throw new Error('Credential limit reached.');
		uniqueKey(homeDir, config, key);
		const keyFile = writeCredentialKey(homeDir, name, key);
		config.credentials[name] = { id: createCredentialId(), policy: selectedPolicy };
		writeStackConfig(homeDir, config);
		syncPortalCredentialBundles(homeDir, config);
		return { username: name, policy: selectedPolicy, keyFile };
	});
}
export function rotateCredential(homeDir: string, value: unknown, suppliedKey?: string): string {
	const name = username(value);
	const key = suppliedKey === undefined ? generateCredentialKey() : normalizeCredentialKey(suppliedKey);
	return mutateStack(homeDir, (config) => {
		if (!Object.hasOwn(config.credentials, name)) throw new Error(`Unknown credential: ${name}`);
		uniqueKey(homeDir, config, key, name);
		const keyFile = writeCredentialKey(homeDir, name, key);
		syncPortalCredentialBundles(homeDir, config);
		return keyFile;
	});
}
export function setCredentialPolicy(homeDir: string, value: unknown, selectedPolicy: unknown): void {
	const name = username(value);
	const selected = policy(selectedPolicy);
	mutateStack(homeDir, (config) => {
		const credential = Object.hasOwn(config.credentials, name) ? config.credentials[name] : undefined;
		if (!credential) throw new Error(`Unknown credential: ${name}`);
		credential.policy = selected;
		writeStackConfig(homeDir, config);
		syncPortalCredentialBundles(homeDir, config);
	});
}
export function removeCredential(homeDir: string, value: unknown): void {
	const name = username(value);
	mutateStack(homeDir, (config) => {
		if (!Object.hasOwn(config.credentials, name)) throw new Error(`Unknown credential: ${name}`);
		const usages = [...portalCredentialUsages(homeDir, config, name), ...oauthCredentialUsages(homeDir, name)];
		if (usages.length) throw new Error(`Credential is assigned to ${usages.join(', ')}.`);
		if (Object.keys(config.credentials).length === 1) throw new Error('Cannot remove the final credential.');
		delete config.credentials[name];
		writeStackConfig(homeDir, config);
		removeCredentialKey(homeDir, name);
		syncPortalCredentialBundles(homeDir, config);
	});
}
export function mapPortalUser(homeDir: string, value: { portal: unknown; userId: unknown; username?: unknown }): void {
	if (!isPortalName(value.portal)) throw new Error('Portal must be discord or slack.');
	const portal = value.portal;
	if (!isPortalUserId(portal, value.userId)) throw new Error(`Invalid ${portal} user ID.`);
	const userId = value.userId;
	mutateStack(homeDir, (config) => {
		const mapping = readPortalCredentialMap(homeDir, portal);
		if (value.username === undefined || value.username === '') delete mapping.users[userId];
		else {
			const name = username(value.username);
			if (!Object.hasOwn(config.credentials, name)) throw new Error(`Unknown credential: ${name}`);
			mapping.users[userId] = name;
		}
		writePortalCredentialMap(homeDir, portal, mapping);
		syncPortalCredentialBundles(homeDir, config);
	});
}
export function saveStackIntent(homeDir: string, config: StackConfig, baseline: StackConfig): StackConfig {
	return mutateStack(homeDir, (current) => {
		if (!baseline || JSON.stringify(current) !== JSON.stringify(baseline)) throw new Error('Settings changed since refresh. Refresh and review before saving.');
		const saved = writeStackConfig(homeDir, config);
		ensureRuntime(createFholdState(homeDir));
		return saved;
	});
}

export function mapOAuthIdentity(homeDir: string, value: { issuer: string; subject: string; username?: unknown }): void {
	mutateStack(homeDir, (config) => {
		const mapping = readOAuthIdentityMap(homeDir);
		const index = mapping.identities.findIndex((identity) => identity.issuer === value.issuer && identity.subject === value.subject);
		if (value.username === undefined) {
			if (index < 0) throw new Error('OAuth identity has no mapping.');
			mapping.identities.splice(index, 1);
		} else {
			const name = username(value.username);
			if (!Object.hasOwn(config.credentials, name)) throw new Error(`Unknown credential: ${name}`);
			if (index >= 0) mapping.identities[index] = { issuer: value.issuer, subject: value.subject, username: name };
			else mapping.identities.push({ issuer: value.issuer, subject: value.subject, username: name });
		}
		writeOAuthIdentityMap(homeDir, mapping);
	});
}

export function savePortalTokens(homeDir: string, value: { portal: unknown; botToken?: string; appToken?: string }): string[] {
	if (!isPortalName(value.portal)) throw new Error('Portal must be discord or slack.');
	const portal = value.portal;
	if (portal === 'discord' && value.appToken !== undefined) throw new Error('App token is valid only for Slack');
	const botToken = value.botToken === undefined ? undefined : normalizePortalSecret(value.botToken);
	const appToken = value.appToken === undefined ? undefined : normalizePortalSecret(value.appToken);
	if (botToken === undefined && appToken === undefined) throw new Error('At least one portal token is required');
	return mutateStack(homeDir, () => {
		const paths: string[] = [];
		// Validate every destination before the first secret write, including all
		// parent components and dangling symlink leaves.
		for (const name of [botToken !== undefined ? (portal === 'discord' ? 'discord_bot_token' : 'slack_bot_token') : undefined, appToken !== undefined ? 'slack_app_token' : undefined]) {
			if (name) assertSafePortablePath(createFholdState(homeDir).homeDir, `state/secrets/${name}`, true);
		}
		if (botToken !== undefined) paths.push(writePortalSecret(homeDir, portal, portal === 'discord' ? 'discord_bot_token' : 'slack_bot_token', botToken));
		if (appToken !== undefined) paths.push(writePortalSecret(homeDir, portal, 'slack_app_token', appToken));
		return paths;
	});
}

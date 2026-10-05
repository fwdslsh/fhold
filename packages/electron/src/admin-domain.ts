import {
 applyRestore, classifyInstall, createBackup,
 installHome, createCredential, rotateCredential, removeCredential, mapPortalUser,
 isPortalName, readPortalCredentialMap, readStackConfig, planRestore, saveStackIntent,
 type PortalName, type StackConfig
} from '@fhold/lib';
import type { StackAction } from './admin-types.js';

export function interruptionPrompt(action: unknown) {
	if (typeof action !== 'string' || !['start', 'restart', 'stop', 'remote-setup'].includes(action))
		throw new Error('Invalid restart confirmation request.');
	if (action === 'remote-setup') return {
		message: 'Continue remote setup?',
		detail: 'Setup may restart containers before and after native sign-in. Active work and connections may be interrupted, and all saved settings will be applied. Your data is kept. You can cancel now and set this up later.',
		buttons: ['Set up later', 'Continue setup']
	};
	if (action === 'stop') return {
		message: 'Stop this instance?',
		detail: 'Active work and connections will be interrupted. Your data and saved settings are kept.',
		buttons: ['Cancel', 'Stop now']
	};
	return {
		message: action === 'start' ? 'Start and apply saved settings?' : 'Restart and apply saved settings?',
		detail: 'All saved settings will be applied. Running containers may be recreated, interrupting active work and connections. Your data is kept. You can leave this for later.',
		buttons: [action === 'start' ? 'Start later' : 'Restart later', action === 'start' ? 'Start now' : 'Restart now']
	};
}

export function confirmedAdminAction(value: unknown): StackAction {
	const input = value as { action?: unknown; confirmed?: unknown } | null;
	if (!input || typeof input !== 'object' || typeof input.action !== 'string' || !['start', 'restart', 'stop'].includes(input.action))
		throw new Error('Invalid stack action.');
	if (input.confirmed !== true) throw new Error('Confirm the container action before continuing.');
	return input.action as StackAction;
}

export function isAdminPageUrl(
	value: unknown,
	indexUrl: string,
	windows = process.platform === 'win32'
): boolean {
	if (typeof value !== 'string' || value.length > 4_096) return false;
	try {
		const url = new URL(value);
		if (url.protocol !== 'file:' || url.search || url.hash || url.username || url.password)
			return false;
		if (/%2f|%5c/i.test(url.pathname)) return false;
		const expected = new URL(indexUrl);
		if (url.hostname !== expected.hostname) return false;
		const path = decodeURIComponent(url.pathname);
		const expectedPath = decodeURIComponent(expected.pathname);
		return windows ? path.toLowerCase() === expectedPath.toLowerCase() : path === expectedPath;
	} catch {
		return false;
	}
}

export function externalAdminUrl(value: unknown): string {
	if (typeof value !== 'string' || value.length > 4_096) throw new Error('Invalid external URL.');
	const url = new URL(value);
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
		throw new Error('Only HTTP or HTTPS links without embedded credentials can be opened.');
	}
	return url.href;
}

export function adminPortalTokens(
	value: unknown,
	configured: Record<string, boolean>
): { portal: PortalName; botToken?: string; appToken?: string } {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Invalid portal token operation');
	}
	const input = value as { portal?: unknown; botToken?: unknown; appToken?: unknown };
	if (!isPortalName(input.portal)) throw new Error('Portal must be discord or slack.');
	for (const token of [input.botToken, input.appToken]) {
		if (token !== undefined && typeof token !== 'string') throw new Error('Invalid portal token.');
	}
	const botToken = input.botToken as string | undefined;
	const appToken = input.appToken as string | undefined;
	if (input.portal === 'discord' && !botToken) throw new Error('Discord bot token is required.');
	if (
		input.portal === 'slack' &&
		((!configured.slack_bot_token && !botToken) || (!configured.slack_app_token && !appToken))
	) {
		throw new Error('Both Slack tokens are required the first time.');
	}
	if (input.portal === 'slack' && !botToken && !appToken) {
		throw new Error('Enter at least one Slack token to replace.');
	}
	return {
		portal: input.portal,
		...(botToken ? { botToken } : {}),
		...(input.portal === 'slack' && appToken ? { appToken } : {})
	};
}

export async function installFromAdmin(config?: unknown, homeDir?: string, automaticPorts = true): Promise<string> {
 return installHome({ homeDir, ...(config === undefined ? {} : { config }), automaticPorts });
}

export function saveAdminConfig(homeDir: string, config: StackConfig, baseline: StackConfig): StackConfig {
 return saveStackIntent(homeDir, config, baseline);
}

function current(homeDir: string): StackConfig {
	const result = readStackConfig(homeDir);
	if (!result.ok) throw new Error(result.error);
	return result.config;
}

export const createAdminCredential = createCredential;
export const rotateAdminCredential = rotateCredential;
export const removeAdminCredential = removeCredential;
export const mapAdminPortalUser = mapPortalUser;

export function adminPortalMappings(homeDir: string) {
	const config = current(homeDir);
	return Object.fromEntries(
		(['discord', 'slack'] as const).map((portal) => [
			portal,
			{
				default: config.portals[portal].credential,
				users: readPortalCredentialMap(homeDir, portal).users
			}
		])
	);
}

export async function backupFromAdmin(
	homeDir: string,
	value: {
		destination: string;
		includeProviderAuth?: boolean;
		includeUserEnv?: boolean;
		includePortalMaps?: boolean;
		includeOAuth?: boolean;
	}
) {
	return createBackup({ sourceHome: homeDir, ...value });
}

export function restoreFromAdmin(
	homeDir: string,
	value: {
		sourceHome: string;
		apply?: boolean;
		previewDigest?: string;
		acknowledgeUnrestored?: boolean;
		includeProviderAuth?: boolean;
		includeUserEnv?: boolean;
		includePortalMaps?: boolean;
		includeOAuth?: boolean;
	}
) {
	if (classifyInstall(homeDir) !== 'setup_incomplete') {
		throw new Error('Restore is available only before setup is completed on a fresh installation.');
	}
	const { apply, previewDigest, ...importOptions } = value;
	const options = { destinationHome: homeDir, ...importOptions };
	if (!apply) return planRestore(options);
	if (!previewDigest || !/^[a-f0-9]{64}$/.test(previewDigest)) {
		throw new Error('Preview this restore before applying it.');
	}
	return applyRestore(options, previewDigest);
}

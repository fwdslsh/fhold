import { applyRestore, planRestore } from '../control-plane/restore.js';
import { classifyInstall, markInstalled } from '../control-plane/state.js';
import { configureGuardianModeratorModel } from '../control-plane/opencode.js';
import { mutateStack } from '../control-plane/operations.js';
import type { AssistantReadiness } from '../control-plane/native-agent.js';
import { createBackup } from '../control-plane/backup.js';
import { installHome } from '../control-plane/install.js';
import {
	createCredential,
	rotateCredential,
	removeCredential,
	setCredentialPolicy,
	mapPortalUser,
	saveStackIntent
} from '../control-plane/operations.js';
import {
	isPortalName,
	readPortalCredentialMap,
	type PortalName
} from '../control-plane/portal-credential-store.js';
import {
	readStackConfig,
	type GuardianPolicy,
	type StackConfig
} from '../control-plane/stack-config.js';
import {
	exportInstance,
	planInstanceRestore,
	restoreInstance,
	INSTANCE_BACKUP_NOTICE
} from '../control-plane/instance-backup.js';
import type { HostingActionEffect } from '../hosting/types.js';
import type { StackAction } from './types.js';

/** Host application completion is separate from the native agent verification. */
export async function completeInstanceSetup(
	homeDir: string,
	readiness: Extract<AssistantReadiness, { ok: true }>
): Promise<void> {
	mutateStack(homeDir, () => {
		configureGuardianModeratorModel(homeDir, readiness.provider, readiness.model);
		markInstalled(homeDir);
	});
}

export function interruptionPrompt(action: unknown, effect?: HostingActionEffect) {
	if (
		typeof action !== 'string' ||
		![
			'start',
			'restart',
			'stop',
			'update',
			'apply',
			'remote-setup',
			'recovery-init',
			'recovery-restore',
			'instance-export',
			'instance-import'
		].includes(action)
	)
		throw new Error('Invalid restart confirmation request.');
	if (action === 'apply')
		return {
			message: 'Apply saved changes?',
			detail:
				effect === 'update-deployment'
					? 'The hosting platform will update the deployment. Running instances stop and start again; a stopped instance finishes stopped, although the platform may briefly activate a new revision. Active work may be interrupted. Agent readiness and backup durability are checked separately.'
					: 'All saved instance settings will be applied. Containers will start or restart, interrupting active work and connections. Your data is kept. You can leave this for later.',
			buttons: ['Later', 'Apply changes']
		};
	if (effect === 'request-platform-state' && (action === 'start' || action === 'stop'))
		return {
			message: `Request the hosting platform to ${action} this app?`,
			detail:
				'This submits a native platform request, not a settings update or container replacement. Active connections may be interrupted. Acceptance does not prove replica drain or agent readiness; check platform status before replacing any writers.',
			buttons: ['Cancel', `Request ${action}`]
		};
	if (effect === 'restart-runtime' && action === 'restart')
		return {
			message: 'Restart the active runtime?',
			detail:
				'This requests a native runtime restart. Active work and connections will be interrupted. It does not change images, settings, mounts, scale rules or secrets. Request acceptance is not proof of agent readiness or a completed recovery checkpoint.',
			buttons: ['Cancel', 'Restart runtime']
		};
	if (action === 'instance-export' || action === 'instance-import')
		return {
			message:
				action === 'instance-export'
					? 'Export this entire stopped instance?'
					: 'Import this entire instance into the empty folder?',
			detail: INSTANCE_BACKUP_NOTICE,
			buttons: [
				'Cancel',
				action === 'instance-export' ? 'Export entire instance' : 'Import entire instance'
			]
		};
	if (action === 'recovery-init')
		return {
			message: 'Initialize a new recovery destination?',
			detail:
				'The instance must be stopped. This is a one-time operation for a genuinely unused destination and instance ID. It does not restore data, start containers or overwrite an existing recovery namespace. Keep the destination private.',
			buttons: ['Cancel', 'Initialize new destination']
		};
	if (action === 'recovery-restore')
		return {
			message: 'Validate and restore this same instance?',
			detail:
				'The instance must be stopped. Its accepted checkpoint is validated before missing native files are restored. Existing local data is not overwritten, incompatible native versions are refused, and containers remain stopped. This is not a portable import or rollback.',
			buttons: ['Cancel', 'Validate / restore']
		};
	if (action === 'remote-setup')
		return {
			message: 'Continue remote setup?',
			detail:
				'Native sign-in runs first. Completing setup may restart containers to apply saved settings. Active work and connections may be interrupted. Your data is kept. Cancelling sign-in does not change startup settings or restart containers.',
			buttons: ['Set up later', 'Continue setup']
		};
	if (action === 'update')
		return {
			message: 'Update this instance?',
			detail:
				'Refresh managed files and recreate containers with the runtime version included in these tools. Active work may be interrupted. Your configuration, knowledge and sessions are preserved.',
			buttons: ['Update later', 'Update now']
		};
	if (action === 'stop')
		return {
			message: 'Stop this instance?',
			detail:
				'Active work and connections will be interrupted. Your data and saved settings are kept.',
			buttons: ['Cancel', 'Stop now']
		};
	return {
		message:
			action === 'start' ? 'Start and apply saved settings?' : 'Restart and apply saved settings?',
		detail:
			'All saved settings will be applied. Running containers may be recreated, interrupting active work and connections. Your data is kept. You can leave this for later.',
		buttons: [
			action === 'start' ? 'Start later' : 'Restart later',
			action === 'start' ? 'Start now' : 'Restart now'
		]
	};
}

export function confirmedAdminAction(value: unknown): StackAction {
	const input = value as { action?: unknown; confirmed?: unknown } | null;
	if (
		!input ||
		typeof input !== 'object' ||
		typeof input.action !== 'string' ||
		!['start', 'restart', 'stop'].includes(input.action)
	)
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

export async function installFromAdmin(
	config?: unknown,
	homeDir?: string,
	automaticPorts = true
): Promise<string> {
	return installHome({ homeDir, ...(config === undefined ? {} : { config }), automaticPorts });
}

export function saveAdminConfig(
	homeDir: string,
	config: StackConfig,
	baseline: StackConfig
): StackConfig {
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
export function updateAdminCredentialPolicy(
	homeDir: string,
	value: { username: string; policy: GuardianPolicy; previousPolicy: GuardianPolicy }
): void {
	setCredentialPolicy(homeDir, value.username, value.policy, value.previousPolicy);
}
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
		full?: boolean;
		confirmed?: boolean;
		includeProviderAuth?: boolean;
		includeUserEnv?: boolean;
		includePortalMaps?: boolean;
		includeOAuth?: boolean;
	}
) {
	if (value.full !== undefined && typeof value.full !== 'boolean')
		throw new Error('Invalid export scope.');
	if (value.full)
		return exportInstance({
			sourceHome: homeDir,
			destination: value.destination,
			confirmedStopped: value.confirmed === true
		});
	const { full: _full, confirmed: _confirmed, ...options } = value;
	return createBackup({ sourceHome: homeDir, ...options });
}

export async function instanceRestoreFromAdmin(
	homeDir: string,
	value: { sourceHome: string; apply?: boolean; previewDigest?: string; confirmed?: boolean }
) {
	const options = {
		sourceHome: value.sourceHome,
		destinationHome: homeDir,
		confirmedStopped: value.confirmed === true
	};
	if (!value.apply) return planInstanceRestore(options);
	if (!value.previewDigest || !/^[a-f0-9]{64}$/.test(value.previewDigest))
		throw new Error('Preview this full-instance import before applying it.');
	return restoreInstance(options, value.previewDigest);
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

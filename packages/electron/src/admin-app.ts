import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent, OpenDialogOptions } from 'electron';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
	activateComposeCommand,
	beginRemoteEnable,
	remoteTool,
	remoteBrowserUrls,
	remoteConnection,
	beginProviderOAuth,
	buildComposeOptions,
	classifyInstall,
	composeLogs,
	composePs,
	completeProviderOAuth,
	configureGuardianModeratorModel,
	connectionDetails,
	createFholdState,
	defaultStackConfig,
	deactivateComposeCommand,
	ensureDockerReady,
	isCodexSandbox,
	isCredentialUsername,
	isPortalName,
	listProviders,
	markInstalled,
	mutateStack,
	restartStatus,
	parseComposePsRows,
	parseStackConfig,
	portalSecretConfigured,
	readCredentialKey,
	readStackConfig,
	requireInstall,
	setProviderApiKey,
	stackConfigFile,
	testAssistantReadiness,
	savePortalTokens
} from '@fhold/lib';
import { recoverySnapshot, recoveryStatus, runRecoveryOperation, saveRecoverySettings, saveRecoveryCredential } from '@fhold/lib';
import {
	reviewCodexRecall,
	changeCodexRecall,
	assertProjectOwnership,
	isInstanceName
} from '@fhold/lib';
import type { AssistantReadiness, CodexSandbox, RemoteEnableSession } from '@fhold/lib';

import { AdminInstances } from './admin-instances.js';

import { ADMIN_CHANNELS, type AdminSnapshot, type StackAction } from './admin-types.js';
import {
	confirmedAdminAction,
	interruptionPrompt,
	adminPortalMappings,
	adminPortalTokens,
	backupFromAdmin,
	instanceRestoreFromAdmin,
	createAdminCredential,
	externalAdminUrl,
	restoreFromAdmin,
	installFromAdmin,
	isAdminPageUrl,
	mapAdminPortalUser,
	removeAdminCredential,
	rotateAdminCredential,
	saveAdminConfig
} from './admin-domain.js';

const adminDirectory = fileURLToPath(new URL('../admin', import.meta.url));
const adminIndexPath = join(adminDirectory, 'index.html');
const adminIndexUrl = pathToFileURL(adminIndexPath).href;
let activeRemote: { homeDir: string; session: RemoteEnableSession } | undefined;
let remoteStarting = false;
let instances: AdminInstances;
let pendingOAuth: { homeDir: string; provider: string; method: number } | undefined;

function managedState() {
	return createFholdState(instances.current().homeDir);
}

function handleAdmin(
	channel: string,
	handler: (event: IpcMainInvokeEvent, value?: unknown) => unknown
): void {
	ipcMain.handle(channel, (event, value: unknown) => {
		requireAdminSender(event);
		return instances.run(() => handler(event, value));
	});
}

function requireSwitchable(): void {
	instances.assertIdle();
	if (remoteStarting || activeRemote?.session.snapshot().running)
		throw new Error('Finish or cancel native remote setup before switching instances.');
}

if (!process.env.FH_SKELETON_DIR && !process.env.FH_REPO_ROOT) {
	process.env.FH_SKELETON_DIR = app.isPackaged
		? join(process.resourcesPath, 'skeleton')
		: join(import.meta.dirname, '..', '..', 'skeleton');
}

function requireAdminSender(event: IpcMainInvokeEvent): void {
	if (
		event.senderFrame !== event.sender.mainFrame ||
		!isAdminPageUrl(event.senderFrame?.url, adminIndexUrl)
	)
		throw new Error('Unauthorized admin IPC sender');
}

function state() {
	const value = managedState();
	requireInstall(value.homeDir);
	return value;
}

function connectionSnapshot(homeDir: string): NonNullable<AdminSnapshot['connectionDetails']> {
	return {
		opencode: connectionDetails(homeDir, 'opencode'),
		mcp: connectionDetails(homeDir, 'mcp'),
		claude: connectionDetails(homeDir, 'claude')
	};
}

function oauthInput(value: unknown): {
	provider: string;
	method: number;
	inputs?: Record<string, string>;
} {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Invalid provider sign-in request.');
	}
	const input = value as { provider?: unknown; method?: unknown; inputs?: unknown };
	if (typeof input.provider !== 'string' || typeof input.method !== 'number') {
		throw new Error('Provider and sign-in method are required.');
	}
	if (
		input.inputs !== undefined &&
		(!input.inputs || typeof input.inputs !== 'object' || Array.isArray(input.inputs))
	) {
		throw new Error('Invalid provider sign-in fields.');
	}
	if (
		input.inputs &&
		Object.values(input.inputs as Record<string, unknown>).some((item) => typeof item !== 'string')
	) {
		throw new Error('Invalid provider sign-in fields.');
	}
	return {
		provider: input.provider,
		method: input.method,
		...(input.inputs ? { inputs: input.inputs as Record<string, string> } : {})
	};
}

export async function adminSnapshot(): Promise<AdminSnapshot> {
	const candidate = managedState();
	const installState = classifyInstall(candidate.homeDir);
	if (installState === 'not_installed') {
		const config = defaultStackConfig(candidate.homeDir);
		if (instances.setupName) {
			config.deployment.projectName = instances.setupName;
			config.recovery.instanceId = instances.setupName;
		}
		return {
			installationReadiness: await ensureDockerReady(),
			phase: 'not_installed',
			homeDir: candidate.homeDir,
			configPath: stackConfigFile(candidate.homeDir),
			config,
			services: [],
			portalMappings: {},
			portalSecrets: {}
		};
	}
	if (installState === 'incompatible_home') {
		throw new Error(
			'The selected folder is incompatible with fhold. Choose an empty directory for installation.'
		);
	}
	const current = state();
	const config = readStackConfig(current.homeDir);
	if (!config.ok) throw new Error(config.error);
	const result = await composePs(buildComposeOptions(current));
	const services = result.ok
		? parseComposePsRows(result.stdout).map((row) => ({
				name: row.service,
				state: row.state,
				health: row.health
			}))
		: [];
	let recovery: ReturnType<typeof recoverySnapshot> | undefined;
	let recoveryError: string | undefined;
	try { recovery = recoverySnapshot(current.homeDir); }
	catch { recoveryError = 'Recovery selection could not be read. Review config/recovery/include.json; no recovery settings were changed.'; }
	return {
		phase: installState === 'installed' ? 'ready' : 'setup_incomplete',
		homeDir: current.homeDir,
		configPath: stackConfigFile(current.homeDir),
		config: config.config,
		services,
		pendingRestart: restartStatus(current.homeDir),
		recovery,
		recoveryError,
		...(result.ok ? {} : { dockerError: result.stderr || 'Docker is unavailable' }),
		portalMappings: adminPortalMappings(current.homeDir),
		portalSecrets: {
			discord: portalSecretConfigured(current.homeDir, 'discord'),
			slack: portalSecretConfigured(current.homeDir, 'slack')
		},
		connectionDetails: connectionSnapshot(current.homeDir)
	};
}

export async function runAdminAction(action: StackAction): Promise<AdminSnapshot> {
	const current = state();
	if (action === 'stop') {
		await deactivateComposeCommand(current);
	} else if (action === 'restart') {
		await activateComposeCommand(current, [
			'up',
			'-d',
			'--force-recreate',
			'--remove-orphans',
			'--wait'
		]);
	} else {
		await activateComposeCommand(current, ['up', '-d', '--remove-orphans', '--wait']);
	}
	return adminSnapshot();
}

async function completeAdminReadiness(
	homeDir: string,
	readiness: AssistantReadiness
): Promise<void> {
	if (!readiness.ok) return;
	mutateStack(homeDir, () => {
		configureGuardianModeratorModel(homeDir, readiness.provider, readiness.model);
		markInstalled(homeDir);
	});
}

export function registerAdminIpc(): void {
	instances = new AdminInstances(app.getPath('userData'));
	ipcMain.handle(ADMIN_CHANNELS.welcome, (event) => {
		requireAdminSender(event);
		return instances.welcome();
	});
	ipcMain.handle(ADMIN_CHANNELS.openInstance, (event, target: unknown) => {
		requireAdminSender(event);
		requireSwitchable();
		instances.open(target);
		activeRemote = undefined;
		pendingOAuth = undefined;
	});
	ipcMain.handle(ADMIN_CHANNELS.prepareNewInstance, (event, target: unknown) => {
		requireAdminSender(event);
		requireSwitchable();
		instances.prepareNew(target);
		activeRemote = undefined;
		pendingOAuth = undefined;
	});
	ipcMain.handle(ADMIN_CHANNELS.closeInstance, (event) => {
		requireAdminSender(event);
		requireSwitchable();
		instances.close();
		activeRemote = undefined;
		pendingOAuth = undefined;
	});
	handleAdmin(ADMIN_CHANNELS.codexRecall, async (_event, value: unknown) => {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new Error('Invalid recall request.');
		const input = value as Record<string, unknown>;
		const current = state();
		if (input.action === 'review') return reviewCodexRecall(current);
		if (input.action !== 'approve' && input.action !== 'disable')
			throw new Error('Unknown recall action.');
		if (typeof input.digest !== 'string') throw new Error('Review the current hooks first.');
		if (remoteStarting || activeRemote?.session.snapshot().running)
			throw new Error('Finish or cancel remote setup first.');
		return changeCodexRecall(current, input.action, input.digest, input.confirmed === true);
	});
	handleAdmin(ADMIN_CHANNELS.remote, async (_event, value: unknown) => {
		if (!value || typeof value !== 'object') throw new Error('Invalid native remote request.');
		const input = value as Record<string, unknown>;
		const tool = remoteTool(input.tool);
		const current = state();
		if (input.action === 'connection') {
			const output = await remoteConnection(current, tool);
			for (const url of remoteBrowserUrls(output))
				void shell.openExternal(url).catch(() => undefined);
			return { tool, stage: 'connection', output, running: false, enabled: true };
		}
		if (input.action === 'enable') {
			if (input.restartConfirmed !== true)
				throw new Error('Confirm the possible container restarts before remote setup.');
			if (remoteStarting || activeRemote?.session.snapshot().running)
				throw new Error('Finish or cancel the current remote setup first.');
			if (input.sandbox !== undefined && !isCodexSandbox(input.sandbox))
				throw new Error('Invalid Codex sandbox mode.');
			remoteStarting = true;
			const opened = new Set<string>();
			try {
				const session = await beginRemoteEnable(current, tool, {
					trusted: input.trusted === true,
					sandbox: input.sandbox as CodexSandbox | undefined,
					update(progress) {
						for (const url of remoteBrowserUrls(progress.output)) {
							if (opened.has(url)) continue;
							opened.add(url);
							void shell.openExternal(url).catch(() => undefined);
						}
					}
				});
				activeRemote = { homeDir: current.homeDir, session };
				return session.snapshot();
			} finally {
				remoteStarting = false;
			}
		}
		if (input.action === 'disable') {
			const read = readStackConfig(current.homeDir);
			if (!read.ok) throw new Error(read.error);
			const config = structuredClone(read.config);
			config.assistant[tool === 'codex' ? 'codexRemote' : 'claudeRemote'] = false;
			saveAdminConfig(current.homeDir, config, read.config);
			return { tool, stage: 'saved', output: '', running: false, enabled: false };
		}
		if (
			!activeRemote ||
			activeRemote.homeDir !== current.homeDir ||
			activeRemote.session.snapshot().tool !== tool
		)
			throw new Error('Start remote setup for this installation first.');
		if (input.action === 'input') {
			if (typeof input.input !== 'string') throw new Error('A native prompt answer is required.');
			activeRemote.session.input(input.input);
		} else if (input.action === 'cancel') {
			activeRemote.session.cancel();
			return activeRemote.session.done;
		} else if (input.action !== 'progress') throw new Error('Unknown remote setup action.');
		return activeRemote.session.snapshot();
	});
	app.on('before-quit', (event) => {
		if (!activeRemote?.session.snapshot().running) return;
		event.preventDefault();
		activeRemote.session.cancel();
		void activeRemote.session.done.finally(() => app.quit());
	});
	handleAdmin(ADMIN_CHANNELS.snapshot, (_event) => {
		return adminSnapshot();
	});
	ipcMain.handle(ADMIN_CHANNELS.selectedHome, (event) => {
		requireAdminSender(event);
		const welcome = instances.welcome();
		return welcome.selectedInstance?.homeDir ?? welcome.defaultInstance.homeDir;
	});
	handleAdmin(
		ADMIN_CHANNELS.install,
		async (_event, value: unknown, automaticPorts: unknown = true) => {
			if (typeof automaticPorts !== 'boolean')
				throw new Error('Invalid connection port selection.');
			const parsed = parseStackConfig(value);
			if (!parsed.ok) throw new Error(parsed.error);
			if (!isInstanceName(parsed.config.deployment.projectName))
				throw new Error(
					'Instance name must be 1–63 lowercase letters, numbers or hyphens, starting and ending with a letter or number.'
				);
			const docker = await ensureDockerReady();
			if (!docker.ok) throw new Error(docker.message);
			await assertProjectOwnership(parsed.config.deployment.projectName);
			await installFromAdmin(parsed.config, instances.current().homeDir, automaticPorts);
			return runAdminAction('start');
		}
	);
	handleAdmin(ADMIN_CHANNELS.saveConfig, async (_event, value: unknown) => {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new Error('Invalid settings save request');
		const input = value as { config?: unknown; baseConfig?: unknown };
		const parsed = parseStackConfig(input.config);
		if (!parsed.ok) throw new Error(parsed.error);
		const baseline = parseStackConfig(input.baseConfig);
		if (!baseline.ok)
			throw new Error('Refresh settings before saving; a valid baseline is required.');
		const current = state();
		saveAdminConfig(current.homeDir, parsed.config, baseline.config);
		return adminSnapshot();
	});
	handleAdmin(ADMIN_CHANNELS.confirmRestart, async (event, action: unknown) => {
		const options = {
			...interruptionPrompt(action),
			type: 'question' as const,
			defaultId: 0,
			cancelId: 0,
			noLink: true
		};
		if (action === 'instance-export' || action === 'instance-import')
			options.detail += `\n\nSelected instance folder: ${instances.current().homeDir}`;
		const owner = BrowserWindow.fromWebContents(event.sender);
		const result = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
		return result.response === 1;
	});
	handleAdmin(ADMIN_CHANNELS.action, (_event, input: unknown) => {
		return runAdminAction(confirmedAdminAction(input));
	});
	handleAdmin(ADMIN_CHANNELS.logs, async (_event) => {
		const current = state();
		const result = await composeLogs(buildComposeOptions(current), 250);
		if (!result.ok) throw new Error(result.stderr || 'Could not read Docker logs');
		return result.stdout.slice(-200_000);
	});
	handleAdmin(ADMIN_CHANNELS.providers, (_event) => {
		const current = state();
		return listProviders(current.homeDir);
	});
	handleAdmin(ADMIN_CHANNELS.providerKey, async (_event, value: unknown) => {
		if (!value || typeof value !== 'object') throw new Error('Invalid provider settings');
		const input = value as { provider?: unknown; key?: unknown };
		if (typeof input.provider !== 'string' || typeof input.key !== 'string') {
			throw new Error('Provider and key are required.');
		}
		const current = state();
		await setProviderApiKey(current.homeDir, input.provider, input.key);
		const readiness = await testAssistantReadiness(current.homeDir, {
			provider: input.provider
		});
		await completeAdminReadiness(current.homeDir, readiness);
		return readiness;
	});
	handleAdmin(ADMIN_CHANNELS.providerOAuthStart, async (_event, value: unknown) => {
		const input = oauthInput(value);
		const current = state();
		const authorization = await beginProviderOAuth(
			current.homeDir,
			input.provider,
			input.method,
			input.inputs
		);
		pendingOAuth = { homeDir: current.homeDir, provider: input.provider, method: input.method };
		await shell.openExternal(externalAdminUrl(authorization.url));
		return authorization;
	});
	handleAdmin(ADMIN_CHANNELS.providerOAuthFinish, async (_event, value: unknown) => {
		const input = oauthInput(value);
		const rawCode = (value as { code?: unknown }).code;
		if (rawCode !== undefined && typeof rawCode !== 'string') {
			throw new Error('Invalid provider authorization code.');
		}
		const current = state();
		if (
			!pendingOAuth ||
			pendingOAuth.homeDir !== current.homeDir ||
			pendingOAuth.provider !== input.provider ||
			pendingOAuth.method !== input.method
		)
			throw new Error('Start provider sign-in for this instance first.');
		await completeProviderOAuth(current.homeDir, input.provider, input.method, rawCode);
		pendingOAuth = undefined;
		const readiness = await testAssistantReadiness(current.homeDir, {
			provider: input.provider
		});
		await completeAdminReadiness(current.homeDir, readiness);
		return readiness;
	});
	handleAdmin(ADMIN_CHANNELS.readiness, (_event, value: unknown) => {
		if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
			throw new Error('Invalid provider readiness request.');
		}
		const rawProvider = (value as { provider?: unknown } | undefined)?.provider;
		if (rawProvider !== undefined && typeof rawProvider !== 'string') {
			throw new Error('Invalid readiness provider.');
		}
		const current = state();
		return testAssistantReadiness(current.homeDir, {
			...(rawProvider ? { provider: rawProvider } : {})
		}).then(async (readiness) => {
			await completeAdminReadiness(current.homeDir, readiness);
			return readiness;
		});
	});
	handleAdmin(ADMIN_CHANNELS.assistantPassword, (_event) => {
		const current = state();
		const details = connectionDetails(current.homeDir, 'opencode', {
			showAssistantPassword: true
		});
		if (!details.password) throw new Error('OpenCode password is unavailable.');
		return { password: details.password };
	});
	handleAdmin(ADMIN_CHANNELS.copyText, (_event, value: unknown) => {
		if (typeof value !== 'string' || value.length < 1 || value.length > 10_000) {
			throw new Error('Invalid clipboard value.');
		}
		clipboard.writeText(value);
	});
	handleAdmin(ADMIN_CHANNELS.openExternal, async (_event, value: unknown) => {
		await shell.openExternal(externalAdminUrl(value));
	});
	ipcMain.handle(ADMIN_CHANNELS.chooseDirectory, async (event, value: unknown) => {
		requireAdminSender(event);
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('Invalid directory selection request.');
		}
		const purpose = (value as { purpose?: unknown }).purpose;
		if (
			purpose !== 'backup' &&
			purpose !== 'restore' &&
			purpose !== 'instance' &&
			purpose !== 'recovery' &&
			purpose !== 'new-instance'
		) {
			throw new Error('Directory purpose must be instance, new-instance, backup, recovery or restore.');
		}
		const options: OpenDialogOptions = {
			title:
				purpose === 'new-instance'
					? 'Choose a folder for the new fhold instance'
					: purpose === 'instance'
						? 'Open a fhold folder'
						: purpose === 'recovery'
							? 'Choose a private checkpoint directory'
							: purpose === 'backup'
							? 'Choose an empty export directory'
							: 'Choose an fhold export',
			buttonLabel:
				purpose === 'new-instance'
					? 'Use this folder'
					: purpose === 'instance'
						? 'Open instance'
						: purpose === 'recovery'
							? 'Use for recovery'
							: purpose === 'backup'
							? 'Use for export'
							: 'Use this export',
			properties: purpose === 'restore' ? ['openDirectory'] : ['openDirectory', 'createDirectory']
		};
		const owner = BrowserWindow.fromWebContents(event.sender);
		const result = owner
			? await dialog.showOpenDialog(owner, options)
			: await dialog.showOpenDialog(options);
		return result.canceled ? undefined : result.filePaths[0];
	});
	handleAdmin(ADMIN_CHANNELS.credential, async (_event, value: unknown) => {
		if (!value || typeof value !== 'object') throw new Error('Invalid credential operation');
		const input = value as { action?: unknown; username?: unknown; policy?: unknown };
		const current = state();
		if (input.action === 'create') {
			createAdminCredential(current.homeDir, {
				username: input.username,
				policy: input.policy
			});
		} else if (input.action === 'rotate') rotateAdminCredential(current.homeDir, input.username);
		else if (input.action === 'remove') removeAdminCredential(current.homeDir, input.username);
		else throw new Error('Invalid credential operation');
		return adminSnapshot();
	});
	handleAdmin(ADMIN_CHANNELS.credentialKey, (_event, value: unknown) => {
		if (!isCredentialUsername(value)) throw new Error('Invalid credential username.');
		const current = state();
		const config = readStackConfig(current.homeDir);
		if (!config.ok) throw new Error(config.error);
		if (!Object.hasOwn(config.config.credentials, value)) {
			throw new Error(`Unknown credential: ${value}`);
		}
		return { username: value, key: readCredentialKey(current.homeDir, value) };
	});
	handleAdmin(ADMIN_CHANNELS.mapPortalUser, async (_event, value: unknown) => {
		if (!value || typeof value !== 'object') throw new Error('Invalid portal mapping');
		const current = state();
		mapAdminPortalUser(current.homeDir, value as never);
		return adminSnapshot();
	});
	handleAdmin(ADMIN_CHANNELS.portalToken, async (_event, value: unknown) => {
		if (!value || typeof value !== 'object') throw new Error('Invalid portal token operation');
		const input = value as { portal?: unknown; botToken?: unknown; appToken?: unknown };
		if (!isPortalName(input.portal)) throw new Error('Portal must be discord or slack.');
		const current = state();
		const config = readStackConfig(current.homeDir);
		if (!config.ok) throw new Error(config.error);
		const configured = portalSecretConfigured(current.homeDir, input.portal);
		const { botToken, appToken } = adminPortalTokens(value, configured);
		savePortalTokens(current.homeDir, { portal: input.portal, botToken, appToken });
		return adminSnapshot();
	});
	handleAdmin(ADMIN_CHANNELS.backup, (_event, value: unknown) => {
		if (!value || typeof value !== 'object') throw new Error('Invalid backup request');
		const current = state();
		return backupFromAdmin(current.homeDir, value as never);
	});
	handleAdmin(ADMIN_CHANNELS.recovery, async (_event, value: unknown) => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid recovery request.');
		const input = value as Record<string, unknown>;
		const home = state().homeDir;
		if (input.action === 'save') {
			if (typeof input.baselineDigest !== 'string') throw new Error('Refresh recovery settings before saving.');
			saveRecoverySettings(home, { settings: input.settings, selection: input.selection, baselineDigest: input.baselineDigest });
			return adminSnapshot();
		}
		if (input.action === 'credential') {
			saveRecoveryCredential(home, input.connectionString);
			return adminSnapshot();
		}
		if (input.action === 'status') return recoveryStatus(home);
		if (input.action === 'inspect' || input.action === 'init' || input.action === 'restore') return runRecoveryOperation(home, input.action, input.confirmed === true);
		throw new Error('Invalid recovery action.');
	});
	handleAdmin(ADMIN_CHANNELS.restoreData, (_event, value: unknown) => {
		if (!value || typeof value !== 'object') throw new Error('Invalid restore request');
		const current = state();
		return restoreFromAdmin(current.homeDir, value as never);
	});
	handleAdmin(ADMIN_CHANNELS.restoreInstance, (_event, value: unknown) => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid full-instance import request.');
		return instanceRestoreFromAdmin(managedState().homeDir, value as never);
	});
}

export function createAdminWindow(options: { show?: boolean } = {}): BrowserWindow {
	// Initial size only. Setup, navigation and instance reloads never resize it.
	const window = new BrowserWindow({
		width: 1120,
		height: 780,
		minWidth: 640,
		minHeight: 540,
		title: 'fhold — Setup & settings',
		backgroundColor: '#0d1117',
		show: options.show ?? true,
		webPreferences: {
			preload: join(import.meta.dirname, 'admin-preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true
		}
	});
	window.on('closed', () => activeRemote?.session.cancel());
	window.webContents.setWindowOpenHandler(({ url }) => {
		try {
			void shell.openExternal(externalAdminUrl(url)).catch(() => undefined);
		} catch {
			// Keep untrusted or malformed renderer navigation inside the deny-only boundary.
		}
		return { action: 'deny' };
	});
	window.webContents.on('will-navigate', (event, url) => {
		if (!isAdminPageUrl(url, adminIndexUrl)) event.preventDefault();
	});
	void window.loadFile(adminIndexPath);
	return window;
}

import {
	ensureDockerReady,
	hostingProvider,
	hostingConnectionSetup,
	openInstanceSession,
	LOCAL_CONNECTION,
	parseHostingConnection,
	connectionEndpoint,
	checkHostingConnection,
	invokeOperation as invoke,
	parseLegacyCredentialOperation,
	parseLegacyRecoveryOperation,
	parseOperationInput as parseInput,
	parseRequestContext as confirmationContext,
	type ComposedInstanceSession
} from '@fhold/lib';
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent, OpenDialogOptions } from 'electron';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { AdminInstances } from './admin-instances.js';
import electronUpdater from 'electron-updater';
import { AdminSettingsStore } from './admin-settings.js';
import { AdminUpdates } from './admin-updates.js';
import { AdminDesktop } from './admin-desktop.js';

import { ADMIN_CHANNELS, type AdminSnapshot, type StackAction } from './admin-types.js';
import {
	confirmedAdminAction,
	interruptionPrompt,
	externalAdminUrl,
	isAdminPageUrl
} from './admin-domain.js';

const adminDirectory = fileURLToPath(new URL('../admin', import.meta.url));
const adminIndexPath = join(adminDirectory, 'index.html');
const adminIndexUrl = pathToFileURL(adminIndexPath).href;
let instances: AdminInstances;
let updates: AdminUpdates;
let desktop: AdminDesktop;
let activeSession: { key: string; api: ComposedInstanceSession } | undefined;
// A native sign-in flow can request that Admin opens a browser after its IPC call
// has completed. Keep that callback bound to the selected session rather than the
// mutable current instance so a late event cannot escape to a newly selected host.
let managementGeneration = 0;
function session() {
	const target = instances.current();
	const key = JSON.stringify(target);
	if (activeSession?.key === key) return activeSession.api;
	const generation = managementGeneration;
	let api: ComposedInstanceSession | undefined;
	const openUrl = (url: string) => {
		if (
			managementGeneration !== generation ||
			activeSession?.key !== key ||
			activeSession?.api !== api
		)
			return;
		void shell.openExternal(externalAdminUrl(url)).catch(() => undefined);
	};
	const connection =
		target.kind === 'local'
			? LOCAL_CONNECTION
			: instances.hosting.connection(target.ref.connectionId);
	const ref =
		target.kind === 'local'
			? { kind: 'local-docker' as const, connectionId: 'local' as const, homeDir: target.homeDir }
			: target.ref;
	api = openInstanceSession(connection, ref, {
		setupName: instances.setupName,
		openUrl
	});
	activeSession = { key, api };
	return api;
}
async function discardSession() {
	managementGeneration++;
	const old = activeSession;
	activeSession = undefined;
	await old?.api.close();
}

function selectedConnection(id: string) {
	const target = instances.welcome().selectedInstance;
	return target?.kind === 'hosted' && target.ref.connectionId === id;
}
async function hostingInfo(id: string) {
	const installation = hostingProvider(instances.hosting.connection(id)).installation;
	if (!installation)
		throw Error(
			'This provider does not expose an instance-directory installer. Use its deployment tooling.'
		);
	return installation.info();
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
	if (activeSession?.api.busy())
		throw new Error('Finish or cancel native remote setup before switching instances.');
}

function requireAdminSender(event: IpcMainInvokeEvent): void {
	if (
		event.senderFrame !== event.sender.mainFrame ||
		!isAdminPageUrl(event.senderFrame?.url, adminIndexUrl)
	)
		throw new Error('Unauthorized admin IPC sender');
}

export async function adminSnapshot(): Promise<AdminSnapshot> {
	return session().inspect();
}
export async function runAdminAction(action: StackAction): Promise<AdminSnapshot> {
	if (action === 'restart') await invoke(session().host.restart, undefined, { confirmed: true });
	else await invoke(session().host[action], undefined, { confirmed: true });
	return adminSnapshot();
}

export function registerAdminIpc(): void {
	instances = new AdminInstances(app.getPath('userData'));
	desktop = new AdminDesktop({
		platform: process.platform,
		packaged: app.isPackaged,
		appImage: process.env.APPIMAGE,
		home: app.getPath('home'),
		dataHome: process.env.XDG_DATA_HOME,
		icon: join(app.getAppPath(), 'assets/icon.png'),
		version: app.getVersion()
	});
	updates = new AdminUpdates(new AdminSettingsStore(app.getPath('userData')), {
		version: app.getVersion(),
		unavailableReason:
			!app.isPackaged || process.argv.includes('--fhold-release-smoke')
				? 'Automatic updates are available in installed releases, not development or smoke tests.'
				: JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')).fholdPreview ===
						true
					? 'Automatic updates are disabled in PR previews. Use a released Admin to receive updates.'
					: process.platform === 'linux' && !process.env.APPIMAGE
						? 'Run the AppImage to enable automatic updates, or download Admin from GitHub.'
						: process.platform !== 'linux'
							? 'Automatic updates are not yet published for Windows or macOS. Use a new native build to update Admin.'
							: undefined,
		createUpdater: () =>
			process.platform === 'win32'
				? new electronUpdater.NsisUpdater()
				: process.platform === 'darwin'
					? new electronUpdater.MacUpdater()
					: new electronUpdater.AppImageUpdater(),
		changed: (snapshot) => {
			for (const window of BrowserWindow.getAllWindows())
				if (!window.isDestroyed())
					window.webContents.send(ADMIN_CHANNELS.appUpdateChanged, snapshot);
		}
	});
	for (const [channel, operation] of [
		[ADMIN_CHANNELS.appSettings, () => updates.snapshot()],
		[ADMIN_CHANNELS.checkAppUpdate, () => updates.check()],
		[ADMIN_CHANNELS.downloadAppUpdate, () => updates.download()]
	] as const)
		ipcMain.handle(channel, (event) => {
			requireAdminSender(event);
			return operation();
		});
	ipcMain.handle(ADMIN_CHANNELS.saveAppSettings, (event, value: unknown) => {
		requireAdminSender(event);
		return updates.save(value);
	});
	ipcMain.handle(ADMIN_CHANNELS.installAppUpdate, async (event) => {
		requireAdminSender(event);
		requireSwitchable();
		const owner = BrowserWindow.fromWebContents(event.sender);
		const options = {
			type: 'question' as const,
			buttons: ['Later', 'Restart Admin'],
			defaultId: 0,
			cancelId: 0,
			message: 'Restart Admin to install its update?',
			detail:
				'Unsaved forms and unfinished sign-in steps in Admin will close. Your agents and containers keep running. No instance configuration or remote CLI is updated.'
		};
		const result = owner
			? await dialog.showMessageBox(owner, options)
			: await dialog.showMessageBox(options);
		if (result.response !== 1) return;
		await desktop.finish();
		requireSwitchable();
		updates.install();
	});
	updates.start();
	ipcMain.handle(ADMIN_CHANNELS.desktopStatus, (event) => {
		requireAdminSender(event);
		return desktop.status();
	});
	ipcMain.handle(ADMIN_CHANNELS.installDesktop, (event) => {
		requireAdminSender(event);
		if (['ready', 'installing'].includes(updates.snapshot().update.phase))
			throw Error(
				'Restart Admin to finish its downloaded update, then add it to your application menu.'
			);
		return desktop.install(async () => {
			const owner = BrowserWindow.fromWebContents(event.sender);
			const options = {
				type: 'question' as const,
				buttons: ['Cancel', 'Replace menu copy'],
				defaultId: 0,
				cancelId: 0,
				message: `Replace the menu copy with Admin ${app.getVersion()}?`,
				detail: `This replaces ${desktop.paths.appImage} with this running download. The menu copy may be newer, so this can downgrade Admin. To keep it, cancel and open Admin from your application menu. Your agents are not changed.`
			};
			const result = owner
				? await dialog.showMessageBox(owner, options)
				: await dialog.showMessageBox(options);
			return result.response === 1;
		});
	});
	ipcMain.handle(ADMIN_CHANNELS.hostingFeatures, (event, id: string) => {
		requireAdminSender(event);
		const provider = hostingProvider(instances.hosting.connection(id));
		return { installation: !!provider.installation, emptyHint: provider.emptyHint };
	});
	ipcMain.handle(ADMIN_CHANNELS.hostingSetup, (event, value: unknown) => {
		requireAdminSender(event);
		return instances.runConnection(async () => {
			if (!value || typeof value !== 'object' || Array.isArray(value))
				throw new Error('Choose a connection setup action.');
			const input = value as Record<string, unknown>;
			const setup = hostingConnectionSetup(input.provider);
			if (!setup) throw new Error('This hosting provider uses native host setup.');
			if (input.action === 'sign-in') {
				await setup.signIn();
				return;
			}
			if (input.action !== 'choices' || typeof input.field !== 'string')
				throw new Error('Choose a connection setup action.');
			const values = input.values ?? {};
			if (
				!values ||
				typeof values !== 'object' ||
				Array.isArray(values) ||
				Object.values(values).some((value) => typeof value !== 'string')
			)
				throw new Error('Connection scope values must be text.');
			return setup.choices(input.field, values as Record<string, string>);
		});
	});
	ipcMain.handle(ADMIN_CHANNELS.hostingInfo, (event, id: string) => {
		requireAdminSender(event);
		return instances.runConnection(() => hostingInfo(id));
	});
	ipcMain.handle(
		ADMIN_CHANNELS.hostingDirectory,
		(event, value: { connectionId: string; path?: string }) => {
			requireAdminSender(event);
			return instances.runConnection(async () => {
				const installation = hostingProvider(
					instances.hosting.connection(value.connectionId)
				).installation;
				if (!installation) throw new Error('This provider has no instance-directory browser.');
				return installation.directory(value.path);
			});
		}
	);
	handleAdmin(ADMIN_CHANNELS.snapshot, () => adminSnapshot());
	handleAdmin(ADMIN_CHANNELS.action, (_event, value) =>
		runAdminAction(confirmedAdminAction(value))
	);
	handleAdmin(ADMIN_CHANNELS.logs, (_event, value) =>
		invoke(session().host.logs, { tail: 250, ...parseInput('host.logs', value ?? {}) })
	);
	handleAdmin(ADMIN_CHANNELS.directory, (_event, value) => {
		const operation = session().docker?.directory;
		if (!operation) throw new Error('This instance does not expose an instance directory.');
		return invoke(operation, parseInput('docker.directory', value ?? {}));
	});
	handleAdmin(ADMIN_CHANNELS.providers, () => invoke(session().agent.providers, undefined));
	handleAdmin(ADMIN_CHANNELS.providerKey, (_event, value) =>
		invoke(session().agent.setKey, parseInput('agent.setKey', value))
	);
	handleAdmin(ADMIN_CHANNELS.providerEndpoint, (_event, value) =>
		invoke(session().agent.saveEndpoint, parseInput('agent.saveEndpoint', value))
	);
	handleAdmin(ADMIN_CHANNELS.providerModels, (_event, value) =>
		invoke(session().agent.discoverModels, parseInput('agent.discoverModels', value))
	);
	handleAdmin(ADMIN_CHANNELS.providerUse, (_event, value) =>
		invoke(session().agent.selectModel, parseInput('agent.selectModel', value))
	);
	handleAdmin(ADMIN_CHANNELS.providerRemove, (_event, value) =>
		invoke(session().agent.removeProvider, parseInput('agent.removeProvider', value))
	);
	handleAdmin(ADMIN_CHANNELS.providerOAuthStart, (_event, value) =>
		invoke(session().agent.oauthStart, parseInput('agent.oauthStart', value))
	);
	handleAdmin(ADMIN_CHANNELS.providerOAuthFinish, (_event, value) =>
		invoke(session().agent.oauthFinish, parseInput('agent.oauthFinish', value))
	);
	handleAdmin(ADMIN_CHANNELS.readiness, (_event, value) =>
		invoke(session().agent.readiness, parseInput('agent.readiness', value ?? {}))
	);
	handleAdmin(ADMIN_CHANNELS.connectAgent, (_event, value) =>
		invoke(session().agent.connect, parseInput('agent.connect', value ?? {}))
	);
	handleAdmin(ADMIN_CHANNELS.openKnowledge, async () => {
		const selected = session();
		const { url } = await invoke(selected.data.knowledgeUi, undefined);
		if (activeSession?.api !== selected)
			throw new Error('The selected instance changed. Try again.');
		try {
			await shell.openExternal(externalAdminUrl(url));
		} catch {
			throw new Error('Could not open your browser. Check your default browser and try again.');
		}
	});
	handleAdmin(ADMIN_CHANNELS.openOpenCode, async () => {
		const selected = session();
		const { url } = await invoke(selected.agent.browserLink, undefined);
		if (activeSession?.api !== selected)
			throw new Error('The selected instance changed. Try again.');
		try {
			await shell.openExternal(externalAdminUrl(url));
		} catch {
			// OS launcher errors may include the private one-use link.
			throw new Error('Could not open your browser. Check your default browser and try again.');
		}
	});
	handleAdmin(ADMIN_CHANNELS.assistantPassword, () =>
		invoke(session().agent.assistantPassword, undefined)
	);
	handleAdmin(ADMIN_CHANNELS.remote, (_event, value) =>
		invoke(session().agent.remote, parseInput('agent.remote', value), confirmationContext(value))
	);
	handleAdmin(ADMIN_CHANNELS.codexRecall, (_event, value) =>
		invoke(
			session().agent.codexRecall,
			parseInput('agent.codexRecall', value),
			confirmationContext(value)
		)
	);
	handleAdmin(ADMIN_CHANNELS.credential, async (_event, value) => {
		const active = session();
		const operation = parseLegacyCredentialOperation(value);
		switch (operation.name) {
			case 'apps.credentials.create':
				await invoke(active.apps.credentials.create, operation.input);
				break;
			case 'apps.credentials.updatePolicy':
				await invoke(active.apps.credentials.updatePolicy, operation.input);
				break;
			case 'apps.credentials.rotate':
				await invoke(active.apps.credentials.rotate, operation.input);
				break;
			case 'apps.credentials.remove':
				await invoke(active.apps.credentials.remove, operation.input);
				break;
		}
		return active.inspect();
	});
	handleAdmin(ADMIN_CHANNELS.credentialKey, (_event, value) =>
		invoke(
			session().apps.credentials.revealKey,
			parseInput('apps.credentials.revealKey', { username: value })
		)
	);
	handleAdmin(ADMIN_CHANNELS.mapPortalUser, async (_event, value) => {
		const active = session();
		await invoke(active.apps.portal.mapUser, parseInput('apps.portal.mapUser', value));
		return active.inspect();
	});
	handleAdmin(ADMIN_CHANNELS.portalToken, async (_event, value) => {
		const active = session();
		await invoke(active.apps.portal.saveToken, parseInput('apps.portal.saveToken', value));
		return active.inspect();
	});
	handleAdmin(ADMIN_CHANNELS.backup, (_event, value) =>
		invoke(session().data.backup, parseInput('data.backup', value), confirmationContext(value))
	);
	handleAdmin(ADMIN_CHANNELS.restoreData, (_event, value) =>
		invoke(
			session().data.restoreData,
			parseInput('data.restoreData', value),
			confirmationContext(value)
		)
	);
	handleAdmin(ADMIN_CHANNELS.restoreInstance, (_event, value) =>
		invoke(
			session().data.restoreInstance,
			parseInput('data.restoreInstance', value),
			confirmationContext(value)
		)
	);
	handleAdmin(ADMIN_CHANNELS.recovery, async (_event, value) => {
		const active = session();
		const operation = parseLegacyRecoveryOperation(value);
		switch (operation.name) {
			case 'data.recovery.status':
				return invoke(active.data.recovery.status, operation.input, operation.context);
			case 'data.recovery.inspect':
				return invoke(active.data.recovery.inspect, operation.input, operation.context);
			case 'data.recovery.initialize':
				return invoke(active.data.recovery.initialize, operation.input, operation.context);
			case 'data.recovery.restore':
				return invoke(active.data.recovery.restore, operation.input, operation.context);
			case 'data.recovery.save':
				await invoke(active.data.recovery.save, operation.input, operation.context);
				return active.inspect();
			case 'data.recovery.setCredential':
				await invoke(active.data.recovery.setCredential, operation.input, operation.context);
				return active.inspect();
		}
	});
	handleAdmin(ADMIN_CHANNELS.update, (_event, value) => {
		const operation = session().docker?.update;
		if (!operation) throw new Error('This instance does not support image updates.');
		return invoke(operation, parseInput('docker.update', value ?? {}), { confirmed: true }).then(
			() => adminSnapshot()
		);
	});
	ipcMain.handle(ADMIN_CHANNELS.install, (event, config: unknown, automaticPorts: unknown) => {
		requireAdminSender(event);
		return instances.run(async () => {
			const operation = session().docker?.install;
			if (!operation) throw new Error('This instance does not support local installation.');
			await invoke(operation, parseInput('docker.install', { config, automaticPorts }), {
				confirmed: true
			});
			return adminSnapshot();
		});
	});
	handleAdmin(ADMIN_CHANNELS.saveConfig, async (_event, value) => {
		const operation = session().docker?.saveConfig;
		if (!operation) throw new Error('This instance does not expose deployment configuration.');
		await invoke(operation, parseInput('docker.saveConfig', value), { confirmed: true });
		return adminSnapshot();
	});
	app.on('before-quit', (event) => {
		if (!activeSession && !desktop.busy()) return;
		event.preventDefault();
		void Promise.all([discardSession(), desktop.finish()]).finally(() => app.quit());
	});
	async function confirmConnectionChange(
		event: IpcMainInvokeEvent,
		message: string,
		detail: string
	): Promise<boolean> {
		const owner = BrowserWindow.fromWebContents(event.sender);
		const options = {
			type: 'warning' as const,
			buttons: ['Cancel', 'Continue'],
			defaultId: 0,
			cancelId: 0,
			message,
			detail
		};
		return (
			(owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options))
				.response === 1
		);
	}
	ipcMain.handle(
		ADMIN_CHANNELS.hostingUpdateConnection,
		async (event, id: string, value: unknown) => {
			requireAdminSender(event);
			requireSwitchable();
			const previous = instances.hosting.connection(id);
			const next = parseHostingConnection(value);
			const retarget = connectionEndpoint(previous) !== connectionEndpoint(next);
			if (
				retarget &&
				!(await confirmConnectionChange(
					event,
					'Change this connection’s host?',
					'Saved recent instances for this connection will be cleared and its open view closed. No running containers or instance files will be changed.'
				))
			)
				return undefined;
			requireSwitchable();
			const result = instances.hosting.updateConnection(id, next);
			if (retarget) {
				if (selectedConnection(id)) await discardSession();
				instances.forgetConnectionTargets(id);
			}
			return result;
		}
	);
	ipcMain.handle(ADMIN_CHANNELS.hostingRemoveConnection, async (event, id: string) => {
		requireAdminSender(event);
		requireSwitchable();
		instances.hosting.connection(id);
		if (
			!(await confirmConnectionChange(
				event,
				'Remove this saved connection?',
				'Only connection metadata and its recent selections are removed. Instances remain running and no data is deleted.'
			))
		)
			return false;
		requireSwitchable();
		if (selectedConnection(id)) await discardSession();
		instances.hosting.removeConnection(id);
		instances.forgetConnectionTargets(id);
		return true;
	});
	ipcMain.handle(ADMIN_CHANNELS.hostingCheckConnection, (event, id: string) => {
		requireAdminSender(event);
		requireSwitchable();
		return instances.runConnection(() => checkHostingConnection(instances.hosting.connection(id)));
	});
	ipcMain.handle(ADMIN_CHANNELS.hostingConnections, (event) => {
		requireAdminSender(event);
		return [
			LOCAL_CONNECTION,
			...instances.hosting.read().connections.filter((item) => item.id !== 'local')
		];
	});
	ipcMain.handle(ADMIN_CHANNELS.hostingSaveConnection, (event, value: unknown) => {
		requireAdminSender(event);
		requireSwitchable();
		return instances.hosting.saveConnection(value);
	});
	ipcMain.handle(ADMIN_CHANNELS.hostingInstances, async (event, id: unknown) => {
		requireAdminSender(event);
		requireSwitchable();
		if (typeof id !== 'string') throw new Error('Choose a hosting connection.');
		return instances.runConnection(() =>
			hostingProvider(instances.hosting.connection(id)).listInstances()
		);
	});
	ipcMain.handle(ADMIN_CHANNELS.welcome, (event) => {
		requireAdminSender(event);
		return instances.welcome();
	});
	ipcMain.handle(ADMIN_CHANNELS.installationReadiness, (event, id?: string) => {
		requireAdminSender(event);
		// Read-only host checks can run before any installation folder is selected.
		return id && id !== 'local'
			? checkHostingConnection(instances.hosting.connection(id)).then((result) => ({
					ok: result.ok,
					message: result.checks.find((item) => !item.ok)?.detail
				}))
			: ensureDockerReady();
	});
	ipcMain.handle(ADMIN_CHANNELS.openInstance, async (event, target: unknown) => {
		requireAdminSender(event);
		requireSwitchable();
		await discardSession();
		instances.open(target);
	});
	ipcMain.handle(ADMIN_CHANNELS.prepareNewInstance, async (event, target: unknown) => {
		requireAdminSender(event);
		requireSwitchable();
		await discardSession();
		instances.prepareNew(target);
	});
	ipcMain.handle(ADMIN_CHANNELS.closeInstance, async (event) => {
		requireAdminSender(event);
		requireSwitchable();
		await discardSession();
		instances.close();
	});

	ipcMain.handle(ADMIN_CHANNELS.selectedHome, (event) => {
		requireAdminSender(event);
		const welcome = instances.welcome();
		const target = welcome.selectedInstance;
		return target?.kind === 'hosted'
			? target.ref.kind === 'ssh-docker'
				? target.ref.remoteHome
				: target.ref.kind === 'azure-container-apps'
					? target.ref.resourceId
					: target.ref.homeDir
			: (target?.homeDir ?? welcome.defaultInstance.homeDir);
	});

	handleAdmin(ADMIN_CHANNELS.confirmRestart, async (event, action: unknown) => {
		const operation =
			action === 'start' || action === 'stop' || action === 'restart'
				? session().host[action]
				: undefined;
		const effect = operation?.support === 'supported' ? operation.effect : undefined;
		const options = {
			...interruptionPrompt(action, effect),
			type: 'question' as const,
			defaultId: 0,
			cancelId: 0,
			noLink: true
		};
		if (action === 'instance-export' || action === 'instance-import') {
			const snapshot = await adminSnapshot();
			options.detail += `\n\nSelected instance folder: ${snapshot.docker?.homeDir || 'Not managed through this connection'}`;
		}
		const owner = BrowserWindow.fromWebContents(event.sender);
		const result = owner
			? await dialog.showMessageBox(owner, options)
			: await dialog.showMessageBox(options);
		return result.response === 1;
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
			throw new Error(
				'Directory purpose must be instance, new-instance, backup, recovery or restore.'
			);
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
}

export function createAdminWindow(options: { show?: boolean } = {}): BrowserWindow {
	// Initial size only. Setup, navigation and instance reloads never resize it.
	const window = new BrowserWindow({
		width: 1120,
		height: 780,
		minWidth: 640,
		minHeight: 540,
		title: 'fhold Admin',
		icon: join(app.getAppPath(), 'assets/icon.png'),
		backgroundColor: '#0d1117',
		show: options.show ?? true,
		webPreferences: {
			preload: join(import.meta.dirname, 'admin-preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true
		}
	});
	window.on('closed', () => {
		void discardSession();
	});
	window.on('focus', () => {
		void updates?.backgroundCheck();
	});
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

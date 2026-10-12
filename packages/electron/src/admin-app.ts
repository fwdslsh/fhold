import {
	SshInstanceManagement,
	MANAGEMENT_METHODS,
	ensureDockerReady,
	hostingProvider,
	openHostingInstance,
	LOCAL_CONNECTION,
	parseHostingConnection,
	connectionEndpoint,
	checkHostingConnection,
	repairSshCli,
	sshArgs,
	SSH_RPC_COMMAND,
	runHostingProcess,
	type HostingConnection,
	type InstanceManagement
} from '@fhold/lib';
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent, OpenDialogOptions } from 'electron';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { AdminInstances } from './admin-instances.js';

import {
	ADMIN_CHANNELS,
	type AdminSnapshot,
	type AdminViewSnapshot,
	type StackAction
} from './admin-types.js';
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
let activeManagement: { key: string; api: InstanceManagement } | undefined;
function management() {
	const target = instances.current();
	const homeDir =
		target.kind === 'local'
			? target.homeDir
			: target.ref.kind === 'ssh-docker'
				? target.ref.remoteHome
				: undefined;
	if (!homeDir)
		throw Error('This hosting environment does not expose instance-file administration.');
	const key = JSON.stringify(target);
	if (activeManagement?.key === key) return activeManagement.api;
	const openUrl = (url: string) => {
		void shell.openExternal(externalAdminUrl(url)).catch(() => undefined);
	};
	const connection =
		target.kind === 'local'
			? LOCAL_CONNECTION
			: instances.hosting.connection(target.ref.connectionId);
	const ref =
		target.kind === 'local'
			? { kind: 'local-docker' as const, connectionId: 'local' as const, homeDir }
			: target.ref;
	const api = openHostingInstance(connection, ref).management?.({
		setupName: instances.setupName,
		openUrl
	});
	if (!api) throw Error('This hosting environment does not expose instance administration.');
	activeManagement = { key, api };
	return api;
}
async function discardManagement() {
	const old = activeManagement;
	activeManagement = undefined;
	await old?.api.close();
}
function selectedConnection(id: string) {
	const target = instances.welcome().selectedInstance;
	return target?.kind === 'hosted' && target.ref.connectionId === id;
}
function hostedSession() {
	const target = instances.current();
	return target.kind === 'hosted' && target.ref.kind === 'azure-container-apps'
		? openHostingInstance(instances.hosting.connection(target.ref.connectionId), target.ref)
		: undefined;
}
async function hostingInfo(id: string) {
	const connection = instances.hosting.connection(id);
	if (connection.kind !== 'ssh-docker') throw Error('Choose an SSH computer.');
	const response = JSON.parse(
		await runHostingProcess('ssh', [...sshArgs(connection), SSH_RPC_COMMAND], {
			input: JSON.stringify({ version: 1, action: 'hello' })
		})
	) as { ok?: boolean; value?: { instancesDirectory?: string; management?: string[] } };
	if (
		response.ok !== true ||
		typeof response.value?.instancesDirectory !== 'string' ||
		!response.value.management?.includes('snapshot')
	)
		throw Error('Update the remote fhold CLI from Connections before managing this computer.');
	return {
		instancesDirectory: response.value.instancesDirectory,
		defaultHome: join(response.value.instancesDirectory, 'default')
	};
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
	if (activeManagement?.api.busy())
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

export async function adminSnapshot(): Promise<AdminViewSnapshot> {
	const session = hostedSession();
	if (session) return { phase: 'remote', hosting: await session.inspect() };
	const snapshot = await management().call<AdminSnapshot>('snapshot');
	const target = instances.current();
	return target.kind === 'hosted' && target.ref.kind === 'ssh-docker'
		? {
				...snapshot,
				target: target.ref,
				connectionLabel: instances.hosting.connection(target.ref.connectionId).label
			}
		: snapshot;
}
export async function runAdminAction(action: StackAction): Promise<AdminViewSnapshot> {
	const session = hostedSession();
	if (session) {
		const result = await session.operate(action, true);
		return { phase: 'remote', hosting: result.snapshot };
	}
	await management().call('action', { action, confirmed: true });
	return adminSnapshot();
}

export function registerAdminIpc(): void {
	instances = new AdminInstances(app.getPath('userData'));
	ipcMain.handle(ADMIN_CHANNELS.hostingInfo, (event, id: string) => {
		requireAdminSender(event);
		return instances.runConnection(() => hostingInfo(id));
	});
	ipcMain.handle(
		ADMIN_CHANNELS.hostingDirectory,
		(event, value: { connectionId: string; path?: string }) => {
			requireAdminSender(event);
			return instances.runConnection(async () => {
				const info = await hostingInfo(value.connectionId);
				const connection = instances.hosting.connection(value.connectionId) as Extract<
					HostingConnection,
					{ kind: 'ssh-docker' }
				>;
				const api = new SshInstanceManagement(connection, info.defaultHome);
				try {
					return await api.call('directory', value.path ?? info.instancesDirectory);
				} finally {
					await api.close();
				}
			});
		}
	);
	for (const method of MANAGEMENT_METHODS) {
		if (
			method === 'transferCreate' ||
			method === 'transferRelease' ||
			method === 'transferPack' ||
			method === 'transferUnpack'
		)
			continue;
		ipcMain.handle(ADMIN_CHANNELS[method], (event, value: unknown, ...extra: unknown[]) => {
			requireAdminSender(event);
			return instances.run(async () => {
				if (method === 'snapshot') return adminSnapshot();
				if (method === 'action') return runAdminAction(confirmedAdminAction(value));
				if (method === 'logs' && hostedSession()) return hostedSession()!.logs({ tail: 250 });
				const result = await management().call(method, value, ...extra);
				if (result && typeof result === 'object' && 'phase' in result) return adminSnapshot();
				return result;
			});
		});
	}
	app.on('before-quit', (event) => {
		if (!activeManagement) return;
		event.preventDefault();
		void discardManagement().finally(() => app.quit());
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
				if (selectedConnection(id)) await discardManagement();
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
		if (selectedConnection(id)) await discardManagement();
		instances.hosting.removeConnection(id);
		instances.forgetConnectionTargets(id);
		return true;
	});
	ipcMain.handle(ADMIN_CHANNELS.hostingCheckConnection, (event, id: string) => {
		requireAdminSender(event);
		requireSwitchable();
		return instances.runConnection(() => checkHostingConnection(instances.hosting.connection(id)));
	});
	ipcMain.handle(ADMIN_CHANNELS.hostingRepairConnection, async (event, id: string) => {
		requireAdminSender(event);
		requireSwitchable();
		const connection = instances.hosting.connection(id);
		if (
			!(await confirmConnectionChange(
				event,
				'Install or update the remote fhold CLI?',
				`Download this tooling release and replace ~/.local/bin/fhold on ${connection.label}. No sudo, SSH trust changes, container restarts or instance configuration changes are made.`
			))
		)
			return undefined;
		requireSwitchable();
		return instances.runConnection(async () => {
			const result = await repairSshCli(connection, { confirmed: true });
			if (selectedConnection(id)) await discardManagement();
			return result;
		});
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
		await discardManagement();
		instances.open(target);
	});
	ipcMain.handle(ADMIN_CHANNELS.prepareNewInstance, async (event, target: unknown) => {
		requireAdminSender(event);
		requireSwitchable();
		await discardManagement();
		instances.prepareNew(target);
	});
	ipcMain.handle(ADMIN_CHANNELS.closeInstance, async (event) => {
		requireAdminSender(event);
		requireSwitchable();
		await discardManagement();
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
		const target = instances.current();
		const options = {
			...interruptionPrompt(action, target.kind === 'hosted' ? target.ref.kind : 'local-docker'),
			type: 'question' as const,
			defaultId: 0,
			cancelId: 0,
			noLink: true
		};
		if (action === 'instance-export' || action === 'instance-import')
			options.detail += `\n\nSelected instance folder: ${(await management().call<AdminSnapshot>('snapshot')).homeDir}`;
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
		void discardManagement();
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

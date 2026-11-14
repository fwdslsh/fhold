import { contextBridge, ipcRenderer } from 'electron';

import { ADMIN_CHANNELS, type AdminApi, type StackAction } from './admin-types.js';
import type { StackConfig } from '@fhold/lib';

const api: AdminApi = {
	operation: (name, input, context) =>
		ipcRenderer.invoke(ADMIN_CHANNELS.operation, name, input, context),
	desktopStatus: () => ipcRenderer.invoke(ADMIN_CHANNELS.desktopStatus),
	installDesktop: () => ipcRenderer.invoke(ADMIN_CHANNELS.installDesktop),
	appSettings: () => ipcRenderer.invoke(ADMIN_CHANNELS.appSettings),
	saveAppSettings: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.saveAppSettings, value),
	checkAppUpdate: () => ipcRenderer.invoke(ADMIN_CHANNELS.checkAppUpdate),
	downloadAppUpdate: () => ipcRenderer.invoke(ADMIN_CHANNELS.downloadAppUpdate),
	installAppUpdate: () => ipcRenderer.invoke(ADMIN_CHANNELS.installAppUpdate),
	onAppUpdate: (listener) => {
		const receive = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof listener>[0]) =>
			listener(snapshot);
		ipcRenderer.on(ADMIN_CHANNELS.appUpdateChanged, receive);
		return () => {
			ipcRenderer.removeListener(ADMIN_CHANNELS.appUpdateChanged, receive);
		};
	},
	hostingFeatures: (id) => ipcRenderer.invoke(ADMIN_CHANNELS.hostingFeatures, id),
	provisioningOptions: (id) => ipcRenderer.invoke(ADMIN_CHANNELS.provisioningOptions, id),
	provisioningPreview: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.provisioningPreview, value),
	provisioningInstall: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.provisioningInstall, value),
	provisioningResume: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.provisioningResume, value),
	applyDeployment: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.applyDeployment, value),
	hostingSetup: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.hostingSetup, value),
	hostingInfo: (id) => ipcRenderer.invoke(ADMIN_CHANNELS.hostingInfo, id),
	hostingDirectory: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.hostingDirectory, value),
	update: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.update, value),
	hostingConnections: () => ipcRenderer.invoke(ADMIN_CHANNELS.hostingConnections),
	hostingSaveConnection: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.hostingSaveConnection, value),
	hostingUpdateConnection: (id, value) =>
		ipcRenderer.invoke(ADMIN_CHANNELS.hostingUpdateConnection, id, value),
	hostingRemoveConnection: (id) => ipcRenderer.invoke(ADMIN_CHANNELS.hostingRemoveConnection, id),
	hostingCheckConnection: (id) => ipcRenderer.invoke(ADMIN_CHANNELS.hostingCheckConnection, id),
	hostingInstances: (id) => ipcRenderer.invoke(ADMIN_CHANNELS.hostingInstances, id),
	welcome: () => ipcRenderer.invoke(ADMIN_CHANNELS.welcome),
	openInstance: (target) => ipcRenderer.invoke(ADMIN_CHANNELS.openInstance, target),
	prepareNewInstance: (target) => ipcRenderer.invoke(ADMIN_CHANNELS.prepareNewInstance, target),
	closeInstance: () => ipcRenderer.invoke(ADMIN_CHANNELS.closeInstance),
	installationReadiness: (id) => ipcRenderer.invoke(ADMIN_CHANNELS.installationReadiness, id),
	snapshot: () => ipcRenderer.invoke(ADMIN_CHANNELS.snapshot),
	selectedHome: () => ipcRenderer.invoke(ADMIN_CHANNELS.selectedHome),
	install: (config: StackConfig, automaticPorts = true) =>
		ipcRenderer.invoke(ADMIN_CHANNELS.install, config, automaticPorts),
	saveConfig: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.saveConfig, value),
	confirmRestart: (action) => ipcRenderer.invoke(ADMIN_CHANNELS.confirmRestart, action),
	action: (action: StackAction, confirmed = false) =>
		ipcRenderer.invoke(ADMIN_CHANNELS.action, { action, confirmed }),
	openOpenCode: () => ipcRenderer.invoke(ADMIN_CHANNELS.openOpenCode),
	openKnowledge: () => ipcRenderer.invoke(ADMIN_CHANNELS.openKnowledge),
	syncKnowledge: () => ipcRenderer.invoke(ADMIN_CHANNELS.syncKnowledge),
	copyText: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.copyText, value),
	openExternal: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.openExternal, value),
	chooseDirectory: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.chooseDirectory, value)
};

contextBridge.exposeInMainWorld('fholdAdmin', api);

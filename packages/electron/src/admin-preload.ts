import { contextBridge, ipcRenderer } from 'electron';

import { ADMIN_CHANNELS, type AdminApi, type StackAction } from './admin-types.js';
import type { StackConfig } from '@fhold/lib';

const api: AdminApi = {
	hostingFeatures: (id) => ipcRenderer.invoke(ADMIN_CHANNELS.hostingFeatures, id),
	hostingSetup: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.hostingSetup, value),
	directory: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.directory, value),
	hostingInfo: (id) => ipcRenderer.invoke(ADMIN_CHANNELS.hostingInfo, id),
	hostingDirectory: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.hostingDirectory, value),
	update: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.update, value),
	hostingConnections: () => ipcRenderer.invoke(ADMIN_CHANNELS.hostingConnections),
	hostingSaveConnection: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.hostingSaveConnection, value),
	hostingUpdateConnection: (id, value) =>
		ipcRenderer.invoke(ADMIN_CHANNELS.hostingUpdateConnection, id, value),
	hostingRemoveConnection: (id) => ipcRenderer.invoke(ADMIN_CHANNELS.hostingRemoveConnection, id),
	hostingCheckConnection: (id) => ipcRenderer.invoke(ADMIN_CHANNELS.hostingCheckConnection, id),
	hostingRepairConnection: (id) => ipcRenderer.invoke(ADMIN_CHANNELS.hostingRepairConnection, id),
	hostingInstances: (id) => ipcRenderer.invoke(ADMIN_CHANNELS.hostingInstances, id),
	welcome: () => ipcRenderer.invoke(ADMIN_CHANNELS.welcome),
	openInstance: (target) => ipcRenderer.invoke(ADMIN_CHANNELS.openInstance, target),
	prepareNewInstance: (target) => ipcRenderer.invoke(ADMIN_CHANNELS.prepareNewInstance, target),
	closeInstance: () => ipcRenderer.invoke(ADMIN_CHANNELS.closeInstance),
	installationReadiness: (id) => ipcRenderer.invoke(ADMIN_CHANNELS.installationReadiness, id),
	codexRecall: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.codexRecall, value),
	remote: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.remote, value),
	snapshot: () => ipcRenderer.invoke(ADMIN_CHANNELS.snapshot),
	selectedHome: () => ipcRenderer.invoke(ADMIN_CHANNELS.selectedHome),
	install: (config: StackConfig, automaticPorts = true) =>
		ipcRenderer.invoke(ADMIN_CHANNELS.install, config, automaticPorts),
	saveConfig: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.saveConfig, value),
	confirmRestart: (action) => ipcRenderer.invoke(ADMIN_CHANNELS.confirmRestart, action),
	action: (action: StackAction, confirmed = false) =>
		ipcRenderer.invoke(ADMIN_CHANNELS.action, { action, confirmed }),
	logs: (options) => ipcRenderer.invoke(ADMIN_CHANNELS.logs, options),
	providers: () => ipcRenderer.invoke(ADMIN_CHANNELS.providers),
	providerKey: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.providerKey, value),
	providerEndpoint: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.providerEndpoint, value),
	providerModels: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.providerModels, value),
	providerUse: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.providerUse, value),
	providerRemove: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.providerRemove, value),
	providerOAuthStart: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.providerOAuthStart, value),
	providerOAuthFinish: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.providerOAuthFinish, value),
	readiness: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.readiness, value),
	assistantPassword: () => ipcRenderer.invoke(ADMIN_CHANNELS.assistantPassword),
	copyText: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.copyText, value),
	openExternal: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.openExternal, value),
	chooseDirectory: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.chooseDirectory, value),
	credential: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.credential, value),
	credentialKey: (username) => ipcRenderer.invoke(ADMIN_CHANNELS.credentialKey, username),
	mapPortalUser: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.mapPortalUser, value),
	portalToken: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.portalToken, value),
	backup: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.backup, value),
	restoreInstance: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.restoreInstance, value),
	recovery: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.recovery, value),
	restoreData: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.restoreData, value)
};

contextBridge.exposeInMainWorld('fholdAdmin', api);

import { contextBridge, ipcRenderer } from 'electron';

import { ADMIN_CHANNELS, type AdminApi, type StackAction } from './admin-types.js';
import type { StackConfig } from '@fhold/lib';

const api: AdminApi = {
	welcome: () => ipcRenderer.invoke(ADMIN_CHANNELS.welcome),
	openInstance: (target) => ipcRenderer.invoke(ADMIN_CHANNELS.openInstance, target),
	prepareNewInstance: (target) => ipcRenderer.invoke(ADMIN_CHANNELS.prepareNewInstance, target),
	closeInstance: () => ipcRenderer.invoke(ADMIN_CHANNELS.closeInstance),
	codexRecall: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.codexRecall, value),
	remote: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.remote, value),
	snapshot: () => ipcRenderer.invoke(ADMIN_CHANNELS.snapshot),
	selectedHome: () => ipcRenderer.invoke(ADMIN_CHANNELS.selectedHome),
	install: (config: StackConfig, automaticPorts = true) => ipcRenderer.invoke(ADMIN_CHANNELS.install, config, automaticPorts),
	saveConfig: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.saveConfig, value),
	action: (action: StackAction) => ipcRenderer.invoke(ADMIN_CHANNELS.action, action),
	logs: () => ipcRenderer.invoke(ADMIN_CHANNELS.logs),
	providers: () => ipcRenderer.invoke(ADMIN_CHANNELS.providers),
	providerKey: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.providerKey, value),
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
	restoreData: (value) => ipcRenderer.invoke(ADMIN_CHANNELS.restoreData, value)
};

contextBridge.exposeInMainWorld('fholdAdmin', api);

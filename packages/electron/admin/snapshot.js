import { renderCredentials, renderMappings } from './access.js';
import { renderConnectionKeys } from './keys.js';
import {
	renderConnectionDetails,
	renderConnectionLinks,
	renderNetworkDetails,
	renderPortalSecrets,
	updateConditionalConnections,
	updatePortalTokenFields
} from './connections.js';
import { isHealthy } from './model.js';
import { loadProviders, renderReadiness, resetProviderState } from './providers.js';
import { renderPhase, renderServices } from './runtime.js';
import { renderInstallationReadiness, renderInstancePicker } from './instances.js';
import { renderRemoteStatus } from './remote.js';
import { renderRecovery, updateRecoveryFields } from './recovery.js';
import { state } from './state.js';
import {
	renderInstanceCapabilities,
	renderInstanceDetails,
	renderPlatformAccess
} from './instance-presentation.js';
import {
	byId,
	captureDirtyForms,
	message,
	notice,
	restoreDirtyForms,
	setSkipTarget,
	setText,
	showView
} from './ui.js';

let statusReadInFlight = false;

export function render(snapshot, options = {}) {
	const drafts = options.preserveDirty === false ? {} : captureDirtyForms();
	const previousPhase = state.currentSnapshot?.phase;
	state.currentSnapshot = snapshot;
	state.currentConfig = snapshot.config || null;
	if (snapshot.phase === 'remote' && previousPhase !== 'remote') resetProviderState();
	state.renderingSnapshot = true;
	if (snapshot.phase === 'not_installed' && previousPhase !== 'not_installed') {
		byId('install-instance-name').value = snapshot.config.deployment.projectName;
		byId('install-home').value = snapshot.homeDir;
		byId('install-home').dataset.suggestedHome =
			`${state.instancesDirectory}/${snapshot.config.deployment.projectName}`;
		byId('install-assistant-port').value = String(snapshot.config.assistant.port);
		byId('install-gateway-port').value = String(snapshot.config.gateway.port);
	}
	renderInstancePicker(snapshot);
	renderPhase(snapshot.phase);
	renderInstanceCapabilities(snapshot);
	if (snapshot.phase === 'remote') {
		if (previousPhase !== 'remote') {
			// Never present an old instance's secrets or settings as cloud state.
			for (const fields of document.querySelectorAll('[data-instance-feature]'))
				for (const control of fields.querySelectorAll('input, select, textarea')) {
					control.value = '';
					if (control instanceof HTMLInputElement) control.checked = false;
				}
		}
		renderInstanceDetails(snapshot);
		renderPlatformAccess(snapshot);
		renderServices(snapshot);
		state.renderingSnapshot = false;
		return;
	}
	byId('recovery-assistant-port').value = String(snapshot.config.assistant.port);
	byId('recovery-gateway-port').value = String(snapshot.config.gateway.port);
	if (snapshot.phase === 'not_installed') {
		renderInstallationReadiness(snapshot.installationReadiness);
		state.renderingSnapshot = false;
		return;
	}

	renderInstanceDetails(snapshot);
	renderNetworkDetails(snapshot);

	byId('gateway').checked = snapshot.config.gateway.enabled;
	byId('discord').checked = snapshot.config.portals.discord.enabled;
	byId('slack').checked = snapshot.config.portals.slack.enabled;
	byId('assistant-bind').value = snapshot.config.assistant.bindAddress;
	byId('assistant-port').value = String(snapshot.config.assistant.port);
	byId('gateway-bind').value = snapshot.config.gateway.bindAddress;
	byId('gateway-port').value = String(snapshot.config.gateway.port);
	const discordAccess = snapshot.config.portals.discord.access;
	const slackAccess = snapshot.config.portals.slack.access;
	byId('discord-guilds').value = discordAccess.guilds.join(',');
	byId('discord-roles').value = discordAccess.roles.join(',');
	byId('discord-users').value = discordAccess.users.join(',');
	byId('discord-blocked-users').value = discordAccess.blockedUsers.join(',');
	byId('slack-channels').value = slackAccess.channels.join(',');
	byId('slack-users').value = slackAccess.users.join(',');
	byId('slack-blocked-users').value = slackAccess.blockedUsers.join(',');

	renderServices(snapshot);
	renderRemoteStatus(snapshot);
	renderRecovery(snapshot);
	renderCredentials(snapshot);
	renderMappings(snapshot);
	renderConnectionKeys(snapshot);
	renderPortalSecrets(snapshot);
	renderConnectionDetails(snapshot);
	restoreDirtyForms(drafts);
	updateRecoveryFields();
	updateConditionalConnections();
	updatePortalTokenFields();
	state.renderingSnapshot = false;

	if (state.lastReadiness && state.lastReadinessProvider === byId('provider').value) {
		renderReadiness(state.lastReadiness);
	}

	if (snapshot.phase === 'ready') {
		showView(state.currentView);
	}

	const assistant = snapshot.services.find((service) => service.name === 'assistant');
	if (!state.providersLoaded && isHealthy(assistant))
		queueMicrotask(() => void loadProviders(false));
}

export async function showFatalError(error) {
	byId('instance-welcome').hidden = true;
	byId('loading-state').hidden = true;
	byId('install-section').hidden = true;
	byId('instance-import-section').hidden = true;
	byId('app-shell').hidden = true;
	byId('error-state').hidden = false;
	setText('error-message', message(error));
	setText('error-home', '');
	byId('error-home').hidden = true;
	setSkipTarget('error-state');
	try {
		const location = await state.api.selectedHome();
		if (location) {
			setText('error-home', location);
			byId('error-home').hidden = false;
		}
	} catch {
		/* An unavailable location is omitted, never replaced with a fake path. */
	}
	byId('error-state').focus();
}

export async function refresh({ statusOnly = false } = {}) {
	if (state.snapshotPromise) {
		const needsFullRead = !statusOnly && statusReadInFlight;
		await state.snapshotPromise;
		if (needsFullRead) await refresh();
		return;
	}
	const previous = state.currentSnapshot;
	statusReadInFlight = statusOnly;
	state.snapshotPromise = (async () => {
		try {
			const snapshot = await state.api.snapshot();
			if (statusOnly && (state.operationInFlight || state.currentSnapshot !== previous)) return;
			if (snapshot.phase === 'remote') {
				render(snapshot);
				return;
			}
			if (
				statusOnly &&
				state.currentSnapshot?.phase === snapshot.phase &&
				state.currentSnapshot.homeDir === snapshot.homeDir
			) {
				// Status reads must not reset forms, keys, hook reviews or the saved
				// configuration baseline behind an operator's unsaved changes.
				state.currentSnapshot = {
					...state.currentSnapshot,
					services: snapshot.services,
					updateImageTag: snapshot.updateImageTag,
					dockerError: snapshot.dockerError,
					pendingRestart: snapshot.pendingRestart,
					connectionDetails: snapshot.connectionDetails,
					connectionError: snapshot.connectionError
				};
				renderServices(snapshot);
				renderNetworkDetails(snapshot);
				renderConnectionLinks(snapshot);
				updateConditionalConnections();
				if (
					!state.providersLoaded &&
					!isHealthy(previous.services.find((service) => service.name === 'assistant')) &&
					isHealthy(snapshot.services.find((service) => service.name === 'assistant'))
				)
					queueMicrotask(() => void loadProviders(false));
			} else render(snapshot);
		} catch (error) {
			if (statusOnly && (state.operationInFlight || state.currentSnapshot !== previous)) return;
			if (state.currentSnapshot?.phase === 'remote') {
				setText('runtime-status-detail', `Status is unavailable: ${message(error)}`);
				byId('runtime-status-detail').hidden = false;
			} else if (state.currentSnapshot?.phase !== 'not_installed' && state.currentSnapshot) {
				state.currentSnapshot = {
					...state.currentSnapshot,
					services: [],
					dockerError: message(error)
				};
				renderServices(state.currentSnapshot);
				if (!statusOnly)
					notice(`Could not refresh status: ${message(error)}`, 'error', { persist: true });
			} else {
				await showFatalError(error);
				notice(message(error), 'error', { persist: true });
			}
		}
	})();
	try {
		await state.snapshotPromise;
	} finally {
		state.snapshotPromise = undefined;
		statusReadInFlight = false;
	}
}

export async function refreshVisibleStatus() {
	if (
		document.hidden ||
		state.adminSettingsOpen ||
		state.operationInFlight ||
		!state.currentSnapshot ||
		byId('app-shell').hidden ||
		byId('remote-dialog').open
	)
		return;
	await refresh({ statusOnly: true });
}

export function bindSnapshotEvents() {
	window.addEventListener('focus', () => void refreshVisibleStatus());
	document.addEventListener('visibilitychange', () => void refreshVisibleStatus());
	window.setInterval(() => void refreshVisibleStatus(), 15_000);
}

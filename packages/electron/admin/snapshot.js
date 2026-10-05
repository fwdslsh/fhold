import { renderCredentials, renderMappings } from './access.js';
import {
	renderConnectionDetails,
	renderNetworkDetails,
	renderPortalSecrets,
	updateConditionalConnections,
	updatePortalTokenFields
} from './connections.js';
import { isHealthy } from './model.js';
import { loadProviders, renderReadiness } from './providers.js';
import { renderPhase, renderServices } from './runtime.js';
import { renderInstallationReadiness, renderInstancePicker } from './instances.js';
import { renderPreferences } from './preferences.js';
import { renderRemoteStatus } from './remote.js';
import { renderRecovery, updateRecoveryFields } from './recovery.js';
import { state } from './state.js';
import {
	byId,
	captureDirtyForms,
	message,
	notice,
	restoreDirtyForms,
	setBadge,
	setSkipTarget,
	setText,
	showView
} from './ui.js';

let statusReadInFlight = false;

export function render(snapshot, options = {}) {
	const drafts = options.preserveDirty === false ? {} : captureDirtyForms();
	const previousPhase = state.currentSnapshot?.phase;
	state.currentSnapshot = snapshot;
	state.currentConfig = snapshot.config;
	state.renderingSnapshot = true;
	if (snapshot.phase === 'not_installed' && previousPhase !== 'not_installed') {
		byId('install-instance-name').value = snapshot.config.deployment.projectName;
		byId('install-home').value = snapshot.homeDir;
		byId('install-home').dataset.suggestedHome = `${state.instancesDirectory}/${snapshot.config.deployment.projectName}`;
		byId('install-assistant-port').value = String(snapshot.config.assistant.port);
		byId('install-gateway-port').value = String(snapshot.config.gateway.port);
	}
	renderInstancePicker(snapshot);
	byId('recovery-assistant-port').value = String(snapshot.config.assistant.port);
	byId('recovery-gateway-port').value = String(snapshot.config.gateway.port);
	renderPhase(snapshot.phase);
	if (snapshot.phase === 'not_installed') {
		renderInstallationReadiness(snapshot.installationReadiness);
		state.renderingSnapshot = false;
		return;
	}

	setText('home', snapshot.homeDir);
	setText('overview-home', snapshot.homeDir);
	setText('instance-name', snapshot.config.deployment?.projectName || '—');
	setText('config-path', snapshot.configPath);
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
	renderPreferences(snapshot);
	renderRemoteStatus(snapshot);
	renderRecovery(snapshot);
	renderCredentials(snapshot);
	renderMappings(snapshot);
	renderPortalSecrets(snapshot);
	renderConnectionDetails(snapshot);
	restoreDirtyForms(drafts);
	updateRecoveryFields();
	updateConditionalConnections();
	updatePortalTokenFields();
	state.renderingSnapshot = false;

	if (!state.lastReadiness) {
		if (snapshot.phase === 'ready') {
			byId('provider-status').className = 'inline-status success';
			byId('provider-status').replaceChildren();
			const title = document.createElement('strong');
			title.textContent = 'Provider setup is complete.';
			const detail = document.createElement('span');
			detail.textContent =
				'Run a readiness check whenever you want to verify the connection again.';
			byId('provider-status').append(title, detail);
			setBadge(byId('provider-badge'), 'Connected', 'success');
		} else {
			setBadge(byId('provider-badge'), 'Sign-in needed', 'neutral');
		}
	} else {
		renderReadiness(state.lastReadiness);
	}

	if (snapshot.phase === 'ready' && previousPhase === 'setup_incomplete') {
		showView('overview');
	} else if (snapshot.phase === 'ready') {
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
	setSkipTarget('error-state');
	try {
		setText('error-home', await state.api.selectedHome());
	} catch {
		setText('error-home', 'Selected fhold home');
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
					dockerError: snapshot.dockerError,
					pendingRestart: snapshot.pendingRestart
				};
				renderServices(snapshot);
				if (
					!state.providersLoaded &&
					!isHealthy(previous.services.find((service) => service.name === 'assistant')) &&
					isHealthy(snapshot.services.find((service) => service.name === 'assistant'))
				)
					queueMicrotask(() => void loadProviders(false));
			} else render(snapshot);
		} catch (error) {
			if (statusOnly && (state.operationInFlight || state.currentSnapshot !== previous)) return;
			if (state.currentSnapshot?.phase !== 'not_installed' && state.currentSnapshot) {
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

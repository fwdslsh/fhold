import { renderCredentials, renderMappings } from './access.js';
import { renderConnectionKeys } from './keys.js';
import {
	renderConnectionDetails,
	renderNetworkDetails,
	renderPortalSecrets,
	updateConditionalConnections,
	updatePortalTokenFields
} from './connections.js';
import { loadProviders, renderReadiness, resetProviderState } from './providers.js';
import { known } from './model.js';
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
	showView
} from './ui.js';

let statusReadInFlight = false;
const lifecycle = (snapshot) => known(snapshot?.lifecycle) || 'externally-managed';
const instanceKey = (snapshot) => JSON.stringify(snapshot?.identity?.ref || null);

export function render(snapshot, options = {}) {
	const drafts = options.preserveDirty === false ? {} : captureDirtyForms();
	const previous = state.currentSnapshot;
	const phase = lifecycle(snapshot);
	state.currentSnapshot = snapshot;
	state.currentConfig = snapshot.docker?.config || null;
	if (previous && instanceKey(previous) !== instanceKey(snapshot)) resetProviderState();
	state.renderingSnapshot = true;
	if (
		phase === 'not-installed' &&
		snapshot.docker &&
		(lifecycle(previous) !== 'not-installed' || instanceKey(previous) !== instanceKey(snapshot))
	) {
		const { config, homeDir } = snapshot.docker;
		byId('install-instance-name').value = config.deployment.projectName;
		byId('install-home').value = homeDir;
		byId('install-home').dataset.suggestedHome =
			`${state.instancesDirectory}/${config.deployment.projectName}`;
		byId('install-assistant-port').value = String(config.assistant.port);
		byId('install-gateway-port').value = String(config.gateway.port);
	}
	renderInstancePicker(snapshot);
	renderPhase(phase);
	renderInstanceCapabilities(snapshot);
	renderInstanceDetails(snapshot);
	renderPlatformAccess(snapshot);
	renderConnectionDetails(snapshot);
	renderServices(snapshot);
	renderRemoteStatus(snapshot);
	// App policy is an independent provider-neutral observation. It must remain
	// usable for a qualified non-Docker agent rather than being hidden by the
	// Compose settings form below.
	renderCredentials(snapshot);
	renderMappings(snapshot);
	renderConnectionKeys(snapshot);
	renderPortalSecrets(snapshot);
	const agentConnected = snapshot.agent?.access?.state === 'known';
	if (agentConnected && !state.providersLoaded) queueMicrotask(() => void loadProviders(false));
	renderNetworkDetails(snapshot);
	renderRecovery(snapshot);
	updateRecoveryFields();
	if (phase === 'not-installed') {
		renderInstallationReadiness(snapshot.docker?.installationReadiness);
		state.renderingSnapshot = false;
		return;
	}
	const config = snapshot.docker?.config;
	if (!config) {
		// Provider-neutral agent/app observations are rendered above.  Docker
		// configuration is only needed for the local Compose forms below.
		state.renderingSnapshot = false;
		return;
	}
	byId('recovery-assistant-port').value = String(config.assistant.port);
	byId('recovery-gateway-port').value = String(config.gateway.port);
	byId('gateway').checked = config.gateway.enabled;
	byId('discord').checked = config.portals.discord.enabled;
	byId('slack').checked = config.portals.slack.enabled;
	byId('assistant-bind').value = config.assistant.bindAddress;
	byId('assistant-port').value = String(config.assistant.port);
	byId('gateway-bind').value = config.gateway.bindAddress;
	byId('gateway-port').value = String(config.gateway.port);
	const discordAccess = config.portals.discord.access;
	const slackAccess = config.portals.slack.access;
	byId('discord-guilds').value = discordAccess.guilds.join(',');
	byId('discord-roles').value = discordAccess.roles.join(',');
	byId('discord-users').value = discordAccess.users.join(',');
	byId('discord-blocked-users').value = discordAccess.blockedUsers.join(',');
	byId('slack-channels').value = slackAccess.channels.join(',');
	byId('slack-users').value = slackAccess.users.join(',');
	byId('slack-blocked-users').value = slackAccess.blockedUsers.join(',');
	restoreDirtyForms(drafts);
	updateConditionalConnections();
	updatePortalTokenFields();
	state.renderingSnapshot = false;
	if (state.lastReadiness && state.lastReadinessProvider === byId('provider').value)
		renderReadiness(state.lastReadiness);
	if (phase === 'ready') showView(state.currentView);
}

export async function showFatalError(error) {
	byId('instance-welcome').hidden = true;
	byId('loading-state').hidden = true;
	byId('install-section').hidden = true;
	byId('instance-import-section').hidden = true;
	byId('app-shell').hidden = true;
	byId('error-state').hidden = false;
	byId('error-message').textContent = message(error);
	byId('error-home').textContent = '';
	byId('error-home').hidden = true;
	setSkipTarget('error-state');
	try {
		const location = await state.api.selectedHome();
		if (location) {
			byId('error-home').textContent = location;
			byId('error-home').hidden = false;
		}
	} catch {
		/* An unavailable location is omitted. */
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
			if (statusOnly && instanceKey(previous) === instanceKey(snapshot)) {
				state.currentSnapshot = {
					...previous,
					services: snapshot.services,
					deployment: snapshot.deployment,
					pendingChanges: snapshot.pendingChanges,
					operations: snapshot.operations
				};
				renderServices(state.currentSnapshot);
			} else render(snapshot);
		} catch (error) {
			if (statusOnly && (state.operationInFlight || state.currentSnapshot !== previous)) return;
			if (state.currentSnapshot) {
				state.currentSnapshot = {
					...state.currentSnapshot,
					services: { state: 'unavailable', reason: message(error) }
				};
				renderServices(state.currentSnapshot);
				if (!statusOnly)
					notice(`Could not refresh status: ${message(error)}`, 'error', { persist: true });
			} else await showFatalError(error);
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

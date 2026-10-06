import { friendlyServiceName, isHealthy, isRunning } from './model.js';
import { refresh, render } from './snapshot.js';
import { state } from './state.js';
import { renderRestartStatus, requestStackAction } from './restart.js';
import { updateRecoveryFields } from './recovery.js';
import { renderConnectionStatus, updateGuardianGuide } from './connections.js';
import { checkInstallationReadiness, prepareInstallTarget } from './instances.js';
import { all, byId, notice, operation, setBadge, setSkipTarget, setText, showView } from './ui.js';

export function renderPhase(phase) {
	byId('instance-welcome').hidden = true;
	byId('loading-state').hidden = true;
	byId('error-state').hidden = true;
	byId('install-section').hidden = phase !== 'not_installed';
	byId('instance-import-section').hidden = true;
	byId('app-shell').hidden = phase === 'not_installed';
	for (const element of all('.setup-only')) element.hidden = phase !== 'setup_incomplete';
	for (const element of all('.ready-only')) element.hidden = phase !== 'ready';
	document.body.dataset.phase = phase;
	const notifications = byId('notification-area');
	const alertLocation = byId(phase === 'ready' ? 'sidebar-alerts' : 'setup-alerts');
	if (notifications.parentElement !== alertLocation) alertLocation.append(notifications);
	setSkipTarget(phase === 'not_installed' ? 'install-section' : 'main-content');
	if (phase === 'setup_incomplete') {
		showView('provider');
	} else if (phase === 'ready') {
		showView(
			state.currentView === 'provider' && state.lastReadiness?.ok ? 'overview' : state.currentView
		);
	}
}

export function renderRuntimeControls(snapshot) {
	const assistant = snapshot.services.find((service) => service.name === 'assistant');
	const running = isRunning(assistant);
	const unavailable = !!snapshot.dockerError;
	byId('start-stack').disabled = state.operationInFlight || unavailable || running;
	byId('restart-stack').disabled = state.operationInFlight || unavailable || !running;
	byId('stop-stack').disabled =
		state.operationInFlight || unavailable || snapshot.services.length === 0;
	renderRestartStatus(snapshot);
	updateRecoveryFields();
}

export function renderServices(snapshot) {
	renderConnectionStatus(snapshot);
	updateGuardianGuide();
	const unavailable = !!snapshot.dockerError;
	setText(
		'runtime-status-detail',
		unavailable ? 'Container status is unavailable. fhold will retry automatically.' : ''
	);
	byId('runtime-status-detail').hidden = !unavailable;
	const services = byId('services');
	services.replaceChildren();
	if (snapshot.services.length === 0) {
		const empty = document.createElement('div');
		empty.className = 'empty-state';
		empty.textContent = snapshot.dockerError || 'fhold is stopped.';
		services.append(empty);
	} else {
		for (const service of snapshot.services) {
			const row = document.createElement('div');
			row.className = 'service';
			const identity = document.createElement('div');
			identity.className = 'service-name';
			const name = document.createElement('strong');
			name.textContent = friendlyServiceName(service.name);
			const technical = document.createElement('small');
			technical.textContent = service.name;
			identity.append(name, technical);
			const status = document.createElement('span');
			const healthy = isHealthy(service);
			setBadge(
				status,
				healthy ? 'Running normally' : [service.state, service.health].filter(Boolean).join(' · '),
				healthy ? 'success' : 'neutral'
			);
			row.append(identity, status);
			services.append(row);
		}
	}
	const assistant = snapshot.services.find((service) => service.name === 'assistant');
	const guardian = snapshot.services.find((service) => service.name === 'guardian');
	setText(
		'overview-heading',
		unavailable
			? 'Container status is unavailable.'
			: isHealthy(assistant)
				? 'Your personal agent is ready.'
				: assistant
					? 'Your agent needs attention.'
					: 'Your agent is stopped.'
	);
	setText(
		'assistant-summary',
		unavailable
			? 'Status unavailable'
			: isHealthy(assistant)
				? 'Running normally'
				: assistant
					? 'Needs attention'
					: 'Stopped'
	);
	setText(
		'guardian-summary',
		snapshot.config.gateway.enabled
			? unavailable
				? 'Status unavailable'
				: isHealthy(guardian)
					? 'Enabled and healthy'
					: 'Enabled · needs attention'
			: 'Not enabled'
	);
	const enabledPortals = ['discord', 'slack'].filter(
		(portal) => snapshot.config.portals[portal].enabled
	);
	setText(
		'portal-summary',
		enabledPortals.length
			? enabledPortals.map((portal) => portal[0].toUpperCase() + portal.slice(1)).join(' and ')
			: 'None enabled'
	);
	renderRuntimeControls(snapshot);
	const needsRecovery = snapshot.phase === 'setup_incomplete' && !isHealthy(assistant);
	byId('setup-recovery').hidden = !needsRecovery;
	byId('provider-connection').hidden = needsRecovery;
	setText(
		'setup-runtime',
		isHealthy(assistant) ? 'Your agent is running locally.' : 'Agent startup needs attention.'
	);
	setText(
		'setup-step',
		needsRecovery ? 'Step 1 of 3 · Start your agent' : 'Step 2 of 3 · Connect your AI'
	);
	if (needsRecovery) {
		setText('view-title', 'Start your agent');
		setText(
			'view-description',
			'Your files are safe. Retry startup before connecting an AI account.'
		);
	}
	if (needsRecovery) {
		setText(
			'recovery-message',
			snapshot.dockerError ||
				'A port conflict or Docker problem may have interrupted the first start. Adjust the ports if needed, then retry safely.'
		);
	}
}

export function bindRuntimeEvents() {
	for (const button of all('[data-check-prerequisites]'))
		button.addEventListener('click', () => void checkInstallationReadiness());
	byId('install-automatic-ports').addEventListener('change', () => {
		const automatic = byId('install-automatic-ports').checked;
		byId('install-assistant-port').disabled = automatic;
		byId('install-gateway-port').disabled = automatic;
	});
	byId('install-form').addEventListener('submit', async (event) => {
		event.preventDefault();
		if (state.operationInFlight || byId('install-section').hidden) return;
		const automaticPorts = byId('install-automatic-ports').checked;
		const assistantPort = Number(byId('install-assistant-port').value);
		const gatewayPort = Number(byId('install-gateway-port').value);
		if (!automaticPorts && assistantPort === gatewayPort) {
			notice('The Assistant and protected-access ports must be different.', 'error', {
				persist: true
			});
			byId('install-gateway-port').focus();
			return;
		}
		let prepared = false;
		const result = await operation(
			'Setting up fhold',
			async () => {
				await prepareInstallTarget();
				const snapshot = await state.api.snapshot();
				prepared = true;
				state.currentSnapshot = snapshot;
				state.currentConfig = snapshot.config;
				const config = snapshot.config;
				if (!automaticPorts) {
					config.assistant.port = assistantPort;
					config.gateway.port = gatewayPort;
				}
				return state.api.install(config, automaticPorts);
			},
			'fhold is installed. Next, connect your AI provider.'
		);
		if (result) byId('view-title').focus();
		else if (prepared) await refresh();
	});

	byId('recovery-form').addEventListener('submit', async (event) => {
		event.preventDefault();
		if (!state.currentConfig) return;
		const assistantPort = Number(byId('recovery-assistant-port').value);
		const gatewayPort = Number(byId('recovery-gateway-port').value);
		if (assistantPort === gatewayPort) {
			notice('The Assistant and protected-access ports must be different.', 'error', {
				persist: true
			});
			byId('recovery-gateway-port').focus();
			return;
		}
		const config = structuredClone(state.currentConfig);
		config.assistant.port = assistantPort;
		config.gateway.port = gatewayPort;
		const saved = await operation(
			'Saving startup settings',
			async () => {
				const saved = await state.api.saveConfig({ config, baseConfig: state.currentConfig });
				render(saved);
				return saved;
			},
			'Startup settings saved.'
		);
		if (saved) await requestStackAction('start');
	});

	all('[data-action]').forEach((button) => {
		button.addEventListener('click', () => {
			const action = button.dataset.action;
			void requestStackAction(action);
		});
	});
}

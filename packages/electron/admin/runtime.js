import { friendlyServiceName, isHealthy, isRunning, serviceImageDetails } from './model.js';
import { refresh, render } from './snapshot.js';
import { state } from './state.js';
import { renderRestartStatus, requestStackAction } from './restart.js';
import { updateRecoveryFields } from './recovery.js';
import { renderConnectionStatus, updateGuardianGuide } from './connections.js';
import { checkInstallationReadiness, prepareInstallTarget } from './instances.js';
import { all, byId, notice, operation, setBadge, setSkipTarget, setText, showView } from './ui.js';
import { renderHostedControls } from './hosting.js';

export function renderPhase(phase) {
	const setup = phase === 'setup_incomplete' || state.awaitingSetupFinish;
	byId('instance-welcome').hidden = true;
	byId('loading-state').hidden = true;
	byId('error-state').hidden = true;
	byId('install-section').hidden = phase !== 'not_installed';
	byId('instance-import-section').hidden = true;
	byId('app-shell').hidden = phase === 'not_installed';
	for (const element of all('.setup-only')) element.hidden = !setup;
	for (const element of all('.ready-only')) element.hidden = phase !== 'ready' || setup;
	document.body.dataset.phase = setup ? 'setup_incomplete' : phase;
	const notifications = byId('notification-area');
	const alertLocation = byId(phase === 'ready' && !setup ? 'sidebar-alerts' : 'setup-alerts');
	if (notifications.parentElement !== alertLocation) alertLocation.append(notifications);
	setSkipTarget(phase === 'not_installed' ? 'install-section' : 'main-content');
	if (setup) {
		showView('provider');
	} else if (phase === 'ready') {
		showView(state.currentView);
	}
}

export function renderRuntimeControls(snapshot) {
	if (snapshot.phase === 'remote') {
		renderHostedControls(snapshot.hosting);
		return;
	}
	const assistant = snapshot.services.find((service) => service.name === 'assistant');
	const running = isRunning(assistant);
	const unavailable = !!snapshot.dockerError;
	byId('start-stack').disabled = state.operationInFlight || unavailable || running;
	byId('restart-stack').disabled = state.operationInFlight || unavailable || !running;
	byId('stop-stack').disabled =
		state.operationInFlight || unavailable || snapshot.services.length === 0;
	byId('update-stack').disabled = state.operationInFlight || unavailable;
	renderRestartStatus(snapshot);
	updateRecoveryFields();
}

export function renderServices(snapshot) {
	const missingHostVersion = !snapshot.updateImageTag && snapshot.target?.kind === 'ssh-docker';
	setText('update-image-tag', snapshot.updateImageTag || 'Not reported');
	setText('runtime-version-help', missingHostVersion
		? 'This host has an older fhold CLI. In Host connections, choose Check, then Install / update remote CLI to show image versions. Your agent keeps running.'
		: snapshot.updateImageTag
			? 'Included with the fhold CLI managing this instance. Custom image settings are kept.'
			: 'The managing tool did not report an update version. Update the fhold tools to restore version information. Your agent keeps running.');
	byId('runtime-version-settings').hidden = !missingHostVersion;
	renderConnectionStatus(snapshot);
	updateGuardianGuide();
	const unavailable = !!snapshot.dockerError;
	const warnings = snapshot.services.flatMap((service) => service.warnings ?? []);
	if (snapshot.connectionError)
		warnings.push(`Browser connection unavailable. ${snapshot.connectionError}`);
	setText(
		'runtime-status-detail',
		unavailable
			? 'Container status is unavailable. fhold will retry automatically.'
			: warnings.join(' ')
	);
	byId('runtime-status-detail').hidden = !unavailable && warnings.length === 0;
	const services = byId('services');
	services.replaceChildren();
	if (snapshot.services.length === 0) {
		const empty = document.createElement('div');
		empty.className = 'empty-state';
		empty.textContent = snapshot.dockerError || 'fhold is stopped.';
		services.append(empty);
	} else {
		const order = { assistant: 0, guardian: 1, discord: 2, slack: 3 };
		const orderedServices = [...snapshot.services].sort((a, b) =>
			(order[a.name] ?? 4) - (order[b.name] ?? 4) || a.name.localeCompare(b.name)
		);
		for (const service of orderedServices) {
			const row = document.createElement('div');
			row.className = 'service';
			const identity = document.createElement('div');
			identity.className = 'service-name';
			const name = document.createElement('strong');
			name.textContent = friendlyServiceName(service.name);
			const image = document.createElement('small');
			image.className = 'service-image';
			image.title = service.image || (missingHostVersion
				? 'Update the remote fhold CLI to report this container’s image reference.'
				: 'Docker did not report an image reference.');
			const details = serviceImageDetails(service.image);
			const label = document.createElement('span');
			label.textContent = `${details.label} `;
			const tag = document.createElement('code');
			tag.textContent = details.value;
			image.append(label, tag);
			identity.append(name, image);
			const status = document.createElement('span');
			const healthy = isHealthy(service);
			const degraded = healthy && service.warnings?.length > 0;
			setBadge(
				status,
				degraded
					? 'Running · needs attention'
					: healthy
						? 'Running normally'
						: [service.state, service.health].filter(Boolean).join(' · '),
				degraded ? 'warning' : healthy ? 'success' : 'neutral'
			);
			row.append(identity, status);
			services.append(row);
		}
	}
	const assistant = snapshot.services.find((service) => service.name === 'assistant');
	const guardian = snapshot.services.find((service) => service.name === 'guardian');
	const degraded = isHealthy(assistant) && assistant.warnings?.length > 0;
	setText(
		'overview-heading',
		unavailable
			? 'Container status is unavailable.'
			: isHealthy(assistant)
				? degraded
					? 'Your agent is running; some features need attention.'
					: 'Your personal agent is ready.'
				: assistant
					? 'Your agent needs attention.'
					: 'Your agent is stopped.'
	);
	setText(
		'assistant-summary',
		unavailable
			? 'Status unavailable'
			: isHealthy(assistant)
				? degraded
					? 'Running · needs attention'
					: 'Running normally'
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
		isHealthy(assistant) ? 'Your agent is running.' : 'Agent startup needs attention.'
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
	byId('update-stack').addEventListener('click', async () => {
		if (state.operationInFlight) return;
		if (!(await state.api.confirmRestart('update'))) return;
		const result = await operation(
			'Updating instance',
			() => state.api.update({ confirmed: true }),
			'Instance updated.'
		);
		if (result) render(result);
	});
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
		const result = await operation(
			'Setting up fhold',
			async () => {
				await prepareInstallTarget();
				const snapshot = await state.api.snapshot();
				state.currentSnapshot = snapshot;
				state.currentConfig = snapshot.config;
				const config = snapshot.config;
				if (!automaticPorts) {
					config.assistant.port = assistantPort;
					config.gateway.port = gatewayPort;
				}
				try {
					return await state.api.install(config, automaticPorts);
				} catch (error) {
					// Preparing selected the target. Finish its failure-recovery read
					// before operation() re-enables Install or permits another target.
					await refresh();
					throw error;
				}
			},
			'fhold is installed. Next, connect your AI provider.'
		);
		if (result) byId('view-title').focus();
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

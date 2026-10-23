import { friendlyServiceName, isHealthy, isRunning, serviceImageDetails } from './model.js';
import { refresh, render } from './snapshot.js';
import { state } from './state.js';
import { renderRestartStatus, requestStackAction } from './restart.js';
import { updateRecoveryFields } from './recovery.js';
import { renderConnectionStatus, updateGuardianGuide } from './connections.js';
import { checkInstallationReadiness, prepareInstallTarget } from './instances.js';
import { all, byId, notice, operation, setBadge, setSkipTarget, setText, showView } from './ui.js';
import { instanceCapability, instancePresentation } from './instance-presentation.js';

export function renderPhase(lifecycle) {
	const setup = lifecycle === 'setup-incomplete' || state.awaitingSetupFinish;
	const ready = lifecycle === 'ready' || lifecycle === 'externally-managed';
	byId('instance-welcome').hidden = true;
	byId('loading-state').hidden = true;
	byId('error-state').hidden = true;
	byId('install-section').hidden = lifecycle !== 'not-installed';
	byId('instance-import-section').hidden = true;
	byId('app-shell').hidden = lifecycle === 'not-installed';
	for (const element of all('.setup-only')) element.hidden = !setup;
	for (const element of all('.ready-only')) element.hidden = !ready || setup;
	document.body.dataset.phase = setup ? 'setup_incomplete' : ready ? 'ready' : lifecycle;
	const notifications = byId('notification-area');
	const alertLocation = byId(ready && !setup ? 'sidebar-alerts' : 'setup-alerts');
	if (notifications.parentElement !== alertLocation) alertLocation.append(notifications);
	setSkipTarget(lifecycle === 'not-installed' ? 'install-section' : 'main-content');
	if (setup) {
		showView('provider');
	} else if (ready) {
		showView(state.currentView);
	}
}

export function renderRuntimeControls(snapshot) {
	const view = instancePresentation(snapshot);
	const assistant = view.services.find((service) => service.name === 'assistant');
	const running = isRunning(assistant);
	const observed = snapshot.services?.state === 'known';
	const reasons = [];
	for (const [action, operationKey] of [
		['start', 'host.start'],
		['restart', 'host.restart'],
		['stop', 'host.stop'],
		['update', 'docker.update']
	]) {
		const capability = instanceCapability(operationKey, snapshot);
		const button = byId(`${action}-stack`);
		button.disabled =
			state.operationInFlight ||
			!capability.supported ||
			(observed &&
				(action === 'start'
					? running
					: action === 'restart'
						? !running
						: action === 'stop'
							? view.services.length === 0
							: false));
		button.title = capability.supported ? '' : capability.reason;
		if (!capability.supported && action !== 'update')
			reasons.push(`${action[0].toUpperCase()}${action.slice(1)}: ${capability.reason}`);
	}
	setText('runtime-action-help', reasons.join(' '));
	byId('runtime-action-help').hidden = reasons.length === 0;
	renderRestartStatus(snapshot);
	if (snapshot.data?.recovery?.state === 'known') updateRecoveryFields();
}

export function renderServices(snapshot) {
	const view = instancePresentation(snapshot);
	const reportedServices = view.services;
	const missingHostVersion =
		!view.docker?.updateImageTag && snapshot.operations?.['docker.update']?.support === 'unknown';
	setText('update-image-tag', view.docker?.updateImageTag || 'Not reported');
	setText(
		'runtime-version-help',
		missingHostVersion
			? `${snapshot.operations?.['docker.update']?.reason ? `${snapshot.operations['docker.update'].reason} ` : ''}Image metadata is unavailable. Check this host connection and local tooling distribution. Your agent keeps running.`
			: !instanceCapability('docker.update', snapshot).supported
				? `${instanceCapability('docker.update', snapshot).reason} Images above are deployment references; platform status is not agent readiness.`
				: view.docker?.updateImageTag
					? 'Included with the fhold CLI managing this instance. Custom image settings are kept.'
					: 'The managing tool did not report an update version. Update the fhold tools to restore version information. Your agent keeps running.'
	);
	byId('runtime-version-settings').hidden = !missingHostVersion;
	renderConnectionStatus(snapshot);
	updateGuardianGuide();
	setText('instance-client-guidance', view.deployment.guidance?.client || '');
	byId('instance-client-guidance').hidden = !view.deployment.guidance?.client;
	const unavailable = snapshot.services?.state === 'unavailable';
	const warnings = [
		...(view.deployment.warnings || []),
		...view.services.flatMap((service) => service.warnings ?? [])
	];
	setText(
		'runtime-status-detail',
		unavailable
			? 'Container status is unavailable. fhold will retry automatically.'
			: warnings.join(' ')
	);
	byId('runtime-status-detail').hidden = !unavailable && warnings.length === 0;
	const services = byId('services');
	services.replaceChildren();
	if (reportedServices.length === 0) {
		const empty = document.createElement('div');
		empty.className = 'empty-state';
		empty.textContent =
			view.serviceReason || view.deployment.state || 'No service status reported.';
		services.append(empty);
	} else {
		const order = { assistant: 0, guardian: 1, discord: 2, slack: 3 };
		const orderedServices = [...reportedServices].sort(
			(a, b) => (order[a.name] ?? 4) - (order[b.name] ?? 4) || a.name.localeCompare(b.name)
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
			const provenance = service.imageProvenance;
			const configured = !service.image && !provenance?.observedReferences?.length;
			const references = service.image
				? [service.image]
				: provenance?.observedReferences?.length
					? provenance.observedReferences
					: provenance?.configuredReferences ||
						(provenance?.configuredReference ? [provenance.configuredReference] : []);
			image.title =
				(references.length
					? `${configured ? 'Configured deployment image, not a running-replica observation: ' : ''}${references.join(', ')}`
					: '') ||
				(missingHostVersion
					? 'Check this host connection to report this container’s image reference.'
					: 'This connection did not report an image reference.');
			const details = serviceImageDetails(references[0]);
			const label = document.createElement('span');
			label.className = configured && references.length ? 'image-origin' : 'visually-hidden';
			label.textContent = configured && references.length ? 'Configured · ' : `${details.label} `;
			const tag = document.createElement('code');
			tag.textContent =
				references.length > 1
					? references.map((reference) => serviceImageDetails(reference).value).join(', ')
					: details.value;
			image.append(label, tag);
			identity.append(name);
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
			row.append(identity, image, status);
			services.append(row);
		}
	}
	const assistant = view.services.find((service) => service.name === 'assistant');
	const degraded = isHealthy(assistant) && assistant.warnings?.length > 0;
	setBadge(
		byId('assistant-summary'),
		unavailable
			? 'Status unavailable'
			: view.deployment.state
				? view.deployment.state
				: isHealthy(assistant)
					? degraded
						? 'Running · needs attention'
						: 'Running'
					: assistant
						? 'Needs attention'
						: 'Stopped',
		unavailable || view.deployment.state
			? 'neutral'
			: degraded
				? 'warning'
				: isHealthy(assistant)
					? 'success'
					: 'neutral'
	);
	renderRuntimeControls(snapshot);
	const needsRecovery =
		snapshot.lifecycle?.state === 'known' &&
		snapshot.lifecycle.value === 'setup-incomplete' &&
		!isHealthy(assistant);
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
			view.serviceReason ||
				'A port conflict or Docker problem may have interrupted the first start. Adjust the ports if needed, then retry safely.'
		);
	}
}

export function bindRuntimeEvents() {
	byId('update-stack').addEventListener('click', async () => {
		if (state.operationInFlight || !instanceCapability('docker.update').supported) return;
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
				state.currentConfig = snapshot.docker?.config || null;
				const config = snapshot.docker?.config;
				if (!config)
					throw new Error('The selected instance does not expose local installation settings.');
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
		if (saved) await requestStackAction('host.start');
	});

	all('[data-action]').forEach((button) => {
		button.addEventListener('click', () => {
			void requestStackAction(button.dataset.action);
		});
	});
}

import { state } from './state.js';
import {
	all,
	byId,
	message,
	notice,
	operation,
	setBusy,
	setOptions,
	setSkipTarget,
	setText
} from './ui.js';
import { openInstance, renderInstancePicker } from './instances.js';
import { renderRestartStatus } from './restart.js';

export function targetKey(target) {
	return target.kind === 'hosted'
		? JSON.stringify([target.ref.kind, target.ref.connectionId, targetLocation(target)])
		: target.homeDir;
}
export function targetLocation(target) {
	return target.kind === 'hosted' ? target.ref.remoteHome || target.ref.resourceId : target.homeDir;
}
export function renderHosted(snapshot) {
	const hosted = snapshot.hosting;
	state.currentSnapshot = snapshot;
	state.currentConfig = null;
	for (const id of [
		'loading-state',
		'error-state',
		'instance-welcome',
		'install-section',
		'instance-import-section'
	])
		byId(id).hidden = true;
	byId('app-shell').hidden = false;
	document.body.dataset.phase = 'ready';
	for (const element of all('.setup-only, [data-view-panel], [data-view]')) element.hidden = true;
	byId('view-hosted').hidden = false;
	byId('mobile-navigation').hidden = true;
	renderRestartStatus(hosted);
	byId('sidebar-alerts').append(byId('notification-area'));
	setSkipTarget('main-content');
	setText('view-title', hosted.name);
	setText(
		'view-description',
		hosted.ref.kind === 'ssh-docker' ? 'Remote Docker host' : 'Azure Container App · experimental'
	);
	setText('hosted-location', hosted.location);
	setText(
		'hosted-state',
		hosted.platformState ||
			hosted.services
				.map((service) => `${service.name}: ${service.state} ${service.health}`)
				.join('\n') ||
			'Stopped'
	);
	setText(
		'hosted-warnings',
		[...hosted.warnings, ...hosted.services.flatMap((service) => service.warnings || [])].join('\n')
	);
	byId('hosted-warnings').hidden = !byId('hosted-warnings').textContent;
	setText('hosted-settings-detail', hosted.capabilities.settings.reason);
	setText('hosted-transfer-detail', hosted.capabilities.transfer.reason);
	setText(
		'hosted-client-detail',
		hosted.ref.kind === 'azure-container-apps'
			? 'Status checks do not wake a scaled-to-zero agent. Opening OpenCode may wake it.'
			: 'The native API stays on the Docker host. Use a native SSH port forward to open a loopback-only address.'
	);
	setText(
		'hosted-revisions',
		(hosted.revisions || [])
			.map(
				(item) =>
					`${item.name}: ${item.active ? 'active' : 'inactive'}, ${item.replicas} replica(s), ${item.health}`
			)
			.join('\n')
	);
	byId('hosted-revisions').hidden = !hosted.revisions?.length;
	const client = byId('hosted-open-agent');
	client.hidden = !hosted.clientUrl;
	client.href = hosted.clientUrl || 'about:blank';
	for (const button of all('[data-hosted-action]')) {
		const capability = hosted.capabilities[button.dataset.hostedAction];
		button.disabled = state.operationInFlight || !capability.supported;
		button.hidden = !capability.supported;
	}
	setText(
		'hosted-restart-detail',
		hosted.capabilities.restart.reason ||
			'Restart applies saved Docker-host settings and can interrupt current work.'
	);
	renderInstancePicker(snapshot);
}

async function loadConnections() {
	const connections = await state.api.hostingConnections();
	setOptions(
		byId('hosting-connection'),
		connections.map((item) => ({ value: item.id, label: item.label })),
		'local'
	);
}
async function discover() {
	await operation('Finding instances', async () => {
		const instances = await state.api.hostingInstances(byId('hosting-connection').value);
		const list = byId('hosting-instance-list');
		list.replaceChildren();
		if (!instances.length) {
			const empty = document.createElement('p');
			empty.textContent = 'No fhold instances found. Check the instance roots or deployment tag.';
			list.append(empty);
		}
		for (const instance of instances) {
			const button = document.createElement('button');
			button.className = 'instance-choice';
			button.type = 'button';
			const name = document.createElement('span');
			name.className = 'instance-name';
			name.textContent = instance.name;
			const path = document.createElement('span');
			path.className = 'instance-path';
			path.textContent = instance.location;
			button.append(name, path);
			button.addEventListener(
				'click',
				() =>
					void openInstance(
						instance.ref.kind === 'local-docker'
							? { kind: 'local', homeDir: instance.ref.homeDir }
							: { kind: 'hosted', ref: instance.ref }
					)
			);
			list.append(button);
		}
	});
}
export function bindHostingEvents() {
	byId('open-hosting').addEventListener('toggle', () => {
		if (byId('open-hosting').open)
			void loadConnections().catch((error) => notice(message(error), 'error', { persist: true }));
	});
	byId('hosting-provider').addEventListener('change', () => {
		const ssh = byId('hosting-provider').value === 'ssh-docker';
		byId('hosting-ssh-fields').hidden = !ssh;
		byId('hosting-azure-fields').hidden = ssh;
	});
	byId('hosting-discover').addEventListener('click', () => void discover());
	byId('hosting-add-form').addEventListener('submit', async (event) => {
		event.preventDefault();
		const saved = await operation('Saving connection', async () => {
			const saved = await state.api.hostingSaveConnection({
				id: byId('hosting-id').value.trim(),
				kind: byId('hosting-provider').value,
				host: byId('hosting-host').value.trim(),
				roots: byId('hosting-roots')
					.value.split('\n')
					.map((value) => value.trim())
					.filter(Boolean),
				subscriptionId: byId('hosting-subscription').value.trim(),
				resourceGroup: byId('hosting-group').value.trim()
			});
			await loadConnections();
			byId('hosting-connection').value = saved.id;
			byId('hosting-add').open = false;
			return saved;
		});
		if (saved) await discover();
	});
	for (const button of all('[data-hosted-action]'))
		button.addEventListener('click', async () => {
			if (state.operationInFlight) return;
			const action = button.dataset.hostedAction;
			let confirmed = false;
			setBusy(true);
			try {
				confirmed = await state.api.confirmRestart(action);
			} catch (error) {
				notice(message(error), 'error', { persist: true });
			} finally {
				setBusy(false);
			}
			if (!confirmed) return;
			await operation(
				`${action[0].toUpperCase()}${action.slice(1)} instance`,
				() => state.api.action(action, true),
				state.currentSnapshot?.hosting.ref.kind === 'azure-container-apps'
					? 'Request submitted. Check platform status.'
					: 'Operation complete.'
			);
		});
	byId('hosted-load-logs').addEventListener(
		'click',
		() =>
			void operation('Reading logs', async () => {
				byId('hosted-logs').value = await state.api.logs();
			})
	);
}

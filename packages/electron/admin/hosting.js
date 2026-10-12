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
import { openInstance, renderInstancePicker, showNewInstanceSetup } from './instances.js';
import { renderRestartStatus } from './restart.js';
import { chooseManagedDirectory } from './directories.js';

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

let savedConnections = [];
let editingId;
let discoveryEpoch = 0;
function selectedConnectionId() {
	return (
		state.currentSnapshot?.target?.connectionId || state.currentSnapshot?.hosting?.ref.connectionId
	);
}
async function loadConnections() {
	const selected = byId('hosting-connection').value;
	savedConnections = await state.api.hostingConnections();
	setOptions(
		byId('hosting-connection'),
		savedConnections.map((item) => ({ value: item.id, label: item.label })),
		savedConnections.some((item) => item.id === selected) ? selected : 'local'
	);
	renderConnectionList();
}
function hostingStatus(value, error = false) {
	const status = byId(byId('hosting-manager').open ? 'hosting-manager-status' : 'hosting-status');
	status.textContent = value;
	status.hidden = !value;
	status.className = `help-text${error ? ' danger-text' : ''}`;
	status.setAttribute('role', error ? 'alert' : 'status');
}
async function connectionOperation(progress, action) {
	if (state.operationInFlight) return undefined;
	setBusy(true);
	hostingStatus(`${progress}…`);
	try {
		return await action();
	} catch (error) {
		hostingStatus(message(error), true);
		return undefined;
	} finally {
		setBusy(false);
	}
}
async function discover() {
	const id = byId('hosting-connection').value;
	const epoch = ++discoveryEpoch;
	byId('hosting-instance-list').replaceChildren();
	byId('hosting-discover').hidden = true;
	for (const button of ['hosting-install', 'hosting-import', 'hosting-open-folder'])
		byId(button).hidden = true;
	await connectionOperation('Finding instances', async () => {
		let instances;
		try {
			instances = await state.api.hostingInstances(id);
		} catch (error) {
			if (epoch !== discoveryEpoch || id !== byId('hosting-connection').value) return;
			throw error;
		}
		if (epoch !== discoveryEpoch || id !== byId('hosting-connection').value) return;
		const list = byId('hosting-instance-list');
		const connection = savedConnections.find((item) => item.id === id);
		for (const button of ['hosting-install', 'hosting-import', 'hosting-open-folder'])
			byId(button).hidden = connection?.kind !== 'ssh-docker';
		list.replaceChildren();
		hostingStatus(
			instances.length
				? ''
				: 'No instances found. Open Manage host connections to check sign-in and the remote CLI, or add an instance root.'
		);
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
	byId('hosting-discover').hidden = !byId('hosting-status').classList.contains('danger-text');
}
export async function showHostingChooser(id) {
	byId('app-shell').hidden = true;
	byId('instance-welcome').hidden = false;
	byId('instance-options').hidden = true;
	byId('open-hosting').hidden = false;
	await loadConnections();
	if (id) byId('hosting-connection').value = id;
	await discover();
}
function providerFields() {
	const ssh = byId('hosting-provider').value === 'ssh-docker';
	byId('hosting-ssh-fields').hidden = !ssh;
	byId('hosting-ssh-advanced').hidden = !ssh;
	byId('hosting-azure-fields').hidden = ssh;
	byId('hosting-host').required = ssh;
	byId('hosting-subscription').required = !ssh;
	byId('hosting-group').required = !ssh;
	byId('hosting-port').disabled = !ssh;
}
function editConnection(connection) {
	if (state.operationInFlight) return;
	editingId = connection?.id;
	byId('hosting-add-form').reset();
	delete byId('hosting-id').dataset.manual;
	byId('hosting-add-form').hidden = false;
	byId('hosting-new').hidden = true;
	setText('hosting-editor-title', connection ? 'Edit connection' : 'Add connection');
	for (const [field, value] of Object.entries({
		id: connection?.id,
		label: connection?.label,
		provider: connection?.kind || 'ssh-docker',
		host: connection?.host,
		port: connection?.port,
		roots: connection?.roots?.join('\n'),
		subscription: connection?.subscriptionId,
		group: connection?.resourceGroup
	}))
		byId(`hosting-${field}`).value = value ?? '';
	byId('hosting-id').readOnly = !!connection;
	byId('hosting-provider').disabled = !!connection;
	byId('hosting-advanced').open = false;
	providerFields();
	byId('hosting-label').focus();
}
function closeEditor() {
	editingId = undefined;
	byId('hosting-add-form').hidden = true;
	byId('hosting-new').hidden = false;
}
function renderConnectionList() {
	const list = byId('hosting-manager-list');
	list.replaceChildren();
	for (const connection of savedConnections.filter((item) => item.id !== 'local')) {
		const row = document.createElement('section');
		row.className = 'hosting-connection-row';
		const description = document.createElement('div');
		const title = document.createElement('strong');
		title.textContent = connection.label;
		const location = document.createElement('p');
		location.className = 'help-text';
		location.textContent = connection.host || `${connection.resourceGroup} · Azure`;
		description.append(title, location);
		const buttons = document.createElement('div');
		buttons.className = 'button-row compact';
		for (const [label, action] of [
			[
				'Open',
				async () => {
					byId('hosting-manager').close();
					await showHostingChooser(connection.id);
				}
			],
			['Edit', () => editConnection(connection)],
			['Check', () => checkConnection(connection)],
			['Remove', () => removeConnection(connection)]
		]) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'secondary';
			button.textContent = label;
			button.setAttribute('aria-label', `${label} ${connection.label}`);
			button.addEventListener('click', () => void action());
			buttons.append(button);
		}
		row.append(description, buttons);
		list.append(row);
	}
	if (!list.children.length) {
		const hint = document.createElement('p');
		hint.className = 'help-text';
		hint.textContent = 'No remote connections yet. This computer is always available.';
		list.append(hint);
	}
}
async function checkConnection(connection) {
	byId('hosting-check-details').replaceChildren();
	await connectionOperation(`Checking ${connection.label}`, async () => {
		const result = await state.api.hostingCheckConnection(connection.id);
		hostingStatus(
			result.ok ? `${connection.label} is ready.` : `${connection.label} needs attention.`,
			!result.ok
		);
		const details = byId('hosting-check-details');
		for (const check of result.checks) {
			const line = document.createElement('p');
			line.className = `help-text${check.ok ? '' : ' danger-text'}`;
			line.textContent = `${check.name}: ${check.detail}`;
			details.append(line);
		}
		if (connection.kind === 'ssh-docker' && result.repairable) {
			const repair = document.createElement('button');
			repair.type = 'button';
			repair.className = 'secondary';
			repair.textContent = 'Install / update remote CLI';
			repair.addEventListener('click', async () => {
				const done = await connectionOperation('Updating remote CLI', () =>
					state.api.hostingRepairConnection(connection.id)
				);
				if (done) {
					hostingStatus(done);
					await checkConnection(connection);
				} else if (
					done === undefined &&
					!byId('hosting-manager-status').classList.contains('danger-text')
				)
					hostingStatus('Remote CLI installation cancelled.');
			});
			details.append(repair);
		}
	});
}
async function removeConnection(connection) {
	const removed = await connectionOperation('Removing saved connection', () =>
		state.api.hostingRemoveConnection(connection.id)
	);
	if (!removed) {
		if (removed === false) hostingStatus('Removal cancelled.');
		return;
	}
	const selected = selectedConnectionId() === connection.id;
	if (selected) {
		window.location.reload();
		return;
	}
	closeEditor();
	byId('hosting-check-details').replaceChildren();
	byId('hosting-instance-list').replaceChildren();
	await loadConnections();
	state.recentInstances = state.recentInstances.filter(
		(item) => item.kind !== 'hosted' || item.ref.connectionId !== connection.id
	);
	if (state.currentSnapshot) renderInstancePicker(state.currentSnapshot);
	hostingStatus('Connection removed. Instances remain running.');
}
export async function manageHostingConnections() {
	if (state.operationInFlight) return;
	byId('hosting-manager').showModal();
	closeEditor();
	byId('hosting-check-details').replaceChildren();
	await connectionOperation('Loading connections', async () => {
		await loadConnections();
		hostingStatus('');
	});
}
export function bindHostingEvents() {
	byId('hosting-open-folder').addEventListener('click', async () => {
		const connection = savedConnections.find(
			(item) => item.id === byId('hosting-connection').value
		);
		const previous = state.installConnection;
		state.installConnection = connection;
		try {
			const home = await chooseManagedDirectory('instance');
			if (home)
				await openInstance({
					kind: 'hosted',
					ref: { kind: 'ssh-docker', connectionId: connection.id, remoteHome: home }
				});
		} finally {
			state.installConnection = previous;
		}
	});
	byId('connect-host').addEventListener('click', () => void showHostingChooser());
	byId('hosting-back').addEventListener('click', () => {
		byId('open-hosting').hidden = true;
		state.installConnection = undefined;
		state.installationReadiness = undefined;
		if (state.currentSnapshot) {
			byId('instance-welcome').hidden = true;
			byId('app-shell').hidden = false;
		} else byId('instance-options').hidden = false;
	});
	byId('hosting-manage').addEventListener('click', () => void manageHostingConnections());
	byId('hosting-manager-close').addEventListener('click', () => {
		if (!state.operationInFlight) byId('hosting-manager').close();
	});
	byId('hosting-manager').addEventListener('cancel', (event) => {
		if (state.operationInFlight) event.preventDefault();
	});
	byId('hosting-new').addEventListener('click', () => editConnection());
	byId('hosting-edit-cancel').addEventListener('click', closeEditor);
	byId('hosting-label').addEventListener('input', () => {
		if (!editingId && !byId('hosting-id').dataset.manual)
			byId('hosting-id').value = byId('hosting-label')
				.value.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '')
				.slice(0, 63);
	});
	byId('hosting-id').addEventListener('input', () => {
		byId('hosting-id').dataset.manual = 'true';
	});
	for (const id of ['hosting-id', 'hosting-port'])
		byId(id).addEventListener('invalid', () => {
			byId('hosting-advanced').open = true;
		});
	byId('hosting-provider').addEventListener('change', providerFields);
	byId('hosting-connection').addEventListener('change', () => {
		discoveryEpoch++;
		byId('hosting-instance-list').replaceChildren();
		hostingStatus('');
		void discover();
	});
	for (const [button, importing] of [
		['hosting-install', false],
		['hosting-import', true]
	])
		byId(button).addEventListener('click', async () => {
			const connection = savedConnections.find(
				(item) => item.id === byId('hosting-connection').value
			);
			const info = await connectionOperation('Preparing setup', () =>
				state.api.hostingInfo(connection.id)
			);
			if (!info) return;
			state.installConnection = connection;
			state.instancesDirectory = info.instancesDirectory;
			state.installationReadiness = undefined;
			byId('open-hosting').hidden = true;
			byId('install-home').value = '';
			delete byId('install-home').dataset.suggestedHome;
			if (importing)
				byId('begin-instance-import').dispatchEvent(
					new CustomEvent('click', { detail: { remote: true } })
				);
			else showNewInstanceSetup();
		});
	byId('hosting-discover').addEventListener('click', () => void discover());
	byId('hosting-add-form').addEventListener('submit', async (event) => {
		event.preventDefault();
		const previous = savedConnections.find((item) => item.id === editingId);
		const saved = await connectionOperation('Saving connection', async () => {
			const value = {
				id: byId('hosting-id').value.trim(),
				label: byId('hosting-label').value.trim(),
				kind: byId('hosting-provider').value,
				host: byId('hosting-host').value.trim(),
				port: byId('hosting-port').value ? Number(byId('hosting-port').value) : undefined,
				roots: byId('hosting-roots')
					.value.split('\n')
					.map((value) => value.trim())
					.filter(Boolean),
				subscriptionId: byId('hosting-subscription').value.trim(),
				resourceGroup: byId('hosting-group').value.trim()
			};
			const saved = editingId
				? await state.api.hostingUpdateConnection(editingId, value)
				: await state.api.hostingSaveConnection(value);
			if (!saved) {
				hostingStatus('Change cancelled.');
				return;
			}
			const endpoint = (item) =>
				JSON.stringify([item.kind, item.host, item.port, item.subscriptionId, item.resourceGroup]);
			if (
				previous &&
				endpoint(previous) !== endpoint(saved) &&
				selectedConnectionId() === saved.id
			) {
				window.location.reload();
				return;
			}
			await loadConnections();
			byId('hosting-connection').value = saved.id;
			closeEditor();
			byId('hosting-instance-list').replaceChildren();
			hostingStatus('Connection saved. Check it to verify sign-in and discover instances.');
			return saved;
		});
		if (saved) {
			await checkConnection(saved);
			if (!byId('hosting-manager-status').classList.contains('danger-text')) {
				byId('hosting-manager').close();
				await showHostingChooser(saved.id);
			}
		}
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

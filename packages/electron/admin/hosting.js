import { state } from './state.js';
import { byId, message, setBusy, setOptions, setSkipTarget, setText } from './ui.js';
import {
	confirmInstanceSwitch,
	openInstance,
	renderInstancePicker,
	showNewInstanceSetup
} from './instances.js';
import { chooseManagedDirectory } from './directories.js';
import { openAdminSettings, closeAdminSettings } from './settings.js';

export function targetKey(target) {
	return target.kind === 'hosted'
		? JSON.stringify([target.ref.kind, target.ref.connectionId, targetLocation(target)])
		: target.homeDir;
}
export function targetLocation(target) {
	return target.kind === 'hosted' ? target.ref.remoteHome || target.ref.resourceId : target.homeDir;
}

let savedConnections = [];
let editingId;
let discoveryEpoch = 0;
function selectedConnectionId() {
	return state.currentSnapshot?.identity?.ref?.connectionId;
}
export async function loadHostingConnections() {
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
	const status = byId(state.adminSettingsOpen ? 'hosting-manager-status' : 'hosting-status');
	status.textContent = value;
	status.hidden = !value;
	status.className = `help-text${error ? ' danger-text' : ''}`;
	status.setAttribute('role', error ? 'alert' : 'status');
}
function clearInstanceOpenError() {
	setText('instance-preference-warning', '');
	byId('instance-preference-warning').hidden = true;
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
	clearInstanceOpenError();
	const id = byId('hosting-connection').value;
	const epoch = ++discoveryEpoch;
	byId('hosting-instance-list').replaceChildren();
	byId('hosting-discover').hidden = true;
	for (const id of ['hosting-install', 'hosting-import', 'hosting-open-folder']) {
		byId(id).hidden = false;
		byId(id).disabled = true;
	}
	byId('hosting-open-folder').hidden = id === 'local';
	byId('hosting-creation-help').hidden = true;
	byId('choose-instance').hidden = id !== 'local';
	let features;
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
		features = await state.api.hostingFeatures(id);
		if (epoch !== discoveryEpoch || id !== byId('hosting-connection').value) return;
		list.replaceChildren();
		hostingStatus(
			instances.length
				? ''
				: features.emptyHint || 'No instances found. Check this connection in Admin settings.'
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
			button.setAttribute('aria-label', `Open ${instance.name} at ${instance.location}`);
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
	if (epoch !== discoveryEpoch || id !== byId('hosting-connection').value) return;
	for (const button of ['hosting-install', 'hosting-import', 'hosting-open-folder']) {
		byId(button).disabled = !features?.installation;
		byId(button).title = features?.installation ? '' : 'Unavailable through this connection.';
	}
	byId('hosting-creation-help').hidden = !features || features.installation;
	byId('hosting-discover').hidden = !byId('hosting-status').classList.contains('danger-text');
}
export async function showHostingChooser(id) {
	if (state.operationInFlight) return;
	// Finish a status render before hiding the app: a late hosted snapshot must
	// not reopen it over the chooser. Browsing leaves the selected target intact.
	await state.snapshotPromise;
	if (state.operationInFlight) return;
	clearInstanceOpenError();
	for (const surface of [
		'app-shell',
		'loading-state',
		'error-state',
		'install-section',
		'instance-import-section'
	])
		byId(surface).hidden = true;
	byId('instance-welcome').hidden = false;
	byId('instance-options').hidden = true;
	byId('open-hosting').hidden = false;
	setSkipTarget('instance-welcome');
	byId('hosting-chooser-title').focus();
	try {
		await loadHostingConnections();
		if (id)
			byId('hosting-connection').value = savedConnections.some((item) => item.id === id)
				? id
				: 'local';
		await discover();
	} catch (error) {
		hostingStatus(message(error), true);
	}
}
function providerFields() {
	const kind = byId('hosting-provider').value;
	const ssh = kind === 'ssh-docker';
	const azure = kind === 'azure-container-apps';
	byId('hosting-ssh-fields').hidden = !ssh;
	byId('hosting-ssh-advanced').hidden = !ssh;
	byId('hosting-azure-fields').hidden = !azure;
	byId('hosting-host').required = ssh;
	byId('hosting-subscription').required = azure;
	byId('hosting-group').required = azure;
	byId('hosting-port').disabled = !ssh;
}
function savedChoice(id, value, placeholder) {
	setOptions(
		byId(id),
		[{ value: '', label: placeholder }, ...(value ? [{ value, label: value }] : [])],
		value || ''
	);
}
async function loadAzureChoices(field) {
	const id = field === 'subscriptionId' ? 'hosting-subscription' : 'hosting-group';
	const select = byId(id);
	const saved = select.value;
	const choices = await state.api.hostingSetup({
		provider: 'azure-container-apps',
		action: 'choices',
		field,
		values: { subscriptionId: byId('hosting-subscription').value }
	});
	if (!choices) return;
	const preserved =
		saved && !choices.some((item) => item.value === saved)
			? [{ value: saved, label: `${saved} · saved` }]
			: [];
	setOptions(
		select,
		[
			{
				value: '',
				label: field === 'subscriptionId' ? 'Choose a subscription' : 'Choose a resource group'
			},
			...choices,
			...preserved
		],
		saved
	);
}
function editConnection(connection) {
	if (state.operationInFlight) return;
	hostingStatus('');
	byId('hosting-check-details').replaceChildren();
	editingId = connection?.id;
	byId('hosting-add-form').reset();
	savedChoice('hosting-subscription', connection?.subscriptionId, 'Choose a subscription');
	savedChoice('hosting-group', connection?.resourceGroup, 'Choose a resource group');
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
		description.className = 'hosting-connection-description';
		const title = document.createElement('strong');
		title.textContent = connection.label;
		const location = document.createElement('p');
		location.className = 'help-text';
		location.textContent =
			connection.kind === 'ssh-docker'
				? `${connection.host}${connection.port ? `:${connection.port}` : ''} · SSH`
				: `${connection.resourceGroup} · Azure`;
		description.append(title, location);
		const buttons = document.createElement('div');
		buttons.className = 'button-row compact';
		for (const [label, action] of [
			[
				'Open instances',
				async () => {
					closeAdminSettings({ restore: false });
					await showHostingChooser(connection.id);
				}
			],
			['Edit', () => editConnection(connection)],
			['Check', () => checkConnection(connection)],
			['Remove', () => removeConnection(connection)]
		]) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = label === 'Open instances' ? 'secondary' : 'text-button';
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
		const checks = document.createElement('details');
		checks.className = 'connection-diagnostics';
		checks.open = !result.ok;
		const summary = document.createElement('summary');
		summary.textContent = 'Connection details';
		checks.append(summary);
		for (const check of result.checks) {
			const line = document.createElement('p');
			line.className = `help-text${check.ok ? '' : ' danger-text'}`;
			line.textContent = `${check.name}: ${check.detail}`;
			checks.append(line);
		}
		details.append(checks);
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
	await loadHostingConnections();
	state.recentInstances = state.recentInstances.filter(
		(item) => item.kind !== 'hosted' || item.ref.connectionId !== connection.id
	);
	if (state.currentSnapshot) renderInstancePicker(state.currentSnapshot);
	hostingStatus('Connection removed. Instances remain running.');
}
export async function manageHostingConnections() {
	if (state.operationInFlight) return;
	closeEditor();
	byId('hosting-check-details').replaceChildren();
	await openAdminSettings('connections');
}
export function bindHostingEvents() {
	byId('hosting-sign-in').addEventListener(
		'click',
		() =>
			void connectionOperation('Waiting for Azure sign-in in your browser', async () => {
				await state.api.hostingSetup({ provider: 'azure-container-apps', action: 'sign-in' });
				await loadAzureChoices('subscriptionId');
				hostingStatus('Signed in. Choose a subscription and resource group.');
			})
	);
	byId('hosting-load-scopes').addEventListener(
		'click',
		() =>
			void connectionOperation('Loading subscriptions', async () => {
				await loadAzureChoices('subscriptionId');
				if (byId('hosting-subscription').value) await loadAzureChoices('resourceGroup');
				hostingStatus('Choose a subscription and resource group.');
			})
	);
	byId('hosting-subscription').addEventListener('change', () => {
		savedChoice('hosting-group', '', 'Choose a resource group');
		if (byId('hosting-subscription').value)
			void connectionOperation('Loading resource groups', async () => {
				await loadAzureChoices('resourceGroup');
				hostingStatus('Choose a resource group.');
			});
	});
	byId('hosting-open-folder').addEventListener('click', async () => {
		if (state.operationInFlight) return;
		const connection = savedConnections.find(
			(item) => item.id === byId('hosting-connection').value
		);
		const previous = state.installConnection;
		state.installConnection = connection;
		try {
			const home = await chooseManagedDirectory('instance');
			if (home)
				await openInstance(
					connection.id === 'local'
						? { kind: 'local', homeDir: home }
						: {
								kind: 'hosted',
								ref: { kind: 'ssh-docker', connectionId: connection.id, remoteHome: home }
							}
				);
		} catch (error) {
			hostingStatus(message(error), true);
		} finally {
			state.installConnection = previous;
		}
	});
	byId('connect-host').addEventListener('click', () => void showHostingChooser());
	byId('open-hosting').addEventListener('hosting-refresh', () => {
		if (!byId('open-hosting').hidden) void showHostingChooser();
	});
	byId('hosting-back').addEventListener('click', () => {
		if (state.operationInFlight) return;
		discoveryEpoch++;
		byId('open-hosting').hidden = true;
		state.installConnection = undefined;
		state.installationReadiness = undefined;
		if (state.currentSnapshot) {
			byId('instance-welcome').hidden = true;
			byId('app-shell').hidden = false;
			setSkipTarget('main-content');
			byId('instance-picker').focus();
		} else {
			byId('instance-options').hidden = false;
			byId('connect-host').focus();
		}
	});
	byId('hosting-manage').addEventListener('click', () => void manageHostingConnections());
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
			if (state.operationInFlight || !confirmInstanceSwitch()) return;
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
			await loadHostingConnections();
			byId('hosting-connection').value = saved.id;
			closeEditor();
			byId('hosting-instance-list').replaceChildren();
			hostingStatus('Connection saved. Check it to verify sign-in and discover instances.');
			return saved;
		});
		if (saved) await checkConnection(saved);
	});
}

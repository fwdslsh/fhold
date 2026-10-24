import { state } from './state.js';
import { all, byId, message, setSkipTarget, setText } from './ui.js';
import { loadHostingConnections } from './hosting.js';

const appSurfaces = [
	'loading-state',
	'instance-welcome',
	'error-state',
	'install-section',
	'instance-import-section',
	'app-shell'
];
let returnFocus;
let returnScroll;
let previousSkip;
let preferencesDirty = false;
let updateAction = false;
let desktopAction = false;

function renderDesktop(status) {
	byId('admin-desktop-section').hidden = !status.supported;
	byId('admin-desktop-status').setAttribute('role', 'status');
	setText('admin-desktop-path', status.appImage);
	setText(
		'admin-desktop-status',
		status.replacesExistingCopy
			? `The menu copy may be newer. Replace it only if you want to use this running version (${status.version}).`
			: status.installed
				? status.runningInstalledCopy
					? 'Installed. Menu launches and automatic updates use this copy.'
					: 'Installed. Open Admin from the application menu next time.'
				: 'Adds the fhold icon and a launcher for your user account.'
	);
	setText(
		'admin-desktop-install',
		status.replacesExistingCopy
			? `Replace menu copy with ${status.version}`
			: status.installed
				? 'Refresh menu entry'
				: 'Add to application menu'
	);
}

export function settingsMessage(value, error = false) {
	const element = byId('admin-settings-message');
	element.textContent = value || '';
	element.hidden = !value;
	element.className = `help-text${error ? ' danger-text' : ''}`;
	element.setAttribute('role', error ? 'alert' : 'status');
}

export function renderAdminSettings(snapshot) {
	state.appSettingsSnapshot = snapshot;
	const { settings, update } = snapshot;
	if (!preferencesDirty) {
		byId('admin-update-channel').value = settings.updates.channel;
		byId('admin-update-automatic').checked = settings.updates.automatic;
	}
	setText('admin-app-version', `Version ${update.version}`);
	setText(
		'admin-update-channel-help',
		{
			stable: 'Stable releases only. Switching channels never downgrades Admin.',
			beta: 'Beta and stable releases. Preview builds may have unfinished features.',
			alpha: 'Alpha, beta and stable releases. For testing the newest experimental builds.'
		}[byId('admin-update-channel').value]
	);
	const busy = updateAction || ['checking', 'downloading', 'installing'].includes(update.phase);
	byId('admin-desktop-install').disabled =
		desktopAction || ['ready', 'installing'].includes(update.phase);
	byId('admin-desktop-update-notice').hidden = !['ready', 'installing'].includes(update.phase);
	for (const id of ['admin-update-channel', 'admin-update-automatic', 'admin-updates-save'])
		byId(id).disabled = busy;
	byId('admin-update-check').disabled = busy || !update.supported || update.phase === 'ready';
	byId('admin-update-download').hidden = update.phase !== 'available';
	byId('admin-update-download').disabled = busy;
	byId('admin-update-install').hidden = update.phase !== 'ready';
	byId('admin-update-install').disabled = busy || desktopAction;
	const status = byId('admin-update-status');
	status.textContent =
		update.error ||
		update.unavailableReason ||
		{
			idle: update.checkedAt
				? `No newer update found on the ${settings.updates.channel} channel.`
				: 'Updates have not been checked yet.',
			checking: `Checking the ${settings.updates.channel} channel…`,
			available: `Admin ${update.availableVersion} is available.`,
			downloading: `Downloading Admin ${update.availableVersion}…`,
			ready: `Admin ${update.availableVersion} is ready. It will install when Admin closes.`,
			installing: 'Restarting Admin to install its update…'
		}[update.phase];
	status.className = `help-text${update.error ? ' danger-text' : ''}`;
	status.setAttribute('role', update.error ? 'alert' : 'status');
	const progress = byId('admin-update-progress');
	progress.hidden = update.phase !== 'downloading';
	if (update.progress === undefined) progress.removeAttribute('value');
	else progress.value = update.progress;
	for (const badge of all('[data-admin-update-badge]')) badge.hidden = update.phase !== 'ready';
	if (snapshot.settingsError) settingsMessage(snapshot.settingsError, true);
}

export async function openAdminSettings(section) {
	if (state.operationInFlight) return;
	if (!state.adminSettingsOpen) {
		returnFocus = document.activeElement;
		returnScroll = { left: window.scrollX, top: window.scrollY };
		previousSkip = byId('skip-link').getAttribute('href');
	}
	state.adminSettingsOpen = true;
	document.body.dataset.adminSettings = 'true';
	byId('admin-settings').hidden = false;
	for (const id of appSurfaces) byId(id).inert = true;
	setSkipTarget('admin-settings');
	byId('admin-settings-title').focus();
	settingsMessage('');
	try {
		const [snapshot, desktop] = await Promise.all([
			state.api.appSettings(),
			state.api.desktopStatus(),
			loadHostingConnections()
		]);
		renderAdminSettings(snapshot);
		renderDesktop(desktop);
		if (section === 'connections') byId('hosting-manager').scrollIntoView({ block: 'start' });
	} catch (error) {
		settingsMessage(message(error), true);
	}
}

export function closeAdminSettings(options = {}) {
	if (state.operationInFlight) return;
	state.adminSettingsOpen = false;
	delete document.body.dataset.adminSettings;
	byId('admin-settings').hidden = true;
	for (const id of appSurfaces) byId(id).inert = false;
	if (previousSkip) byId('skip-link').setAttribute('href', previousSkip);
	if (options.restore !== false) {
		returnFocus?.focus();
		if (returnScroll) window.scrollTo?.(returnScroll);
		byId('open-hosting').dispatchEvent(new Event('hosting-refresh'));
	}
}

async function updateOperation(action) {
	if (updateAction) return;
	updateAction = true;
	settingsMessage('');
	if (state.appSettingsSnapshot) renderAdminSettings(state.appSettingsSnapshot);
	try {
		const result = await action();
		if (result) renderAdminSettings(result);
	} catch (error) {
		settingsMessage(message(error), true);
	} finally {
		updateAction = false;
		if (state.appSettingsSnapshot) renderAdminSettings(state.appSettingsSnapshot);
	}
}

export function bindAdminSettingsEvents() {
	byId('admin-desktop-install').addEventListener('click', async () => {
		if (desktopAction) return;
		desktopAction = true;
		byId('admin-desktop-install').disabled = true;
		setText('admin-desktop-status', 'Installing the menu entry and application copy…');
		try {
			renderDesktop(await state.api.installDesktop());
		} catch (error) {
			byId('admin-desktop-status').setAttribute('role', 'alert');
			setText('admin-desktop-status', message(error));
		} finally {
			desktopAction = false;
			if (state.appSettingsSnapshot) renderAdminSettings(state.appSettingsSnapshot);
		}
	});
	for (const button of all('[data-admin-settings]'))
		button.addEventListener('click', () => void openAdminSettings());
	byId('admin-settings-back').addEventListener('click', closeAdminSettings);
	byId('admin-updates-form').addEventListener('input', () => {
		preferencesDirty = true;
	});
	byId('admin-update-channel').addEventListener('change', () => {
		preferencesDirty = true;
		if (state.appSettingsSnapshot) renderAdminSettings(state.appSettingsSnapshot);
	});
	byId('admin-updates-form').addEventListener('submit', (event) => {
		event.preventDefault();
		void updateOperation(async () => {
			const snapshot = await state.api.saveAppSettings({
				updates: {
					channel: byId('admin-update-channel').value,
					automatic: byId('admin-update-automatic').checked
				}
			});
			preferencesDirty = false;
			settingsMessage('Admin preferences saved.');
			return snapshot;
		});
	});
	byId('admin-update-check').addEventListener(
		'click',
		() => void updateOperation(() => state.api.checkAppUpdate())
	);
	byId('admin-update-download').addEventListener(
		'click',
		() => void updateOperation(() => state.api.downloadAppUpdate())
	);
	byId('admin-update-install').addEventListener(
		'click',
		() => void updateOperation(() => state.api.installAppUpdate())
	);
	state.api.onAppUpdate?.(renderAdminSettings);
	void state.api
		.appSettings?.()
		.then(renderAdminSettings)
		.catch((error) => settingsMessage(message(error), true));
}

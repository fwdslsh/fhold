import { refresh } from './snapshot.js';
import { state } from './state.js';
import { all, byId, message, notice, setBusy, setOptions, setSkipTarget, setText } from './ui.js';

export function renderInstancePicker(snapshot) {
	const others = state.recentInstances.filter((target) => target.homeDir !== snapshot.homeDir);
	setOptions(
		byId('instance-picker'),
		[
			{
				value: snapshot.homeDir,
				label: snapshot.config.deployment?.projectName || 'Selected instance'
			},
			...others.map((target) => ({
				value: target.homeDir,
				label: target.name || target.homeDir.split('/').filter(Boolean).at(-1) || 'Saved instance'
			})),
			{ value: 'open-another', label: 'Open another instance…' }
		],
		snapshot.homeDir
	);
	byId('instance-picker').disabled = state.operationInFlight;
}

function confirmInstanceSwitch() {
	return (
		!(state.dirtyForms.size || state.activeOAuth) ||
		window.confirm(
			'Switch instances? Unsaved changes and unfinished sign-in steps will be discarded. Running stacks will not be stopped.'
		)
	);
}

function suggestInstanceHome() {
	if (!state.instancesDirectory) return;
	const name = byId('new-instance-name').value.trim();
	if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) return;
	const field = byId('new-instance-home');
	const suggested = `${state.instancesDirectory}/${name}`;
	if (!field.value || field.value === field.dataset.suggestedHome) field.value = suggested;
	field.dataset.suggestedHome = suggested;
}

export function renderWelcome(welcome) {
	state.instancesDirectory = welcome.instancesDirectory || '';
	suggestInstanceHome();
	byId('loading-state').hidden = true;
	byId('error-state').hidden = true;
	byId('install-section').hidden = true;
	byId('app-shell').hidden = true;
	byId('instance-welcome').hidden = false;
	document.body.dataset.phase = 'welcome';
	setSkipTarget('instance-welcome');
	const previous = welcome.recentInstances[0];
	const primary = previous || welcome.defaultInstance;
	setText('open-recent-instance', previous ? 'Open previous instance' : 'Open default instance');
	setText('primary-instance-path', primary.homeDir);
	byId('open-recent-instance').onclick = () => void openInstance(primary);
	byId('default-instance-option').hidden = primary.homeDir === welcome.defaultInstance.homeDir;
	setText('default-instance-path', welcome.defaultInstance.homeDir);
	byId('open-default-instance').onclick = () => void openInstance(welcome.defaultInstance);
	const recent = byId('recent-instances');
	recent.replaceChildren();
	const others = welcome.recentInstances.filter(
		(item) => item.homeDir !== primary.homeDir && item.homeDir !== welcome.defaultInstance.homeDir
	);
	byId('recent-instances-section').hidden = !others.length;
	for (const target of others) {
		const row = document.createElement('div');
		row.className = 'instance-row';
		const path = document.createElement('span');
		path.className = 'instance-path';
		path.textContent = target.homeDir;
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'secondary';
		button.textContent = 'Open';
		button.setAttribute('aria-label', `Open ${target.homeDir}`);
		button.addEventListener('click', () => void openInstance(target));
		row.append(path, button);
		recent.append(row);
	}
	setText('instance-preference-warning', welcome.preferenceError || '');
	byId('instance-preference-warning').hidden = !welcome.preferenceError;
}

export async function openInstance(target, create = false) {
	if (state.operationInFlight || !confirmInstanceSwitch()) return;
	setBusy(true);
	try {
		await state.snapshotPromise;
		await state.providerLoadPromise?.catch(() => {});
		if (create) await state.api.prepareNewInstance(target);
		else await state.api.openInstance(target);
		// Reload all renderer modules: no forms, keys, OAuth or restore previews
		// from the previously managed instance survive a switch.
		window.location.reload();
	} catch (error) {
		notice(message(error), 'error', { persist: true });
	} finally {
		setBusy(false);
	}
}

export async function showInstances() {
	if (state.operationInFlight || !confirmInstanceSwitch()) return;
	setBusy(true);
	try {
		await state.snapshotPromise;
		// Finish the tracked background account lookup before changing its target.
		await state.providerLoadPromise?.catch(() => {});
		await state.api.closeInstance();
		window.location.reload();
	} catch (error) {
		notice(message(error), 'error', { persist: true });
	} finally {
		setBusy(false);
	}
}

export function bindInstanceEvents() {
	byId('instance-picker').addEventListener('change', async () => {
		const requested = byId('instance-picker').value;
		byId('instance-picker').value = state.currentSnapshot?.homeDir || '';
		if (requested === 'open-another') await showInstances();
		else {
			const target = state.recentInstances.find((item) => item.homeDir === requested);
			if (target && target.homeDir !== state.currentSnapshot?.homeDir) await openInstance(target);
		}
	});
	byId('new-instance-name').addEventListener('input', suggestInstanceHome);
	byId('choose-instance').addEventListener('click', async () => {
		if (state.operationInFlight) return;
		const directory = await state.api.chooseDirectory({ purpose: 'instance' }).catch((error) => {
			notice(message(error), 'error', { persist: true });
		});
		if (directory) await openInstance({ kind: 'local', homeDir: directory });
	});
	byId('new-instance-browse').addEventListener('click', async () => {
		if (state.operationInFlight) return;
		setBusy(true);
		try {
			const directory = await state.api.chooseDirectory({ purpose: 'new-instance' });
			if (directory) byId('new-instance-home').value = directory;
		} catch (error) {
			notice(message(error), 'error', { persist: true });
		} finally {
			setBusy(false);
		}
	});
	byId('new-instance-form').addEventListener('submit', async (event) => {
		event.preventDefault();
		await openInstance(
			{
				kind: 'local',
				homeDir: byId('new-instance-home').value.trim(),
				name: byId('new-instance-name').value.trim()
			},
			true
		);
	});
	for (const button of all('[data-instance-switch]'))
		button.addEventListener('click', () => void showInstances());
}

export async function initializeAdmin() {
	try {
		const welcome = await state.api.welcome();
		state.recentInstances = welcome.recentInstances;
		if (welcome.selectedInstance) await refresh();
		else renderWelcome(welcome);
	} catch (error) {
		byId('loading-state').hidden = true;
		notice(`Could not load instances: ${message(error)}`, 'error', { persist: true });
	}
}

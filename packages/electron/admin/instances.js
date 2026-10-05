import { refresh } from './snapshot.js';
import { state } from './state.js';
import { all, byId, message, notice, setBusy, setOptions, setSkipTarget, setText } from './ui.js';

function instanceName(target) {
	return target.name || target.homeDir.split(/[\\/]/).filter(Boolean).at(-1) || 'Saved instance';
}

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
				label: instanceName(target)
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
	const name = byId('install-instance-name').value.trim();
	const field = byId('install-home');
	if (state.instancesDirectory && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
		const suggested = `${state.instancesDirectory}/${name}`;
		if (!field.value || field.value === field.dataset.suggestedHome) field.value = suggested;
		field.dataset.suggestedHome = suggested;
	}
}

export function renderInstallationReadiness(readiness) {
	state.installationReadiness = readiness;
	const ready = readiness?.ok === true;
	setText('install-prerequisite', ready
		? 'Docker and Compose are ready.'
		: readiness?.message || 'Checking Docker and Compose…');
	byId('install-prerequisite').className = `prerequisite${readiness ? ready ? ' ready' : ' error' : ''}`;
	byId('install').disabled = state.operationInFlight || !ready;
	byId('check-prerequisites').hidden = !readiness || ready;
}

export async function checkInstallationReadiness() {
	if (state.setupCheckPromise) return state.setupCheckPromise;
	renderInstallationReadiness(undefined);
	state.setupCheckPromise = (async () => {
		try {
			renderInstallationReadiness(await state.api.installationReadiness());
		} catch (error) {
			renderInstallationReadiness({ ok: false, message: message(error) });
		} finally {
			state.setupCheckPromise = undefined;
		}
	})();
	return state.setupCheckPromise;
}

function showNewInstanceSetup() {
	if (state.operationInFlight) return;
	suggestInstanceHome();
	byId('instance-welcome').hidden = true;
	byId('install-section').hidden = false;
	document.body.dataset.phase = 'not_installed';
	setSkipTarget('install-section');
	byId('install-instance-name').focus();
	if (state.installationReadiness?.ok) renderInstallationReadiness(state.installationReadiness);
	else void checkInstallationReadiness();
}

export async function prepareInstallTarget({ importing = false } = {}) {
	try {
		await state.api.prepareNewInstance({
			kind: 'local',
			homeDir: byId('install-home').value.trim(),
			...(importing ? {} : { name: byId('install-instance-name').value.trim() })
		});
	} catch (error) {
		byId('install-advanced').open = true;
		byId('install-home').focus();
		throw error;
	}
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
	const targets = [...welcome.recentInstances];
	if (welcome.defaultInstance.available && !targets.some((target) => target.homeDir === welcome.defaultInstance.homeDir))
		targets.push(welcome.defaultInstance);
	const existingSection = byId('existing-instance-section');
	const begin = byId('begin-new-instance');
	const hasAvailable = targets.some((target) => target.available);
	// DOM and visual order agree: first-time setup first, saved instances first
	// when there is an actual compatible home to open. No automatic selection.
	byId('instance-options').append(...(hasAvailable
		? [existingSection, begin] : [begin, existingSection]));
	begin.className = hasAvailable ? 'secondary' : 'primary';
	byId('instance-options').hidden = false;
	const recent = byId('recent-instances');
	recent.replaceChildren();
	byId('recent-instances-section').hidden = !targets.length;
	setText('recent-instances-title', welcome.recentInstances.length ? 'Recent instances' : 'On this computer');
	for (const target of targets) {
		const row = document.createElement('button');
		row.type = 'button';
		row.className = 'instance-choice';
		row.dataset.homeDir = target.homeDir;
		row.disabled = !target.available;
		const name = document.createElement('span');
		name.className = 'instance-name';
		name.textContent = instanceName(target);
		row.append(name);
		if (!target.available || target.homeDir === welcome.recentInstances[0]?.homeDir) {
			const meta = document.createElement('span');
			meta.className = 'instance-meta';
			meta.textContent = target.available ? 'Last used' : 'Unavailable';
			row.append(meta);
		}
		const path = document.createElement('span');
		path.className = 'instance-path';
		path.textContent = target.homeDir;
		row.setAttribute('aria-label', `${target.available ? 'Open' : 'Unavailable:'} ${instanceName(target)} at ${target.homeDir}`);
		row.addEventListener('click', () => { if (target.available) void openInstance(target); });
		row.append(path);
		recent.append(row);
	}
	setText('instance-preference-warning', welcome.preferenceError || '');
	byId('instance-preference-warning').hidden = !welcome.preferenceError;
}

export async function openInstance(target) {
	if (state.operationInFlight || !confirmInstanceSwitch()) return;
	setBusy(true);
	try {
		await state.snapshotPromise;
		await state.providerLoadPromise?.catch(() => {});
		await state.api.openInstance(target);
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
	byId('begin-new-instance').addEventListener('click', showNewInstanceSetup);
	byId('instance-picker').addEventListener('change', async () => {
		const requested = byId('instance-picker').value;
		byId('instance-picker').value = state.currentSnapshot?.homeDir || '';
		if (requested === 'open-another') await showInstances();
		else {
			const target = state.recentInstances.find((item) => item.homeDir === requested);
			if (target && target.homeDir !== state.currentSnapshot?.homeDir) await openInstance(target);
		}
	});
	byId('install-instance-name').addEventListener('input', suggestInstanceHome);
	byId('install-home').addEventListener('input', suggestInstanceHome);
	for (const field of all('#install-advanced input'))
		field.addEventListener('invalid', () => { byId('install-advanced').open = true; });
	byId('choose-instance').addEventListener('click', async () => {
		if (state.operationInFlight) return;
		let directory;
		setBusy(true);
		try {
			directory = await state.api.chooseDirectory({ purpose: 'instance' });
		} catch (error) {
			notice(message(error), 'error', { persist: true });
		} finally {
			setBusy(false);
		}
		if (directory) await openInstance({ kind: 'local', homeDir: directory });
	});
	byId('install-browse').addEventListener('click', async () => {
		if (state.operationInFlight) return;
		setBusy(true);
		try {
			const directory = await state.api.chooseDirectory({ purpose: 'new-instance' });
			if (directory) {
				byId('install-home').value = directory;
				suggestInstanceHome();
			}
		} catch (error) {
			notice(message(error), 'error', { persist: true });
		} finally {
			setBusy(false);
		}
	});
	for (const button of all('[data-instance-switch]'))
		button.addEventListener('click', () => void showInstances());
}

export async function initializeAdmin() {
	try {
		const welcome = await state.api.welcome();
		state.recentInstances = welcome.recentInstances;
		state.instancesDirectory = welcome.instancesDirectory || '';
		if (welcome.selectedInstance) await refresh();
		else {
			renderWelcome(welcome);
			void checkInstallationReadiness();
		}
	} catch (error) {
		byId('loading-state').hidden = true;
		notice(`Could not load instances: ${message(error)}`, 'error', { persist: true });
	}
}

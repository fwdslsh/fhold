import { refresh } from './snapshot.js';
import { state } from './state.js';
import { all, byId, message, notice, setBusy, setOptions, setSkipTarget, setText } from './ui.js';
import { showHostingChooser, targetKey, targetLocation } from './hosting.js';
import { chooseManagedDirectory } from './directories.js';
import { resetProviderState } from './providers.js';

function instanceName(target) {
	const parts = targetLocation(target)?.split(/[\\/]/).filter(Boolean) || [];
	const fallback =
		target.kind === 'hosted' && parts.at(-1) === 'home' ? parts.at(-2) : parts.at(-1);
	const name = target.name || fallback || 'Saved instance';
	return target.kind === 'hosted' ? `${name} · ${target.ref.connectionId}` : name;
}

export function renderInstancePicker(snapshot) {
	const selected =
		snapshot.phase === 'remote'
			? targetKey({ kind: 'hosted', ref: snapshot.hosting.ref })
			: snapshot.target
				? targetKey({ kind: 'hosted', ref: snapshot.target })
				: snapshot.homeDir;
	const others = state.recentInstances.filter((target) => targetKey(target) !== selected);
	setOptions(
		byId('instance-picker'),
		[
			{
				value: selected,
				label:
					snapshot.phase === 'remote'
						? instanceName({
								kind: 'hosted',
								ref: snapshot.hosting.ref,
								name: snapshot.hosting.name
							})
						: snapshot.target
							? `${snapshot.config.deployment.projectName} · ${snapshot.connectionLabel}`
							: snapshot.config.deployment?.projectName || 'Selected instance'
			},
			...others.map((target) => ({
				value: targetKey(target),
				label: instanceName(target)
			})),
			{ value: 'open-another', label: 'Open another instance…' }
		],
		selected
	);
	byId('instance-picker').disabled = state.operationInFlight;
}

export function confirmInstanceSwitch() {
	return (
		!(state.dirtyForms.size || state.activeOAuth) ||
		window.confirm(
			'Switch instances? Unsaved changes and unfinished sign-in steps will be discarded. Running stacks will not be stopped.'
		)
	);
}

function showInstanceError(error) {
	notice(message(error), 'error', { persist: true });
	if (!byId('instance-welcome').hidden) {
		setText('instance-preference-warning', message(error));
		byId('instance-preference-warning').hidden = false;
		byId('instance-preference-warning').setAttribute('role', 'alert');
	}
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
	for (const location of all('[data-setup-location]')) {
		location.hidden = !state.installConnection || state.installConnection.id === 'local';
		location.textContent = `On ${state.installConnection?.label || 'this computer'}`;
	}
	const ready = readiness?.ok === true;
	const failed = readiness?.ok === false;
	for (const requirements of all('[data-install-requirements]')) {
		requirements.hidden = ready;
		requirements.className = `install-requirements${failed ? ' warning' : ''}`;
		requirements.setAttribute('role', failed ? 'alert' : 'status');
		requirements.querySelector('[data-requirement-title]').hidden = !failed;
		requirements.querySelector('[data-requirement-guidance]').hidden = !failed;
		requirements.querySelector('[data-requirement-message]').textContent = ready
			? ''
			: readiness?.message || 'Checking installation requirements…';
		requirements.querySelector('[data-check-prerequisites]').hidden = !readiness || ready;
	}
	byId('install').disabled = state.operationInFlight || !ready;
	byId('preview-instance-restore').disabled = state.operationInFlight || !ready;
	byId('apply-instance-restore').disabled =
		state.operationInFlight || !ready || !state.instanceRestorePreview;
}

export async function checkInstallationReadiness() {
	if (state.setupCheckPromise) return state.setupCheckPromise;
	renderInstallationReadiness(undefined);
	state.setupCheckPromise = (async () => {
		try {
			renderInstallationReadiness(
				await state.api.installationReadiness(state.installConnection?.id)
			);
		} catch (error) {
			renderInstallationReadiness({ ok: false, message: message(error) });
		} finally {
			state.setupCheckPromise = undefined;
		}
	})();
	return state.setupCheckPromise;
}

export function showNewInstanceSetup() {
	if (state.operationInFlight) return;
	state.currentSnapshot = null;
	state.currentConfig = null;
	resetProviderState();
	suggestInstanceHome();
	byId('instance-welcome').hidden = true;
	byId('instance-import-section').hidden = true;
	byId('install-section').hidden = false;
	document.body.dataset.phase = 'not_installed';
	setSkipTarget('install-section');
	notice('');
	byId('install-instance-name').focus();
	if (state.installationReadiness?.ok) renderInstallationReadiness(state.installationReadiness);
	else void checkInstallationReadiness();
}

export async function prepareInstallTarget() {
	try {
		const homeDir = byId('install-home').value.trim();
		await state.api.prepareNewInstance(
			state.installConnection?.kind === 'ssh-docker'
				? {
						kind: 'hosted',
						ref: {
							kind: 'ssh-docker',
							connectionId: state.installConnection.id,
							remoteHome: homeDir
						},
						name: byId('install-instance-name').value.trim()
					}
				: { kind: 'local', homeDir, name: byId('install-instance-name').value.trim() }
		);
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
	byId('instance-import-section').hidden = true;
	byId('app-shell').hidden = true;
	byId('instance-welcome').hidden = false;
	document.body.dataset.phase = 'welcome';
	setSkipTarget('instance-welcome');
	const targets = [...welcome.recentInstances];
	if (
		welcome.defaultInstance.available &&
		!targets.some((target) => targetKey(target) === targetKey(welcome.defaultInstance))
	)
		targets.push(welcome.defaultInstance);
	const existingSection = byId('existing-instance-section');
	const begin = byId('begin-new-instance');
	const createActions = byId('instance-create-actions');
	const open = byId('connect-host');
	const hasAvailable = targets.some((target) => target.available);
	// DOM and visual order agree: first-time setup first, saved instances first
	// when there is an actual compatible home to open. No automatic selection.
	byId('instance-options').append(
		...(hasAvailable
			? [existingSection, open, createActions]
			: [createActions, open, existingSection])
	);
	begin.className = hasAvailable ? 'secondary' : 'primary';
	byId('instance-options').hidden = false;
	byId('open-hosting').hidden = true;
	const recent = byId('recent-instances');
	recent.replaceChildren();
	byId('recent-instances-section').hidden = !targets.length;
	setText(
		'recent-instances-title',
		welcome.recentInstances.length ? 'Recent instances' : 'On this computer'
	);
	for (const target of targets) {
		const row = document.createElement('button');
		row.type = 'button';
		row.className = 'instance-choice';
		row.dataset.homeDir = targetLocation(target);
		row.disabled = !target.available;
		const name = document.createElement('span');
		name.className = 'instance-name';
		name.textContent = instanceName(target);
		row.append(name);
		if (
			!target.available ||
			(welcome.recentInstances[0] && targetKey(target) === targetKey(welcome.recentInstances[0]))
		) {
			const meta = document.createElement('span');
			meta.className = 'instance-meta';
			meta.textContent = target.available ? 'Last used' : 'Unavailable';
			row.append(meta);
		}
		const path = document.createElement('span');
		path.className = 'instance-path';
		path.textContent = targetLocation(target);
		row.setAttribute(
			'aria-label',
			`${target.available ? 'Open' : 'Unavailable:'} ${instanceName(target)} at ${targetLocation(target)}`
		);
		row.addEventListener('click', () => {
			if (target.available) void openInstance(target);
		});
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
		showInstanceError(error);
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
	byId('begin-new-instance').addEventListener('click', () => {
		state.installConnection = undefined;
		state.installationReadiness = undefined;
		showNewInstanceSetup();
	});
	byId('instance-picker').addEventListener('change', async () => {
		const requested = byId('instance-picker').value;
		const current = state.currentSnapshot;
		const selected =
			current?.phase === 'remote'
				? targetKey({ kind: 'hosted', ref: current.hosting.ref })
				: current?.target
					? targetKey({ kind: 'hosted', ref: current.target })
					: current?.homeDir || '';
		byId('instance-picker').value = selected;
		if (requested === 'open-another')
			await showHostingChooser(
				current?.target?.connectionId || current?.hosting?.ref?.connectionId
			);
		else {
			const target = state.recentInstances.find((item) => targetKey(item) === requested);
			if (target && targetKey(target) !== selected) await openInstance(target);
		}
	});
	byId('install-instance-name').addEventListener('input', suggestInstanceHome);
	byId('install-home').addEventListener('input', suggestInstanceHome);
	for (const field of all('#install-advanced input'))
		field.addEventListener('invalid', () => {
			byId('install-advanced').open = true;
		});
	byId('choose-instance').addEventListener('click', async () => {
		if (state.operationInFlight) return;
		let directory;
		setBusy(true);
		try {
			directory = await state.api.chooseDirectory({ purpose: 'instance' });
		} catch (error) {
			showInstanceError(error);
		} finally {
			setBusy(false);
		}
		if (directory) await openInstance({ kind: 'local', homeDir: directory });
	});
	byId('install-browse').addEventListener('click', async () => {
		if (state.operationInFlight) return;
		setBusy(true);
		try {
			const directory = await chooseManagedDirectory('new-instance');
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

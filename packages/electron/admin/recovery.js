import { chooseDirectory } from './backup.js';
import { offerRestart } from './restart.js';
import { render } from './snapshot.js';
import { state } from './state.js';
import { byId, message, notice, operation, setBusy, setFormClean } from './ui.js';

const lists = {
	paths: 'paths',
	sqlite: 'sqlite',
	excludePaths: 'exclusions',
	externalMounts: 'external',
	recoverMounts: 'recover-mounts'
};
const id = (suffix) => `runtime-recovery-${suffix}`;
const lines = (suffix) =>
	byId(id(suffix))
		.value.split(/\r?\n/)
		.map((value) => value.trim())
		.filter(Boolean);

export function updateRecoveryFields() {
	const enabled = byId(id('enabled')).checked;
	const blob = byId(id('storage')).value === 'blob';
	const identity = byId(id('auth')).value === 'managed-identity';
	byId(id('settings')).hidden = !enabled;
	byId(id('directory-field')).hidden = blob;
	byId(id('directory-help')).hidden = blob;
	byId(id('blob-field')).hidden = !blob;
	byId(id('blob-auth')).hidden = !blob;
	byId(id('client-id-field')).hidden = !identity;
	byId(id('credential-form')).hidden = !enabled || !blob || identity;
	const saved = state.currentSnapshot?.config?.recovery?.enabled;
	const running = state.currentSnapshot?.services?.some(
		(service) => !['exited', 'dead'].includes(service.state)
	);
	byId('initialize-recovery').disabled = !saved || running || state.operationInFlight;
	byId('restore-runtime-recovery').disabled = !saved || running || state.operationInFlight;
	byId('inspect-recovery').disabled = !saved || state.operationInFlight;
	byId('check-recovery-status').disabled = !saved || state.operationInFlight;
}

export function renderRecovery(snapshot) {
	const recovery = snapshot.recovery;
	const settings = recovery?.settings || snapshot.config.recovery;
	if (!settings) return;
	byId(id('enabled')).checked = settings.enabled;
	byId(id('storage')).value = settings.destination.startsWith('azblob:') ? 'blob' : 'directory';
	byId(id('directory')).value = settings.destination.startsWith('file:')
		? decodeURIComponent(new URL(settings.destination).pathname)
		: '';
	byId(id('blob')).value = settings.destination.startsWith('azblob:') ? settings.destination : '';
	byId(id('auth')).value = settings.authentication;
	byId(id('client-id')).value = settings.clientId;
	for (const [suffix, value] of [
		['instance-id', settings.instanceId],
		['interval', settings.intervalSeconds],
		['max-unsaved', settings.maxUnsavedSeconds],
		['timeout', settings.operationTimeoutSeconds]
	])
		byId(id(suffix)).value = String(value);
	for (const [key, suffix] of Object.entries(lists))
		byId(id(suffix)).value = (recovery?.selection[key] || []).join('\n');
	byId(id('auto-network')).checked = recovery?.selection.autoExcludeNetworkMounts === true;
	byId(id('credential-status')).textContent = recovery?.credentialConfigured
		? 'A private connection string is saved. Its value is not shown.'
		: 'No connection string saved. Add one below, or select a deployment identity.';
	byId(id('policy-path')).textContent = recovery?.policyPath || 'config/recovery/include.json';
	byId('save-recovery-settings').disabled = !!snapshot.recoveryError;
	renderRecoveryStatus({
		state: settings.enabled ? 'configured' : 'disabled',
		failure: snapshot.recoveryError
	});
	updateRecoveryFields();
}

export function recoveryInput() {
	const previous = state.currentSnapshot.recovery;
	const settings = { ...previous.settings, enabled: byId(id('enabled')).checked };
	const directory = byId(id('directory')).value.trim();
	settings.destination =
		byId(id('storage')).value === 'blob'
			? byId(id('blob')).value.trim()
			: directory
				? `file://${encodeURI(directory).replaceAll('#', '%23').replaceAll('?', '%3F')}`
				: '';
	settings.instanceId = byId(id('instance-id')).value.trim();
	settings.intervalSeconds = Number(byId(id('interval')).value);
	settings.maxUnsavedSeconds = Number(byId(id('max-unsaved')).value);
	settings.operationTimeoutSeconds = Number(byId(id('timeout')).value);
	settings.authentication = byId(id('auth')).value;
	settings.clientId = byId(id('client-id')).value.trim();
	const selection = Object.fromEntries(
		Object.entries(lists).map(([key, suffix]) => [key, lines(suffix)])
	);
	selection.autoExcludeNetworkMounts = byId(id('auto-network')).checked;
	const versioned =
		previous.selection.version === 1 ||
		selection.autoExcludeNetworkMounts ||
		['excludePaths', 'externalMounts', 'recoverMounts'].some((key) => selection[key].length);
	if (versioned) selection.version = 1;
	else
		for (const key of [
			'excludePaths',
			'externalMounts',
			'recoverMounts',
			'autoExcludeNetworkMounts'
		])
			delete selection[key];
	return { action: 'save', settings, selection, baselineDigest: previous.digest };
}

export function renderRecoveryStatus(status) {
	const panel = byId(id('status'));
	panel.replaceChildren();
	const title = document.createElement('strong');
	const detail = document.createElement('span');
	if (status.state === 'disabled') {
		title.textContent = 'Ephemeral container support is off.';
		detail.textContent = 'Local persistence is unchanged. Import / export remains available above.';
	} else if (status.state === 'ready') {
		title.textContent = 'Checkpoint accepted.';
		detail.textContent = `Last publication: ${new Date(status.lastPublishedAt).toLocaleString()}. This is same-instance recovery, not a portable archive.`;
	} else {
		title.textContent =
			status.state === 'stopped'
				? 'Instance is stopped.'
				: status.state === 'not-ready'
					? 'Recovery needs attention.'
					: 'Recovery configured; checkpoint not checked.';
		detail.textContent =
			status.failure ||
			status.detail ||
			(status.state === 'stopped'
				? 'Initialize only a new namespace, or validate an existing one, then start the instance.'
				: 'Save does not create a checkpoint. Apply settings and check the running recovery worker.');
	}
	panel.append(title, detail);
	panel.className = `inline-status ${status.state === 'ready' ? 'success' : status.failure ? 'error' : 'neutral'}`;
}

export function bindRecoveryEvents() {
	for (const suffix of ['enabled', 'storage', 'auth'])
		byId(id(suffix)).addEventListener('change', updateRecoveryFields);
	byId('choose-recovery-directory').addEventListener(
		'click',
		() => void chooseDirectory('recovery', id('directory'))
	);
	byId(id('form')).addEventListener('submit', async (event) => {
		event.preventDefault();
		const previous = state.currentSnapshot.recovery.settings;
		const saved = await operation(
			'Saving checkpoint settings',
			async () => {
				const result = await state.api.recovery(recoveryInput());
				setFormClean(id('form'));
				render(result);
				return result;
			},
			'Checkpoint settings saved. Existing checkpoints and containers were not changed.'
		);
		if (saved) {
			const next = saved.config.recovery;
			const newNamespace =
				next.enabled &&
				(!previous.enabled ||
					previous.destination !== next.destination ||
					previous.instanceId !== next.instanceId);
			if (newNamespace)
				renderRecoveryStatus({
					state: 'configured',
					detail:
						'Recovery destination selected. If it is unused, stop this instance, initialize once, then start. If it already has checkpoints, start to resume—never initialize again.'
				});
			else await offerRestart(saved);
		}
		updateRecoveryFields();
	});
	byId(id('credential-form')).addEventListener('submit', async (event) => {
		event.preventDefault();
		const secret = byId(id('connection-string'));
		const connectionString = secret.value;
		secret.value = '';
		const saved = await operation(
			'Saving private storage credential',
			() => state.api.recovery({ action: 'credential', connectionString }),
			'Private storage credential saved.'
		);
		if (saved) await offerRestart(saved);
		updateRecoveryFields();
	});
	for (const [control, action] of [
		['check-recovery-status', 'status'],
		['inspect-recovery', 'inspect'],
		['initialize-recovery', 'init'],
		['restore-runtime-recovery', 'restore']
	]) {
		byId(control).addEventListener('click', async () => {
			if (state.operationInFlight) return;
			let confirmed = false;
			if (action === 'init' || action === 'restore') {
				setBusy(true);
				try {
					confirmed = await state.api.confirmRestart(`recovery-${action}`);
				} catch (error) {
					notice(message(error), 'error', { persist: true });
				} finally {
					setBusy(false);
					updateRecoveryFields();
				}
				if (!confirmed) return;
			}
			const result = await operation(
				action === 'status'
					? 'Checking recovery checkpoint'
					: action === 'inspect'
						? 'Inspecting saved recovery coverage'
						: action === 'init'
							? 'Initializing new recovery destination'
							: 'Validating offline recovery',
				() => state.api.recovery({ action, confirmed }),
				action === 'init'
					? 'New destination initialized. Start the instance to publish its first checkpoint.'
					: action === 'restore'
						? 'Recovery validated. Containers remain stopped.'
						: 'Recovery check complete.'
			);
			if (result === undefined) return;
			byId(id('details')).value =
				typeof result === 'string' ? result : JSON.stringify(result, null, 2);
			if (action === 'status') renderRecoveryStatus(result);
			updateRecoveryFields();
		});
	}
}

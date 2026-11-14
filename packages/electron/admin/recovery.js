import { chooseDirectory } from './backup.js';
import { offerRestart } from './restart.js';
import { refresh, render } from './snapshot.js';
import { known } from './model.js';
import { state } from './state.js';
import { byId, message, notice, operation, setBusy, setFormClean } from './ui.js';
import { instanceCapability } from './instance-presentation.js';

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
	const recoveryOperation = (name) =>
		instanceCapability(`data.recovery.${name}`, state.currentSnapshot).supported;
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
	const snapshot = state.currentSnapshot;
	const recovery = known(snapshot?.data?.recovery);
	const saved = (recovery?.settings || snapshot?.docker?.config?.recovery)?.enabled;
	// A scaled-to-zero app, paused container or missing observation is not a
	// confirmed stop. Providers still enforce stopped writers at invocation.
	const services = known(snapshot?.services);
	const stopped = services?.every((service) =>
		['exited', 'dead', 'stopped'].includes(service.state?.toLowerCase())
	);
	const editable = Boolean(known(state.currentSnapshot?.data?.recovery)?.digest);
	const canSave = recoveryOperation('save');
	byId(id('options')).disabled = !editable || !canSave;
	byId(id('form')).hidden = !recovery?.settings && !snapshot?.docker?.config?.recovery;
	const unavailable = byId('recovery-fields-unavailable');
	unavailable.hidden = editable && canSave;
	unavailable.textContent = !canSave
		? instanceCapability('data.recovery.save', snapshot).reason
		: recovery?.settings
			? 'Backup settings cannot be edited until current coverage is inspected.'
			: snapshot?.data?.recovery?.reason || 'Inspect saved coverage to load backup settings.';
	const directoryPicker = instanceCapability('docker.directory', snapshot).supported;
	byId('choose-recovery-directory').hidden = !directoryPicker;
	byId(id('directory')).placeholder = directoryPicker
		? '/path/on/instance-host/private-backups'
		: '/recovery/instance-name';
	byId(id('directory-help')).textContent = directoryPicker
		? 'Choose a private directory on the instance host outside the instance home. Checkpoints finish locally, then copy here. A mounted network directory needs atomic creation and rename, not hard links. Live SQLite stays on local storage.'
		: 'Enter a path inside the container on an already mounted persistent backup volume. This does not create or mount storage. Checkpoints finish on local disk, then copy here; live SQLite stays local.';
	byId(id('credential-status')).textContent = !blob
		? 'Directory access uses the existing host or volume mount; no Blob credential is required.'
		: identity
			? 'Uses the deployment’s managed identity. No connection string is required; storage access is verified by the recovery worker.'
			: recovery?.credentialConfigured && recovery.settings.authentication === 'connection-string'
				? 'A private connection string is configured. Its value is not shown.'
				: 'No connection string configured. Add one below, or select a deployment identity.';
	byId('save-recovery-settings').disabled = !editable || state.operationInFlight || !canSave;
	byId('save-recovery-credential').disabled =
		state.operationInFlight || !recoveryOperation('setCredential');
	byId('initialize-recovery').disabled =
		!saved || !stopped || state.operationInFlight || !recoveryOperation('initialize');
	byId('restore-runtime-recovery').disabled =
		!saved || !stopped || state.operationInFlight || !recoveryOperation('restore');
	byId('inspect-recovery').disabled = state.operationInFlight || !recoveryOperation('inspect');
	byId('check-recovery-status').disabled =
		!saved || state.operationInFlight || !recoveryOperation('status');
	byId(id('offline-availability')).textContent = [
		!stopped
			? 'Stop the instance and wait for completion before initializing or restoring offline.'
			: '',
		...['initialize', 'restore'].map((action) => {
			const capability = instanceCapability(`data.recovery.${action}`, snapshot);
			return capability.supported ? '' : capability.reason;
		})
	]
		.filter(Boolean)
		.join(' ');
	updateCheckpointPackageActions();
}

export function renderRecovery(snapshot) {
	const recovery = known(snapshot.data?.recovery);
	const settings = recovery?.settings || snapshot.docker?.config?.recovery;
	if (!settings) {
		byId(id('enabled')).checked = false;
		byId(id('storage')).value = 'directory';
		byId(id('auth')).value = 'connection-string';
		for (const suffix of ['directory', 'blob', 'client-id', 'connection-string'])
			byId(id(suffix)).value = '';
		renderRecoveryStatus({
			state: 'not-ready',
			detail: snapshot.data?.recovery?.reason || 'Inspect saved coverage to load backup settings.'
		});
		updateRecoveryFields();
		return;
	}
	const editable = Boolean(recovery?.digest);
	byId(id('enabled')).checked = settings.enabled;
	byId(id('akm-capture')).checked = settings.akmIndexCapture === true;
	byId(id('akm-restore')).checked = settings.akmIndexRestore === true;
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
	byId(id('policy-path')).textContent = recovery?.policyPath || 'config/recovery/include.json';
	renderRecoveryStatus({
		state: editable ? (settings.enabled ? 'configured' : 'disabled') : 'not-ready',
		failure: editable
			? snapshot.data?.recovery?.state === 'unavailable'
				? snapshot.data.recovery.reason
				: undefined
			: snapshot.data?.recovery?.reason ||
				'Checkpoint settings are not available through this connection.'
	});
	updateRecoveryFields();
}

export function recoveryInput() {
	const previous = known(state.currentSnapshot.data?.recovery);
	if (!previous?.digest || !previous?.settings)
		throw new Error('Checkpoint settings are not available through this connection.');
	const settings = { ...previous.settings, enabled: byId(id('enabled')).checked };
	const directory = byId(id('directory')).value.trim();
	settings.destination =
		byId(id('storage')).value === 'blob'
			? byId(id('blob')).value.trim()
			: directory
				? `file://${directory.split('/').map(encodeURIComponent).join('/')}`
				: '';
	settings.instanceId = byId(id('instance-id')).value.trim();
	settings.intervalSeconds = Number(byId(id('interval')).value);
	settings.maxUnsavedSeconds = Number(byId(id('max-unsaved')).value);
	settings.operationTimeoutSeconds = Number(byId(id('timeout')).value);
	settings.akmIndexCapture = byId(id('akm-capture')).checked;
	settings.akmIndexRestore = byId(id('akm-restore')).checked;
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
	return { settings, selection, baselineDigest: previous.digest };
}

export function renderRecoveryStatus(status) {
	const panel = byId(id('status'));
	panel.replaceChildren();
	const title = document.createElement('strong');
	const detail = document.createElement('span');
	if (status.state === 'disabled') {
		title.textContent = 'Automatic Assistant backups are off.';
		detail.textContent =
			'Existing local data and backups are unchanged. Manual export remains available below.';
	} else if (status.state === 'ready' && (status.durable === false || status.lastAttemptFailed)) {
		title.textContent = 'Agent is running; backups need attention.';
		detail.textContent =
			status.failure ||
			'The last checkpoint is overdue. Recovery will retry without stopping your agent. Check the backup destination and instance logs.';
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
	panel.className = `inline-status ${status.state === 'ready' && status.durable !== false && !status.lastAttemptFailed ? 'success' : status.failure ? 'error' : 'neutral'}`;
}

export function bindRecoveryEvents() {
	bindCheckpointPackageEvents();
	for (const suffix of ['enabled', 'storage', 'auth'])
		byId(id(suffix)).addEventListener('change', updateRecoveryFields);
	byId('choose-recovery-directory').addEventListener('click', () => {
		if (instanceCapability('docker.directory').supported)
			void chooseDirectory('recovery', id('directory'));
	});
	byId(id('form')).addEventListener('submit', async (event) => {
		event.preventDefault();
		if (!instanceCapability('data.recovery.save').supported) return;
		const previous =
			known(state.currentSnapshot.data?.recovery)?.settings ||
			state.currentSnapshot.docker?.config?.recovery;
		if (!previous) throw new Error('Recovery settings are not available for this instance.');
		const saved = await operation(
			'Saving checkpoint settings',
			async () => {
				await state.api.operation('data.recovery.save', recoveryInput());
				const result = await state.api.snapshot();
				setFormClean(id('form'));
				render(result);
				return result;
			},
			'Checkpoint settings saved. Existing checkpoints and containers were not changed.'
		);
		if (saved) {
			const next = known(saved.data?.recovery)?.settings || saved.docker?.config?.recovery;
			if (!next) {
				updateRecoveryFields();
				return;
			}
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
		if (!instanceCapability('data.recovery.setCredential').supported) return;
		const secret = byId(id('connection-string'));
		const connectionString = secret.value;
		secret.value = '';
		const saved = await operation(
			'Saving private storage credential',
			() =>
				state.api
					.operation('data.recovery.setCredential', { connectionString })
					.then(() => state.api.snapshot()),
			'Private storage credential saved.'
		);
		if (saved) await offerRestart(saved);
		updateRecoveryFields();
	});
	for (const [control, operationKey, action] of [
		['check-recovery-status', 'data.recovery.status', 'status'],
		['inspect-recovery', 'data.recovery.inspect', 'inspect'],
		['initialize-recovery', 'data.recovery.initialize', 'init'],
		['restore-runtime-recovery', 'data.recovery.restore', 'restore']
	]) {
		byId(control).addEventListener('click', async () => {
			if (state.operationInFlight || !instanceCapability(operationKey).supported) return;
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
				() => state.api.operation(operationKey, undefined, { confirmed }),
				action === 'init'
					? 'New destination initialized. Start the instance to publish its first checkpoint.'
					: action === 'restore'
						? 'Recovery validated. Containers remain stopped.'
						: 'Recovery check complete.'
			);
			if (result === undefined) return;
			if (action === 'inspect') await refresh();
			byId(id('details')).value =
				typeof result === 'string' ? result : JSON.stringify(result, null, 2);
			if (action === 'status') renderRecoveryStatus(result);
			updateRecoveryFields();
		});
	}
}

function checkpointRequest() {
	return {
		directory: byId('checkpoint-source').value.trim(),
		destinationHome: byId('checkpoint-home').value.trim(),
		backupDirectory: byId('checkpoint-backups').value.trim()
	};
}
function updateCheckpointPackageActions() {
	const target = JSON.stringify(state.currentSnapshot?.identity?.ref);
	if (state.checkpointPackageTarget !== target) {
		state.checkpointPackageTarget = target;
		state.checkpointPackagePreview = null;
		for (const name of ['export-directory', 'source', 'home', 'backups'])
			byId(`checkpoint-${name}`).value = '';
		byId('checkpoint-package-result').value =
			'No checkpoint package operation has run for this instance.';
	}
	const supported = instanceCapability('data.recovery.package').supported;
	byId('export-checkpoint').disabled = !supported || state.operationInFlight;
	byId('preview-checkpoint').disabled = !supported || state.operationInFlight;
	byId('import-checkpoint').disabled =
		!supported ||
		state.operationInFlight ||
		!state.checkpointPackagePreview ||
		state.checkpointPackagePreview.signature !== JSON.stringify(checkpointRequest());
}
function bindCheckpointPackageEvents() {
	for (const [button, purpose, input] of [
		['choose-checkpoint-export', 'recovery', 'checkpoint-export-directory'],
		['choose-checkpoint-source', 'recovery', 'checkpoint-source'],
		['choose-checkpoint-home', 'new-instance', 'checkpoint-home'],
		['choose-checkpoint-backups', 'recovery', 'checkpoint-backups']
	])
		byId(button).addEventListener('click', () => void chooseDirectory(purpose, input));
	for (const name of ['source', 'home', 'backups'])
		byId(`checkpoint-${name}`).addEventListener('input', () => {
			state.checkpointPackagePreview = null;
			updateCheckpointPackageActions();
		});
	byId('checkpoint-export-form').addEventListener('submit', async (event) => {
		event.preventDefault();
		if (!instanceCapability('data.recovery.package').supported) return;
		const result = await operation(
			'Exporting Assistant backup',
			() =>
				state.api.operation('data.recovery.package', {
					operation: 'export',
					directory: byId('checkpoint-export-directory').value.trim()
				}),
			'Assistant checkpoint package exported. Keep this backup private.'
		);
		if (result) byId('checkpoint-package-result').value = JSON.stringify(result, null, 2);
		updateCheckpointPackageActions();
	});
	byId('preview-checkpoint').addEventListener('click', async () => {
		if (!instanceCapability('data.recovery.package').supported) return;
		const input = checkpointRequest(),
			signature = JSON.stringify(input);
		state.checkpointPackagePreview = null;
		const result = await operation(
			'Validating Assistant backup',
			() =>
				state.api.operation('data.recovery.package', {
					operation: 'preview',
					directory: input.directory
				}),
			'Assistant backup validated. Review its identity, private state and coverage before importing.'
		);
		if (result) {
			byId('checkpoint-package-result').value = JSON.stringify(result, null, 2);
			state.checkpointPackagePreview = { digest: result.previewDigest, signature };
		}
		updateCheckpointPackageActions();
	});
	byId('checkpoint-import-form').addEventListener('submit', async (event) => {
		event.preventDefault();
		const preview = state.checkpointPackagePreview;
		if (
			!instanceCapability('data.recovery.package').supported ||
			!preview ||
			preview.signature !== JSON.stringify(checkpointRequest())
		)
			return;
		const input = checkpointRequest();
		setBusy(true);
		let confirmed;
		try {
			confirmed = await state.api.confirmRestart('checkpoint-import');
		} catch (error) {
			notice(message(error), 'error', { persist: true });
		} finally {
			setBusy(false);
		}
		if (!confirmed) return;
		const result = await operation(
			'Importing Assistant backup',
			() =>
				state.api.operation(
					'data.recovery.package',
					{ operation: 'import', ...input, previewDigest: preview.digest },
					{ confirmed: true }
				),
			'Assistant restored into the new home. Open that folder to review settings and start it; original writers must remain stopped.'
		);
		if (result) {
			byId('checkpoint-package-result').value = JSON.stringify(result, null, 2);
			state.checkpointPackagePreview = null;
		}
		updateCheckpointPackageActions();
	});
}

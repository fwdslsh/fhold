import { isRunning, known } from './model.js';
import { refresh } from './snapshot.js';
import { state } from './state.js';
import { byId, message, notice, operation, setBusy, setText } from './ui.js';
import { instanceCapability } from './instance-presentation.js';

export function renderRestartStatus(snapshot) {
	const pending = known(snapshot.pendingChanges);
	byId('pending-restart').hidden = !pending?.pending;
	const services = known(snapshot.services) || [];
	const running = services.some(isRunning);
	setText('pending-restart-title', running ? 'Pending restart' : 'Saved changes pending startup');
	setText(
		'pending-restart-detail',
		pending?.detail ||
			(running
				? 'Saved changes will apply after a restart.'
				: 'Saved changes will apply when the instance starts.')
	);
	setText('apply-pending-restart', running ? 'Restart to apply' : 'Start to apply');
	byId('apply-pending-restart').disabled =
		state.operationInFlight ||
		snapshot.services?.state === 'unavailable' ||
		!instanceCapability(running ? 'host.restart' : 'host.start').supported;
}

/** Native dialog: postponing is the default and Escape never applies changes. */
const lifecycleActions = {
	'host.start': {
		action: 'start',
		labels: ['Starting fhold', 'fhold started. Saved settings applied.']
	},
	'host.restart': {
		action: 'restart',
		labels: ['Restarting fhold', 'fhold restarted. Saved settings applied.']
	},
	'host.stop': {
		action: 'stop',
		labels: ['Stopping fhold', 'fhold stopped. Your data is unchanged.']
	}
};

export async function requestStackAction(operationKey) {
	const lifecycle = lifecycleActions[operationKey];
	if (!lifecycle || state.operationInFlight || !instanceCapability(operationKey).supported) return;
	setBusy(true);
	let confirmed = false;
	try {
		confirmed = await state.api.confirmRestart(lifecycle.action);
	} catch (error) {
		notice(message(error), 'error', { persist: true });
	} finally {
		setBusy(false);
	}
	if (!confirmed) return;
	const result = await operation(
		lifecycle.labels[0],
		() => state.api.action(lifecycle.action, true),
		lifecycle.labels[1]
	);
	if (!result) await refresh();
	return result;
}

export async function offerRestart(snapshot = state.currentSnapshot) {
	const pending = known(snapshot?.pendingChanges);
	if (!pending?.pending) return;
	const services = known(snapshot?.services) || [];
	return requestStackAction(services.some(isRunning) ? 'host.restart' : 'host.start');
}

export function bindRestartEvents() {
	byId('apply-pending-restart').addEventListener('click', () => void offerRestart());
}

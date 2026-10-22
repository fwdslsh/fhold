import { isRunning } from './model.js';
import { refresh } from './snapshot.js';
import { state } from './state.js';
import { byId, message, notice, operation, setBusy, setText } from './ui.js';
import { instanceCapability } from './instance-presentation.js';

export function renderRestartStatus(snapshot) {
	const pending =
		snapshot.pendingChanges?.state === 'known' ? snapshot.pendingChanges.value : undefined;
	byId('pending-restart').hidden = !pending?.pending;
	const services = snapshot.services?.state === 'known' ? snapshot.services.value : [];
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
		!instanceCapability(running ? 'restart' : 'start').supported;
}

/** Native dialog: postponing is the default and Escape never applies changes. */
export async function requestStackAction(action) {
	if (state.operationInFlight || !instanceCapability(action).supported) return;
	setBusy(true);
	let confirmed = false;
	try {
		confirmed = await state.api.confirmRestart(action);
	} catch (error) {
		notice(message(error), 'error', { persist: true });
	} finally {
		setBusy(false);
	}
	if (!confirmed) return;
	const labels = {
		start: ['Starting fhold', 'fhold started. Saved settings applied.'],
		restart: ['Restarting fhold', 'fhold restarted. Saved settings applied.'],
		stop: ['Stopping fhold', 'fhold stopped. Your data is unchanged.']
	};
	const result = await operation(
		labels[action][0],
		() => state.api.action(action, true),
		labels[action][1]
	);
	if (!result) await refresh();
	return result;
}

export async function offerRestart(snapshot = state.currentSnapshot) {
	const pending =
		snapshot?.pendingChanges?.state === 'known' ? snapshot.pendingChanges.value : undefined;
	if (!pending?.pending) return;
	const services = snapshot?.services?.state === 'known' ? snapshot.services.value : [];
	return requestStackAction(services.some(isRunning) ? 'restart' : 'start');
}

export function bindRestartEvents() {
	byId('apply-pending-restart').addEventListener('click', () => void offerRestart());
}

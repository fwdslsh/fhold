import { isRunning } from './model.js';
import { refresh } from './snapshot.js';
import { state } from './state.js';
import { byId, message, notice, operation, setBusy, setText } from './ui.js';

export function renderRestartStatus(snapshot) {
	const pending = snapshot.pendingRestart;
	byId('pending-restart').hidden = !pending?.required;
	const running = snapshot.services.some(isRunning);
	setText('pending-restart-title', running ? 'Pending restart' : 'Saved changes pending startup');
	setText(
		'pending-restart-detail',
		pending?.error ||
			(running
				? 'Settings are saved. Restart when you are ready to apply them to the containers. Active work may be interrupted.'
				: 'Your saved settings will be applied the next time you start this instance.')
	);
	setText('apply-pending-restart', running ? 'Restart to apply' : 'Start to apply');
	byId('apply-pending-restart').disabled = state.operationInFlight || Boolean(snapshot.dockerError);
}

/** Native dialog: postponing is the default and Escape never applies changes. */
export async function requestStackAction(action) {
	if (state.operationInFlight) return;
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
	if (!snapshot?.pendingRestart?.required) return;
	return requestStackAction(snapshot.services.some(isRunning) ? 'restart' : 'start');
}

export function bindRestartEvents() {
	byId('apply-pending-restart').addEventListener('click', () => void offerRestart());
}

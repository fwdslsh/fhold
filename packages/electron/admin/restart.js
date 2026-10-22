import { isRunning } from './model.js';
import { refresh } from './snapshot.js';
import { state } from './state.js';
import { byId, message, notice, operation, setBusy, setText } from './ui.js';
import { instanceCapability, instancePresentation } from './instance-presentation.js';

export function renderRestartStatus(snapshot) {
	const pending = snapshot.pendingRestart;
	byId('pending-restart').hidden = !pending?.required;
	const running = snapshot.services.some(isRunning);
	setText('pending-restart-title', running ? 'Pending restart' : 'Saved changes pending startup');
	setText(
		'pending-restart-detail',
		pending?.error ||
			(running
				? 'Saved changes will apply after a restart.'
				: 'Saved changes will apply when the instance starts.')
	);
	setText('apply-pending-restart', running ? 'Restart to apply' : 'Start to apply');
	byId('apply-pending-restart').disabled =
		state.operationInFlight ||
		Boolean(snapshot.dockerError) ||
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
		instancePresentation(state.currentSnapshot).managed
			? labels[action][1]
			: 'Request submitted. Check platform status.'
	);
	if (!result) await refresh();
	return result;
}

export async function offerRestart(snapshot = state.currentSnapshot) {
	if (snapshot?.phase === 'remote') snapshot = snapshot.hosting;
	if (!snapshot?.pendingRestart?.required) return;
	return requestStackAction(snapshot.services.some(isRunning) ? 'restart' : 'start');
}

export function bindRestartEvents() {
	byId('apply-pending-restart').addEventListener('click', () => void offerRestart());
}

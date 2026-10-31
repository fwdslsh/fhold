import { isRunning, known } from './model.js';
import { refresh, render } from './snapshot.js';
import { state } from './state.js';
import { byId, message, notice, operation, setBusy, setText } from './ui.js';
import { instanceCapability } from './instance-presentation.js';
import { deploymentOutcomeNotice } from './configuration.js';

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
	const deploymentApply = instanceCapability('host.deployment.apply', snapshot).supported;
	setText(
		'apply-pending-restart',
		deploymentApply ? 'Apply changes' : running ? 'Restart to apply' : 'Start to apply'
	);
	byId('apply-pending-restart').disabled =
		state.operationInFlight ||
		snapshot.services?.state === 'unavailable' ||
		!(deploymentApply || instanceCapability(running ? 'host.restart' : 'host.start').supported);
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
		'Lifecycle result received.'
	);
	if (result?.snapshot) {
		render(result.snapshot);
		deploymentOutcomeNotice(result.outcome);
	}
	if (!result) await refresh();
	return result;
}

export async function offerRestart(snapshot = state.currentSnapshot) {
	const pending = known(snapshot?.pendingChanges);
	if (!pending?.pending) return;
	if (instanceCapability('host.deployment.apply', snapshot).supported) {
		if (state.operationInFlight) return;
		let confirmed = false;
		setBusy(true);
		try {
			confirmed = await state.api.confirmRestart('apply');
		} catch (error) {
			notice(message(error), 'error', { persist: true });
		} finally {
			setBusy(false);
		}
		if (!confirmed) return;
		const result = await operation(
			'Applying saved deployment changes',
			() => state.api.applyDeployment({ confirmed: true }),
			'Deployment result received.'
		);
		if (result) {
			render(result.snapshot);
			deploymentOutcomeNotice(result.outcome);
		}
		return result;
	}
	const services = known(snapshot?.services) || [];
	return requestStackAction(services.some(isRunning) ? 'host.restart' : 'host.start');
}

export function bindRestartEvents() {
	byId('apply-pending-restart').addEventListener('click', () => void offerRestart());
}

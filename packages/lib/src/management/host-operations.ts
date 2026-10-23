import type {
	HostingAction,
	HostingActionOptions,
	HostingSnapshot,
	InstanceSession
} from '../hosting/types.js';
import {
	supportedOperation,
	unsupportedOperation,
	type HostOperations,
	type LifecycleOutcome,
	type Operation
} from './contracts.js';

/** Adapt native host eligibility and effects without teaching consumers provider names. */
export function hostOperations(session: InstanceSession): {
	host: HostOperations;
	inspectHost(): Promise<HostingSnapshot>;
	latest(): HostingSnapshot | undefined;
} {
	let latest: HostingSnapshot | undefined;
	async function inspectHost() {
		latest = await session.inspect();
		return latest;
	}
	function lifecycle(
		action: HostingAction
	): Operation<HostingActionOptions | void, LifecycleOutcome> {
		return {
			support: 'supported',
			effect: session.actionEffects[action],
			availability() {
				// No optional diagnostic/preflight is required before invoking a
				// supported action. invoke always resolves current target eligibility.
				if (!latest) return { state: 'ready' };
				const capability = latest?.capabilities[action];
				return capability?.supported
					? { state: 'ready' }
					: {
							state: 'unavailable',
							reason: capability?.reason ?? 'Inspect the selected deployment before changing it.'
						};
			},
			async invoke(input, context) {
				context.signal?.throwIfAborted();
				if (!context.confirmed)
					throw new Error('Confirm this lifecycle operation before changing the deployment.');
				const observed = await inspectHost();
				context.signal?.throwIfAborted();
				if (!observed.capabilities[action].supported)
					throw new Error(
						observed.capabilities[action].reason ?? 'This lifecycle operation is unavailable.'
					);
				const result = await session.operate(action, true, input || undefined);
				latest = result.snapshot;
				return result.pending
					? { state: 'accepted', scope: 'request-accepted' }
					: { state: 'completed', scope: 'deployment-reconciled', result };
			}
		};
	}
	return {
		inspectHost,
		latest: () => latest,
		host: {
			inspect: supportedOperation(inspectHost),
			start: lifecycle('start'),
			stop: lifecycle('stop'),
			restart: lifecycle('restart'),
			logs: supportedOperation((input) => session.logs(input)),
			console: (() => {
				const console = session.console;
				return console
					? supportedOperation((input) => console(input))
					: unsupportedOperation('An interactive console is not available for this instance.');
			})()
		}
	};
}

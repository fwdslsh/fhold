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
} {
	async function inspectHost() {
		return session.inspect();
	}
	function lifecycle(
		action: HostingAction
	): Operation<HostingActionOptions | void, LifecycleOutcome> {
		return {
			support: 'supported',
			effect: session.actionEffects[action],
			// A snapshot's capability is presentation data. Never let a stale
			// snapshot prevent invoke() from re-reading the authoritative target.
			availability: () => ({ state: 'ready' }),
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
				if (result.operation?.state === 'unknown' || result.operation?.state === 'failed')
					return {
						state: result.operation.state,
						scope: 'request-accepted',
						reason: result.operation.message ?? `Azure ${result.operation.step} did not complete.`
					};
				return result.pending
					? { state: 'accepted', scope: 'request-accepted', reference: result.operation?.reference }
					: { state: 'completed', scope: 'deployment-reconciled', result };
			}
		};
	}
	return {
		inspectHost,
		host: {
			deployment: session.deployment ?? {
				inspect: unsupportedOperation('Deployment settings are unavailable.'),
				prepare: unsupportedOperation('Use this Docker instance’s settings to stage changes.'),
				apply: unsupportedOperation('Use restart to apply this instance’s settings.'),
				discard: unsupportedOperation('No deployment draft is available.'),
				update: unsupportedOperation('Image updates are unavailable.')
			},
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

import type { HostingSnapshot } from '../hosting/types.js';
import type { ProviderSettings } from '../control-plane/provider-settings.js';
import { createHttpsNativeAgentService, type NativeAgentService } from './agent-access.js';
import type { InstanceSessionBindings } from './instance-session.js';
import {
	supportedOperation,
	unsupportedOperation,
	type AgentObservations,
	type AgentOperations,
	type Observation,
	type RequestContext
} from './contracts.js';

type Options = {
	inspectHost(): Promise<HostingSnapshot>;
	fetch?: typeof fetch;
};

/** Native HTTP capabilities over an explicitly acquired, private session route. */
export function httpsAgentBindings(
	options: Options
): Pick<InstanceSessionBindings, 'agent' | 'inspectAgent' | 'close'> {
	let service: NativeAgentService | undefined;
	let route: AbortController | undefined;
	let selectedRuntime: string | undefined;
	let closed = false;
	let attempt: { provider: string; method: number; id: string; runtime: string } | undefined;
	let access: AgentObservations['access'] = {
		state: 'not-inspected',
		reason: 'Connect to the agent with its native OpenCode password.'
	};
	let models: AgentObservations['models'] = {
		state: 'not-inspected',
		reason: 'Connect to inspect the active model.'
	};
	let account: AgentObservations['account'] = {
		state: 'not-inspected',
		reason: 'Connect to inspect saved AI accounts.'
	};
	let readiness: AgentObservations['readiness'] = {
		state: 'not-inspected',
		reason: 'Run an explicit model test.'
	};

	function known<T>(value: T): Observation<T> {
		return { state: 'known', value, observedAt: new Date().toISOString() };
	}
	function current(context: RequestContext): NativeAgentService {
		context.signal?.throwIfAborted();
		if (closed || !service)
			throw new Error('Connect to this agent before managing its AI accounts.');
		return service;
	}
	function runtime(snapshot: HostingSnapshot, writing: boolean): string {
		const revisions = snapshot.revisions?.filter((item) => item.active) ?? [];
		if (revisions.length !== 1 || !revisions[0])
			throw new Error('Select a deployment with one active agent revision before connecting.');
		if (writing && revisions[0].replicas !== 1)
			throw new Error(
				'A single running agent replica must be identifiable before changing native accounts. Inspect the deployment and reconnect.'
			);
		return revisions[0].name;
	}
	async function bound(context: RequestContext, writing = true): Promise<NativeAgentService> {
		const selected = current(context);
		const observed = await options.inspectHost();
		context.signal?.throwIfAborted();
		if (closed || service !== selected)
			throw new Error('This agent connection was closed or replaced.');
		let observedRuntime: string;
		try {
			observedRuntime = runtime(observed, false);
		} catch {
			observedRuntime = '';
		}
		if (observedRuntime !== selectedRuntime) {
			route?.abort();
			service = undefined;
			selectedRuntime = undefined;
			attempt = undefined;
			access = {
				state: 'unavailable',
				reason: 'The agent runtime changed. Reconnect to its current runtime.'
			};
			account = {
				state: 'not-inspected',
				reason: 'Reconnect to inspect the current native accounts.'
			};
			models = { state: 'not-inspected', reason: 'Reconnect to inspect the current model.' };
			readiness = {
				state: 'not-inspected',
				reason: 'Run a requested test against the current runtime.'
			};
			throw new Error(
				'This agent runtime changed during the connection. Reconnect before continuing native setup.'
			);
		}
		if (writing) runtime(observed, true);
		return selected;
	}
	function connected<I, O>(run: (input: I, context: RequestContext) => Promise<O>) {
		return supportedOperation(run, () =>
			service && !closed
				? { state: 'ready' }
				: {
						state: 'unavailable',
						reason: 'Connect to the agent with its native OpenCode password first.'
					}
		);
	}
	async function providers(context: RequestContext): Promise<ProviderSettings> {
		const selected = await bound(context, false);
		const [inventory, config] = await Promise.all([
			selected.listProviders({ signal: context.signal }),
			selected.readConfig({ signal: context.signal })
		]);
		if (closed || service !== selected) throw new Error('The agent connection was closed.');
		const model =
			typeof config.model === 'object' && config.model !== null
				? (config.model as Record<string, unknown>)
				: undefined;
		let selectedModel: ProviderSettings['currentModel'];
		if (typeof config.model === 'string') {
			const separator = config.model.indexOf('/');
			if (separator > 0 && separator < config.model.length - 1)
				selectedModel = {
					provider: config.model.slice(0, separator),
					model: config.model.slice(separator + 1)
				};
		} else if (typeof model?.providerID === 'string' && typeof model.model === 'string') {
			selectedModel = { provider: model.providerID, model: model.model };
		}
		models = known(selectedModel ?? {});
		account = known({ signedIn: inventory.some((item) => item.authenticated) });
		return { providers: inventory, ...(selectedModel ? { currentModel: selectedModel } : {}) };
	}
	const preferenceReason =
		'Native preferences need an owned file-editing route. This connection provides the OpenCode HTTP API only; use the native agent interface or deployment tools.';
	const agent: Partial<AgentOperations> = {
		connect: supportedOperation(
			async (input, context) => {
				if (closed) throw new Error('This instance session is closed. Open the instance again.');
				context.signal?.throwIfAborted();
				const snapshot = await options.inspectHost();
				if (closed) throw new Error('This instance session is closed. Open the instance again.');
				context.signal?.throwIfAborted();
				const selected = runtime(snapshot, false);
				if (!snapshot.clientUrl)
					throw new Error('No reachable native OpenCode HTTPS address is configured.');
				if (!input.password)
					throw new Error(
						'Enter this agent’s native OpenCode password. Azure sign-in is a separate credential.'
					);
				route?.abort();
				service = undefined;
				attempt = undefined;
				access = { state: 'not-inspected', reason: 'Connecting to the selected native agent.' };
				account = { state: 'not-inspected', reason: 'Refresh saved AI accounts after connecting.' };
				models = { state: 'not-inspected', reason: 'Refresh the active model after connecting.' };
				readiness = { state: 'not-inspected', reason: 'Run an explicit model test.' };
				route = new AbortController();
				const pendingRoute = route;
				const pending = createHttpsNativeAgentService({
					endpoint: snapshot.clientUrl,
					password: input.password,
					signal: pendingRoute.signal,
					fetch: options.fetch
				});
				try {
					await pending.waitForReady({ timeoutMs: 10_000, signal: context.signal });
				} catch (error) {
					pendingRoute.abort();
					if (route === pendingRoute) {
						route = undefined;
						access = {
							state: 'unavailable',
							reason:
								'Native OpenCode connection could not be established. Check its address and password.'
						};
					}
					throw error;
				}
				if (closed || route !== pendingRoute)
					throw new Error('This agent connection was closed or replaced.');
				service = pending;
				selectedRuntime = selected;
				access = known({ endpoint: snapshot.clientUrl, username: 'opencode' });
				return { endpoint: snapshot.clientUrl, username: 'opencode' };
			},
			undefined,
			{ requiresPassword: true }
		),
		providers: connected(async (_input, context) => providers(context)),
		modelInventory: connected(async (_input, context) => (await providers(context)).providers),
		setKey: connected(async (input, context) => {
			await (await bound(context)).setProviderApiKey(input.provider, input.key, {
				signal: context.signal
			});
		}),
		removeProvider: connected(async (input, context) => {
			if (input.endpoint) throw new Error(preferenceReason);
			await (await bound(context)).removeProviderAuth(input.provider, { signal: context.signal });
			return providers(context);
		}),
		oauthStart: connected(async (input, context) => {
			const selected = await bound(context);
			const result = await selected.beginProviderOAuth(input.provider, input.method, input.inputs, {
				signal: context.signal
			});
			if (closed || service !== selected)
				throw new Error('The agent connection closed during sign-in.');
			attempt = {
				provider: input.provider,
				method: input.method,
				id: result.attemptID,
				runtime: selectedRuntime!
			};
			return result;
		}),
		oauthFinish: connected(async (input, context) => {
			const selected = await bound(context);
			const pending = attempt;
			if (
				!pending ||
				pending.provider !== input.provider ||
				pending.method !== input.method ||
				pending.runtime !== selectedRuntime
			)
				throw new Error('Start sign-in for this account in the current agent connection first.');
			// Completion may consume the native code even if its response is lost.
			attempt = undefined;
			await selected.completeProviderOAuth(pending.provider, pending.id, input.code, {
				signal: context.signal
			});
		}),
		readiness: connected(async (input, context) => {
			const selected = await bound(context);
			const result = await selected.testReadiness({ ...input, signal: context.signal });
			if (closed || service !== selected)
				throw new Error('The agent connection closed during the test.');
			readiness = known({ ready: result.ok, ...(!result.ok ? { detail: result.error } : {}) });
			return result;
		}),
		selectModel: unsupportedOperation(preferenceReason),
		saveEndpoint: unsupportedOperation(preferenceReason),
		discoverModels: unsupportedOperation(
			'Custom server model discovery must run from the Assistant network; this connection has no qualified runtime command route.'
		),
		remote: unsupportedOperation(
			'Guided Claude/Codex setup requires a qualified native command session. Use the deployment’s interactive console and the image-baked setup skills.'
		),
		codexRecall: unsupportedOperation(
			'Native hook inspection requires a qualified runtime command session.'
		)
	};
	return {
		agent,
		inspectAgent: async () => ({ access, account, models, readiness }),
		async close() {
			closed = true;
			route?.abort();
			service = undefined;
			attempt = undefined;
			selectedRuntime = undefined;
			access = { state: 'unavailable', reason: 'The native agent connection is closed.' };
		}
	};
}

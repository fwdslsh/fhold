import type { HostingSnapshot } from '../hosting/types.js';
import type { ProviderSettings } from '../control-plane/provider-settings.js';
import {
	createHttpsNativeAgentService,
	type NativeAgentService
} from '../control-plane/native-agent.js';
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
type OAuthAttempt = { provider: string; method: number; id: string; runtime: string };
type ConnectionState =
	| { state: 'idle' }
	| { state: 'closed' }
	| { state: 'connecting'; route: AbortController }
	| {
			state: 'connected';
			service: NativeAgentService;
			route: AbortController;
			runtime: string;
			attempt?: OAuthAttempt;
	  };

/** Native HTTP capabilities over an explicitly acquired, private session route. */
export function httpsAgentBindings(
	options: Options
): Pick<InstanceSessionBindings, 'agent' | 'inspectApplication' | 'close'> {
	let connection: ConnectionState = { state: 'idle' };
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
	function clearConnection(
		reason: string,
		phase: 'connecting' | 'unavailable' = 'unavailable'
	): void {
		if (connection.state === 'connected' || connection.state === 'connecting')
			connection.route.abort();
		connection = { state: 'idle' };
		access =
			phase === 'connecting'
				? { state: 'not-inspected', reason }
				: { state: 'unavailable', reason };
		account = {
			state: 'not-inspected',
			reason:
				phase === 'connecting'
					? 'Refresh saved AI accounts after connecting.'
					: 'Reconnect to inspect the current native accounts.'
		};
		models = {
			state: 'not-inspected',
			reason:
				phase === 'connecting'
					? 'Refresh the active model after connecting.'
					: 'Reconnect to inspect the current model.'
		};
		readiness = {
			state: 'not-inspected',
			reason: 'Run a requested test against the current runtime.'
		};
	}
	function isClosed(): boolean {
		return connection.state === 'closed';
	}

	function known<T>(value: T): Observation<T> {
		return { state: 'known', value, observedAt: new Date().toISOString() };
	}
	function assertCurrent(
		context: RequestContext
	): Extract<ConnectionState, { state: 'connected' }> {
		context.signal?.throwIfAborted();
		if (connection.state !== 'connected')
			throw new Error('Connect to this agent before managing its AI accounts.');
		return connection;
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
		const selected = assertCurrent(context);
		const observed = await options.inspectHost();
		context.signal?.throwIfAborted();
		if (connection !== selected) throw new Error('This agent connection was closed or replaced.');
		let observedRuntime: string;
		try {
			observedRuntime = runtime(observed, false);
		} catch {
			observedRuntime = '';
		}
		if (observedRuntime !== selected.runtime) {
			clearConnection('The agent runtime changed. Reconnect to its current runtime.');
			throw new Error(
				'This agent runtime changed during the connection. Reconnect before continuing native setup.'
			);
		}
		if (writing) runtime(observed, true);
		return selected.service;
	}
	function connected<I, O>(run: (input: I, context: RequestContext) => Promise<O>) {
		return supportedOperation(run, () =>
			connection.state === 'connected'
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
		if (connection.state !== 'connected' || connection.service !== selected)
			throw new Error('The agent connection was closed.');
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
				if (isClosed())
					throw new Error('This instance session is closed. Open the instance again.');
				context.signal?.throwIfAborted();
				const snapshot = await options.inspectHost();
				if (isClosed())
					throw new Error('This instance session is closed. Open the instance again.');
				context.signal?.throwIfAborted();
				const selected = runtime(snapshot, false);
				if (!snapshot.clientUrl)
					throw new Error('No reachable native OpenCode HTTPS address is configured.');
				if (!input.password)
					throw new Error(
						'Enter this agent’s native OpenCode password. Azure sign-in is a separate credential.'
					);
				clearConnection('Connecting to the selected native agent.', 'connecting');
				const pendingRoute = new AbortController();
				connection = { state: 'connecting', route: pendingRoute };
				const pending = createHttpsNativeAgentService({
					endpoint: snapshot.clientUrl,
					password: input.password,
					signal: pendingRoute.signal,
					fetch: options.fetch
				});
				try {
					await pending.waitForReady({ timeoutMs: 10_000, signal: context.signal });
				} catch (error) {
					if (connection.state === 'connecting' && connection.route === pendingRoute) {
						clearConnection(
							'Native OpenCode connection could not be established. Check its address and password.'
						);
					}
					throw error;
				}
				if (connection.state !== 'connecting' || connection.route !== pendingRoute)
					throw new Error('This agent connection was closed or replaced.');
				connection = {
					state: 'connected',
					service: pending,
					route: pendingRoute,
					runtime: selected
				};
				access = known({ endpoint: snapshot.clientUrl, username: 'opencode' });
				return { endpoint: snapshot.clientUrl, username: 'opencode' };
			},
			undefined,
			{ requiresPassword: true, acquireClients: ['opencode'] }
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
			if (connection.state !== 'connected' || connection.service !== selected)
				throw new Error('The agent connection closed during sign-in.');
			connection.attempt = {
				provider: input.provider,
				method: input.method,
				id: result.attemptID,
				runtime: connection.runtime
			};
			return result;
		}),
		oauthFinish: connected(async (input, context) => {
			const selected = await bound(context);
			const current = assertCurrent(context);
			const pending = current.attempt;
			if (
				!pending ||
				pending.provider !== input.provider ||
				pending.method !== input.method ||
				pending.runtime !== current.runtime
			)
				throw new Error('Start sign-in for this account in the current agent connection first.');
			// Completion may consume the native code even if its response is lost.
			current.attempt = undefined;
			await selected.completeProviderOAuth(pending.provider, pending.id, input.code, {
				signal: context.signal
			});
		}),
		readiness: connected(async (input, context) => {
			const selected = await bound(context);
			const result = await selected.testReadiness({
				provider: input.provider,
				model: input.model,
				signal: context.signal
			});
			if (connection.state !== 'connected' || connection.service !== selected)
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
		inspectApplication: async () => ({ agent: { access, account, models, readiness } }),
		async close() {
			clearConnection('The native agent connection is closed.');
			connection = { state: 'closed' };
		}
	};
}

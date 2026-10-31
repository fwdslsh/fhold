import type { HostingSnapshot } from '../hosting/types.js';
import {
	discoverProviderModels,
	listProviderSettings,
	removeProviderSetup,
	saveProviderEndpoint,
	useProviderModel,
	type ProviderSettings
} from '../control-plane/provider-settings.js';
import {
	createHttpsNativeAgentService,
	httpsNativeAgentAccess,
	type NativeAgentService
} from '../control-plane/native-agent.js';
import { createNativeManagement } from '../control-plane/native-management.js';
import type { NativePtyOptions, NativePtySession } from '../control-plane/native-pty.js';
import type { RemoteProgress } from '../control-plane/remote.js';
import type { InstanceSessionBindings } from './instance-session.js';
import {
	supportedOperation,
	unsupportedOperation,
	type AgentObservations,
	type AgentOperations,
	type Observation,
	type RequestContext
} from './contracts.js';
import type { Operation } from './contracts.js';

type Options = {
	inspectHost(): Promise<HostingSnapshot>;
	fetch?: typeof fetch;
	webSocket?: NativePtyOptions['webSocket'];
	resolveAccess?(): Promise<{ endpoint: string; username: string; password?: string }>;
	readinessTimeoutMs?: number;
	recoveryEnvironment?(): Promise<Record<string, string>>;
};
type OAuthAttempt = { provider: string; method: number; id: string; runtime: string };
type ConnectionState =
	| { state: 'idle' }
	| { state: 'closed' }
	| { state: 'connecting'; route: AbortController }
	| {
			state: 'connected';
			service: NativeAgentService;
			management: ReturnType<typeof createNativeManagement>;
			route: AbortController;
			runtime: string;
			attempt?: OAuthAttempt;
	  };

/** Native HTTP capabilities over an explicitly acquired, private session route. */
export function httpsAgentBindings(options: Options): Pick<
	InstanceSessionBindings,
	'agent' | 'inspectApplication' | 'close' | 'busy'
> & {
	recoveryStatus: Operation<void, Record<string, unknown>>;
	recoveryInspect: Operation<void, string>;
} {
	let connection: ConnectionState = { state: 'idle' };
	let verifiedModel: { provider: string; model: string } | undefined;
	let remote:
		| {
				session?: NativePtySession;
				startup?: AbortController;
				progress: RemoteProgress;
		  }
		| undefined;
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
		remote?.startup?.abort();
		if (connection.state === 'connected') void connection.management.close();
		if (connection.state === 'connected' || connection.state === 'connecting')
			connection.route.abort();
		connection = { state: 'idle' };
		verifiedModel = undefined;
		remote = undefined;
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
		try {
			return await listProviderSettings(assertCurrent(context).management.settings, {
				signal: context.signal
			});
		} catch {
			context.signal?.throwIfAborted();
			return { providers: inventory, ...(selectedModel ? { currentModel: selectedModel } : {}) };
		}
	}
	async function management(context: RequestContext, writing = true) {
		await bound(context, writing);
		return assertCurrent(context).management;
	}
	const agent: Partial<AgentOperations> = {
		browserLink: connected(async (_input, context) =>
			(await bound(context, false)).browserLink({ signal: context.signal })
		),
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
				const resolved = options.resolveAccess
					? await options.resolveAccess()
					: { endpoint: snapshot.clientUrl, username: 'opencode' };
				context.signal?.throwIfAborted();
				if (isClosed())
					throw new Error('This instance session is closed. Open the instance again.');
				if (!resolved.endpoint)
					throw new Error('No reachable native OpenCode HTTPS address is configured.');
				const password = input.password || ('password' in resolved ? resolved.password : undefined);
				if (!password)
					throw new Error(
						'Enter this agent’s native OpenCode password. Azure sign-in is a separate credential.'
					);
				clearConnection('Connecting to the selected native agent.', 'connecting');
				const pendingRoute = new AbortController();
				connection = { state: 'connecting', route: pendingRoute };
				const pending = createHttpsNativeAgentService({
					endpoint: resolved.endpoint,
					username: resolved.username,
					password,
					signal: pendingRoute.signal,
					fetch: options.fetch
				});
				try {
					await pending.waitForReady({
						timeoutMs: options.readinessTimeoutMs ?? 300_000,
						signal: context.signal
					});
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
					management: createNativeManagement(
						httpsNativeAgentAccess({
							endpoint: resolved.endpoint,
							username: resolved.username,
							password
						}),
						pending,
						{ fetch: options.fetch, webSocket: options.webSocket, signal: pendingRoute.signal }
					),
					route: pendingRoute,
					runtime: selected
				};
				access = known({ endpoint: resolved.endpoint, username: resolved.username });
				return { endpoint: resolved.endpoint, username: resolved.username };
			},
			undefined,
			{
				requiresPassword: !options.resolveAccess,
				acceptsPassword: true,
				acquireClients: ['opencode']
			}
		),
		providers: connected(async (_input, context) => providers(context)),
		modelInventory: connected(async (_input, context) => (await providers(context)).providers),
		setKey: connected(async (input, context) => {
			verifiedModel = undefined;
			await (await bound(context)).setProviderApiKey(input.provider, input.key, {
				signal: context.signal
			});
		}),
		removeProvider: connected(async (input, context) => {
			verifiedModel = undefined;
			if (input.endpoint)
				return removeProviderSetup((await management(context)).settings, input.provider, {
					endpoint: true,
					signal: context.signal
				});
			await (await bound(context)).removeProviderAuth(input.provider, { signal: context.signal });
			return providers(context);
		}),
		oauthStart: connected(async (input, context) => {
			verifiedModel = undefined;
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
			verifiedModel =
				result.ok && result.provider && result.model
					? { provider: result.provider, model: result.model }
					: undefined;
			return result;
		}),
		selectModel: connected(async (input, context) => {
			if (verifiedModel?.provider !== input.provider || verifiedModel.model !== input.model)
				throw new Error('Test this model before using it for your agent.');
			return useProviderModel((await management(context)).settings, input.provider, input.model, {
				signal: context.signal
			});
		}),
		saveEndpoint: connected(async (input, context) => {
			verifiedModel = undefined;
			return saveProviderEndpoint((await management(context)).settings, input, {
				signal: context.signal
			});
		}),
		discoverModels: connected(async (input, context) =>
			discoverProviderModels((await management(context)).settings, input)
		),
		remote: connected(async (input, context) => {
			if (!['claude', 'codex'].includes(input.tool)) throw new Error('Choose claude or codex.');
			if (input.action === 'disable')
				throw new Error(
					'Change native worker startup in deployment settings and apply it explicitly. Cancelling sign-in never changes startup intent.'
				);
			if (input.action === 'connection') {
				const selected = await management(context, false);
				const settings = await selected.remoteSettings();
				if (!settings[input.tool])
					throw new Error('Enable the worker in deployment settings first.');
				return {
					tool: input.tool,
					stage: 'connection',
					output: await selected.remoteConnection(input.tool),
					running: false,
					enabled: true
				};
			}
			if (input.action !== 'enable') {
				if (!remote || remote.progress.tool !== input.tool)
					throw new Error('Start native setup for this worker first.');
				if (input.action === 'cancel') {
					remote.startup?.abort();
					await remote.session?.cancel();
				} else if (input.action === 'input') {
					await management(context, false);
					if (
						input.input === undefined ||
						input.input.length > 2_048 ||
						[...input.input].some((character) => {
							const code = character.charCodeAt(0);
							return code < 32 || code === 127;
						})
					)
						throw new Error('Enter a single native setup response.');
					remote.session?.input(JSON.stringify({ input: input.input }) + '\n');
				}
				return { ...remote.progress };
			}
			if (input.trusted !== true)
				throw new Error('Confirm trusted native access; it bypasses Guardian.');
			if (remote?.progress.running)
				throw new Error('Finish or cancel the existing native setup first.');
			const selected = await management(context);
			const settings = await selected.remoteSettings();
			const sandbox = input.sandbox ?? settings.sandbox;
			if (!['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox))
				throw new Error('Choose a supported native Codex isolation mode.');
			if (input.tool === 'codex' && sandbox !== settings.sandbox)
				throw new Error(
					'Save and apply the chosen native isolation mode in deployment settings before sign-in.'
				);
			const startup = new AbortController();
			const current: {
				progress: RemoteProgress;
				session?: NativePtySession;
				startup?: AbortController;
			} = {
				progress: {
					tool: input.tool,
					stage: 'starting',
					output: '',
					running: true,
					enabled: settings[input.tool]
				} as RemoteProgress,
				startup
			};
			remote = current;
			let buffer = '',
				ready = false;
			try {
				current.session = await selected.remoteSetup(
					input.tool,
					sandbox,
					(text) => {
						buffer += text;
						while (buffer.includes('\n')) {
							const end = buffer.indexOf('\n'),
								line = buffer.slice(0, end).trim();
							buffer = buffer.slice(end + 1);
							if (!line) continue;
							try {
								const item = JSON.parse(line) as Record<string, unknown>;
								if (typeof item.stage === 'string') current.progress.stage = item.stage;
								if (typeof item.output === 'string')
									current.progress.output = (
										item.replace === true ? item.output : current.progress.output + item.output
									).slice(-65_536);
								if (typeof item.error === 'string') current.progress.error = item.error;
								if (item.ready === true) ready = true;
							} catch {
								current.progress.error = 'Native setup output was invalid; setup was interrupted.';
								void current.session?.cancel();
							}
						}
					},
					{
						signal: AbortSignal.any(
							[context.signal, startup.signal].filter(
								(value): value is AbortSignal => value instanceof AbortSignal
							)
						)
					}
				);
				current.startup = undefined;
				void current.session.done
					.then(({ exitCode }) => {
						current.progress.running = false;
						current.progress.stage =
							exitCode === 0 && ready && !current.progress.error ? 'complete' : 'failed';
						if (current.progress.stage === 'failed')
							current.progress.error ??=
								'Native setup did not complete. Review its output; startup settings were preserved.';
					})
					.catch(() => {
						current.progress.running = false;
						current.progress.stage = 'interrupted';
						current.progress.error =
							'Native setup disconnected or was cancelled. Input was not replayed and deployment settings were preserved.';
					});
			} catch (error) {
				current.progress.running = false;
				throw error;
			}
			return { ...current.progress };
		}),
		codexRecall: unsupportedOperation(
			'Native hook inspection requires a qualified runtime command session.'
		)
	};
	return {
		agent,
		recoveryStatus: connected(async (_input, context) =>
			(await management(context)).recoveryStatus()
		),
		recoveryInspect: options.recoveryEnvironment
			? connected(async (_input, context) =>
					(await management(context)).recoveryInspect(await options.recoveryEnvironment!())
				)
			: unsupportedOperation(
					'Native coverage inspection requires the selected deployment’s recovery configuration.'
				),
		busy: () => remote?.progress.running === true,
		inspectApplication: async () => ({ agent: { access, account, models, readiness } }),
		async close() {
			clearConnection('The native agent connection is closed.');
			connection = { state: 'closed' };
		}
	};
}

import {
	discoverProviderModels,
	listProviderSettings,
	removeProviderSetup,
	saveProviderEndpoint,
	useProviderModel,
	type NativeProviderSettingsPort
} from '../control-plane/provider-settings.js';
import type { AssistantReadiness } from '../control-plane/native-agent.js';
import type { AgentOperations, RequestContext } from './contracts.js';

type AgentInput<Name extends keyof AgentOperations> = Parameters<
	Extract<AgentOperations[Name], { support: 'supported' }>['invoke']
>[0];

/**
 * Provider/account use cases over an explicitly selected native agent route,
 * shared by local Docker homes and session-bound HTTPS agents. It owns only the
 * temporary browser-auth attempt and model-verification state; native settings
 * retain their own persistence semantics.
 */
export class AgentServices {
	private closed = false;
	private readonly lifetime = new AbortController();
	private pendingOAuth: { provider: string; method: number; attemptID: string } | undefined;
	private verifiedModel: Extract<AssistantReadiness, { ok: true }> | undefined;

	constructor(
		private readonly options: {
			/** Resolve the current route; `writing` asks for a target safe to change. */
			bind(context: RequestContext, writing: boolean): Promise<NativeProviderSettingsPort>;
			openUrl?(url: string): void;
			completeSetup?(readiness: Extract<AssistantReadiness, { ok: true }>): Promise<void>;
		}
	) {}

	private requireOpen() {
		if (this.closed) throw new Error('This agent session is closed. Open the instance again.');
	}
	private signal(context: RequestContext): AbortSignal {
		return context.signal
			? AbortSignal.any([context.signal, this.lifetime.signal])
			: this.lifetime.signal;
	}
	private async target(context: RequestContext, writing = true) {
		this.requireOpen();
		const target = await this.options.bind(context, writing);
		this.requireOpen();
		return target;
	}
	private async completeReadiness(
		readiness: Extract<AssistantReadiness, { ok: true }>
	): Promise<string | undefined> {
		this.requireOpen();
		try {
			await this.options.completeSetup?.(readiness);
		} catch {
			return 'The native model test passed, but installation completion could not be saved. Review the instance status; the model test does not need to be repeated.';
		}
	}
	async providers(context: RequestContext = {}) {
		return listProviderSettings(await this.target(context, false), { signal: this.signal(context) });
	}
	async setKey(input: AgentInput<'setKey'>, context: RequestContext = {}): Promise<void> {
		this.verifiedModel = undefined;
		const target = await this.target(context);
		await target.agent.setProviderApiKey(input.provider, input.key, {
			signal: this.signal(context)
		});
	}
	async endpoint(input: AgentInput<'saveEndpoint'>, context: RequestContext = {}) {
		this.verifiedModel = undefined;
		return saveProviderEndpoint(await this.target(context), input, {
			signal: this.signal(context)
		});
	}
	async models(input: AgentInput<'discoverModels'>, context: RequestContext = {}) {
		return discoverProviderModels(await this.target(context), input);
	}
	async use(input: AgentInput<'selectModel'>, context: RequestContext = {}) {
		const verified = this.verifiedModel;
		const settings = await useProviderModel(await this.target(context), input.provider, input.model, {
			signal: this.signal(context)
		});
		this.requireOpen();
		// Setup completion still needs a passed native test of the selected model.
		if (
			settings.write?.effective === 'verified' &&
			verified?.provider === input.provider &&
			verified.model === input.model
		) {
			const warning = await this.completeReadiness(verified);
			if (warning)
				settings.configurationIssue = [settings.configurationIssue, warning]
					.filter(Boolean)
					.join(' ');
		}
		return settings;
	}
	async remove(input: AgentInput<'removeProvider'>, context: RequestContext = {}) {
		this.verifiedModel = undefined;
		return removeProviderSetup(await this.target(context), input.provider, {
			endpoint: input.endpoint === true,
			signal: this.signal(context)
		});
	}
	async oauthStart(input: AgentInput<'oauthStart'>, context: RequestContext = {}) {
		this.verifiedModel = undefined;
		const target = await this.target(context);
		const authorization = await target.agent.beginProviderOAuth(
			input.provider,
			input.method,
			input.inputs,
			{ signal: this.signal(context) }
		);
		this.requireOpen();
		this.pendingOAuth = {
			provider: input.provider,
			method: input.method,
			attemptID: authorization.attemptID
		};
		this.options.openUrl?.(authorization.url);
		return authorization;
	}
	async oauthFinish(input: AgentInput<'oauthFinish'>, context: RequestContext = {}) {
		const target = await this.target(context);
		const pending = this.pendingOAuth;
		if (!pending || pending.provider !== input.provider || pending.method !== input.method)
			throw new Error('Start sign-in for this account in the current agent connection first.');
		// An exchange is single-use, including an uncertain network response.
		this.pendingOAuth = undefined;
		this.verifiedModel = undefined;
		await target.agent.completeProviderOAuth(pending.provider, pending.attemptID, input.code, {
			signal: this.signal(context)
		});
		this.requireOpen();
	}
	async readiness(input: AgentInput<'readiness'> = {}, context: RequestContext = {}) {
		const target = await this.target(context);
		const readiness = await target.agent.testReadiness({
			signal: this.signal(context),
			provider: input.provider,
			model: input.model
		});
		this.requireOpen();
		this.verifiedModel = readiness.ok ? readiness : undefined;
		if (!readiness.ok || !this.options.completeSetup) return readiness;
		const settings = input.provider
			? await listProviderSettings(target, { signal: this.signal(context) }).catch(() => undefined)
			: undefined;
		this.requireOpen();
		if (
			!input.provider ||
			(settings?.currentModel?.provider === readiness.provider &&
				settings?.currentModel?.model === readiness.model)
		) {
			const warning = await this.completeReadiness(readiness);
			if (warning) return { ...readiness, warning };
		}
		return readiness;
	}
	/** Forget a sign-in attempt and model test that belonged to a replaced route. */
	reset(): void {
		this.pendingOAuth = undefined;
		this.verifiedModel = undefined;
	}
	close(): void {
		// OpenCode has no native OAuth cancellation API. Discard only this local
		// attempt reference; its provider-side attempt expires independently.
		this.closed = true;
		this.lifetime.abort();
		this.reset();
	}
}

import {
	beginProviderOAuth,
	completeProviderOAuth,
	setProviderApiKey,
	testAssistantReadiness,
	type AssistantReadiness
} from '../control-plane/opencode.js';
import {
	discoverProviderModels,
	listProviderSettings,
	removeProviderSetup,
	saveProviderEndpoint,
	useProviderModel
} from '../control-plane/provider-settings.js';
import { connectionDetails } from '../control-plane/connection.js';
import type { FholdState } from '../control-plane/foundation.js';
import type { AgentOperations } from './contracts.js';

type AgentInput<Name extends keyof AgentOperations> = Parameters<
	Extract<AgentOperations[Name], { support: 'supported' }>['invoke']
>[0];

/**
 * Local provider/account use cases. It owns only temporary browser-auth and
 * verification state; deployment intent remains in the caller's explicit
 * Docker operation and native settings retain their own persistence semantics.
 */
export class LocalAgentServices {
	private closed = false;
	private readonly lifetime = new AbortController();
	private pendingOAuth:
		| { homeDir: string; provider: string; method: number; attemptID: string }
		| undefined;
	private verifiedModel:
		| { homeDir: string; readiness: Extract<AssistantReadiness, { ok: true }> }
		| undefined;

	constructor(
		private readonly current: () => FholdState,
		private readonly openUrl?: (url: string) => void,
		private readonly completeSetup?: (
			readiness: Extract<AssistantReadiness, { ok: true }>
		) => Promise<void>
	) {}

	private state(): FholdState {
		this.requireOpen();
		return this.current();
	}
	private requireOpen() {
		if (this.closed) throw new Error('This agent session is closed. Open the instance again.');
	}
	private async completeReadiness(
		readiness: Extract<AssistantReadiness, { ok: true }>
	): Promise<string | undefined> {
		this.requireOpen();
		try {
			await this.completeSetup?.(readiness);
		} catch {
			return 'The native model test passed, but installation completion could not be saved. Review the instance status; the model test does not need to be repeated.';
		}
	}
	providers() {
		return listProviderSettings(this.state().homeDir, { signal: this.lifetime.signal });
	}
	async setKey(input: AgentInput<'setKey'>): Promise<void> {
		this.verifiedModel = undefined;
		await setProviderApiKey(this.state().homeDir, input.provider, input.key, {
			signal: this.lifetime.signal
		});
	}
	endpoint(input: AgentInput<'saveEndpoint'>) {
		this.verifiedModel = undefined;
		return saveProviderEndpoint(this.state().homeDir, input, { signal: this.lifetime.signal });
	}
	models(input: AgentInput<'discoverModels'>) {
		return discoverProviderModels(this.state().homeDir, input);
	}
	async use(input: AgentInput<'selectModel'>) {
		const current = this.state();
		if (
			!this.verifiedModel ||
			this.verifiedModel.homeDir !== current.homeDir ||
			this.verifiedModel.readiness.provider !== input.provider ||
			this.verifiedModel.readiness.model !== input.model
		)
			throw new Error('Test this model before using it for your agent.');
		const settings = await useProviderModel(current.homeDir, input.provider, input.model, {
			signal: this.lifetime.signal
		});
		this.requireOpen();
		if (settings.write?.effective === 'verified' && this.verifiedModel) {
			const warning = await this.completeReadiness(this.verifiedModel.readiness);
			if (warning)
				settings.configurationIssue = [settings.configurationIssue, warning]
					.filter(Boolean)
					.join(' ');
		}
		return settings;
	}
	remove(input: AgentInput<'removeProvider'>) {
		this.verifiedModel = undefined;
		return removeProviderSetup(this.state().homeDir, input.provider, {
			endpoint: input.endpoint === true,
			signal: this.lifetime.signal
		});
	}
	async oauthStart(input: AgentInput<'oauthStart'>) {
		const current = this.state();
		const authorization = await beginProviderOAuth(
			current.homeDir,
			input.provider,
			input.method,
			input.inputs,
			{ signal: this.lifetime.signal }
		);
		this.requireOpen();
		this.pendingOAuth = {
			homeDir: current.homeDir,
			provider: input.provider,
			method: input.method,
			attemptID: authorization.attemptID
		};
		this.openUrl?.(authorization.url);
		return authorization;
	}
	async oauthFinish(input: AgentInput<'oauthFinish'>): Promise<void> {
		const current = this.state();
		if (
			!this.pendingOAuth ||
			this.pendingOAuth.homeDir !== current.homeDir ||
			this.pendingOAuth.provider !== input.provider ||
			this.pendingOAuth.method !== input.method
		)
			throw new Error('Start provider sign-in for this instance first.');
		const attemptID = this.pendingOAuth.attemptID;
		// An exchange is single-use, including an uncertain network response.
		this.pendingOAuth = undefined;
		this.verifiedModel = undefined;
		await completeProviderOAuth(current.homeDir, input.provider, attemptID, input.code, {
			signal: this.lifetime.signal
		});
		this.requireOpen();
	}
	readiness(input: AgentInput<'readiness'> = {}) {
		const current = this.state();
		return testAssistantReadiness(current.homeDir, {
			signal: this.lifetime.signal,
			provider: input.provider,
			model: input.model
		}).then(async (readiness) => {
			this.requireOpen();
			this.verifiedModel = readiness.ok ? { homeDir: current.homeDir, readiness } : undefined;
			const settings =
				readiness.ok && input.provider
					? await listProviderSettings(current.homeDir, { signal: this.lifetime.signal }).catch(
							() => undefined
						)
					: undefined;
			this.requireOpen();
			if (
				readiness.ok &&
				(!input.provider ||
					(settings?.currentModel?.provider === readiness.provider &&
						settings?.currentModel?.model === readiness.model))
			) {
				const warning = await this.completeReadiness(readiness);
				if (warning) return { ...readiness, warning };
			}
			return readiness;
		});
	}
	password() {
		const current = this.state();
		const details = connectionDetails(current.homeDir, 'opencode', { showAssistantPassword: true });
		if (!details.password) throw new Error('OpenCode password is unavailable.');
		return { password: details.password };
	}
	close(): void {
		// OpenCode has no native OAuth cancellation API. Discard only this local
		// attempt reference; its provider-side attempt expires independently.
		this.closed = true;
		this.lifetime.abort();
		this.pendingOAuth = undefined;
		this.verifiedModel = undefined;
	}
}

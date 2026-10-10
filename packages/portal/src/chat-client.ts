import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import type { PortalCredential } from './credential-registry.js';
import { createLogger, errorMessage } from './runtime.js';

export type PortalQuestion = {
	question: string;
	options: Array<{ label: string; description: string }>;
	multiple?: boolean;
	custom?: boolean;
};
export type PortalInteraction =
	| { kind: 'question'; handle: string; questions: PortalQuestion[] }
	| {
			kind: 'permission';
			handle: string;
			permission: string;
			patterns: string[];
			allowedDecisions: Array<'once' | 'always' | 'reject'>;
	  };
export type ChatUpdate = {
	conversation: string;
	job: string;
	status: string;
	text: string;
	tools: Array<{ name: string; status: string }>;
};
export type ChatResult = {
	conversation: string;
	text: string;
	pending?: { job: string; interactions: PortalInteraction[] };
};
const log = createLogger('portal:chat');

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function update(value: unknown): ChatUpdate | undefined {
	const data = asRecord(value);
	if (!data || typeof data.session !== 'string' || typeof data.job !== 'string') return;
	return {
		conversation: data.session,
		job: data.job,
		status: typeof data.status === 'string' ? data.status : 'running',
		text: typeof data.text === 'string' ? data.text.slice(0, 100_000) : '',
		tools: Array.isArray(data.tools)
			? data.tools.flatMap((entry) => {
					const tool = asRecord(entry);
					return typeof tool?.name === 'string' && typeof tool.status === 'string'
						? [{ name: tool.name.slice(0, 128), status: tool.status }]
						: [];
				})
			: []
	};
}

function interactions(value: unknown): PortalInteraction[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry): PortalInteraction[] => {
		const data = asRecord(entry);
		if (!data || typeof data.handle !== 'string') return [];
		if (data.kind === 'permission') {
			return [
				{
					kind: 'permission',
					handle: data.handle,
					permission: typeof data.permission === 'string' ? data.permission : 'action',
					patterns: Array.isArray(data.patterns)
						? data.patterns.filter((v): v is string => typeof v === 'string')
						: [],
					allowedDecisions: Array.isArray(data.allowedDecisions)
						? data.allowedDecisions.filter(
								(v): v is 'once' | 'always' | 'reject' =>
									v === 'once' || v === 'always' || v === 'reject'
							)
						: ['reject']
				}
			];
		}
		if (data.kind !== 'question' || !Array.isArray(data.questions)) return [];
		const questions = data.questions.flatMap((entry): PortalQuestion[] => {
			const question = asRecord(entry);
			if (typeof question?.question !== 'string') return [];
			return [
				{
					question: question.question,
					options: Array.isArray(question.options)
						? question.options.flatMap((entry) => {
								const option = asRecord(entry);
								return typeof option?.label === 'string'
									? [
											{
												label: option.label,
												description:
													typeof option.description === 'string' ? option.description : ''
											}
										]
									: [];
							})
						: [],
					multiple: question.multiple === true,
					custom: question.custom !== false
				}
			];
		});
		return questions.length ? [{ kind: 'question', handle: data.handle, questions }] : [];
	});
}

function contentText(content: unknown): string {
	if (!Array.isArray(content)) return '';
	return content
		.map((item) => {
			const value = asRecord(item);
			return value?.type === 'text' && typeof value.text === 'string' ? value.text : '';
		})
		.filter(Boolean)
		.join('\n');
}

function interactionText(structured: Record<string, unknown>): string {
	const interactions = Array.isArray(structured.interactions) ? structured.interactions : [];
	const lines = interactions.flatMap((entry) => {
		const interaction = asRecord(entry);
		if (interaction?.kind === 'question' && Array.isArray(interaction.questions)) {
			return interaction.questions.map((question) => {
				const value = asRecord(question);
				const text = typeof value?.question === 'string' ? value.question : 'Agent input required';
				const options = Array.isArray(value?.options)
					? value.options
							.map((option) => asRecord(option)?.label)
							.filter((label): label is string => typeof label === 'string')
					: [];
				return options.length ? `${text}\nOptions: ${options.join(', ')}` : text;
			});
		}
		if (interaction?.kind === 'permission') {
			const permission =
				typeof interaction.permission === 'string' ? interaction.permission : 'privileged action';
			return [
				`The agent is waiting for permission to perform ${permission}. Use a full MCP client to approve or reject it explicitly.`
			];
		}
		return [];
	});
	return lines.join('\n\n') || 'The agent is waiting for input. Use an MCP client to respond.';
}

export class GuardianChatClient {
	private readonly connections = new Map<
		string,
		{ key: string; client?: Client; connecting?: Promise<Client> }
	>();

	private async createClient(token: string): Promise<Client> {
		const url = new URL(process.env.MCP_SERVER_URL ?? 'http://guardian:8080/mcp');
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			throw new Error('MCP_SERVER_URL must use http or https');
		}
		const transport = new StreamableHTTPClientTransport(url, {
			authProvider: { token: async () => token }
		});
		const client = new Client(
			{ name: 'fhold-portal', version: '2' },
			{ capabilities: {}, versionNegotiation: { mode: 'auto' } }
		);
		await client.connect(transport, { timeout: 15_000 });
		return client;
	}

	private async clientFor(credential: PortalCredential): Promise<Client> {
		let slot = this.connections.get(credential.username);
		if (slot && slot.key !== credential.key) {
			this.connections.delete(credential.username);
			const oldClient = slot.client ?? (await slot.connecting?.catch(() => undefined));
			if (oldClient) await oldClient.close().catch(() => {});
			slot = undefined;
		}
		if (slot?.client) return slot.client;
		if (slot?.connecting) return slot.connecting;
		const next: { key: string; client?: Client; connecting?: Promise<Client> } = {
			key: credential.key
		};
		next.connecting = this.createClient(credential.key);
		this.connections.set(credential.username, next);
		try {
			next.client = await next.connecting;
			next.connecting = undefined;
			return next.client;
		} catch (error) {
			if (this.connections.get(credential.username) === next) {
				this.connections.delete(credential.username);
			}
			throw error;
		}
	}

	async connect(credential: PortalCredential): Promise<void> {
		await this.clientFor(credential);
	}

	private async call(
		name: string,
		args: Record<string, unknown>,
		credential: PortalCredential,
		onUpdate?: (update: ChatUpdate) => Promise<unknown>
	) {
		const client = await this.clientFor(credential);
		let delivery = Promise.resolve();
		const result = await client
			.callTool(
				{ name, arguments: args },
				{
					timeout: 45_000,
					maxTotalTimeout: 45_000,
					resetTimeoutOnProgress: true,
					onprogress: (notification) => {
						const meta = asRecord(asRecord(notification)?._meta);
						const snapshot = update(meta?.['io.fwdslsh.fhold/agent']);
						if (!snapshot || !onUpdate) return;
						delivery = delivery
							.then(async () => {
								await onUpdate(snapshot);
							})
							.catch((error) => {
								log.warn('progress_delivery_failed', { error: errorMessage(error) });
							});
					}
				}
			)
			.catch(async (error: unknown) => {
				const slot = this.connections.get(credential.username);
				if (slot?.client === client) this.connections.delete(credential.username);
				await client.close().catch(() => {});
				throw error;
			});
		await delivery;
		const snapshot = !result.isError ? update(result.structuredContent) : undefined;
		if (snapshot && onUpdate) {
			await onUpdate(snapshot).catch((error) => {
				log.warn('progress_delivery_failed', { error: errorMessage(error) });
			});
		}
		return result;
	}

	async chat(
		message: string,
		credential: PortalCredential,
		conversation?: string,
		onUpdate?: (update: ChatUpdate) => Promise<unknown>
	): Promise<ChatResult> {
		const result = await this.call(
			'fhold.agent.run',
			{
				message,
				...(conversation ? { session: conversation } : {}),
				waitMs: 30_000
			},
			credential,
			onUpdate
		);
		return this.track(result, credential, onUpdate);
	}

	async resume(
		job: string,
		credential: PortalCredential,
		onUpdate?: (update: ChatUpdate) => Promise<unknown>
	): Promise<ChatResult> {
		const result = await this.call('fhold.job.get', { job, waitMs: 30_000 }, credential, onUpdate);
		return this.track(result, credential, onUpdate);
	}

	async respond(
		credential: PortalCredential,
		input: { interaction: string; decision?: 'once' | 'always' | 'reject'; answers?: string[][] }
	): Promise<void> {
		const result = await this.call('fhold.interaction.respond', input, credential);
		if (result.isError)
			throw new Error(contentText(result.content) || 'The response could not be recorded.');
	}

	async cancel(job: string, credential: PortalCredential): Promise<void> {
		const result = await this.call('fhold.job.cancel', { job }, credential);
		if (result.isError)
			throw new Error(contentText(result.content) || 'The job could not be stopped.');
	}

	private async track(
		initial: Awaited<ReturnType<GuardianChatClient['call']>>,
		credential: PortalCredential,
		onUpdate?: (update: ChatUpdate) => Promise<unknown>
	): Promise<ChatResult> {
		let result = initial;
		let structured = asRecord(result.structuredContent);
		while (!result.isError && structured?.status === 'running') {
			if (typeof structured.job !== 'string') {
				throw new Error('Guardian did not provide a handle for the running job.');
			}
			result = await this.call(
				'fhold.job.get',
				{
					job: structured.job,
					waitMs: 30_000
				},
				credential,
				onUpdate
			);
			structured = asRecord(result.structuredContent);
		}

		if (result.isError || typeof structured?.session !== 'string') {
			throw new Error(
				(contentText(result.content) || 'Guardian rejected the request').slice(0, 300)
			);
		}
		if (structured.status === 'input_required') {
			const pending = interactions(structured.interactions);
			return {
				conversation: structured.session,
				text: interactionText(structured).slice(0, 100_000),
				...(typeof structured.job === 'string' && pending.length
					? { pending: { job: structured.job, interactions: pending } }
					: {})
			};
		}
		if (structured.status === 'failed') {
			throw new Error(
				(typeof structured.error === 'string' ? structured.error : 'The agent run failed.').slice(
					0,
					300
				)
			);
		}
		const text =
			typeof structured.text === 'string' ? structured.text : contentText(result.content);
		return {
			conversation: structured.session,
			text: (text || '(no text response)').slice(0, 100_000)
		};
	}

	async close(): Promise<void> {
		const slots = [...this.connections.values()];
		this.connections.clear();
		await Promise.all(
			slots.map(async (slot) => {
				const client = slot.client ?? (await slot.connecting?.catch(() => undefined));
				if (client) await client.close().catch(() => {});
			})
		);
	}
}

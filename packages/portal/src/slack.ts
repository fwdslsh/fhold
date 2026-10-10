import { App, SocketModeReceiver, type SayFn, type types } from '@slack/bolt';

import { GuardianChatClient, type ChatUpdate } from './chat-client.js';
import { ConversationStore } from './conversations.js';
import { PortalCredentialRegistry, credentialConversationKey } from './credential-registry.js';
import { ConversationQueue } from './queue.js';
import { PortalInteractions, promptView, type PendingPrompt } from './interactions.js';
import { LiveReply, toolEmoji } from './live-reply.js';
import {
	createLogger,
	errorMessage,
	isAllowed,
	parseIds,
	readSecret,
	splitMessage
} from './runtime.js';

const log = createLogger('portal:slack');

type SlackMessage = {
	user: string;
	text?: string;
	channel: string;
	ts: string;
	thread_ts?: string;
	channel_type?: string;
	subtype?: string;
	bot_id?: string;
};
type SlackBlocks = types.KnownBlock[];

export class SlackPortal {
	private readonly chat = new GuardianChatClient();
	private readonly credentials = new PortalCredentialRegistry('slack');
	private readonly conversations = new ConversationStore();
	private readonly queue = new ConversationQueue();
	private readonly interactions = new PortalInteractions(this.chat);
	private readonly actionLocations = new Map<
		string,
		{
			key: string;
			channel: string;
			ts: string;
			questionIndex?: number;
			post?: (text: string) => Promise<unknown>;
		}
	>();
	private readonly allowedChannels = parseIds(process.env.SLACK_ALLOWED_CHANNELS);
	private readonly allowedUsers = parseIds(process.env.SLACK_ALLOWED_USERS);
	private readonly blockedUsers = parseIds(process.env.SLACK_BLOCKED_USERS);
	private readonly receiver = new SocketModeReceiver({
		appToken: readSecret('SLACK_APP_TOKEN')
	});
	private readonly app = new App({
		token: readSecret('SLACK_BOT_TOKEN'),
		receiver: this.receiver
	});
	private botUserId = '';

	isReady(): boolean {
		return this.receiver.client.websocket?.isActive() ?? false;
	}

	async start(): Promise<void> {
		await this.chat.connect(this.credentials.defaultCredential());
		this.app.event('app_mention', async ({ event, say }) => {
			await this.handleMessage(event as SlackMessage, say, true);
		});
		this.app.event('message', async ({ event, say }) => {
			const message = event as SlackMessage;
			if (message.text?.includes(`<@${this.botUserId}>`)) return;
			await this.handleMessage(message, say, false);
		});
		this.app.action(/^fh:/, async ({ ack, action, body }) => {
			await ack();
			if (body.type !== 'block_actions' || action.type !== 'button' || !('action_id' in action))
				return;
			const channel = body.channel?.id;
			try {
				const id = action.value ?? '';
				const location = this.actionLocations.get(id);
				if (
					!channel ||
					!location ||
					location.channel !== channel ||
					location.ts !== body.message?.ts
				) {
					throw new Error('This control is no longer active.');
				}
				if (!this.permitted({ user: body.user.id, channel, ts: location.ts }))
					throw new Error('You do not have permission to use this bot.');
				const credential = this.credentials.forUser(body.user.id);
				if (action.action_id === 'fh:stop') {
					await this.interactions.stop(id, location.key, body.user.id, credential);
					return;
				}
				const [, value, page] = action.action_id.split(':');
				const prompt = this.interactions.get(id, body.user.id, credential, location.key);
				if (Number(page) !== prompt.questionIndex)
					throw new Error('This question has changed. Use its current buttons.');
				await this.interactions.action(prompt, credential, value);
				await this.refreshPrompt(prompt).catch((error) =>
					log.warn('prompt_update_failed', { error: errorMessage(error) })
				);
			} catch (error) {
				log.warn('interaction_failed', { error: errorMessage(error) });
				if (channel)
					await this.app.client.chat
						.postEphemeral({
							channel,
							user: body.user.id,
							text: errorMessage(error).slice(0, 2_000)
						})
						.catch(() => {});
			}
		});
		this.app.error(async (error) => log.error('client_error', { error: errorMessage(error) }));
		await this.app.start();
		const auth = await this.app.client.auth.test();
		this.botUserId = typeof auth.user_id === 'string' ? auth.user_id : '';
		log.info('connected', { botUserId: this.botUserId });
	}

	private key(message: SlackMessage): string {
		if (message.channel_type === 'im') return `dm:${message.user}`;
		return `thread:${message.channel}:${message.thread_ts ?? message.ts}`;
	}

	private permitted(message: SlackMessage): boolean {
		return isAllowed({
			userId: message.user,
			blockedUsers: this.blockedUsers,
			scopes: [
				{ allowed: this.allowedUsers, actual: [message.user] },
				{ allowed: this.allowedChannels, actual: [message.channel] }
			]
		});
	}

	private async handleMessage(
		message: SlackMessage,
		say: SayFn,
		mentioned: boolean
	): Promise<void> {
		if (!message.user || !message.text || message.subtype || message.bot_id) return;
		if (this.botUserId && message.user === this.botUserId) return;
		const credential = this.credentials.forUser(message.user);
		const key = credentialConversationKey(credential.username, this.key(message));
		const direct = message.channel_type === 'im';
		const activeThread = Boolean(
			message.thread_ts && (this.conversations.get('slack', key) || this.queue.isActive(key))
		);
		if (!mentioned && !direct && !activeThread) return;

		const threadTs = message.thread_ts ?? message.ts;
		if (!this.permitted(message)) {
			await say({ text: 'You do not have permission to use this bot.', thread_ts: threadTs });
			return;
		}

		const text = message.text.replace(/<@[A-Z0-9]+>/g, '').trim();
		if (!text) return;
		const pending = this.interactions.forKey(key);
		if (pending) {
			try {
				const prompt = this.interactions.get(pending.id, message.user, credential, key);
				await this.interactions.answer(prompt, credential, [text]);
				await this.refreshPrompt(prompt).catch((error) =>
					log.warn('prompt_update_failed', { error: errorMessage(error) })
				);
			} catch (error) {
				await say({ text: errorMessage(error), thread_ts: threadTs });
			}
			return;
		}
		if (text === '/clear' || text === '!clear') {
			this.conversations.clear('slack', key);
			await say({ text: 'Conversation cleared.', thread_ts: threadTs });
			return;
		}

		await this.queue.run(key, async () => {
			let stopId = '';
			let head: { ts: string; text: string } | undefined;
			const stopBlocks = (text: string): SlackBlocks =>
				stopId
					? [
							{ type: 'section', text: { type: 'mrkdwn', text } },
							{
								type: 'actions',
								elements: [
									{
										type: 'button',
										action_id: 'fh:stop',
										value: stopId,
										text: { type: 'plain_text', text: 'Stop' }
									}
								]
							}
						]
					: [];
			const live = new LiveReply(async (text) => {
				const first = !head;
				const posted = await say({
					text,
					thread_ts: threadTs,
					...(first ? { blocks: stopBlocks(text) } : {})
				});
				if (!posted.ts) throw new Error('Slack did not return the posted message timestamp.');
				const ts = posted.ts;
				if (first) {
					head = { ts, text };
					this.actionLocations.set(stopId, { key, channel: message.channel, ts });
				}
				return {
					edit: async (text) => {
						await this.app.client.chat.update({
							channel: message.channel,
							ts,
							text,
							...(first ? { blocks: stopBlocks(text) } : {})
						});
						if (first) head = { ts, text };
					}
				};
			}, 2_900);
			const activity = new LiveReply(async (text) => {
				const blocks: SlackBlocks = [{ type: 'context', elements: [{ type: 'mrkdwn', text }] }];
				const posted = await say({ text, thread_ts: threadTs, blocks });
				if (!posted.ts) throw new Error('Slack did not return the activity message timestamp.');
				return {
					edit: (text) =>
						this.app.client.chat.update({
							channel: message.channel,
							ts: posted.ts as string,
							text,
							blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text }] }]
						})
				};
			}, 2_800);
			const reacted = new Set<string>();
			let lastActivity = '';
			const onUpdate = async (update: ChatUpdate) => {
				this.conversations.set('slack', key, update.conversation);
				stopId = this.interactions.working(key, message.user, credential, update.job);
				for (const tool of update.tools) {
					const emoji = toolEmoji(tool.name).slack;
					if (reacted.has(emoji)) continue;
					reacted.add(emoji);
					void this.app.client.reactions
						.add({ name: emoji, channel: message.channel, timestamp: message.ts })
						.catch((error) => log.warn('reaction_unavailable', { error: errorMessage(error) }));
				}
				lastActivity = update.tools
					.map((tool) => `${toolEmoji(tool.name).discord} ${tool.name} — ${tool.status}`)
					.join('\n');
				await activity
					.update(lastActivity)
					.catch((error) => log.warn('activity_delivery_failed', { error: errorMessage(error) }));
				await live.update(
					update.text ||
						(update.status === 'input_required'
							? 'Waiting for your response…'
							: update.status === 'running'
								? 'Working…'
								: '')
				);
			};
			try {
				let result = await this.chat.chat(
					text,
					credential,
					this.conversations.get('slack', key),
					onUpdate
				);
				while (result.pending) {
					this.conversations.set('slack', key, result.conversation);
					const previous = this.interactions.forKey(key);
					const prompt = this.interactions.open(key, message.user, credential, result);
					if (!prompt) break;
					if (previous && previous.id !== prompt.id)
						await this.refreshPrompt(previous).catch(() => {});
					if (!this.actionLocations.has(prompt.id)) {
						const post = (text: string) => say({ text, thread_ts: threadTs });
						for (const chunk of splitMessage(promptView(prompt).text, 2_900).slice(0, -1))
							await post(chunk);
						const posted = await say({ ...this.promptPayload(prompt), thread_ts: threadTs });
						if (!posted.ts) throw new Error('Slack did not return the question message timestamp.');
						this.actionLocations.set(prompt.id, {
							key,
							channel: message.channel,
							ts: posted.ts,
							questionIndex: prompt.questionIndex,
							post
						});
					}
					if ((await this.interactions.wait(prompt)) === 'cancelled') break;
					const currentCredential = this.credentials.forUser(message.user);
					if (currentCredential.username !== credential.username)
						throw new Error('The access mapping changed during this conversation.');
					result = await this.chat.resume(prompt.job, currentCredential, onUpdate);
				}
				this.conversations.set('slack', key, result.conversation);
				await live.update(this.interactions.cancelled(key) ? 'Work stopped.' : result.text, true);
			} catch (error) {
				log.warn('conversation_failed', {
					userId: message.user,
					channelId: message.channel,
					error: errorMessage(error)
				});
				await live.update(
					this.interactions.cancelled(key)
						? 'Work stopped.'
						: 'The request could not be completed. You can check the session in OpenCode.',
					true
				);
			} finally {
				const prompt = this.interactions.forKey(key);
				this.interactions.close(key);
				if (prompt)
					await this.refreshPrompt(prompt).catch((error) =>
						log.warn('prompt_update_failed', { error: errorMessage(error) })
					);
				await activity
					.update(lastActivity, true)
					.catch((error) => log.warn('activity_delivery_failed', { error: errorMessage(error) }));
				this.actionLocations.delete(stopId);
				if (head)
					await this.app.client.chat
						.update({ channel: message.channel, ts: head.ts, text: head.text, blocks: [] })
						.catch((error) =>
							log.warn('stop_control_cleanup_failed', { error: errorMessage(error) })
						);
			}
		});
	}

	private promptPayload(prompt: PendingPrompt): { text: string; blocks: SlackBlocks } {
		const view = promptView(prompt);
		const text = splitMessage(view.text, 2_900).at(-1) ?? 'Agent input required.';
		const blocks: SlackBlocks = [{ type: 'section', text: { type: 'plain_text', text } }];
		for (let index = 0; index < view.actions.length; index += 5) {
			blocks.push({
				type: 'actions',
				elements: view.actions.slice(index, index + 5).map((action) => ({
					type: 'button',
					action_id: `fh:${action.value}:${prompt.questionIndex}`,
					value: prompt.id,
					text: { type: 'plain_text', text: action.label.slice(0, 75) || 'Answer' },
					...(action.danger
						? { style: 'danger' as const }
						: action.selected
							? { style: 'primary' as const }
							: {})
				}))
			});
		}
		return { text, blocks };
	}

	private async refreshPrompt(prompt: PendingPrompt): Promise<void> {
		const location = this.actionLocations.get(prompt.id);
		if (!location) return;
		const pending = this.interactions.forKey(prompt.key) === prompt;
		if (pending && location.questionIndex !== prompt.questionIndex) {
			for (const chunk of splitMessage(promptView(prompt).text, 2_900).slice(0, -1))
				await location.post?.(chunk);
			location.questionIndex = prompt.questionIndex;
		}
		await this.app.client.chat.update({
			channel: location.channel,
			ts: location.ts,
			...(pending
				? this.promptPayload(prompt)
				: {
						text: prompt.outcome === 'answered' ? 'Response recorded.' : 'Request closed.',
						blocks: []
					})
		});
		if (!pending) this.actionLocations.delete(prompt.id);
	}
}

import { App, SocketModeReceiver, type SayFn, type types } from '@slack/bolt';

import { GuardianChatClient, PortalConnectionError, portalFailureText, type ChatUpdate, type ChatResult } from './chat-client.js';
import { DeliveryAccess, PortalDelivery, UnconfirmedDeliveryError } from './delivery.js';
import { ConversationStore } from './conversations.js';
import { PortalCredentialRegistry, credentialConversationKey, type PortalCredential } from './credential-registry.js';
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
			access: DeliveryAccess;
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
	private markdown = true;

	private answerBlocks(text: string): SlackBlocks {
		return this.markdown
			? [{ type: 'markdown', text }]
			: [{ type: 'section', text: { type: 'plain_text', text } }];
	}

	private async deliverAnswer<T>(send: () => Promise<T>): Promise<T> {
		try {
			return await send();
		} catch (error) {
			// Some Slack apps cannot use native Markdown blocks. Fall back only
			// when Slack explicitly rejects the blocks, never retry uncertain sends.
			if (
				!this.markdown ||
				(error as { data?: { error?: string } })?.data?.error !== 'invalid_blocks'
			)
				throw error;
			this.markdown = false;
			log.warn('markdown_unavailable', {
				message: 'Slack rejected Markdown blocks; using plain text.'
			});
			return send();
		}
	}

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
				const selectedCredential = this.credentials.forUser(body.user.id);
				const credential = location.access.credential();
				if (selectedCredential.username !== credential.username)
					throw new Error('Only the person who requested this work can answer.');
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
		void this.recoverDeliveries().catch((error) => log.error('delivery_recovery_failed', { error: errorMessage(error) }));
	}

	private async recoverDeliveries(): Promise<void> {
		for (const record of this.conversations.pendingDeliveries('slack')) {
			const delivery = new PortalDelivery(record, this.conversations);
			try {
				if (record.state === 'blocked') throw new Error(record.reason);
				const destination = record.destination;
				if (destination.adapter !== 'slack' || record.bot !== this.botUserId) throw new Error('Bot identity changed.');
				const message: SlackMessage = { user: record.user, channel: destination.channel, ts: destination.ts, thread_ts: destination.thread, channel_type: destination.channelType };
				if (!this.permitted(message)) throw new Error('Requester no longer has access to the original conversation.');
				const credential = this.credentials.forUser(record.user);
				delivery.assertCredential(credential);
				if (record.key !== credentialConversationKey(credential.username, this.key(message))) throw new Error('Original conversation identity changed.');
				const say: SayFn = (payload) => this.app.client.chat.postMessage({ ...(typeof payload === 'string' ? { text: payload } : payload), channel: destination.channel });
				void this.runConversation(message, say, record.key, credential, delivery).catch((error) => {
					log.warn('delivery_recovery_failed', { error: errorMessage(error) });
				});
			} catch (error) {
				delivery.blocked(errorMessage(error));
				log.warn('delivery_recovery_blocked', { error: errorMessage(error), message: 'Check the original session in OpenCode; work and approvals were not replayed.' });
			}
		}
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
				const location = this.actionLocations.get(prompt.id);
				if (!location) throw new Error('This prompt is no longer active.');
				await this.interactions.answer(prompt, location.access.credential(), [text]);
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

		const id = `${message.channel}:${message.ts}`;
		if (this.conversations.delivery('slack', id)) return;
		const delivery = PortalDelivery.create(this.conversations, {
			id, key, user: message.user, bot: this.botUserId, input: text,
			destination: { adapter: 'slack', channel: message.channel, ts: message.ts, thread: threadTs, channelType: message.channel_type }
		}, credential);
		await this.runConversation(message, say, key, credential, delivery).catch((error) => {
			if (delivery.record.state === 'queued') delivery.blocked(errorMessage(error));
			throw error;
		});
	}

	private async runConversation(message: SlackMessage, say: SayFn, key: string, credential: PortalCredential, delivery: PortalDelivery): Promise<void> {
		const threadTs = message.thread_ts ?? message.ts;
		await this.queue.run(key, async () => {
			const access = new DeliveryAccess(delivery, () => this.credentials.forUser(message.user));
			const currentCredential = () => access.credential();
			// Progress render failures are intentionally tolerated by the MCP client.
			// Recheck at every platform write, including cached and terminal replies.
			const withAccess = <T>(action: () => Promise<T>) => access.write(action);
			currentCredential();
			if (delivery.record.state === 'submitted' || delivery.record.state === 'blocked') {
				await this.blockDelivery(delivery, message.channel, 'Submission could not be confirmed. Check the original session in OpenCode; it was not repeated.');
				log.warn('delivery_recovery_blocked', { message: delivery.record.reason });
				return;
			}
			let stopId = '';
			const firstReceipt = delivery.record.messages.answer?.[0];
			let head: { ts: string; text: string } | undefined = firstReceipt?.id ? { ts: firstReceipt.id, text: firstReceipt.text } : undefined;
			let restoredControls = false;
			let lastText = head?.text ?? '';
			let delivered = false;
			const stopBlocks = (text: string): SlackBlocks =>
				stopId
					? [
							...this.answerBlocks(text),
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
					: this.answerBlocks(text);
			let live: LiveReply;
			try { live = delivery.liveReply('answer', 2_900, async (text) => {
				const first = !head;
				const posted = await this.deliverAnswer(() => withAccess(() =>
					say({
						text,
						thread_ts: threadTs,
						blocks: first ? stopBlocks(text) : this.answerBlocks(text)
					})
				));
				if (!posted.ts) throw new Error('Slack did not return the posted message timestamp.');
				const ts = posted.ts;
				if (first) {
					head = { ts, text };
					this.actionLocations.set(stopId, { key, access, channel: message.channel, ts });
				}
				return { id: ts };
			}, async (ts, text) => {
				const first = head?.ts === ts;
				await this.deliverAnswer(() => withAccess(() => this.app.client.chat.update({ channel: message.channel, ts, text, blocks: first ? stopBlocks(text) : this.answerBlocks(text) })));
				if (first) head = { ts, text };
			}); } catch (error) {
				await this.blockDelivery(delivery, message.channel, errorMessage(error));
				log.warn('delivery_recovery_blocked', { error: errorMessage(error) });
				return;
			}
			const activity = new LiveReply(async (text) => {
				const blocks: SlackBlocks = [{ type: 'context', elements: [{ type: 'mrkdwn', text }] }];
				const posted = await withAccess(() => say({ text, thread_ts: threadTs, blocks }));
				if (!posted.ts) throw new Error('Slack did not return the activity message timestamp.');
				return {
					edit: (text) =>
						withAccess(() => this.app.client.chat.update({
							channel: message.channel,
							ts: posted.ts as string,
							text,
							blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text }] }]
						}))
				};
			}, 2_800);
			const reacted = new Set<string>();
			let lastActivity = '';
			const onUpdate = async (update: ChatUpdate) => {
				currentCredential();
				delivery.accepted(update.job, update.conversation);
				if (update.text) lastText = update.text;
				this.conversations.set('slack', key, update.conversation);
				stopId = this.interactions.working(key, message.user, credential, update.job);
				if (head) {
					this.actionLocations.set(stopId, { key, access, channel: message.channel, ts: head.ts });
					if (!restoredControls) {
						await this.deliverAnswer(() => withAccess(() => this.app.client.chat.update({ channel: message.channel, ts: head!.ts, text: head!.text, blocks: stopBlocks(head!.text) })));
						restoredControls = true;
					}
				}
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
				let result: ChatResult;
				if (delivery.record.state === 'complete') {
					result = { text: delivery.record.result ?? '', conversation: delivery.record.conversation ?? '' };
				} else if (delivery.record.job) {
					result = await this.chat.resume(delivery.record.job, credential, onUpdate);
				} else {
					const input = delivery.record.input!;
					await live.update('Working…', true);
					delivery.submitting();
					result = await this.chat.chat(input, credential, this.conversations.get('slack', key), onUpdate);
				}
				while (result.pending) {
					currentCredential();
					this.conversations.set('slack', key, result.conversation);
					const previous = this.interactions.forKey(key);
					const prompt = this.interactions.open(key, message.user, credential, result);
					if (!prompt) break;
					if (previous && previous.id !== prompt.id)
						await this.refreshPrompt(previous).catch(() => {});
					if (!this.actionLocations.has(prompt.id)) {
						const post = (text: string) => withAccess(() => say({ text, thread_ts: threadTs }));
						const view = promptView(prompt).text;
						const last = splitMessage(view, 2_900).at(-1);
						delivery.refreshPrompt();
						const promptReply = delivery.liveReply('prompt', 2_900, async (text) => {
							const sent = await withAccess(() => say({ ...(text === last ? this.promptPayload(prompt) : { text }), thread_ts: threadTs }));
							if (!sent.ts) throw new Error('Slack did not return the question message timestamp.');
							return { id: sent.ts };
						}, (ts, text) => withAccess(() => this.app.client.chat.update({ channel: message.channel, ts, ...(text === last ? this.promptPayload(prompt) : { text, blocks: [] }) })));
						await promptReply.update(view, true);
						const lastIndex = splitMessage(view, 2_900).length - 1;
						for (const receipt of delivery.record.messages.prompt.slice(lastIndex + 1))
							await withAccess(() => this.app.client.chat.update({ channel: message.channel, ts: receipt.id!, text: 'Previous controls closed. Use the current controls above.', blocks: [] }));
						const ts = delivery.record.messages.prompt[lastIndex].id!;
						delivery.prompt(ts, prompt.questionIndex);
						this.actionLocations.set(prompt.id, {
							key,
							access,
							channel: message.channel,
							ts,
							questionIndex: prompt.questionIndex,
							post
						});
					}
					if ((await this.interactions.wait(prompt)) === 'cancelled') break;
					result = await this.chat.resume(prompt.job, currentCredential(), onUpdate);
				}
				currentCredential();
				this.conversations.set('slack', key, result.conversation);
				lastText = result.text;
				const text = this.interactions.cancelled(key) ? 'Work stopped.' : result.text;
				delivery.complete(text, result.conversation);
				await live.update(text, true);
				delivered = true;
			} catch (error) {
				log.warn('conversation_failed', {
					userId: message.user,
					channelId: message.channel,
					error: errorMessage(error)
				});
				if (access.revoked) return;
				if (error instanceof UnconfirmedDeliveryError) {
					await this.blockDelivery(delivery, message.channel, error.message);
				}
				else if (delivery.record.state !== 'complete') {
					const text = this.interactions.cancelled(key) ? 'Work stopped.' : `${lastText ? `${lastText}\n\n` : ''}${portalFailureText(error)}`;
					const tracking = Boolean(error instanceof PortalConnectionError && delivery.record.job);
					if (!tracking) delivery.complete(text);
					await live.update(text, true);
					delivered = !tracking;
				}
			} finally {
				const prompt = this.interactions.forKey(key);
				this.interactions.close(key);
				this.actionLocations.delete(stopId);
				try { currentCredential(); } catch { /* No private cleanup writes after access revocation. */ }
				if (!access.revoked) {
					if (prompt)
						await this.refreshPrompt(prompt).catch((error) =>
							log.warn('prompt_update_failed', { error: errorMessage(error) })
						);
					await activity
						.update(lastActivity, true)
						.catch((error) => log.warn('activity_delivery_failed', { error: errorMessage(error) }));
					if (head && delivery.record.reason) head.text = delivery.record.reason;
					const finalHead = head;
					if (finalHead)
						await this.deliverAnswer(() => withAccess(() =>
							this.app.client.chat.update({
								channel: message.channel,
								ts: finalHead.ts,
								text: finalHead.text,
								blocks: this.answerBlocks(finalHead.text)
							})
						)).catch((error) =>
							log.warn('stop_control_cleanup_failed', { error: errorMessage(error) })
						);
					const savedPrompt = delivery.record.prompt;
					if (!prompt && savedPrompt)
						await withAccess(() => this.app.client.chat.update({ channel: message.channel, ts: savedPrompt.message, text: 'Previous controls closed. Use the current response or controls.', blocks: [] }))
							.catch((error) => log.warn('prompt_update_failed', { error: errorMessage(error) }));
					if (delivered && !access.revoked) delivery.finish();
				}
				if (prompt && access.revoked) this.actionLocations.delete(prompt.id);
			}
		});
	}

	private async blockDelivery(delivery: PortalDelivery, channel: string, reason: string): Promise<void> {
		delivery.blocked(reason);
		const access = new DeliveryAccess(delivery, () => this.credentials.forUser(delivery.record.user));
		const ts = delivery.record.messages.answer?.[0]?.id;
		if (ts) await this.deliverAnswer(() => access.write(() => this.app.client.chat.update({ channel, ts, text: reason, blocks: this.answerBlocks(reason) })))
			.catch((error) => log.warn('delivery_notice_failed', { error: errorMessage(error) }));
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
		await location.access.write(() => this.app.client.chat.update({
			channel: location.channel,
			ts: location.ts,
			...(pending
				? this.promptPayload(prompt)
				: {
						text: prompt.outcome === 'answered' ? 'Response recorded.' : 'Request closed.',
						blocks: []
					})
		}));
		if (!pending) this.actionLocations.delete(prompt.id);
	}
}

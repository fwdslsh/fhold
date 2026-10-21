import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	Client,
	Events,
	GatewayIntentBits,
	MessageFlags,
	Partials,
	ThreadAutoArchiveDuration,
	type Interaction,
	type Message
} from 'discord.js';

import { GuardianChatClient, portalFailureText } from './chat-client.js';
import type { ChatUpdate, ChatResult } from './chat-client.js';
import { PortalConnectionError } from './chat-client.js';
import { DeliveryAccess, PortalDelivery, UnconfirmedDeliveryError } from './delivery.js';
import type { PortalCredential } from './credential-registry.js';
import { ConversationStore } from './conversations.js';
import { PortalCredentialRegistry, credentialConversationKey } from './credential-registry.js';
import { ConversationQueue } from './queue.js';
import { PortalInteractions, promptView, type PendingPrompt } from './interactions.js';
import { toolEmoji } from './live-reply.js';
import {
	createLogger,
	errorMessage,
	isAllowed,
	parseIds,
	readSecret,
	splitMessage
} from './runtime.js';

const log = createLogger('portal:discord');

export class DiscordPortal {
	private readonly client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.MessageContent,
			GatewayIntentBits.DirectMessages
		],
		partials: [Partials.Channel, Partials.Message]
	});
	private readonly chat = new GuardianChatClient();
	private readonly credentials = new PortalCredentialRegistry('discord');
	private readonly conversations = new ConversationStore();
	private readonly queue = new ConversationQueue();
	private readonly interactions = new PortalInteractions(this.chat);
	private readonly promptMessages = new Map<
		string,
		{
			message: Message;
			access: DeliveryAccess;
			questionIndex: number;
			post: (content: string, components?: ActionRowBuilder<ButtonBuilder>[]) => Promise<Message>;
		}
	>();
	private readonly allowedGuilds = parseIds(process.env.DISCORD_ALLOWED_GUILDS);
	private readonly allowedRoles = parseIds(process.env.DISCORD_ALLOWED_ROLES);
	private readonly allowedUsers = parseIds(process.env.DISCORD_ALLOWED_USERS);
	private readonly blockedUsers = parseIds(process.env.DISCORD_BLOCKED_USERS);

	isReady(): boolean {
		return this.client.isReady();
	}

	async start(): Promise<void> {
		await this.chat.connect(this.credentials.defaultCredential());
		this.client.on(Events.Error, (error) =>
			log.error('client_error', { error: errorMessage(error) })
		);
		this.client.on(Events.MessageCreate, (message) => {
			void this.onMessage(message).catch((error) => {
				log.error('message_failed', { error: errorMessage(error), messageId: message.id });
			});
		});
		this.client.on(Events.InteractionCreate, (interaction) => {
			void this.onInteraction(interaction).catch((error) =>
				log.warn('interaction_failed', { error: errorMessage(error) })
			);
		});
		const ready = new Promise<void>((resolve) => {
			this.client.once(Events.ClientReady, (client) => {
				log.info('connected', { bot: client.user.tag, guilds: client.guilds.cache.size });
				resolve();
			});
		});
		await this.client.login(readSecret('DISCORD_BOT_TOKEN'));
		await ready;
		void this.recoverDeliveries().catch((error) => log.error('delivery_recovery_failed', { error: errorMessage(error) }));
	}

	private async recoverDeliveries(): Promise<void> {
		for (const record of this.conversations.pendingDeliveries('discord')) {
			const delivery = new PortalDelivery(record, this.conversations);
			try {
				if (record.state === 'blocked') throw new Error(record.reason);
				const destination = record.destination;
				if (destination.adapter !== 'discord' || record.bot !== this.client.user?.id) throw new Error('Bot identity changed.');
				const source = await this.client.channels.fetch(destination.sourceChannel);
				const target = await this.client.channels.fetch(destination.channel);
				if (!source?.isTextBased() || !target?.isTextBased() || !('messages' in source) || !('messages' in target))
					throw new Error('Original conversation is unavailable.');
				const message = await source.messages.fetch(destination.sourceMessage);
				const member = message.guild ? await message.guild.members.fetch({ user: record.user, force: true }) : undefined;
				if (message.author.id !== record.user || message.guildId !== destination.guild ||
					!this.permittedUser(record.user, destination.guild, member?.roles.cache.map((role) => role.id) ?? []))
					throw new Error('Requester no longer has access to the original conversation.');
				const credential = this.credentials.forUser(record.user);
				delivery.assertCredential(credential);
				if (record.key !== credentialConversationKey(credential.username, this.conversationKey(record.user, message.guildId, target as Message['channel'])))
					throw new Error('Original conversation identity changed.');
				void this.runConversation(message, target as Message['channel'], record.key, credential, delivery).catch((error) => {
					log.warn('delivery_recovery_failed', { error: errorMessage(error) });
				});
			} catch (error) {
				delivery.blocked(errorMessage(error));
				log.warn('delivery_recovery_blocked', { error: errorMessage(error), message: 'Check the original session in OpenCode; work and approvals were not replayed.' });
			}
		}
	}

	private conversationKey(user: string, guild: string | null, channel: Message['channel']): string {
		if (!guild) return `dm:${user}`;
		if (channel.isThread()) return `thread:${channel.id}`;
		return `channel:${channel.id}:user:${user}`;
	}

	private permitted(message: Message): boolean {
		return this.permittedUser(
			message.author.id,
			message.guildId,
			message.member?.roles.cache.map((role) => role.id) ?? []
		);
	}

	private permittedUser(user: string, guild: string | null, roles: string[]): boolean {
		return isAllowed({
			userId: user,
			blockedUsers: this.blockedUsers,
			scopes: [
				{ allowed: this.allowedUsers, actual: [user] },
				{ allowed: this.allowedGuilds, actual: guild ? [guild] : [] },
				{
					allowed: this.allowedRoles,
					actual: roles
				}
			]
		});
	}

	private async onMessage(message: Message): Promise<void> {
		if (message.author.bot || !this.client.user) return;
		const credential = this.credentials.forUser(message.author.id);
		let key = credentialConversationKey(
			credential.username,
			this.conversationKey(message.author.id, message.guildId, message.channel)
		);
		const isDirectMessage = message.guildId === null;
		const isMention = message.mentions.has(this.client.user.id);
		const isActiveThread =
			message.channel.isThread() &&
			(Boolean(this.conversations.get('discord', key)) || this.queue.isActive(key));
		if (!isDirectMessage && !isMention && !isActiveThread) return;

		if (!this.permitted(message)) {
			await message.reply('You do not have permission to use this bot.');
			return;
		}

		const text = message.content.replace(new RegExp(`<@!?${this.client.user.id}>`, 'g'), '').trim();
		if (!text) return;
		const pending = this.interactions.forKey(key);
		if (pending) {
			try {
				const prompt = this.interactions.get(pending.id, message.author.id, credential, key);
				const rendered = this.promptMessages.get(prompt.id);
				if (!rendered) throw new Error('This prompt is no longer active.');
				await this.interactions.answer(prompt, rendered.access.credential(), [text]);
				await this.refreshPrompt(prompt).catch((error) =>
					log.warn('prompt_update_failed', { error: errorMessage(error) })
				);
			} catch (error) {
				await message.reply(errorMessage(error));
			}
			return;
		}
		if (text === '/clear' || text === '!clear') {
			this.conversations.clear('discord', key);
			await message.reply('Conversation cleared.');
			return;
		}

		let channel = message.channel;
		if (message.guildId && !channel.isThread()) {
			try {
				channel =
					message.thread ??
					(await message.startThread({
						name: text.split('\n')[0].slice(0, 100) || 'Conversation',
						autoArchiveDuration: ThreadAutoArchiveDuration.OneHour
					}));
				if (
					channel.isThread() &&
					channel.permissionsFor(this.client.user)?.has('SendMessagesInThreads') === false
				) {
					throw new Error('The bot cannot send messages in this thread.');
				}
			} catch (error) {
				// Missing thread permissions must not prevent an otherwise valid reply.
				log.warn('thread_unavailable', { error: errorMessage(error), channelId: channel.id });
				channel = message.channel;
			}
			key = credentialConversationKey(
				credential.username,
				this.conversationKey(message.author.id, message.guildId, channel)
			);
		}
		if (this.conversations.delivery('discord', message.id)) return;
		const delivery = PortalDelivery.create(this.conversations, {
			id: message.id, key, user: message.author.id, bot: this.client.user.id, input: text,
			destination: { adapter: 'discord', sourceChannel: message.channel.id, sourceMessage: message.id, channel: channel.id, guild: message.guildId }
		}, credential);
		await this.runConversation(message, channel, key, credential, delivery).catch((error) => {
			if (delivery.record.state === 'queued') delivery.blocked(errorMessage(error));
			throw error;
		});
	}

	private async runConversation(message: Message, channel: Message['channel'], key: string, credential: PortalCredential, delivery: PortalDelivery): Promise<void> {
		await this.queue.run(key, async () => {
			const access = new DeliveryAccess(delivery, () => this.credentials.forUser(message.author.id));
			const currentCredential = () => access.credential();
			// Renderer failures may be tolerated by MCP; authorization failures must
			// still block every write, including cached and terminal answers.
			const withAccess = <T>(action: () => Promise<T>) => access.write(action);
			currentCredential();
			if (delivery.record.state === 'submitted' || delivery.record.state === 'blocked') {
				await this.blockDelivery(delivery, channel, 'Submission could not be confirmed. Check the original session in OpenCode; it was not repeated.');
				log.warn('delivery_recovery_blocked', { message: delivery.record.reason });
				return;
			}
			const post = async (content: string, components?: ActionRowBuilder<ButtonBuilder>[]) =>
				withAccess(() => channel.isThread()
					? channel.send({ content, components, allowedMentions: { parse: [] } })
					: message.reply({ content, components, allowedMentions: { parse: [] } }));
			const replies = new Map<string, Message>();
			const fetchReply = async (id: string) => replies.get(id) ?? channel.messages.fetch(id);
			let delivered = false;
			let live;
			try {
				live = delivery.liveReply('answer', 1_900, async (text) => {
					const reply = await post(text);
					replies.set(reply.id, reply);
					return { id: reply.id };
				}, async (id, text) => {
					const reply = await fetchReply(id);
					return withAccess(() => reply.edit({ content: text, allowedMentions: { parse: [] } }));
				});
			} catch (error) {
				await this.blockDelivery(delivery, channel, errorMessage(error));
				log.warn('delivery_recovery_blocked', { error: errorMessage(error) });
				return;
			}
			const reacted = new Set<string>();
			let stopTyping: (() => void) | undefined = this.startTyping(channel);
			const onUpdate = async (update: ChatUpdate) => {
				currentCredential();
				delivery.accepted(update.job, update.conversation);
				this.conversations.set('discord', key, update.conversation);
				this.interactions.working(key, message.author.id, credential, update.job);
				if (update.status === 'running') stopTyping ??= this.startTyping(channel);
				else {
					stopTyping?.();
					stopTyping = undefined;
				}
				for (const tool of update.tools) {
					const emoji = toolEmoji(tool.name).discord;
					if (reacted.has(emoji)) continue;
					reacted.add(emoji);
					void message
						.react(emoji)
						.catch((error) => log.warn('reaction_failed', { error: errorMessage(error) }));
				}
				await live.update(update.text);
			};
			try {
				let result: ChatResult;
				if (delivery.record.state === 'complete') {
					result = { text: delivery.record.result ?? '', conversation: delivery.record.conversation ?? '' };
				} else if (delivery.record.job) {
					result = await this.chat.resume(delivery.record.job, credential, onUpdate);
				} else {
					const input = delivery.record.input!;
					// Establish an editable platform message before accepting native
					// work, so a lost posting response cannot strand an accepted job.
					await live.update('Working…', true);
					delivery.submitting();
					result = await this.chat.chat(input, credential, this.conversations.get('discord', key), onUpdate);
				}
				while (result.pending) {
					currentCredential();
					stopTyping?.();
					stopTyping = undefined;
					this.conversations.set('discord', key, result.conversation);
					const previous = this.interactions.forKey(key);
					const prompt = this.interactions.open(key, message.author.id, credential, result);
					if (!prompt) break;
					if (previous && previous.id !== prompt.id)
						await this.refreshPrompt(previous).catch((error) =>
							log.warn('prompt_update_failed', { error: errorMessage(error) })
						);
					if (!this.promptMessages.has(prompt.id)) {
						const view = promptView(prompt).text;
						const last = splitMessage(view, 1_900).at(-1);
						delivery.refreshPrompt();
						const promptReply = delivery.liveReply('prompt', 1_900, async (content) => {
							const sent = await post(content, content === last ? this.promptComponents(prompt) : []);
							replies.set(sent.id, sent);
							return { id: sent.id };
						}, async (id, content) => {
							const reply = await fetchReply(id);
							return withAccess(() => reply.edit({ content, components: content === last ? this.promptComponents(prompt) : [], allowedMentions: { parse: [] } }));
						});
						await promptReply.update(view, true);
						const receipts = delivery.record.messages.prompt;
						const lastIndex = splitMessage(view, 1_900).length - 1;
						for (const receipt of receipts.slice(lastIndex + 1)) {
							const reply = await fetchReply(receipt.id!);
							await withAccess(() => reply.edit({ content: 'Previous controls closed. Use the current controls above.', components: [], allowedMentions: { parse: [] } }));
						}
						const sent = await fetchReply(receipts[lastIndex].id!);
						delivery.prompt(sent.id, prompt.questionIndex);
						this.promptMessages.set(prompt.id, {
							message: sent,
							access,
							questionIndex: prompt.questionIndex,
							post
						});
					}
					if ((await this.interactions.wait(prompt)) === 'cancelled') break;
					result = await this.chat.resume(prompt.job, currentCredential(), onUpdate);
				}
				currentCredential();
				if (!this.interactions.cancelled(key)) {
					this.conversations.set('discord', key, result.conversation);
					delivery.complete(result.text, result.conversation);
					await live.update(result.text, true);
					delivered = true;
				} else {
					delivery.complete('Work stopped.', result.conversation);
					await live.update('Work stopped.', true);
					delivered = true;
				}
			} catch (error) {
				log.warn('conversation_failed', { userId: message.author.id, error: errorMessage(error) });
				if (access.revoked) return;
				if (error instanceof UnconfirmedDeliveryError) {
					await this.blockDelivery(delivery, channel, error.message);
				}
				else if (delivery.record.state !== 'complete') {
					const text = this.interactions.cancelled(key) ? 'Work stopped.' : portalFailureText(error);
					const tracking = Boolean(error instanceof PortalConnectionError && delivery.record.job);
					if (!tracking) delivery.complete(text);
					await live.update(text, true);
					delivered = !tracking;
				}
			} finally {
				stopTyping?.();
				const pending = this.interactions.forKey(key);
				this.interactions.close(key);
				try { currentCredential(); } catch { /* Never edit private replies after revocation. */ }
				if (!access.revoked) {
					if (pending)
						await this.refreshPrompt(pending).catch((error) =>
							log.warn('prompt_update_failed', { error: errorMessage(error) })
						);
					if (!pending && delivery.record.prompt) {
						const reply = await fetchReply(delivery.record.prompt.message);
						await withAccess(() => reply.edit({ content: 'Previous controls closed. Use the current response or controls.', components: [], allowedMentions: { parse: [] } }))
							.catch((error) => log.warn('prompt_update_failed', { error: errorMessage(error) }));
					}
					if (delivered && !access.revoked) delivery.finish();
				}
				if (pending && access.revoked) this.promptMessages.delete(pending.id);
			}
		});
	}

	private async blockDelivery(delivery: PortalDelivery, channel: Message['channel'], reason: string): Promise<void> {
		delivery.blocked(reason);
		const access = new DeliveryAccess(delivery, () => this.credentials.forUser(delivery.record.user));
		const head = delivery.record.messages.answer?.[0]?.id;
		if (head) await channel.messages.fetch(head).then((message) => access.write(() => message.edit({ content: reason, components: [], allowedMentions: { parse: [] } })))
			.catch((error) => log.warn('delivery_notice_failed', { error: errorMessage(error) }));
	}

	private startTyping(channel: Message['channel']): () => void {
		let warned = false;
		const tick = () => {
			if ('sendTyping' in channel)
				void channel.sendTyping().catch((error) => {
					if (!warned) log.warn('typing_unavailable', { error: errorMessage(error) });
					warned = true;
				});
		};
		tick();
		const timer = setInterval(tick, 8_000);
		timer.unref?.();
		return () => clearInterval(timer);
	}

	private promptComponents(prompt: PendingPrompt): ActionRowBuilder<ButtonBuilder>[] {
		const actions = promptView(prompt).actions;
		const components: ActionRowBuilder<ButtonBuilder>[] = [];
		for (let index = 0; index < actions.length; index += 5) {
			components.push(
				new ActionRowBuilder<ButtonBuilder>().addComponents(
					actions.slice(index, index + 5).map((action) =>
						new ButtonBuilder()
							.setCustomId(`fh:${prompt.id}:${action.value}:${prompt.questionIndex}`)
							.setLabel(action.label.slice(0, 80) || 'Answer')
							.setStyle(
								action.danger
									? ButtonStyle.Danger
									: action.selected
										? ButtonStyle.Primary
										: ButtonStyle.Secondary
							)
					)
				)
			);
		}
		return components;
	}

	private async refreshPrompt(prompt: PendingPrompt): Promise<void> {
		const rendered = this.promptMessages.get(prompt.id);
		if (!rendered) return;
		const pending = this.interactions.forKey(prompt.key) === prompt;
		const chunks = splitMessage(promptView(prompt).text, 1_900);
		if (pending && rendered.questionIndex !== prompt.questionIndex) {
			for (const chunk of chunks.slice(0, -1)) await rendered.post(chunk);
			rendered.questionIndex = prompt.questionIndex;
		}
		const components = pending ? this.promptComponents(prompt) : [];
		await rendered.access.write(() => rendered.message.edit({
			content: pending
				? (chunks.at(-1) ?? 'Agent input required.')
				: prompt.outcome === 'answered'
					? 'Response recorded.'
					: 'Request closed.',
			components,
			allowedMentions: { parse: [] }
		}));
		if (!pending) this.promptMessages.delete(prompt.id);
	}

	private async onInteraction(interaction: Interaction): Promise<void> {
		if (!interaction.isButton() || !interaction.customId.startsWith('fh:')) return;
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		try {
			const member = interaction.member;
			const roles = member
				? Array.isArray(member.roles)
					? member.roles
					: member.roles.cache.map((role) => role.id)
				: [];
			if (
				!this.permittedUser(interaction.user.id, interaction.guildId, roles) ||
				!interaction.channel
			) {
				throw new Error('You do not have permission to use this bot.');
			}
			const credential = this.credentials.forUser(interaction.user.id);
			const key = credentialConversationKey(
				credential.username,
				this.conversationKey(interaction.user.id, interaction.guildId, interaction.channel)
			);
			const [, id, value, page] = interaction.customId.split(':');
			const prompt = this.interactions.get(id, interaction.user.id, credential, key);
			const rendered = this.promptMessages.get(id);
			if (
				!rendered || rendered.message.id !== interaction.message.id ||
				Number(page) !== prompt.questionIndex
			) {
				throw new Error('This question has changed. Use its current buttons.');
			}
			await this.interactions.action(prompt, rendered.access.credential(), value);
			await this.refreshPrompt(prompt).catch((error) =>
				log.warn('prompt_update_failed', { error: errorMessage(error) })
			);
			await interaction.editReply({ content: 'Response recorded.' });
		} catch (error) {
			await interaction.editReply({ content: errorMessage(error).slice(0, 1_900) });
		}
	}
}

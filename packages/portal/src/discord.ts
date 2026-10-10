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

import { GuardianChatClient } from './chat-client.js';
import type { ChatUpdate } from './chat-client.js';
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
				await this.interactions.answer(prompt, credential, [text]);
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
		await this.queue.run(key, async () => {
			const post = async (content: string, components?: ActionRowBuilder<ButtonBuilder>[]) =>
				channel.isThread()
					? channel.send({ content, components, allowedMentions: { parse: [] } })
					: message.reply({ content, components, allowedMentions: { parse: [] } });
			const live = new LiveReply(async (text) => {
				const reply = await post(text);
				return { edit: (content) => reply.edit({ content, allowedMentions: { parse: [] } }) };
			}, 1_900);
			const reacted = new Set<string>();
			let stopTyping: (() => void) | undefined = this.startTyping(channel);
			const onUpdate = async (update: ChatUpdate) => {
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
				let result = await this.chat.chat(
					text,
					credential,
					this.conversations.get('discord', key),
					onUpdate
				);
				while (result.pending) {
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
						const chunks = splitMessage(promptView(prompt).text, 1_900);
						for (const chunk of chunks.slice(0, -1)) await post(chunk);
						const sent = await post(
							chunks.at(-1) ?? 'Agent input required.',
							this.promptComponents(prompt)
						);
						this.promptMessages.set(prompt.id, {
							message: sent,
							questionIndex: prompt.questionIndex,
							post
						});
					}
					if ((await this.interactions.wait(prompt)) === 'cancelled') break;
					const currentCredential = this.credentials.forUser(message.author.id);
					if (currentCredential.username !== credential.username)
						throw new Error('The access mapping changed during this conversation.');
					result = await this.chat.resume(prompt.job, currentCredential, onUpdate);
				}
				if (!this.interactions.cancelled(key)) {
					this.conversations.set('discord', key, result.conversation);
					await live.update(result.text, true);
				}
			} catch (error) {
				log.warn('conversation_failed', { userId: message.author.id, error: errorMessage(error) });
				await post(
					this.interactions.cancelled(key)
						? 'Work stopped.'
						: 'The request could not be completed. You can check the session in OpenCode.'
				);
			} finally {
				stopTyping?.();
				const pending = this.interactions.forKey(key);
				this.interactions.close(key);
				if (pending)
					await this.refreshPrompt(pending).catch((error) =>
						log.warn('prompt_update_failed', { error: errorMessage(error) })
					);
			}
		});
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
		await rendered.message.edit({
			content: pending
				? (chunks.at(-1) ?? 'Agent input required.')
				: prompt.outcome === 'answered'
					? 'Response recorded.'
					: 'Request closed.',
			components,
			allowedMentions: { parse: [] }
		});
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
			if (
				this.promptMessages.get(id)?.message.id !== interaction.message.id ||
				Number(page) !== prompt.questionIndex
			) {
				throw new Error('This question has changed. Use its current buttons.');
			}
			await this.interactions.action(prompt, credential, value);
			await this.refreshPrompt(prompt).catch((error) =>
				log.warn('prompt_update_failed', { error: errorMessage(error) })
			);
			await interaction.editReply({ content: 'Response recorded.' });
		} catch (error) {
			await interaction.editReply({ content: errorMessage(error).slice(0, 1_900) });
		}
	}
}

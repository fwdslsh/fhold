import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Client as McpClient } from '@modelcontextprotocol/client';

import { ConversationStore } from './conversations.js';
import { PortalCredentialRegistry } from './credential-registry.js';
import * as runtime from './runtime.js';

type SlackReply = { text: string; thread_ts?: string; blocks?: unknown[] };
type SlackPayload = {
	event: Record<string, unknown>;
	say: (reply: SlackReply) => Promise<{ ts: string }>;
};
type TestButton = { data: { custom_id?: string; label?: string } };
type DiscordPost = {
	id: string;
	content: string;
	components: Array<{ components: TestButton[] }>;
	edit: ReturnType<typeof mock>;
};
const slackEvents = new Map<string, (payload: SlackPayload) => Promise<void>>();
let slackAction: (payload: unknown) => Promise<void>;
const discordEvents = new Map<string, (message: unknown) => void>();
const slackUpdate = mock(async (_args: Record<string, unknown>) => ({}));
const slackReaction = mock(async (_args: Record<string, unknown>) => ({}));
const slackEphemeral = mock(async (_args: Record<string, unknown>) => ({}));

mock.module('@slack/bolt', () => ({
	App: class {
		client = {
			auth: { test: async () => ({ user_id: 'UBOT123' }) },
			chat: { update: slackUpdate, postEphemeral: slackEphemeral },
			reactions: { add: slackReaction }
		};
		event(name: string, handler: (payload: SlackPayload) => Promise<void>) {
			slackEvents.set(name, handler);
		}
		action(_pattern: RegExp, handler: (payload: unknown) => Promise<void>) {
			slackAction = handler;
		}
		error() {}
		async start() {}
	},
	SocketModeReceiver: class {
		client = { websocket: { isActive: () => true } };
	}
}));

mock.module('discord.js', () => ({
	Client: class {
		user = { id: '900000', tag: 'test-bot' };
		guilds = { cache: { size: 1 } };
		on(name: string, handler: (message: unknown) => void) {
			discordEvents.set(name, handler);
		}
		once(name: string, handler: (message: unknown) => void) {
			discordEvents.set(name, handler);
		}
		async login() {
			discordEvents.get('ready')?.(this);
		}
		isReady() {
			return true;
		}
	},
	ActionRowBuilder: class {
		components: TestButton[] = [];
		addComponents(buttons: TestButton[]) {
			this.components = buttons;
			return this;
		}
	},
	ButtonBuilder: class {
		data: Record<string, unknown> = {};
		setCustomId(value: string) {
			this.data.custom_id = value;
			return this;
		}
		setLabel(value: string) {
			this.data.label = value;
			return this;
		}
		setStyle(value: number) {
			this.data.style = value;
			return this;
		}
	},
	ButtonStyle: { Primary: 1, Secondary: 2, Danger: 4 },
	MessageFlags: { Ephemeral: 64 },
	ThreadAutoArchiveDuration: { OneHour: 60 },
	Events: {
		Error: 'error',
		MessageCreate: 'messageCreate',
		InteractionCreate: 'interactionCreate',
		ClientReady: 'ready'
	},
	GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4, DirectMessages: 8 },
	Partials: { Channel: 1, Message: 2 }
}));

const { SlackPortal } = await import('./slack.js');
const { DiscordPortal } = await import('./discord.js');
const environmentNames = [
	'PORTAL_CREDENTIALS_FILE',
	'PORTAL_STATE_PATH',
	'SLACK_ALLOWED_CHANNELS',
	'SLACK_ALLOWED_USERS',
	'SLACK_BLOCKED_USERS',
	'DISCORD_ALLOWED_GUILDS',
	'DISCORD_ALLOWED_USERS',
	'DISCORD_ALLOWED_ROLES',
	'DISCORD_BLOCKED_USERS'
];
const originalEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
	slackEvents.clear();
	discordEvents.clear();
	slackUpdate.mockClear();
	slackReaction.mockClear();
	slackEphemeral.mockClear();
	for (const name of environmentNames) delete process.env[name];
	process.env.PORTAL_CREDENTIALS_FILE = 'unused-unit-test-fixture';
	process.env.PORTAL_STATE_PATH = ':memory:';
	process.env.SLACK_ALLOWED_CHANNELS = 'C123';
	process.env.DISCORD_ALLOWED_GUILDS = '123456';
	const credential = { username: 'test-user', key: 'unit-test-key' };
	spyOn(PortalCredentialRegistry.prototype, 'defaultCredential').mockReturnValue(credential);
	spyOn(PortalCredentialRegistry.prototype, 'forUser').mockReturnValue(credential);
	spyOn(runtime, 'readSecret').mockReturnValue('unit-test-bot-token');
	spyOn(McpClient.prototype, 'connect').mockResolvedValue(undefined);
	spyOn(McpClient.prototype, 'close').mockResolvedValue(undefined);
	spyOn(console, 'log').mockImplementation(() => {});
	spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	mock.restore();
	for (const [name, value] of originalEnvironment) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

function response(status: string, text?: string, extra: Record<string, unknown> = {}) {
	return {
		content: [],
		structuredContent: { status, session: 'test.session', job: 'test.job', text, ...extra }
	};
}
function notify(options: Parameters<McpClient['callTool']>[1], fields: Record<string, unknown>) {
	const notification = {
		progress: 1,
		message: 'Agent working',
		_meta: { 'io.fwdslsh.fhold/agent': response('running', undefined, fields).structuredContent }
	};
	options?.onprogress?.(notification);
}
async function until(check: () => boolean) {
	const deadline = Date.now() + 2_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error('Expected platform event did not arrive');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
function discordFixture() {
	const posts: DiscordPost[] = [];
	const post = mock(async (payload: string | Record<string, unknown>) => {
		const data = typeof payload === 'string' ? { content: payload } : payload;
		const result: DiscordPost = {
			id: `post-${posts.length}`,
			content: data.content as string,
			components: (data.components ?? []) as DiscordPost['components'],
			edit: mock(async (next: Record<string, unknown>) => {
				result.content = next.content as string;
				if ('components' in next) result.components = next.components as DiscordPost['components'];
				return result;
			})
		};
		posts.push(result);
		return result;
	});
	const typing = mock(async () => {});
	const thread = {
		id: '777777',
		isThread: () => true,
		send: post,
		sendTyping: typing,
		permissionsFor: mock(() => ({ has: () => true }))
	};
	const channel = { id: '654321', isThread: () => false, send: post, sendTyping: typing };
	const message = {
		id: '111111',
		author: { id: '123456', bot: false },
		guildId: '123456' as string | null,
		mentions: { has: () => true },
		content: '<@900000> Do the work',
		channel,
		reply: mock(async (payload: string | Record<string, unknown>) => post(payload)),
		react: mock(async (_emoji: string) => {}),
		startThread: mock(async (_args: Record<string, unknown>) => thread),
		thread: undefined as typeof thread | undefined
	};
	return { posts, post, typing, thread, channel, message };
}
type DiscordInternals = {
	onMessage(message: unknown): Promise<void>;
	onInteraction(interaction: unknown): Promise<void>;
};
async function discordPortal() {
	const portal = new DiscordPortal();
	await portal.start();
	expect(discordEvents.has('interactionCreate')).toBe(true);
	return portal as unknown as DiscordInternals;
}
function discordButton(post: DiscordPost, channel: unknown, label: string, user = '123456') {
	const button = post.components
		.flatMap((row) => row.components)
		.find((button) => button.data.label === label);
	if (!button) throw new Error(`missing button: ${label}`);
	return {
		isButton: () => true,
		customId: button.data.custom_id,
		user: { id: user },
		guildId: '123456',
		member: null,
		channel,
		message: { id: post.id },
		deferReply: mock(async (_options: unknown) => {}),
		editReply: mock(async (_options: unknown) => {})
	};
}
function questionPost(posts: DiscordPost[]): DiscordPost {
	const prompt = posts.find((post) => post.components.length > 0);
	if (!prompt) throw new Error('Question controls were not delivered');
	return prompt;
}
function slackFixture() {
	const replies: SlackReply[] = [];
	const say = mock(async (reply: SlackReply) => {
		replies.push(reply);
		return { ts: `bot.${replies.length}` };
	});
	const event = { user: 'U123', channel: 'C123', text: '<@UBOT123> Work', ts: '1.000001' };
	return { replies, say, event };
}
async function slackMessage(name: string, payload: SlackPayload) {
	const handler = slackEvents.get(name);
	if (!handler) throw new Error('Slack message handler not registered');
	await handler(payload);
}
function slackButton(reply: SlackReply, ts: string, label: string, user = 'U123') {
	const blocks = reply.blocks as Array<{
		elements?: Array<{ type: string; action_id: string; value: string; text: { text: string } }>;
	}>;
	const button = blocks
		.flatMap((block) => block.elements ?? [])
		.find((element) => element.type === 'button' && element.text.text === label);
	if (!button) throw new Error(`missing Slack button: ${label}`);
	const ack = mock(async () => {});
	return {
		ack,
		action: { ...button, type: 'button' },
		body: { type: 'block_actions', channel: { id: 'C123' }, message: { ts }, user: { id: user } }
	};
}
const question = {
	kind: 'question',
	handle: 'question.handle',
	questions: [
		{
			question: 'Which target?',
			options: [{ label: 'API', description: 'API service' }],
			custom: true
		}
	]
};
const permission = {
	kind: 'permission',
	handle: 'permission.handle',
	permission: 'bash',
	patterns: ['bun test'],
	allowedDecisions: ['once', 'always', 'reject']
};

describe('Discord conversation UX', () => {
	it('answers in the original channel if it can create a thread but cannot send in it', async () => {
		const fixture = discordFixture();
		fixture.thread.permissionsFor.mockReturnValue({ has: () => false });
		spyOn(McpClient.prototype, 'callTool').mockResolvedValue(
			response('completed', 'Still answered')
		);
		const portal = await discordPortal();
		await portal.onMessage(fixture.message);
		expect(fixture.message.reply).toHaveBeenCalledTimes(1);
		expect(fixture.posts[0].content).toBe('Still answered');
	});

	it('shows every permission pattern before its buttons, rather than silently truncating the request', async () => {
		const fixture = discordFixture();
		const patterns = Array.from({ length: 4 }, (_, index) => `pattern-${index}-${'x'.repeat(990)}`);
		spyOn(McpClient.prototype, 'callTool').mockImplementation(async (request) =>
			request.name === 'fhold.agent.run'
				? response('input_required', '', { interactions: [{ ...permission, patterns }] })
				: response('completed', 'Denied')
		);
		const portal = await discordPortal();
		const work = portal.onMessage(fixture.message);
		await until(() => fixture.posts.some((post) => post.components.length > 0));
		const shown = fixture.posts.map((post) => post.content).join('');
		for (const pattern of patterns) expect(shown).toContain(pattern);
		expect(fixture.posts.every((post) => post.content.length <= 1_900)).toBe(true);
		const prompt = questionPost(fixture.posts);
		await portal.onInteraction(discordButton(prompt, fixture.thread, 'Deny'));
		await work;
	});

	it('notices a question answered from another client and clears its obsolete buttons', async () => {
		const fixture = discordFixture();
		spyOn(McpClient.prototype, 'callTool')
			.mockResolvedValueOnce(response('input_required', '', { interactions: [question] }))
			.mockResolvedValueOnce(response('completed', 'Answered in OpenCode'));
		const portal = await discordPortal();
		await portal.onMessage(fixture.message);
		expect(fixture.posts.at(-1)?.content).toBe('Answered in OpenCode');
		expect(fixture.posts.every((post) => post.components.length === 0)).toBe(true);
	});

	it('creates a thread, streams edits, reacts to tools and keeps typing until completion', async () => {
		const fixture = discordFixture();
		const finish = Promise.withResolvers<ReturnType<typeof response>>();
		const callTool = spyOn(McpClient.prototype, 'callTool').mockImplementation(
			async (_request, options) => {
				notify(options, {
					text: 'Beginning',
					tools: [
						{ name: 'bash', status: 'running' },
						{ name: 'akm_search', status: 'running' }
					]
				});
				return finish.promise;
			}
		);
		const interval = spyOn(globalThis, 'setInterval');
		const cleared = spyOn(globalThis, 'clearInterval');
		const portal = await discordPortal();
		const work = portal.onMessage(fixture.message);
		await until(() => fixture.posts.length === 1);
		expect(fixture.message.startThread).toHaveBeenCalledWith({
			name: 'Do the work',
			autoArchiveDuration: 60
		});
		expect(fixture.message.reply).not.toHaveBeenCalled();
		const tick = interval.mock.calls.find(([, delay]) => delay === 8_000)?.[0];
		if (typeof tick !== 'function') throw new Error('missing typing interval');
		tick();
		await until(() => fixture.typing.mock.calls.length === 2);
		finish.resolve(response('completed', 'Finished work'));
		await work;
		expect(fixture.posts.map((post) => post.content)).toEqual(['Finished work']);
		expect(fixture.posts[0].edit).toHaveBeenCalledTimes(1);
		expect(fixture.message.react.mock.calls.map(([emoji]) => emoji)).toEqual(['🐚', '🔎']);
		expect(cleared).toHaveBeenCalled();
		expect(callTool).toHaveBeenCalledTimes(1);
	});

	it('reuses an existing thread and accepts unmentioned followups with the same session', async () => {
		const fixture = discordFixture();
		fixture.message.thread = fixture.thread;
		const callTool = spyOn(McpClient.prototype, 'callTool').mockResolvedValue(
			response('completed', 'Done')
		);
		const portal = await discordPortal();
		await portal.onMessage(fixture.message);
		await portal.onMessage({
			...fixture.message,
			channel: fixture.thread,
			content: 'Next thing',
			mentions: { has: () => false }
		});
		expect(fixture.message.startThread).not.toHaveBeenCalled();
		expect(callTool.mock.calls[1][0].arguments).toEqual({
			message: 'Next thing',
			session: 'test.session',
			waitMs: 30_000
		});
	});

	it('queues early thread replies before the first MCP snapshot instead of losing them', async () => {
		const fixture = discordFixture();
		const finish = Promise.withResolvers<ReturnType<typeof response>>();
		const callTool = spyOn(McpClient.prototype, 'callTool');
		callTool
			.mockImplementationOnce(() => finish.promise)
			.mockResolvedValue(response('completed', 'Followup done'));
		const portal = await discordPortal();
		const first = portal.onMessage(fixture.message);
		await until(() => callTool.mock.calls.length === 1);
		const next = portal.onMessage({
			...fixture.message,
			channel: fixture.thread,
			content: 'Followup',
			mentions: { has: () => false }
		});
		expect(callTool).toHaveBeenCalledTimes(1);
		finish.resolve(response('completed', 'First done'));
		await Promise.all([first, next]);
		expect(callTool).toHaveBeenCalledTimes(2);
		expect(callTool.mock.calls[1][0].arguments?.session).toBe('test.session');
	});

	it('falls back to a channel reply when threads or reactions are unavailable; DMs never create threads', async () => {
		process.env.DISCORD_ALLOWED_GUILDS = '';
		process.env.DISCORD_ALLOWED_USERS = '123456';
		const fixture = discordFixture();
		fixture.message.startThread.mockRejectedValue(new Error('missing thread permission'));
		fixture.message.react.mockRejectedValue(new Error('missing reaction permission'));
		spyOn(McpClient.prototype, 'callTool').mockResolvedValue(
			response('completed', 'Result', { tools: [{ name: 'edit', status: 'completed' }] })
		);
		const portal = await discordPortal();
		await portal.onMessage(fixture.message);
		expect(fixture.posts[0].content).toBe('Result');
		await portal.onMessage({ ...fixture.message, guildId: null });
		expect(fixture.message.startThread).toHaveBeenCalledTimes(1);
		expect(fixture.posts[1].content).toBe('Result');
	});

	it('answers sequential questions with requester-only buttons and free text without rerunning the job', async () => {
		const fixture = discordFixture();
		const callTool = spyOn(McpClient.prototype, 'callTool').mockImplementation(async (request) => {
			if (request.name === 'fhold.agent.run')
				return response('input_required', '', {
					interactions: [
						{
							...question,
							questions: [
								...question.questions,
								{ question: 'Details?', options: [], custom: true }
							]
						}
					]
				});
			return response('completed', 'Selected API staging');
		});
		const portal = await discordPortal();
		const work = portal.onMessage(fixture.message);
		await until(() => fixture.posts.some((post) => post.components.length > 0));
		const prompt = questionPost(fixture.posts);
		const wrong = discordButton(prompt, fixture.thread, 'API', 'other-user');
		await portal.onInteraction(wrong);
		expect(wrong.editReply.mock.calls[0][0]).toMatchObject({
			content: 'Only the person who requested this work can answer.'
		});
		const button = discordButton(prompt, fixture.thread, 'API');
		await portal.onInteraction(button);
		expect(prompt.content).toContain('Details?');
		await portal.onInteraction(button); // stale first-page action cannot answer question two
		expect(callTool).toHaveBeenCalledTimes(1);
		await portal.onMessage({
			...fixture.message,
			channel: fixture.thread,
			mentions: { has: () => false },
			content: 'staging'
		});
		await work;
		expect(callTool.mock.calls.map(([request]) => request.name)).toEqual([
			'fhold.agent.run',
			'fhold.interaction.respond',
			'fhold.job.get'
		]);
		expect(callTool.mock.calls[1][0].arguments).toEqual({
			interaction: 'question.handle',
			answers: [['API'], ['staging']]
		});
		expect(prompt.components).toEqual([]);
		expect(fixture.posts.at(-1)?.content).toBe('Selected API staging');
	});

	it('never treats chat text as command approval and records an explicit button decision', async () => {
		const fixture = discordFixture();
		const callTool = spyOn(McpClient.prototype, 'callTool').mockImplementation(async (request) =>
			request.name === 'fhold.agent.run'
				? response('input_required', '', { interactions: [permission] })
				: response('completed', 'Command completed')
		);
		const portal = await discordPortal();
		const work = portal.onMessage(fixture.message);
		await until(() => fixture.posts.some((post) => post.components.length > 0));
		const prompt = questionPost(fixture.posts);
		await portal.onMessage({
			...fixture.message,
			channel: fixture.thread,
			mentions: { has: () => false },
			content: 'yes'
		});
		expect(callTool).toHaveBeenCalledTimes(1);
		expect(fixture.posts.at(-1)?.content).toContain('approval buttons');
		await portal.onInteraction(discordButton(prompt, fixture.thread, 'Allow once'));
		await work;
		expect(callTool.mock.calls[1][0].arguments).toEqual({
			interaction: 'permission.handle',
			decision: 'once'
		});
		expect(
			callTool.mock.calls.filter(([request]) => request.name === 'fhold.agent.run')
		).toHaveLength(1);
	});
});

describe('Slack conversation UX', () => {
	it('shows complete permission patterns in threaded blocks before the buttons', async () => {
		const fixture = slackFixture();
		const patterns = Array.from({ length: 4 }, (_, index) => `pattern-${index}-${'x'.repeat(990)}`);
		spyOn(McpClient.prototype, 'callTool').mockImplementation(async (request) =>
			request.name === 'fhold.agent.run'
				? response('input_required', '', { interactions: [{ ...permission, patterns }] })
				: response('completed', 'Denied')
		);
		await new SlackPortal().start();
		const work = slackMessage('app_mention', { event: fixture.event, say: fixture.say });
		await until(() =>
			fixture.replies.some(
				(reply) =>
					reply.blocks?.some((block) => (block as { type: string }).type === 'actions') &&
					reply.text.includes('Only the person')
			)
		);
		const shown = fixture.replies.map((reply) => reply.text).join('');
		for (const pattern of patterns) expect(shown).toContain(pattern);
		expect(
			fixture.replies.every((reply) => reply.text.length <= 2_900 && reply.thread_ts === '1.000001')
		).toBe(true);
		const index = fixture.replies.findIndex((reply) => reply.text.includes('Only the person'));
		await slackAction(slackButton(fixture.replies[index], `bot.${index + 1}`, 'Deny'));
		await work;
	});

	it('streams long answers in the original thread with visible text blocks and optional tool feedback', async () => {
		const fixture = slackFixture();
		const stored = spyOn(ConversationStore.prototype, 'set');
		const callTool = spyOn(McpClient.prototype, 'callTool');
		callTool
			.mockImplementationOnce(async (_request, options) => {
				notify(options, { text: 'Beginning', tools: [{ name: 'bash', status: 'running' }] });
				return response('running');
			})
			.mockResolvedValue(response('completed', 's'.repeat(4_100)));
		slackReaction.mockRejectedValueOnce(new Error('missing reactions:write'));
		await new SlackPortal().start();
		await slackMessage('app_mention', {
			event: { ...fixture.event, ts: '2.000002', thread_ts: '1.000001' },
			say: fixture.say
		});
		expect(stored.mock.calls[0]).toEqual([
			'slack',
			'credential:test-user:thread:C123:1.000001',
			'test.session'
		]);
		expect(fixture.replies.every((reply) => reply.thread_ts === '1.000001')).toBe(true);
		const beginning = fixture.replies.find((reply) => reply.text === 'Beginning');
		expect(beginning?.blocks?.[0]).toMatchObject({ type: 'section', text: { text: 'Beginning' } });
		expect(slackUpdate.mock.calls.some(([value]) => value.text === 's'.repeat(2_900))).toBe(true);
		expect(fixture.replies.at(-1)?.text).toBe('s'.repeat(1_200));
		expect(slackUpdate.mock.calls.at(-1)?.[0].blocks).toEqual([]);
		expect(callTool).toHaveBeenCalledTimes(2);
	});

	it('queues unmentioned thread replies during a long job and reuses the session', async () => {
		const fixture = slackFixture();
		const finish = Promise.withResolvers<ReturnType<typeof response>>();
		const callTool = spyOn(McpClient.prototype, 'callTool');
		callTool
			.mockImplementationOnce(() => finish.promise)
			.mockResolvedValue(response('completed', 'Followup done'));
		await new SlackPortal().start();
		const first = slackMessage('app_mention', { event: fixture.event, say: fixture.say });
		await until(() => callTool.mock.calls.length === 1);
		const next = slackMessage('message', {
			event: { ...fixture.event, text: 'Followup', ts: '2.000002', thread_ts: '1.000001' },
			say: fixture.say
		});
		finish.resolve(response('completed', 'First done'));
		await Promise.all([first, next]);
		expect(callTool).toHaveBeenCalledTimes(2);
		expect(callTool.mock.calls[1][0].arguments).toEqual({
			message: 'Followup',
			session: 'test.session',
			waitMs: 30_000
		});
	});

	it('retries final delivery when an intermediate platform post fails', async () => {
		const fixture = slackFixture();
		spyOn(McpClient.prototype, 'callTool')
			.mockResolvedValueOnce(response('running'))
			.mockResolvedValueOnce(response('completed', 'Finished'));
		fixture.say.mockRejectedValueOnce(new Error('Slack temporarily unavailable'));
		await new SlackPortal().start();
		await slackMessage('app_mention', { event: fixture.event, say: fixture.say });
		expect(fixture.replies.at(-1)?.text).toBe('Finished');
		expect(fixture.say).toHaveBeenCalledTimes(2);
	});

	it('supports explicit questions, acknowledges buttons first, and rejects other users with the same credential', async () => {
		const fixture = slackFixture();
		const callTool = spyOn(McpClient.prototype, 'callTool').mockImplementation(async (request) =>
			request.name === 'fhold.agent.run'
				? response('input_required', '', { interactions: [question] })
				: response('completed', 'Selected API')
		);
		await new SlackPortal().start();
		const work = slackMessage('app_mention', { event: fixture.event, say: fixture.say });
		await until(() => fixture.replies.some((reply) => reply.text.includes('Which target?')));
		const index = fixture.replies.findIndex((reply) => reply.text.includes('Which target?'));
		const prompt = fixture.replies[index];
		const other = slackButton(prompt, `bot.${index + 1}`, 'API', 'UOTHER');
		await slackAction(other);
		expect(other.ack).toHaveBeenCalled();
		expect(slackEphemeral.mock.calls[0][0].text).toContain('Only the person');
		expect(callTool).toHaveBeenCalledTimes(1);
		const button = slackButton(prompt, `bot.${index + 1}`, 'API');
		await slackAction(button);
		await work;
		expect(button.ack).toHaveBeenCalledTimes(1);
		expect(callTool.mock.calls[1][0].arguments).toEqual({
			interaction: 'question.handle',
			answers: [['API']]
		});
		expect(callTool.mock.calls.map(([request]) => request.name)).toEqual([
			'fhold.agent.run',
			'fhold.interaction.respond',
			'fhold.job.get'
		]);
	});

	it('uses approval buttons instead of treating text as permission', async () => {
		const fixture = slackFixture();
		const callTool = spyOn(McpClient.prototype, 'callTool').mockImplementation(async (request) =>
			request.name === 'fhold.agent.run'
				? response('input_required', '', { interactions: [permission] })
				: response('completed', 'Permission denied')
		);
		await new SlackPortal().start();
		const work = slackMessage('app_mention', { event: fixture.event, say: fixture.say });
		await until(() =>
			fixture.replies.some((reply) => reply.text.includes('Permission requested:'))
		);
		const index = fixture.replies.findIndex((reply) =>
			reply.text.includes('Permission requested:')
		);
		await slackMessage('message', {
			event: { ...fixture.event, ts: '2.000002', thread_ts: '1.000001', text: 'yes' },
			say: fixture.say
		});
		expect(callTool).toHaveBeenCalledTimes(1);
		expect(fixture.replies.at(-1)?.text).toContain('approval buttons');
		await slackAction(slackButton(fixture.replies[index], `bot.${index + 1}`, 'Deny'));
		await work;
		expect(callTool.mock.calls[1][0].arguments).toEqual({
			interaction: 'permission.handle',
			decision: 'reject'
		});
	});

	it('lets only the requester stop the existing job and removes finished controls', async () => {
		const fixture = slackFixture();
		const finish = Promise.withResolvers<ReturnType<typeof response>>();
		const callTool = spyOn(McpClient.prototype, 'callTool').mockImplementation(
			async (request, options) => {
				if (request.name === 'fhold.job.cancel') return response('cancelled');
				notify(options, { text: 'Working' });
				return finish.promise;
			}
		);
		await new SlackPortal().start();
		const work = slackMessage('app_mention', { event: fixture.event, say: fixture.say });
		await until(() => fixture.replies.length > 0);
		await slackAction(slackButton(fixture.replies[0], 'bot.1', 'Stop', 'UOTHER'));
		expect(callTool).toHaveBeenCalledTimes(1);
		await slackAction(slackButton(fixture.replies[0], 'bot.1', 'Stop'));
		expect(callTool.mock.calls[1][0].name).toBe('fhold.job.cancel');
		finish.resolve(response('failed', 'Aborted'));
		await work;
		expect(slackUpdate.mock.calls.at(-1)?.[0]).toMatchObject({ text: 'Work stopped.', blocks: [] });
		expect(
			callTool.mock.calls.filter(([request]) => request.name === 'fhold.agent.run')
		).toHaveLength(1);
	});
});

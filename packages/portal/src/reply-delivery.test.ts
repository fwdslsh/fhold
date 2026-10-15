import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Client as McpClient, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';

import { ConversationStore } from './conversations.js';
import { PortalCredentialRegistry } from './credential-registry.js';
import * as runtime from './runtime.js';
import { PortalDelivery } from './delivery.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
const slackPosts = new Map<string, SlackReply>();
const discordChannels = new Map<string, unknown>();
const temporaryPaths: string[] = [];
const slackUpdate = mock(async (args: Record<string, unknown>) => {
	const posted = slackPosts.get(args.ts as string);
	if (posted) {
		if (typeof args.text === 'string') posted.text = args.text;
		if (Array.isArray(args.blocks)) posted.blocks = structuredClone(args.blocks);
	}
	return {};
});
let currentSlackSay: (payload: SlackReply) => Promise<{ ts: string }>;
const slackReaction = mock(async (_args: Record<string, unknown>) => ({}));
const slackEphemeral = mock(async (_args: Record<string, unknown>) => ({}));

mock.module('@slack/bolt', () => ({
	App: class {
		client = {
			auth: { test: async () => ({ user_id: 'UBOT123' }) },
			chat: { update: slackUpdate, postEphemeral: slackEphemeral, postMessage: (payload: SlackReply) => currentSlackSay(payload) },
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
		channels = { fetch: async (id: string) => discordChannels.get(id) };
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
	slackPosts.clear();
	discordChannels.clear();
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
	for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
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
		isTextBased: () => true,
		send: post,
		sendTyping: typing,
		permissionsFor: mock(() => ({ has: () => true }))
	};
	const channel = { id: '654321', isThread: () => false, isTextBased: () => true, send: post, sendTyping: typing };
	const message = {
		id: '111111',
		author: { id: '123456', bot: false },
		guildId: '123456' as string | null,
		guild: { members: { fetch: async () => ({ roles: { cache: { map: () => [] } } }) } },
		mentions: { has: () => true },
		content: '<@900000> Do the work',
		channel,
		reply: mock(async (payload: string | Record<string, unknown>) => post(payload)),
		react: mock(async (_emoji: string) => {}),
		startThread: mock(async (_args: Record<string, unknown>) => thread),
		thread: undefined as typeof thread | undefined
	};
	const messages = { fetch: async (id: string) => id === message.id ? message : posts.find((post) => post.id === id) };
	Object.assign(channel, { messages });
	Object.assign(thread, { messages });
	discordChannels.set(channel.id, channel);
	discordChannels.set(thread.id, thread);
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
		const posted = structuredClone(reply);
		replies.push(posted);
		const ts = `bot.${replies.length}`;
		slackPosts.set(ts, posted);
		return { ts };
	});
	currentSlackSay = say;
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

function recoveryFixture(adapter: 'slack' | 'discord', message: string, state: 'tracking' | 'complete' | 'submitted' = 'tracking') {
	const root = mkdtempSync(join(tmpdir(), 'fhold-portal-restart-')); temporaryPaths.push(root);
	process.env.PORTAL_STATE_PATH = join(root, 'portal.db');
	const store = new ConversationStore();
	const delivery = PortalDelivery.create(store, {
		id: adapter === 'slack' ? 'C123:1.000001' : '111111',
		key: adapter === 'slack' ? 'credential:test-user:thread:C123:1.000001' : 'credential:test-user:thread:777777',
		user: adapter === 'slack' ? 'U123' : '123456', bot: adapter === 'slack' ? 'UBOT123' : '900000', input: 'Already submitted request',
		destination: adapter === 'slack' ? { adapter, channel: 'C123', ts: '1.000001', thread: '1.000001' } : { adapter, sourceChannel: '654321', sourceMessage: '111111', channel: '777777', guild: '123456' }
	}, { username: 'test-user', key: 'unit-test-key' });
	delivery.record.messages.answer = [{ id: message, text: 'Working…' }];
	delivery.submitting();
	if (state !== 'submitted') delivery.accepted('test.job', 'test.session');
	if (state === 'complete') delivery.complete('Saved final answer', 'test.session');
	store.close();
	return delivery.record.id;
}

async function settledDelivery(adapter: string, id: string, state = 'done') {
	const store = new ConversationStore();
	try { await until(() => store.delivery(adapter, id)?.state === state); }
	finally { store.close(); }
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
		expect(fixture.posts[0]?.content).toBe('Answered in OpenCode');
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
		expect(fixture.posts[0].edit).toHaveBeenCalledTimes(2);
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
			id: '111112',
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
			id: '111112',
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
		await portal.onMessage({ ...fixture.message, id: '111112', guildId: null });
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
		expect(fixture.posts[0]?.content).toBe('Selected API staging');
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
	it('keeps native bold/table Markdown after the final Stop control is removed', async () => {
		const fixture = slackFixture();
		const text = '**Tasks**\n\n| Title | Owner |\n| --- | --- |\n| Check logs | Ian |';
		spyOn(McpClient.prototype, 'callTool').mockResolvedValue(response('completed', text));
		await new SlackPortal().start();
		await slackMessage('app_mention', { event: fixture.event, say: fixture.say });
		expect(fixture.replies[0].blocks?.[0]).toEqual({ type: 'markdown', text });
		expect(slackUpdate.mock.calls.at(-1)?.[0]).toMatchObject({
			text,
			blocks: [{ type: 'markdown', text }]
		});
	});

	it('falls back to plain text when Slack explicitly rejects Markdown without rerunning work', async () => {
		const fixture = slackFixture();
		fixture.say.mockRejectedValueOnce(
			Object.assign(new Error('invalid_blocks'), { data: { error: 'invalid_blocks' } })
		);
		const calls = spyOn(McpClient.prototype, 'callTool').mockResolvedValue(
			response('completed', '**Answer**')
		);
		await new SlackPortal().start();
		await slackMessage('app_mention', { event: fixture.event, say: fixture.say });
		expect(fixture.say).toHaveBeenCalledTimes(2);
		expect(fixture.replies[0].blocks?.[0]).toEqual({
			type: 'section',
			text: { type: 'plain_text', text: '**Answer**' }
		});
		expect(calls).toHaveBeenCalledTimes(1);
	});

	it('preserves partial answers and reports unknown job status instead of false agent failure', async () => {
		const fixture = slackFixture();
		spyOn(McpClient.prototype, 'callTool')
			.mockImplementationOnce(async (_request, options) => {
				notify(options, { text: 'The search completed.' });
				throw new SdkError(SdkErrorCode.RequestTimeout, 'Request timed out');
			})
			.mockRejectedValue(new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed'));
		await new SlackPortal().start();
		await slackMessage('app_mention', { event: fixture.event, say: fixture.say });
		const final = slackUpdate.mock.calls.at(-1)?.[0].text;
		expect(final).toContain('The search completed.');
		expect(final).toContain('Work may still be running');
		expect(final).not.toContain('request could not be completed');
	});
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
		expect(slackUpdate.mock.calls.some(([reply]) => reply.text === 'Beginning' &&
			(reply.blocks as Array<{type: string}>)[0]?.type === 'markdown')).toBe(true);
		expect(slackUpdate.mock.calls.some(([value]) => value.text === 's'.repeat(2_900))).toBe(true);
		expect(fixture.replies.at(-1)?.text).toBe('s'.repeat(1_200));
		expect(slackUpdate.mock.calls.at(-1)?.[0].blocks).toEqual([
			{ type: 'markdown', text: 's'.repeat(2_900) }
		]);
		expect(fixture.replies.at(-1)?.blocks).toEqual([{ type: 'markdown', text: 's'.repeat(1_200) }]);
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

	it('does not accept work or retry an unacknowledged initial platform post', async () => {
		const fixture = slackFixture();
		const calls = spyOn(McpClient.prototype, 'callTool')
			.mockResolvedValueOnce(response('running'))
			.mockResolvedValueOnce(response('completed', 'Finished'));
		fixture.say.mockRejectedValueOnce(new Error('Slack temporarily unavailable'));
		await new SlackPortal().start();
		await slackMessage('app_mention', { event: fixture.event, say: fixture.say });
		expect(fixture.replies).toEqual([]);
		expect(fixture.say).toHaveBeenCalledTimes(1);
		expect(calls).not.toHaveBeenCalled();
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
		expect(slackUpdate.mock.calls.at(-1)?.[0]).toMatchObject({
			text: 'Work stopped.',
			blocks: [{ type: 'markdown', text: 'Work stopped.' }]
		});
		expect(
			callTool.mock.calls.filter(([request]) => request.name === 'fhold.agent.run')
		).toHaveLength(1);
	});
});

describe('Portal process replacement', () => {
	it('does not rerun an expired Guardian job when restoring a pending reply', async () => {
		const fixture = slackFixture(); const first = await fixture.say({ text: 'Working…' });
		const id = recoveryFixture('slack', first.ts);
		const calls = spyOn(McpClient.prototype, 'callTool').mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'Job handle expired' }] });
		await new SlackPortal().start(); await settledDelivery('slack', id);
		expect(calls.mock.calls.map(([request]) => request.name)).toEqual(['fhold.job.get']);
		expect(fixture.replies[0].text).toContain('Check the session in OpenCode');
		expect(fixture.say).toHaveBeenCalledTimes(1);
	});

	it('restores requester-owned Stop on an existing Slack message without repeating the agent request', async () => {
		const fixture = slackFixture(); const first = await fixture.say({ text: 'Working…' });
		const id = recoveryFixture('slack', first.ts);
		const finish = Promise.withResolvers<ReturnType<typeof response>>();
		const calls = spyOn(McpClient.prototype, 'callTool').mockImplementation(async (request, options) => {
			if (request.name === 'fhold.job.cancel') { finish.resolve(response('completed', 'Cancelled')); return { content: [] }; }
			if (request.name !== 'fhold.job.get') throw new Error('Unexpected native submission');
			notify(options, { text: 'Still working' });
			return finish.promise;
		});
		await new SlackPortal().start();
		await until(() => fixture.replies[0].blocks?.some((block) => (block as { type: string }).type === 'actions') === true);
		await slackAction(slackButton(fixture.replies[0], first.ts, 'Stop', 'UOTHER'));
		expect(calls.mock.calls.filter(([request]) => request.name === 'fhold.job.cancel')).toHaveLength(0);
		await slackAction(slackButton(fixture.replies[0], first.ts, 'Stop'));
		await settledDelivery('slack', id);
		expect(calls.mock.calls.map(([request]) => request.name)).toEqual(['fhold.job.get', 'fhold.job.cancel']);
		expect(fixture.replies[0].text).toBe('Work stopped.');
		expect(fixture.say).toHaveBeenCalledTimes(1);
	});
	it('reopens a persisted Slack job and edits its original message without running the agent again', async () => {
		const fixture = slackFixture();
		const first = await fixture.say({ text: 'Working…', thread_ts: '1.000001' });
		const id = recoveryFixture('slack', first.ts);
		const calls = spyOn(McpClient.prototype, 'callTool').mockResolvedValue(response('completed', 'Recovered final answer'));
		await new SlackPortal().start();
		await settledDelivery('slack', id);
		expect(calls.mock.calls.map(([request]) => request.name)).toEqual(['fhold.job.get']);
		expect(fixture.say).toHaveBeenCalledTimes(1);
		expect(fixture.replies[0].text).toBe('Recovered final answer');
		expect(fixture.replies[0].thread_ts).toBe('1.000001');
	});

	it('reopens a persisted Discord job in the original thread and edits the same message', async () => {
		const fixture = discordFixture();
		const first = await fixture.post({ content: 'Working…' });
		const id = recoveryFixture('discord', first.id);
		const calls = spyOn(McpClient.prototype, 'callTool').mockResolvedValue(response('completed', 'Recovered Discord answer'));
		await new DiscordPortal().start();
		await settledDelivery('discord', id);
		expect(calls.mock.calls.map(([request]) => request.name)).toEqual(['fhold.job.get']);
		expect(fixture.post).toHaveBeenCalledTimes(1);
		expect(first.content).toBe('Recovered Discord answer');
	});

	it('redelivers a persisted final result by editing and survives a second replacement without duplicates', async () => {
		const fixture = slackFixture();
		const first = await fixture.say({ text: 'Working…' });
		const id = recoveryFixture('slack', first.ts, 'complete');
		const calls = spyOn(McpClient.prototype, 'callTool');
		await new SlackPortal().start(); await settledDelivery('slack', id);
		await new SlackPortal().start();
		expect(calls).not.toHaveBeenCalled();
		expect(fixture.say).toHaveBeenCalledTimes(1);
		expect(fixture.replies[0].text).toBe('Saved final answer');
	});

	it('reports an unknown native submission on its existing message without resubmission', async () => {
		const fixture = slackFixture();
		const first = await fixture.say({ text: 'Working…' });
		const id = recoveryFixture('slack', first.ts, 'submitted');
		const calls = spyOn(McpClient.prototype, 'callTool');
		await new SlackPortal().start(); await settledDelivery('slack', id, 'blocked');
		expect(calls).not.toHaveBeenCalled();
		expect(fixture.say).toHaveBeenCalledTimes(1);
		expect(fixture.replies[0].text).toContain('Submission could not be confirmed');
	});

	it('rejects recovery after a requester mapping changes instead of exposing a saved answer', async () => {
		const fixture = slackFixture(); const first = await fixture.say({ text: 'Working…' });
		const id = recoveryFixture('slack', first.ts, 'complete');
		spyOn(PortalCredentialRegistry.prototype, 'forUser').mockReturnValue({ username: 'different', key: 'different-key' });
		const calls = spyOn(McpClient.prototype, 'callTool');
		await new SlackPortal().start(); await settledDelivery('slack', id, 'blocked');
		expect(calls).not.toHaveBeenCalled();
		expect(slackUpdate).not.toHaveBeenCalled();
		expect(fixture.replies[0].text).toBe('Working…');
	});

	it('rechecks current Discord allowlists before recovering or editing a reply', async () => {
		const fixture = discordFixture(); const first = await fixture.post({ content: 'Working…' });
		const id = recoveryFixture('discord', first.id);
		process.env.DISCORD_ALLOWED_USERS = '999999';
		const calls = spyOn(McpClient.prototype, 'callTool');
		await new DiscordPortal().start(); await settledDelivery('discord', id, 'blocked');
		expect(calls).not.toHaveBeenCalled();
		expect(first.edit).not.toHaveBeenCalled();
	});

	it('recreates permission controls from current Guardian state and requires a fresh requester decision', async () => {
		const fixture = slackFixture(); const first = await fixture.say({ text: 'Working…' });
		const id = recoveryFixture('slack', first.ts);
		const previous = await fixture.say({ text: 'Stale permission controls' });
		const previousTail = await fixture.say({ text: 'Previous long question tail', blocks: [{ type: 'actions', elements: [] }] });
		const store = new ConversationStore();
		const record = store.delivery('slack', id)!;
		record.messages.prompt = [{ id: previous.ts, text: 'Stale permission controls' }, { id: previousTail.ts, text: 'Previous long question tail' }];
		record.prompt = { message: previousTail.ts, questionIndex: 0 };
		store.saveDelivery(record); store.close();
		let approved = false;
		const calls = spyOn(McpClient.prototype, 'callTool').mockImplementation(async (request) => {
			if (request.name === 'fhold.interaction.respond') { approved = true; return { content: [] }; }
			if (request.name !== 'fhold.job.get') throw new Error('Native submission must not be replayed');
			return approved ? response('completed', 'Approved result') : response('input_required', '', { interactions: [permission] });
		});
		await new SlackPortal().start();
		await until(() => fixture.replies[1].blocks?.some((block) => (block as { type: string }).type === 'actions') === true);
		await until(() => fixture.replies[2].text.includes('Previous controls closed'));
		expect(fixture.replies[2].blocks).toEqual([]);
		expect(approved).toBe(false);
		await slackAction(slackButton(fixture.replies[1], previous.ts, 'Allow once', 'UOTHER'));
		expect(approved).toBe(false);
		await slackAction(slackButton(fixture.replies[1], previous.ts, 'Allow once'));
		await settledDelivery('slack', id);
		expect(calls.mock.calls.filter(([request]) => request.name === 'fhold.interaction.respond')).toHaveLength(1);
		expect(calls.mock.calls.some(([request]) => request.name === 'fhold.agent.run')).toBe(false);
		expect(fixture.replies).toHaveLength(3);
		expect(fixture.replies[0].text).toBe('Approved result');
	});

	it('restores shorter Discord prompts on the current message and closes surplus old controls', async () => {
		const fixture = discordFixture(); const first = await fixture.post({ content: 'Working…' });
		const id = recoveryFixture('discord', first.id);
		const previous = await fixture.post({ content: 'Old question' });
		const tail = await fixture.post({ content: 'Old question tail' });
		const store = new ConversationStore(); const record = store.delivery('discord', id)!;
		record.messages.prompt = [{ id: previous.id, text: previous.content }, { id: tail.id, text: tail.content }];
		record.prompt = { message: tail.id, questionIndex: 0 }; store.saveDelivery(record); store.close();
		let approved = false;
		const calls = spyOn(McpClient.prototype, 'callTool').mockImplementation(async (request) => {
			if (request.name === 'fhold.interaction.respond') { approved = true; return { content: [] }; }
			if (request.name !== 'fhold.job.get') throw new Error('Native submission must not be replayed');
			return approved ? response('completed', 'Approved Discord result') : response('input_required', '', { interactions: [permission] });
		});
		const portal = new DiscordPortal(); await portal.start();
		await until(() => tail.content.includes('Previous controls closed'));
		expect(tail.components).toEqual([]);
		await (portal as unknown as { onInteraction(value: unknown): Promise<void> }).onInteraction(discordButton(previous, fixture.thread, 'Allow once'));
		await settledDelivery('discord', id);
		expect(approved).toBe(true);
		expect(calls.mock.calls.filter(([request]) => request.name === 'fhold.interaction.respond')).toHaveLength(1);
		expect(fixture.post).toHaveBeenCalledTimes(3);
		expect(first.content).toBe('Approved Discord result');
	});
});

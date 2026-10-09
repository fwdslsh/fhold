import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Client as McpClient } from '@modelcontextprotocol/client';

import { ConversationStore } from './conversations.js';
import { PortalCredentialRegistry } from './credential-registry.js';
import * as runtime from './runtime.js';

type SlackReply = { text: string; thread_ts: string };
type SlackPayload = {
	event: { user: string; channel: string; text: string; ts: string; thread_ts?: string };
	say: (reply: SlackReply) => Promise<unknown>;
};
const slackEvents = new Map<string, (payload: SlackPayload) => Promise<void>>();
const discordEvents = new Map<string, (message: unknown) => void>();

// Mock only the app transports: the shared chat client, policy checks, queue and
// in-memory conversation database run normally. No live bot or provider calls.
mock.module('@slack/bolt', () => ({
	App: class {
		client = { auth: { test: async () => ({ user_id: 'UBOT123' }) } };
		event(name: string, handler: (payload: SlackPayload) => Promise<void>) {
			slackEvents.set(name, handler);
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
	Events: { Error: 'error', MessageCreate: 'messageCreate', ClientReady: 'ready' },
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

function response(status: string, text?: string) {
	return {
		content: [],
		structuredContent: { status, session: 'test.session', job: 'test.job', text }
	};
}

async function slackMessage(name: string, payload: SlackPayload) {
	const handler = slackEvents.get(name);
	if (!handler) throw new Error(`Slack handler not registered: ${name}`);
	await handler(payload);
}

describe('portal long-job reply delivery', () => {
	it('stores the Slack conversation before its notice and sends all final chunks to the original thread', async () => {
		const stored = spyOn(ConversationStore.prototype, 'set');
		const callTool = spyOn(McpClient.prototype, 'callTool');
		callTool
			.mockResolvedValueOnce(response('running'))
			.mockResolvedValueOnce(response('completed', 's'.repeat(4_100)));
		const say = mock(async (_reply: SlackReply) => {
			expect(stored.mock.calls[0]).toEqual([
				'slack',
				'credential:test-user:thread:C123:1.000001',
				'test.session'
			]);
		});
		await new SlackPortal().start();

		await slackMessage('app_mention', {
			event: {
				user: 'U123',
				channel: 'C123',
				text: '<@UBOT123> Do the work',
				ts: '2.000002',
				thread_ts: '1.000001'
			},
			say
		});

		expect(say.mock.calls.map(([reply]) => reply.thread_ts)).toEqual([
			'1.000001',
			'1.000001',
			'1.000001'
		]);
		expect(say.mock.calls[0][0].text).toContain("I'll post the result here");
		expect(
			say.mock.calls
				.slice(1)
				.map(([reply]) => reply.text)
				.join('')
		).toBe('s'.repeat(4_100));
		expect(stored).toHaveBeenCalledTimes(2);
	});

	it('queues unmentioned Slack thread replies while work is running and reuses the session', async () => {
		const progress = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<ReturnType<typeof response>>();
		const callTool = spyOn(McpClient.prototype, 'callTool');
		let runs = 0;
		callTool.mockImplementation(async (request) => {
			if (request.name === 'fhold.agent.run') {
				runs++;
				return runs === 1 ? response('running') : response('completed', 'Follow-up done');
			}
			return finish.promise;
		});
		const say = mock(async (_reply: SlackReply) => {
			progress.resolve();
		});
		await new SlackPortal().start();
		const first = slackMessage('app_mention', {
			event: { user: 'U123', channel: 'C123', text: '<@UBOT123> Work', ts: '1.000001' },
			say
		});
		await progress.promise;

		const next = slackMessage('message', {
			event: {
				user: 'U123',
				channel: 'C123',
				text: 'Then do the next thing',
				ts: '2.000002',
				thread_ts: '1.000001'
			},
			say
		});
		expect(runs).toBe(1);
		finish.resolve(response('completed', 'First work done'));
		await Promise.all([first, next]);

		expect(runs).toBe(2);
		expect(callTool.mock.calls[2][0]).toEqual({
			name: 'fhold.agent.run',
			arguments: {
				message: 'Then do the next thing',
				session: 'test.session',
				waitMs: 30_000
			}
		});
		expect(say.mock.calls.slice(1).map(([reply]) => reply.text)).toEqual([
			'First work done',
			'Follow-up done'
		]);
	});

	it('still posts the Slack result when its progress notice fails', async () => {
		spyOn(McpClient.prototype, 'callTool')
			.mockResolvedValueOnce(response('running'))
			.mockResolvedValueOnce(response('completed', 'Finished'));
		const say = mock(async (_reply: SlackReply) => {});
		say.mockRejectedValueOnce(new Error('Slack temporarily unavailable'));
		await new SlackPortal().start();

		await slackMessage('app_mention', {
			event: { user: 'U123', channel: 'C123', text: '<@UBOT123> Work', ts: '1.000001' },
			say
		});

		expect(say).toHaveBeenCalledTimes(2);
		expect(say.mock.calls[1][0]).toEqual({ text: 'Finished', thread_ts: '1.000001' });
	});

	it('sends the Discord progress notice and final chunks as replies to the original message', async () => {
		const stored = spyOn(ConversationStore.prototype, 'set');
		spyOn(McpClient.prototype, 'callTool')
			.mockResolvedValueOnce(response('running'))
			.mockResolvedValueOnce(response('completed', 'd'.repeat(2_100)));
		const delivered = Promise.withResolvers<void>();
		const reply = mock(async (_text: string) => {
			expect(stored.mock.calls[0]).toEqual([
				'discord',
				'credential:test-user:channel:654321:user:123456',
				'test.session'
			]);
			if (reply.mock.calls.length === 3) delivered.resolve();
		});
		await new DiscordPortal().start();
		const handler = discordEvents.get('messageCreate');
		if (!handler) throw new Error('Discord message handler not registered');

		handler({
			id: '111111',
			author: { id: '123456', bot: false },
			guildId: '123456',
			mentions: { has: () => true },
			content: '<@900000> Do the work',
			channel: { id: '654321', isThread: () => false, sendTyping: async () => {} },
			reply
		});
		await delivered.promise;

		expect(reply.mock.calls[0][0]).toContain("I'll post the result here");
		expect(
			reply.mock.calls
				.slice(1)
				.map(([text]) => text)
				.join('')
		).toBe('d'.repeat(2_100));
		expect(stored).toHaveBeenCalledTimes(2);
	});
});

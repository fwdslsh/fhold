import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Client } from '@modelcontextprotocol/client';

import { GuardianChatClient } from './chat-client.js';

type ToolResult = Awaited<ReturnType<Client['callTool']>>;
const credential = { username: 'test-user', key: 'unit-test-key' };
const clients: GuardianChatClient[] = [];

function response(status: string, fields: Record<string, unknown> = {}): ToolResult {
	return {
		content: [],
		structuredContent: { status, session: 'test.session', job: 'test.job', ...fields }
	};
}

function fixture() {
	spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
	const close = spyOn(Client.prototype, 'close').mockResolvedValue(undefined);
	const callTool = spyOn(Client.prototype, 'callTool');
	const chat = new GuardianChatClient();
	clients.push(chat);
	return { chat, callTool, close };
}

afterEach(async () => {
	for (const client of clients.splice(0)) await client.close();
	mock.restore();
});

describe('Guardian portal job tracking', () => {
	it('returns actionable input, records an explicit response and resumes the existing job', async () => {
		const { chat, callTool } = fixture();
		const prompt = {
			kind: 'question',
			handle: 'interaction.handle',
			questions: [
				{
					question: 'Target?',
					options: [{ label: 'API', description: 'API service' }],
					multiple: false,
					custom: true
				}
			]
		};
		callTool
			.mockResolvedValueOnce(response('input_required', { interactions: [prompt] }))
			.mockResolvedValueOnce({ content: [] })
			.mockResolvedValueOnce(response('completed', { text: 'Done' }));
		const result = await chat.chat('Work', credential);
		expect(result.pending).toEqual({ job: 'test.job', interactions: [prompt] });
		await chat.respond(credential, { interaction: 'interaction.handle', answers: [['API']] });
		expect((await chat.resume('test.job', credential)).text).toBe('Done');
		expect(callTool.mock.calls.map(([request]) => request.name)).toEqual([
			'fhold.agent.run',
			'fhold.interaction.respond',
			'fhold.job.get'
		]);
	});

	it('delivers standard progress metadata and final snapshots in order, tolerating delivery failures', async () => {
		const { chat, callTool } = fixture();
		spyOn(console, 'error').mockImplementation(() => {});
		callTool.mockImplementation(async (_request, options) => {
			const notification = {
				progress: 1,
				message: 'Working',
				_meta: {
					'io.fwdslsh.fhold/agent': response('running', {
						text: 'Partial',
						tools: [{ name: 'bash', status: 'running' }]
					}).structuredContent
				}
			};
			options?.onprogress?.(notification);
			return response('completed', { text: 'Final' });
		});
		const updates: string[] = [];
		const onUpdate = mock(async (update: { text: string }) => {
			updates.push(update.text);
			if (update.text === 'Partial') throw new Error('temporary platform failure');
		});
		expect((await chat.chat('Work', credential, undefined, onUpdate)).text).toBe('Final');
		expect(updates).toEqual(['Partial', 'Final']);
		expect(callTool).toHaveBeenCalledTimes(1);
	});

	it('delivers live snapshots and completion beyond the old three-minute cutoff', async () => {
		const { chat, callTool } = fixture();
		let elapsed = 0;
		spyOn(Date, 'now').mockImplementation(() => elapsed);
		const results = [
			response('running'),
			...Array.from({ length: 7 }, (_, index) => response('running', { job: `job.${index}` })),
			response('completed', { text: 'Finished the requested work.' })
		];
		callTool.mockImplementation(async () => {
			elapsed += 30_000;
			const result = results.shift();
			if (!result) throw new Error('Unexpected extra tool request');
			return result;
		});
		const onUpdate = mock(
			async (_update: { conversation: string; text: string; status: string }) => {}
		);

		const result = await chat.chat('Do the work', credential, undefined, onUpdate);

		expect(result).toEqual({
			conversation: 'test.session',
			text: 'Finished the requested work.'
		});
		expect(elapsed).toBeGreaterThan(180_000);
		expect(onUpdate).toHaveBeenCalledTimes(9);
		expect(onUpdate.mock.calls[0][0]).toMatchObject({
			conversation: 'test.session',
			status: 'running'
		});
		expect(callTool).toHaveBeenCalledTimes(9);
		expect(callTool.mock.calls.map(([request]) => request.name)).toEqual([
			'fhold.agent.run',
			...Array(8).fill('fhold.job.get')
		]);
		expect(callTool.mock.calls[1][0].arguments).toEqual({ job: 'test.job', waitMs: 30_000 });
		expect(callTool.mock.calls[8][0].arguments).toEqual({ job: 'job.6', waitMs: 30_000 });
		for (const [, options] of callTool.mock.calls) {
			expect(options).toMatchObject({ timeout: 45_000, maxTotalTimeout: 45_000 });
		}
	});

	it('delivers fast replies once and continues the existing conversation', async () => {
		const { chat, callTool } = fixture();
		callTool.mockResolvedValue(response('completed', { text: 'Quick answer' }));
		const onUpdate = mock(async () => {});

		expect(await chat.chat('Next question', credential, 'test.previous', onUpdate)).toEqual({
			conversation: 'test.session',
			text: 'Quick answer'
		});
		expect(onUpdate).toHaveBeenCalledTimes(1);
		expect(callTool).toHaveBeenCalledTimes(1);
		expect(callTool.mock.calls[0][0]).toEqual({
			name: 'fhold.agent.run',
			arguments: { message: 'Next question', session: 'test.previous', waitMs: 30_000 }
		});
	});

	it('continues polling and delivers the result when progress delivery fails', async () => {
		const { chat, callTool } = fixture();
		const warnings = spyOn(console, 'error').mockImplementation(() => {});
		callTool
			.mockResolvedValueOnce(response('running'))
			.mockResolvedValueOnce(response('completed', { text: 'The actual result' }));
		const onUpdate = mock(async () => {
			throw new Error('Temporary platform delivery failure');
		});

		expect((await chat.chat('Work', credential, undefined, onUpdate)).text).toBe(
			'The actual result'
		);
		expect(callTool).toHaveBeenCalledTimes(2);
		expect(onUpdate).toHaveBeenCalledTimes(2);
		expect(warnings).toHaveBeenCalledTimes(2);
		expect(JSON.parse(String(warnings.mock.calls[0][0]))).toMatchObject({
			level: 'warn',
			event: 'progress_delivery_failed'
		});
	});

	it('stops for a question without rerunning or implicitly answering it', async () => {
		const { chat, callTool } = fixture();
		callTool.mockResolvedValueOnce(response('running')).mockResolvedValueOnce(
			response('input_required', {
				interactions: [
					{
						kind: 'question',
						questions: [{ question: 'Which folder?', options: [{ label: 'Inbox' }] }]
					}
				]
			})
		);

		expect(await chat.chat('Work', credential)).toEqual({
			conversation: 'test.session',
			text: 'Which folder?\nOptions: Inbox'
		});
		expect(callTool).toHaveBeenCalledTimes(2);
	});

	it('retains explicit permission approval instead of approving work automatically', async () => {
		const { chat, callTool } = fixture();
		callTool.mockResolvedValueOnce(response('running')).mockResolvedValueOnce(
			response('input_required', {
				interactions: [{ kind: 'permission', permission: 'bash' }]
			})
		);

		const result = await chat.chat('Work', credential);
		expect(result.text).toContain('waiting for permission to perform bash');
		expect(result.text).toContain('approve or reject it explicitly');
		expect(callTool).toHaveBeenCalledTimes(2);
	});

	it('reports job failure without submitting the work again or exposing its handle', async () => {
		const { chat, callTool } = fixture();
		callTool
			.mockResolvedValueOnce(response('running'))
			.mockResolvedValueOnce(response('failed', { error: 'Provider unavailable' }));

		await expect(chat.chat('Work', credential)).rejects.toThrow('Provider unavailable');
		expect(callTool).toHaveBeenCalledTimes(2);
	});

	it('closes a failed transport without retrying the agent run', async () => {
		const { chat, callTool, close } = fixture();
		callTool
			.mockResolvedValueOnce(response('running'))
			.mockRejectedValueOnce(new Error('MCP connection lost'));

		await expect(chat.chat('Work', credential)).rejects.toThrow('MCP connection lost');
		expect(close).toHaveBeenCalledTimes(1);
		expect(callTool).toHaveBeenCalledTimes(2);
	});

	it('reports a missing running-job handle instead of returning a manual handoff', async () => {
		const { chat, callTool } = fixture();
		callTool.mockResolvedValue(response('running', { job: undefined }));

		await expect(chat.chat('Work', credential)).rejects.toThrow(
			'Guardian did not provide a handle for the running job'
		);
		expect(callTool).toHaveBeenCalledTimes(1);
	});
});

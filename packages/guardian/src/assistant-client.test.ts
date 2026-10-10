import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantClient } from './assistant-client.js';

const temporary: string[] = [];
afterEach(async () => {
	for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('OpenCode Assistant adapter', () => {
	it('paginates the native 200-session limit instead of truncating the Guardian ownership scan', async () => {
		const root = await mkdtemp(join(tmpdir(), 'fhold-assistant-pagination-'));
		temporary.push(root);
		const passwordFile = join(root, 'password');
		await writeFile(passwordFile, 'synthetic');
		let calls = 0;
		const client = createAssistantClient({
			passwordFile,
			fetch: (async (input, init) => {
				const url = new URL(new Request(input, init).url);
				const offset = calls++ * 200;
				expect(url.searchParams.get('limit')).toBe(offset === 400 ? '100' : '200');
				expect(url.searchParams.get('cursor')).toBe(offset ? `page-${offset}` : null);
				return Response.json({
					data: Array.from({ length: Math.min(200, 405 - offset) }, (_, index) => ({
						id: `ses_${offset + index}`,
						time: { created: 1, updated: 2 }
					})),
					cursor: { next: offset < 400 ? `page-${offset + 200}` : null }
				});
			}) as typeof fetch
		});
		expect(await client.listSessions(500, AbortSignal.timeout(1000))).toHaveLength(405);
		expect(calls).toBe(3);
	});
	it('applies policy before queuing the exact message ID, rotates native auth, and only exposes public activity', async () => {
		const root = await mkdtemp(join(tmpdir(), 'fhold-assistant-client-'));
		temporary.push(root);
		const passwordFile = join(root, 'password');
		await writeFile(passwordFile, 'first-password');
		const requests: Request[] = [];
		const fakeFetch: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			requests.push(request.clone());
			const url = new URL(request.url);
			if (url.pathname.endsWith('/prompt')) return Response.json({ data: {} });
			if (request.method !== 'GET') return new Response(null, { status: 204 });
			if (url.pathname === '/api/session/ses_1/message')
				return Response.json({
					data: [
						{ type: 'user', id: 'msg_request', text: 'do the work', time: { created: 10 } },
						{
							type: 'assistant',
							id: 'msg_answer',
							agent: 'remote-full',
							finish: 'tool-calls',
							time: { created: 20, completed: 30 },
							cost: 0.01,
							snapshot: { files: ['src/index.ts'] },
							content: [
								{ type: 'reasoning', text: 'private reasoning' },
								{
									type: 'tool',
									name: 'shell',
									id: 'private-id',
									state: {
										status: 'completed',
										input: { command: 'private command' },
										content: [{ type: 'text', text: 'private output' }]
									}
								},
								{ type: 'tool', name: 'invalid/name', state: { status: 'running' } },
								{ type: 'text', text: 'done' }
							]
						}
					],
					cursor: {}
				});
			return Response.json({ error: 'unexpected request' }, { status: 500 });
		};
		const client = createAssistantClient({
			baseUrl: 'http://assistant:4096',
			directory: '/work',
			passwordFile,
			fetch: fakeFetch
		});
		await client.runAsync(
			'ses_1',
			'msg_request',
			'do the work',
			'remote-full',
			AbortSignal.timeout(1_000)
		);
		expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
			['PATCH', '/api/session/ses_1'],
			['POST', '/api/session/ses_1/agent'],
			['POST', '/api/session/ses_1/prompt']
		]);
		expect(await requests[0]!.json()).toEqual({ permissions: [] });
		expect(await requests[1]!.json()).toEqual({ agent: 'remote-full' });
		expect(await requests[2]!.json()).toEqual({
			id: 'msg_request',
			text: 'do the work',
			delivery: 'queue'
		});
		expect(
			requests.every(
				(request) =>
					request.headers.get('authorization') ===
					`Basic ${Buffer.from('opencode:first-password').toString('base64')}`
			)
		).toBe(true);
		await writeFile(passwordFile, 'rotated-password');
		const messages = await client.listMessages('ses_1', 20, AbortSignal.timeout(1_000));
		expect(messages).toEqual([
			expect.objectContaining({ id: 'msg_request', role: 'user' }),
			expect.objectContaining({
				id: 'msg_answer',
				parentId: 'msg_request',
				role: 'assistant',
				finish: 'tool-calls',
				tools: [{ name: 'shell', status: 'completed' }],
				text: 'done',
				files: ['src/index.ts']
			})
		]);
		expect(JSON.stringify(messages)).not.toContain('private');
		expect(requests[3]!.headers.get('authorization')).toBe(
			`Basic ${Buffer.from('opencode:rotated-password').toString('base64')}`
		);
	});
});

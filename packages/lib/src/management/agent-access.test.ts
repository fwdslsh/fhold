import { describe, expect, it } from 'bun:test';
import { createHttpsNativeAgentService } from './agent-access.js';

describe('HTTPS native agent access', () => {
	it('uses only the selected HTTPS origin, keeps password private, and rejects redirects', async () => {
		const calls: Request[] = [];
		const service = createHttpsNativeAgentService({
			endpoint: 'https://agent.example.test',
			password: 'session-only-password',
			fetch: (async (input, init) => {
				const request = new Request(input, init);
				calls.push(request);
				expect(init?.redirect).toBe('error');
				expect(request.headers.get('authorization')).toBe(
					`Basic ${Buffer.from('opencode:session-only-password').toString('base64')}`
				);
				return Response.json({ data: [] });
			}) as typeof fetch
		});
		await service.listProviders();
		expect(calls.map((request) => new URL(request.url).origin)).toEqual([
			'https://agent.example.test',
			'https://agent.example.test',
			'https://agent.example.test',
			'https://agent.example.test'
		]);
		expect(JSON.stringify(calls.map((request) => request.url))).not.toContain(
			'session-only-password'
		);
	});

	it('ends readiness immediately when its selected access session is closed', async () => {
		const controller = new AbortController();
		controller.abort();
		let requests = 0;
		const service = createHttpsNativeAgentService({
			endpoint: 'https://agent.example.test',
			password: 'session',
			fetch: (async () => {
				requests++;
				throw new Error('No request after close');
			}) as typeof fetch
		});
		const result = await service.testReadiness({ signal: controller.signal });
		expect(result.ok).toBe(false);
		expect(requests).toBe(0);
	});

	it('does not claim ordinary HTTP, credential-bearing URLs, or cancelled routes are cloud access', async () => {
		for (const endpoint of [
			'http://agent.example.test',
			'https://user:password@agent.example.test',
			'https://agent.example.test/path'
		]) {
			expect(() => createHttpsNativeAgentService({ endpoint, password: 'session' })).toThrow();
		}
		const controller = new AbortController();
		controller.abort();
		const service = createHttpsNativeAgentService({
			endpoint: 'https://agent.example.test',
			password: 'session',
			fetch: (() => {
				throw new Error('fetch must not outlive an already closed access route');
			}) as typeof fetch
		});
		await expect(service.listProviders({ signal: controller.signal })).rejects.toThrow();
	});
});

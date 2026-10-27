import { describe, expect, it } from 'bun:test';
import {
	createHttpsNativeAgentService,
	createNativeAgentService
} from '../control-plane/native-agent.js';

describe('HTTPS native agent access', () => {
	it('requests a native one-use link on the selected origin without sending the password in a URL', async () => {
		const requests: Request[] = [];
		const service = createNativeAgentService(
			{
				endpoint: 'http://127.0.0.1:54321',
				authorization: () => 'Basic synthetic-private-auth'
			},
			{
				fetch: (async (input, init) => {
					const request = new Request(input, init);
					requests.push(request);
					expect(request.headers.get('authorization')).toBe('Basic synthetic-private-auth');
					expect(init?.redirect).toBe('error');
					return Response.json({ code: `one_use-${requests.length}`, expires_in: 300 });
				}) as typeof fetch
			}
		);
		expect(await service.browserLink()).toEqual({
			url: 'http://127.0.0.1:54321/auth/connect/one_use-1'
		});
		expect(await service.browserLink()).toEqual({
			url: 'http://127.0.0.1:54321/auth/connect/one_use-2'
		});
		expect(requests.map((request) => [request.method, request.url])).toEqual([
			['POST', 'http://127.0.0.1:54321/api/pair'],
			['POST', 'http://127.0.0.1:54321/api/pair']
		]);
	});
	it('does not turn a malformed pairing response into a browser destination or log its body', async () => {
		for (const response of [{}, { code: '//other.test/private' }, { code: 'secret?password=x' }]) {
			const service = createHttpsNativeAgentService({
				endpoint: 'https://agent.example.test',
				password: 'private-password',
				fetch: (async () => Response.json(response)) as typeof fetch
			});
			await expect(service.browserLink()).rejects.toThrow(
				'OpenCode did not return a browser sign-in link'
			);
		}
	});
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
		await expect(service.testReadiness({ signal: controller.signal })).rejects.toThrow('aborted');
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

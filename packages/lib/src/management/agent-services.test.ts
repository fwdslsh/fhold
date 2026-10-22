import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgentServices } from './agent-services.js';
import { createFholdState } from '../control-plane/foundation.js';
import { defaultStackConfig, writeStackConfig } from '../control-plane/stack-config.js';

function fixture() {
	const home = mkdtempSync(join(tmpdir(), 'fhold-agent-service-'));
	mkdirSync(join(home, 'state/secrets'), { recursive: true });
	writeStackConfig(home, defaultStackConfig());
	writeFileSync(
		join(home, 'state/secrets/fhold_opencode_password'),
		'synthetic-native-password\n',
		{ mode: 0o600 }
	);
	const integration = {
		id: 'example',
		methods: [{ id: 'browser', type: 'oauth', label: 'Sign in' }],
		connections: []
	};
	const request = (path: string) => {
		const data = (value: unknown) => Response.json({ data: value });
		if (path === '/api/info') return Response.json({ version: '2.0.32' });
		if (path === '/api/integration') return data([integration]);
		if (path === '/api/integration/example') return data(integration);
		if (path === '/api/provider') return data([{ id: 'example', name: 'Example' }]);
		if (path === '/api/model/default') return data({ providerID: 'example', id: 'tool-model' });
		if (path === '/api/model')
			return data([
				{
					id: 'tool-model',
					providerID: 'example',
					capabilities: { tools: true, input: ['text'], output: ['text'] }
				}
			]);
		if (path === '/api/experimental/generate') return data({ text: 'FH_READY' });
		throw new Error(`Unexpected synthetic native request ${path}`);
	};
	return { home, request };
}
test('closing a native auth session suppresses a late browser callback and aborts its requests', async () => {
	const f = fixture();
	let resolveAuthorization!: (response: Response) => void;
	let started!: () => void;
	const pending = new Promise<void>((resolve) => {
		started = resolve;
	});
	const signals: AbortSignal[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (input, init) => {
		const request = new Request(input, init);
		signals.push(request.signal);
		if (new URL(request.url).pathname.endsWith('/connect/oauth')) {
			started();
			return new Promise<Response>((resolve) => {
				resolveAuthorization = resolve;
			});
		}
		return f.request(new URL(request.url).pathname);
	}) as typeof fetch;
	const urls: string[] = [];
	const service = new LocalAgentServices(
		() => createFholdState(f.home),
		(url) => urls.push(url)
	);
	try {
		const login = service.oauthStart({ provider: 'example', method: 0 });
		await pending;
		service.close();
		resolveAuthorization(
			Response.json({
				data: {
					attemptID: 'private_attempt',
					url: 'https://provider.example.test',
					mode: 'code',
					instructions: 'Sign in'
				}
			})
		);
		await expect(login).rejects.toThrow('closed');
		expect(urls).toEqual([]);
		expect(signals.every((signal) => signal.aborted)).toBe(true);
		await expect(
			service.oauthFinish({ provider: 'example', method: 0, code: 'unused' })
		).rejects.toThrow('closed');
	} finally {
		service.close();
		globalThis.fetch = original;
	}
});
test('a failed host setup-completion write does not invalidate a successful native model test', async () => {
	const f = fixture();
	const original = globalThis.fetch;
	globalThis.fetch = (async (input, init) =>
		f.request(new URL(new Request(input, init).url).pathname)) as typeof fetch;
	const service = new LocalAgentServices(
		() => createFholdState(f.home),
		undefined,
		async () => {
			throw new Error('synthetic host write failure');
		}
	);
	try {
		const result = await service.readiness(undefined);
		expect(result).toMatchObject({ ok: true, response: 'FH_READY' });
		expect(result.ok && result.warning).toContain('installation completion could not be saved');
	} finally {
		service.close();
		globalThis.fetch = original;
	}
});

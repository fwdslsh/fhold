import { describe, expect, it } from 'bun:test';
import { httpsAgentBindings } from './https-agent-session.js';
import { capabilities, type HostingSnapshot } from '../hosting/types.js';
import type { Operation } from './contracts.js';

function invoke<I, O>(operation: Operation<I, O> | undefined, input: I): Promise<O> {
	if (!operation || operation.support !== 'supported')
		throw new Error('Unsupported fixture operation');
	return operation.invoke(input, {});
}

function fixture() {
	let revision = 'revision-one';
	let replicas = 1;
	let inspections = 0;
	let completions = 0;
	const requests: Array<{ url: string; signal: AbortSignal }> = [];
	const bindings = httpsAgentBindings({
		async inspectHost(): Promise<HostingSnapshot> {
			inspections++;
			return {
				ref: {
					kind: 'azure-container-apps',
					connectionId: 'cloud',
					resourceId: '/synthetic/agent'
				},
				name: 'agent',
				location: '/synthetic/agent',
				capabilities: capabilities(['start', 'stop']),
				services: [],
				warnings: [],
				revisions: [{ name: revision, active: true, replicas, health: 'Running' }],
				clientUrl: 'https://agent.example.test'
			};
		},
		fetch: (async (input, init) => {
			const request = new Request(input, init);
			requests.push({ url: request.url, signal: request.signal });
			const path = new URL(request.url).pathname;
			const data = (value: unknown) => Response.json({ data: value });
			if (path === '/api/info') return Response.json({ version: '2.0.32' });
			if (path === '/api/pair') return Response.json({ code: 'one-use-code', expires_in: 300 });
			if (path === '/api/config')
				return Response.json([{ type: 'document', info: { model: 'example/tool-model' } }]);
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
			const integration = {
				id: 'example',
				methods: [{ id: 'browser', type: 'oauth', label: 'Sign in' }],
				connections: [{ type: 'credential', id: 'credential-one' }]
			};
			if (path === '/api/integration') return data([integration]);
			if (path === '/api/integration/example') return data(integration);
			if (path === '/api/integration/example/connect/oauth')
				return data({
					attemptID: 'attempt_one',
					url: 'https://provider.example.test/signin',
					mode: 'code',
					instructions: 'Complete native sign-in'
				});
			if (path.endsWith('/complete')) {
				completions++;
				return new Response(null, { status: 204 });
			}
			throw new Error(`Unexpected synthetic native route ${path}`);
		}) as typeof fetch
	});
	return {
		bindings,
		requests,
		get inspections() {
			return inspections;
		},
		get completions() {
			return completions;
		},
		replace() {
			revision = 'revision-two';
		},
		setReplicas(value: number) {
			replicas = value;
		}
	};
}

describe('explicit HTTPS agent session', () => {
	it('uses an explicitly connected HTTPS agent for browser pairing and rejects stale connections', async () => {
		const current = fixture();
		await expect(invoke(current.bindings.agent!.browserLink, undefined)).rejects.toThrow('Connect');
		expect(current.requests).toHaveLength(0);
		await invoke(current.bindings.agent!.connect, { password: 'synthetic-private-password' });
		// An explicit browser open may wake the connected revision; stale replica
		// counts must not gate this behind the account-mutation preflight.
		current.setReplicas(0);
		expect(await invoke(current.bindings.agent!.browserLink, undefined)).toEqual({
			url: 'https://agent.example.test/auth/connect/one-use-code'
		});
		expect(JSON.stringify(await current.bindings.inspectApplication!())).not.toContain(
			'one-use-code'
		);
		current.replace();
		await expect(invoke(current.bindings.agent!.browserLink, undefined)).rejects.toThrow(
			'runtime changed'
		);
		expect(current.requests.filter((request) => request.url.endsWith('/api/pair'))).toHaveLength(1);
		await current.bindings.close!();
	});
	it('passive observations never acquire a route or wake the workload', async () => {
		const current = fixture();
		expect((await current.bindings.inspectApplication!()).agent?.access?.state).toBe(
			'not-inspected'
		);
		expect(current.inspections).toBe(0);
		expect(current.requests).toHaveLength(0);
		const operation = current.bindings.agent!.providers!;
		expect(operation.support === 'supported' && operation.availability().state).toBe('unavailable');
		const connect = current.bindings.agent!.connect!;
		expect(connect.support === 'supported' && connect.input?.acquireClients).toEqual(['opencode']);
		await current.bindings.close!();
	});

	it('binds native inventory to an explicit private connection and aborts it on close', async () => {
		const current = fixture();
		await invoke(current.bindings.agent!.connect, { password: 'synthetic-private-password' });
		const result = await invoke(current.bindings.agent!.providers, undefined);
		expect(result.currentModel).toEqual({ provider: 'example', model: 'tool-model' });
		const observations = (await current.bindings.inspectApplication!()).agent!;
		expect(observations.account?.state === 'known' && observations.account.value.signedIn).toBe(
			true
		);
		expect(JSON.stringify(observations)).not.toContain('synthetic-private-password');
		expect(current.bindings.agent!.selectModel?.support).toBe('unsupported');
		await current.bindings.close!();
		expect(current.requests.every((request) => request.signal.aborted)).toBe(true);
		await expect(invoke(current.bindings.agent!.providers, undefined)).rejects.toThrow('Connect');
	});

	it('invalidates a native OAuth attempt after the selected runtime is replaced', async () => {
		const current = fixture();
		await invoke(current.bindings.agent!.connect, { password: 'synthetic-private-password' });
		await invoke(current.bindings.agent!.oauthStart, { provider: 'example', method: 0 });
		current.replace();
		await expect(
			invoke(current.bindings.agent!.oauthFinish, {
				provider: 'example',
				method: 0,
				code: 'one-use-code'
			})
		).rejects.toThrow('runtime changed');
		expect(current.completions).toBe(0);
		expect((await current.bindings.inspectApplication!()).agent?.access).toMatchObject({
			state: 'unavailable'
		});
		const providers = current.bindings.agent!.providers!;
		expect(providers.support === 'supported' && providers.availability().state).toBe('unavailable');
		await invoke(current.bindings.agent!.connect, { password: 'synthetic-private-password' });
		expect((await current.bindings.inspectApplication!()).agent?.access?.state).toBe('known');
		await current.bindings.close!();
	});

	it('does not submit account mutations to an ambiguous multi-replica route', async () => {
		const current = fixture();
		await invoke(current.bindings.agent!.connect, { password: 'synthetic-private-password' });
		current.setReplicas(2);
		await expect(
			invoke(current.bindings.agent!.oauthStart, { provider: 'example', method: 0 })
		).rejects.toThrow('single running');
		expect(current.requests.some((request) => request.url.includes('/connect/oauth'))).toBe(false);
		await current.bindings.close!();
	});
});

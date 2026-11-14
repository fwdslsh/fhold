import { expect, test } from 'bun:test';
import {
	capabilities,
	composeInstanceSession,
	supportedOperation,
	unsupportedOperation,
	type AgentOperations
} from '@fhold/lib';
import { completeSessionSetup } from './setup.js';

function fixture(effective: 'verified' | 'unconfirmed' = 'verified') {
	const calls: unknown[] = [];
	const ref = {
		kind: 'azure-container-apps' as const,
		connectionId: 'cloud',
		resourceId: '/agent'
	};
	const inspect = async () => ({
		ref,
		name: 'agent',
		location: '/agent',
		capabilities: capabilities([]),
		services: [],
		warnings: []
	});
	const agent: Partial<AgentOperations> = {
		connect: supportedOperation(async () => ({ endpoint: 'https://agent.example.test' })),
		readiness: supportedOperation(async (input) => {
			calls.push(['readiness', input]);
			return { ok: true, response: 'FH_READY', provider: 'example', model: 'large' };
		}),
		selectModel: supportedOperation(async (input) => {
			calls.push(['select', input]);
			return { providers: [], write: { saved: true, effective } };
		})
	};
	const unavailable = () => unsupportedOperation<void, never>('Not configured.');
	const session = composeInstanceSession({
		ref,
		inspectHost: inspect,
		agent,
		host: {
			inspect: supportedOperation(inspect),
			start: unavailable(),
			stop: unavailable(),
			restart: unavailable(),
			logs: unavailable(),
			console: unavailable()
		}
	});
	return { session, calls };
}

test('setup --provider uses the verified model, which completes installation', async () => {
	const f = fixture();
	await completeSessionSetup(f.session, ['--provider', 'example'], () => {});
	expect(f.calls).toEqual([
		['readiness', { provider: 'example' }],
		['select', { provider: 'example', model: 'large' }]
	]);
	await f.session.close();
});

test('setup without a provider verifies the default model and changes nothing', async () => {
	const f = fixture();
	await completeSessionSetup(f.session, [], () => {});
	expect(f.calls).toEqual([['readiness', {}]]);
	await f.session.close();
});

test('setup reports a model selection that did not take effect', async () => {
	const f = fixture('unconfirmed');
	await expect(
		completeSessionSetup(f.session, ['--provider', 'example'], () => {})
	).rejects.toThrow('could not be selected');
	await f.session.close();
});

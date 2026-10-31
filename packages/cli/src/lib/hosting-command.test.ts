import { expect, test } from 'bun:test';
import { supportedOperation, unsupportedOperation, type ComposedInstanceSession } from '@fhold/lib';
import { runSessionCommand } from './hosting-command.js';

function fixture() {
	const calls: unknown[] = [],
		output: string[] = [];
	const ref = {
		kind: 'azure-container-apps' as const,
		connectionId: 'azure',
		resourceId: '/resource'
	};
	const host = {
		deployment: {
			inspect: unsupportedOperation('not used'),
			prepare: unsupportedOperation('not used'),
			apply: unsupportedOperation('not used'),
			discard: unsupportedOperation('not used'),
			update: supportedOperation(
				async (value: { pull?: boolean; container?: string; image?: string }, context) => {
					calls.push(['update', value, context.confirmed]);
					return { state: 'in-progress' as const, step: 'stopping', reference: 'native-operation' };
				}
			)
		},
		inspect: supportedOperation(async () => {
			throw Error('not used');
		}),
		logs: supportedOperation(async (value) => {
			calls.push(['logs', value]);
			return 'log text';
		}),
		console: supportedOperation(async (value) => {
			calls.push(['console', value]);
		}),
		start: supportedOperation(async () => {
			throw Error('not used');
		}),
		stop: supportedOperation(async () => {
			throw Error('not used');
		}),
		restart: supportedOperation(async (_value, context) => {
			calls.push(['restart', context.confirmed]);
			return { snapshot: {} as never };
		})
	};
	const session: ComposedInstanceSession = {
		ref,
		host,
		agent: {
			connect: supportedOperation(
				async () => {
					throw Error('Public link should not acquire native access');
				},
				undefined,
				{ requiresPassword: true }
			)
		} as never,
		apps: {} as never,
		data: {} as never,
		close: async () => {},
		inspect: async () => ({
			identity: { ref, name: 'agent', location: '/resource' },
			lifecycle: {
				state: 'known',
				value: 'deployed',
				observedAt: new Date().toISOString()
			},
			deployment: {
				state: 'known',
				value: { warnings: [], clientUrl: 'https://agent.example.com' },
				observedAt: new Date().toISOString()
			},
			services: { state: 'known', value: [], observedAt: new Date().toISOString() },
			operations: {},
			pendingChanges: { state: 'not-inspected', reason: 'none' },
			agent: {} as never,
			apps: {
				config: { state: 'not-inspected', reason: 'not used' },
				status: { state: 'not-inspected', reason: 'not used' },
				connections: { state: 'not-inspected', reason: 'not used' }
			},
			data: {}
		})
	};
	return {
		calls,
		output,
		session,
		run: (args: string[]) => runSessionCommand(session, args, (text) => output.push(text))
	};
}
test('common hosted commands use provider operations and do not need a Docker home', async () => {
	const f = fixture();
	await f.run([
		'logs',
		'--type',
		'console',
		'--tail=25',
		'--revision',
		'agent--one',
		'--container',
		'assistant'
	]);
	expect(f.calls[0]).toEqual([
		'logs',
		{ type: 'console', tail: 25, revision: 'agent--one', container: 'assistant' }
	]);
	await f.run(['console', '--replica', 'replica-1']);
	expect(f.calls[1]).toEqual(['console', { replica: 'replica-1' }]);
	await f.run(['connect', 'opencode', '--json']);
	expect(JSON.parse(f.output[1]!)).toMatchObject({ url: 'https://agent.example.com' });
	await f.run(['restart', '--confirm']);
	expect(f.calls[2]).toEqual(['restart', true]);
});
test('unknown and irrelevant arguments never cause lifecycle mutations or silently choose local behavior', async () => {
	const f = fixture();
	for (const argv of [
		['stop'],
		['stop', '--confirm', '--revision', 'other'],
		['restart', '--typo'],
		['logs', '--tail', 'bad'],
		['logs', '--type', 'bad'],
		['console', '--tail', '10'],
		['status', '--revision', 'ignored'],
		['update'],
		['update', '--confirm', '--revision', 'ignored']
	])
		await expect(f.run(argv)).rejects.toThrow();
	expect(f.calls).toEqual([]);
	f.session.host.console = unsupportedOperation('This provider does not expose a console.');
	await expect(f.run(['console'])).rejects.toThrow('does not expose');
});

test('hosted updates use the shared deployment operation and preserve incomplete outcomes', async () => {
	const f = fixture();
	await f.run([
		'update',
		'--confirm',
		'--container',
		'assistant',
		'--image',
		'registry/assistant:pinned'
	]);
	expect(f.calls).toEqual([
		['update', { container: 'assistant', image: 'registry/assistant:pinned' }, true]
	]);
	expect(JSON.parse(f.output[0]!)).toEqual({
		state: 'in-progress',
		step: 'stopping',
		reference: 'native-operation'
	});
});

test('hosted update resume requires confirmation, saved changes, and no new update options', async () => {
	const f = fixture();
	f.session.host.deployment.inspect = supportedOperation(async () => ({
		containers: [],
		environment: {},
		pending: { image: 'example/old:pin' }
	}));
	f.session.host.deployment.apply = supportedOperation(async (_input, context) => {
		f.calls.push(['apply', context.confirmed]);
		return { state: 'unknown', step: 'update' };
	});
	for (const args of [
		['update', '--resume'],
		['update', '--resume', '--confirm', '--image', 'other'],
		['update', '--resume', '--confirm', '--container', 'other'],
		['update', '--resume', '--confirm', '--pull']
	])
		await expect(f.run(args)).rejects.toThrow();
	expect(f.calls).toEqual([]);
	await f.run(['update', '--resume', '--confirm']);
	expect(f.calls).toEqual([['apply', true]]);
	expect(JSON.parse(f.output[0]!)).toEqual({ state: 'unknown', step: 'update' });
	f.session.host.deployment.inspect = supportedOperation(async () => ({
		containers: [],
		environment: {}
	}));
	await expect(f.run(['update', '--resume', '--confirm'])).rejects.toThrow(
		'no saved deployment changes'
	);
	expect(f.calls).toHaveLength(1);
});

test('hosted setup verifies the native agent without changing deployment or claiming readiness on failure', async () => {
	const f = fixture();
	f.session.agent.connect = supportedOperation(async (input) => {
		f.calls.push(['connect', input]);
		return { endpoint: 'https://agent.example.test', username: 'native' };
	});
	f.session.agent.readiness = supportedOperation(async (input) => {
		f.calls.push(['readiness', input]);
		return { ok: false as const, error: 'Native account needs sign-in.' };
	});
	await expect(f.run(['setup'])).rejects.toThrow('Native account needs sign-in.');
	expect(f.output).toEqual([]);
	expect(f.calls).toEqual([
		['connect', {}],
		['readiness', {}]
	]);
	f.calls.length = 0;
	f.session.agent.readiness = supportedOperation(async (input) => {
		f.calls.push(['readiness', input]);
		return {
			ok: true as const,
			response: 'Synthetic verified response',
			provider: 'native-provider',
			model: 'native-model'
		};
	});
	await f.run(['setup', '--provider', 'native-provider', '--model', 'native-model']);
	expect(f.calls).toEqual([
		['connect', {}],
		['readiness', { provider: 'native-provider', model: 'native-model' }]
	]);
	expect(f.output.at(-1)).toContain('Verified a real native Assistant response.');
});

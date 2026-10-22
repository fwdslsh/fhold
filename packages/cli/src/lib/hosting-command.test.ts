import { expect, test } from 'bun:test';
import { capabilities, type InstanceSession } from '@fhold/lib';
import { runSessionCommand } from './hosting-command.js';

function fixture() {
	const calls: unknown[] = [],
		output: string[] = [];
	const snapshot = {
		ref: { kind: 'azure-container-apps' as const, connectionId: 'azure', resourceId: '/resource' },
		name: 'agent',
		location: '/resource',
		capabilities: capabilities(['start', 'stop', 'restart']),
		services: [],
		warnings: [],
		clientUrl: 'https://agent.example.com'
	};
	const session: InstanceSession = {
		ref: snapshot.ref,
		inspect: async () => snapshot,
		logs: async (value) => {
			calls.push(['logs', value]);
			return 'log text';
		},
		console: async (value) => {
			calls.push(['console', value]);
		},
		operate: async (action, confirmed, options) => {
			calls.push([action, confirmed, options]);
			return { snapshot, pending: true };
		}
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
	await f.run(['restart', '--confirm', '--revision', 'agent--one']);
	expect(f.calls[2]).toEqual(['restart', true, { revision: 'agent--one' }]);
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
		['update', '--confirm']
	])
		await expect(f.run(argv)).rejects.toThrow();
	expect(f.calls).toEqual([]);
	delete f.session.console;
	await expect(f.run(['console'])).rejects.toThrow('does not expose');
});

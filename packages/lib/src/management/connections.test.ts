import { expect, test } from 'bun:test';
import { publishedConnections } from './connections.js';
import type { HostingSnapshot } from '../hosting/types.js';
import { capabilities } from '../hosting/types.js';
const home = '/tmp/selected-instance';
const snapshot: HostingSnapshot = {
	name: 'qa',
	location: home,
	ref: { kind: 'local-docker', connectionId: 'local', homeDir: home },
	capabilities: capabilities(['start', 'stop', 'restart', 'settings', 'transfer']),
	services: [{ name: 'assistant', state: 'running', health: 'healthy', id: '123abc' }],
	warnings: []
};
test('connections use actual running bindings rather than unapplied settings and never inspect secrets', async () => {
	const result = await publishedConnections(home, snapshot, async (args) => {
		expect(args).toEqual([
			'inspect',
			'--format',
			expect.stringContaining('NetworkSettings.Ports'),
			'123abc'
		]);
		expect(args.join(' ')).not.toContain('.Env');
		return {
			ok: true,
			stdout: JSON.stringify({
				id: '123abcdef',
				home: `${home}/system/stack`,
				ports: { '4096/tcp': [{ HostIp: '0.0.0.0', HostPort: '49331' }] }
			}),
			stderr: '',
			exitCode: 0
		};
	});
	expect(result.assistant).toBe('http://127.0.0.1:49331');
});
test('a stopped instance needs no Docker inspection or browser connection', async () => {
	expect(
		await publishedConnections(home, { ...snapshot, services: [] }, async () => {
			throw Error('must not inspect');
		})
	).toEqual({});
});
test('a project name collision cannot forward or change providers on a different instance', async () => {
	await expect(
		publishedConnections(home, snapshot, async () => ({
			ok: true,
			stdout: JSON.stringify({ id: '123abcdef', home: '/tmp/different/system/stack', ports: {} }),
			stderr: '',
			exitCode: 0
		}))
	).rejects.toThrow('another instance');
});

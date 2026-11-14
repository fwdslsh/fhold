import { expect, test } from 'bun:test';
import { isManagementOperation, parseManagementInput } from './wire-input.js';

test('knowledge UI accepts only a valid native loopback port', () => {
	expect(parseManagementInput('data.knowledgeUi', undefined)).toBeUndefined();
	expect(parseManagementInput('data.knowledgeUi', { loopbackPort: 4444 })).toEqual({
		loopbackPort: 4444
	});
	for (const loopbackPort of [0, 80, 65536, 4000.5, '4444', null])
		expect(() => parseManagementInput('data.knowledgeUi', { loopbackPort })).toThrow('port');
});

test('native wire inputs use the same typed parsers as Admin and cannot supply transport limits', () => {
	expect(
		parseManagementInput('agent.readiness', {
			provider: 'example',
			model: 'test',
			timeoutMs: 1,
			maxResponseBytes: 1
		})
	).toEqual({ provider: 'example', model: 'test' });
	expect(() => parseManagementInput('agent.setKey', { provider: 'example', key: 42 })).toThrow(
		'key'
	);
	expect(() =>
		parseManagementInput('apps.credentials.create', { username: 'owner', policy: 'typo' })
	).toThrow('Policy');
	expect(() => parseManagementInput('docker.install', {})).toThrow();
	expect(() => parseManagementInput('snapshot', { homeDir: '/elsewhere' })).toThrow('no input');
});

test('only named operations are accepted and confirmation never travels inside input', () => {
	for (const name of ['credential', 'providerKey', 'directory', 'hello', 'constructor'])
		expect(isManagementOperation(name)).toBe(false);
	expect(isManagementOperation('apps.credentials.updatePolicy')).toBe(true);
	expect(
		parseManagementInput('apps.credentials.updatePolicy', {
			action: 'policy',
			username: 'owner',
			policy: 'read',
			previousPolicy: 'chat'
		})
	).toEqual({ username: 'owner', policy: 'read', previousPolicy: 'chat' });
	expect(
		parseManagementInput('data.backup', { destination: '/export', full: true, confirmed: true })
	).toEqual({ destination: '/export', full: true });
	expect(
		parseManagementInput('agent.remote', {
			action: 'enable',
			tool: 'claude',
			trusted: true,
			confirmed: true
		})
	).toEqual({ action: 'enable', tool: 'claude', trusted: true });
});

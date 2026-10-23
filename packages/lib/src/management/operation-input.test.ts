import { expect, test } from 'bun:test';
import { defaultRecoverySettings } from '../control-plane/recovery-config.js';
import { parseOperationInput, parseRequestContext } from './operation-input.js';

test('operation ingress returns typed recovery documents and separates confirmation', () => {
	const input = parseOperationInput('data.recovery.save', {
		baselineDigest: 'a'.repeat(64),
		settings: defaultRecoverySettings('agent'),
		selection: { version: 1, paths: [], sqlite: [] },
		confirmed: true,
		ignored: 'not part of the DTO'
	});
	expect(input.settings.instanceId).toBe('agent');
	expect(input.selection).toMatchObject({ version: 1, paths: [], sqlite: [] });
	expect(parseRequestContext({ confirmed: true })).toEqual({ confirmed: true });
	expect('confirmed' in input).toBe(false);
	expect('ignored' in input).toBe(false);
});

test('native readiness input drops transport fields and rejects non-boolean confirmation', () => {
	expect(
		parseOperationInput('agent.readiness', {
			provider: 'openai',
			model: 'gpt-test',
			signal: 'not-a-signal',
			timeoutMs: 1
		})
	).toEqual({ provider: 'openai', model: 'gpt-test' });
	expect(() => parseRequestContext({ confirmed: 'yes' })).toThrow(
		'Confirmation must be true or false.'
	);
	expect(() => parseOperationInput('host.logs', { tail: false })).toThrow('Log tail');
});

test('valid form blanks preserve saved portal tokens and native press-Enter answers', () => {
	expect(
		parseOperationInput('apps.portal.saveToken', {
			portal: 'slack',
			botToken: '',
			appToken: 'replacement-token'
		})
	).toEqual({ portal: 'slack', appToken: 'replacement-token' });
	expect(
		parseOperationInput('agent.remote', { action: 'input', tool: 'claude', input: '' })
	).toEqual({ action: 'input', tool: 'claude', input: '' });
	expect(() => parseOperationInput('agent.remote', { action: ['enable'], tool: 'claude' })).toThrow(
		'Invalid native remote request.'
	);
	expect(() =>
		parseOperationInput('agent.remote', {
			action: 'enable',
			tool: 'codex',
			sandbox: ['workspace-write']
		})
	).toThrow('Invalid Codex sandbox mode.');
});

test('hosting log input preserves the selected system or console source', () => {
	for (const type of ['system', 'console'])
		expect(
			parseOperationInput('host.logs', { type, revision: 'revision-1', container: 'assistant' })
		).toEqual({ type, revision: 'revision-1', container: 'assistant' });
	expect(() => parseOperationInput('host.logs', { type: ['console'] })).toThrow('Log type');
});

import { expect, test } from 'bun:test';
import { parseManagementArgs } from './wire-input.js';

test('native wire inputs use the same typed parsers as Admin and cannot supply transport limits', () => {
	expect(
		parseManagementArgs('readiness', {
			provider: 'example',
			model: 'test',
			timeoutMs: 1,
			maxResponseBytes: 1
		})
	).toEqual([{ provider: 'example', model: 'test' }]);
	expect(() => parseManagementArgs('providerKey', { provider: 'example', key: 42 })).toThrow('key');
	expect(() =>
		parseManagementArgs('credential', { action: 'create', username: 'owner', policy: 'typo' })
	).toThrow('Policy');
	expect(() => parseManagementArgs('install', {}, ['yes'])).toThrow();
});

test('published confirmation fields are retained only in their legacy wire envelope', () => {
	expect(
		parseManagementArgs('backup', { destination: '/export', full: true, confirmed: true })
	).toEqual([{ destination: '/export', full: true, confirmed: true }]);
	expect(
		parseManagementArgs('remote', {
			action: 'enable',
			tool: 'claude',
			trusted: true,
			restartConfirmed: true
		})
	).toEqual([{ action: 'enable', tool: 'claude', trusted: true, restartConfirmed: true }]);
	expect(() =>
		parseManagementArgs('remote', { action: 'enable', tool: 'claude', restartConfirmed: 'yes' })
	).toThrow('Confirmation');
	expect(() =>
		parseManagementArgs('providerKey', { provider: 'example', key: 'synthetic' }, [true])
	).toThrow('options');
});

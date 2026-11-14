import { expect, test } from 'bun:test';
import { backupFromAdmin } from './domain.js';

test('a full export rejects portable include options before reading the instance', async () => {
	await expect(
		backupFromAdmin('/nonexistent/fhold-home', {
			destination: '/nonexistent/export',
			full: true,
			includeProviderAuth: true
		})
	).rejects.toThrow('do not combine portable include options');
});

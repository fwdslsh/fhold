import { describe, expect, it } from 'bun:test';
import { legacyProviderCredentials } from './provider-transfer.js';

describe('auth-only portable v1 credential upgrade', () => {
	it('preserves key and OAuth fields in the native v2 import format with stable retry IDs', () => {
		const old = Buffer.from(
			JSON.stringify({
				personal: { type: 'api', key: 'synthetic-key' },
				openai: {
					type: 'oauth',
					access: 'synthetic-access',
					refresh: 'synthetic-refresh',
					expires: 2000000000000,
					accountId: 'synthetic-account'
				}
			})
		);
		const converted = legacyProviderCredentials(old)!;
		expect(converted.equals(legacyProviderCredentials(old)!)).toBe(true);
		expect(
			JSON.parse(converted.toString()).map((entry: { value: unknown }) => entry.value)
		).toEqual([
			{ type: 'key', key: 'synthetic-key' },
			{
				type: 'oauth',
				methodID: 'chatgpt-browser',
				access: 'synthetic-access',
				refresh: 'synthetic-refresh',
				expires: 2000000000000,
				metadata: { accountID: 'synthetic-account' }
			}
		]);
	});
	it('does not start a native worker for an empty file or silently drop unsupported credentials', () => {
		expect(legacyProviderCredentials(Buffer.from('{}'))).toBeUndefined();
		expect(() =>
			legacyProviderCredentials(Buffer.from('{"x":{"type":"unknown","key":"private-value"}}'))
		).toThrow('Unsupported legacy');
	});
});

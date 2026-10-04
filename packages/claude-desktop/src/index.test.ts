import { describe, expect, it } from 'bun:test';

import { readBridgeConfiguration } from './index.js';

describe('Claude Desktop bridge configuration', () => {
	it('accepts loopback protected access and a strong access key', () => {
		const config = readBridgeConfiguration({
			FH_MCP_URL: 'http://127.0.0.1:3830/mcp',
			FH_MCP_TOKEN: 'k'.repeat(32)
		});
		expect(config.url.href).toBe('http://127.0.0.1:3830/mcp');
		expect(config.token).toBe('k'.repeat(32));
	});

	it('rejects non-loopback, credential-bearing, and malformed URLs', () => {
		for (const url of [
			'https://agent.example.com/mcp',
			'http://192.168.1.20:3830/mcp',
			'http://token@127.0.0.1:3830/mcp',
			'http://127.0.0.1:3830/not-mcp'
		]) {
			expect(() =>
				readBridgeConfiguration({
					FH_MCP_URL: url,
					FH_MCP_TOKEN: 'k'.repeat(32)
				})
			).toThrow('HTTP loopback URL');
		}
	});

	it('rejects missing and weak access keys', () => {
		expect(() => readBridgeConfiguration({})).toThrow('access key');
		expect(() => readBridgeConfiguration({ FH_MCP_TOKEN: 'weak' })).toThrow('access key');
	});
});

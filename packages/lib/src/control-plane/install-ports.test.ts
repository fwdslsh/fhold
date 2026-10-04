import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installHome } from './install.js';
import { chooseInstallPorts, publishedTcpPorts } from './install-ports.js';
import { defaultStackConfig } from './stack-config.js';

const sockets: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		sockets.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
	);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function reserve(port = 0): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', resolve);
	});
	sockets.push(server);
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Missing test port.');
	return address.port;
}

it('recognizes Docker-published IPv4, IPv6 and ranged TCP ports, not UDP or exposed ports', () => {
	expect(
		[
			...publishedTcpPorts(
				'4096/tcp, 0.0.0.0:3810->4096/tcp, [::]:3810->4096/tcp\n192.0.2.1:4000-4002->80-82/tcp, 127.0.0.1:3830->9180/tcp, 99/udp, 0.0.0.0:6000->60/udp'
			)
		].sort((a, b) => a - b)
	).toEqual([3810, 3830, 4000, 4001, 4002]);
	expect([
		...publishedTcpPorts('0.0.0.0:0->80/tcp, [::]:65536->80/tcp, 0.0.0.0:5000-4999->80/tcp')
	]).toEqual([]);
});

describe.skipIf(process.env.FH_SOCKET_TESTS !== '1')('fresh installation port selection', () => {
	it('keeps available preferred ports and releases probes without changing the input', async () => {
		const first = await reserve();
		const second = await reserve();
		await Promise.all(
			sockets
				.splice(0)
				.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
		);
		const config = defaultStackConfig();
		config.assistant.port = first;
		config.gateway.port = second;
		const selected = await chooseInstallPorts(config);
		expect(selected.assistant.port).toBe(first);
		expect(selected.gateway.port).toBe(second);
		expect(selected).not.toBe(config);
		await reserve(first);
		await reserve(second);
	});
	it.each(['assistant', 'gateway'] as const)(
		'generates a distinct pair if the %s port is busy and persists it during install',
		async (busy) => {
			const occupied = await reserve();
			const config = defaultStackConfig();
			config[busy].port = occupied;
			const root = mkdtempSync(join(tmpdir(), 'fhold-automatic-ports-'));
			roots.push(root);
			const homeDir = join(root, 'home');
			await installHome({ homeDir, config, automaticPorts: true });
			const selected = JSON.parse(readFileSync(join(homeDir, 'state', 'stack.json'), 'utf8'));
			expect(selected.assistant.port).not.toBe(occupied);
			expect(selected.gateway.port).not.toBe(occupied);
			expect(selected.assistant.port).not.toBe(selected.gateway.port);
			expect(config[busy].port).toBe(occupied);
			const env = readFileSync(join(homeDir, 'state', 'stack.env'), 'utf8');
			expect(env).toContain(`FH_ASSISTANT_PORT=${selected.assistant.port}`);
			expect(env).toContain(`FH_GUARDIAN_PORT=${selected.gateway.port}`);
			await reserve(selected.assistant.port);
			await reserve(selected.gateway.port);
		}
	);
	it('reports invalid bind addresses before materializing a home', async () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-port-failure-'));
		roots.push(root);
		const homeDir = join(root, 'home');
		const config = defaultStackConfig(homeDir);
		config.assistant.bindAddress = '192.0.2.1';
		await expect(installHome({ homeDir, config, automaticPorts: true })).rejects.toThrow(
			'connection ports'
		);
		expect(existsSync(homeDir)).toBe(false);
	});
});

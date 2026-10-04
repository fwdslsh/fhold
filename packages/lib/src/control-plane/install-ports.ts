import { createServer, type Server } from 'node:net';

import { runDocker } from './docker.js';
import type { StackConfig } from './stack-config.js';

/** Include published TCP ports, not merely exposed container ports. */
export function publishedTcpPorts(output: string): Set<number> {
	const ports = new Set<number>();
	for (const match of output.matchAll(/:(\d+)(?:-(\d+))?->\d+(?:-\d+)?\/tcp\b/g)) {
		const first = Number(match[1]);
		const last = Number(match[2] ?? match[1]);
		if (first < 1 || last > 65535 || last < first) continue;
		for (let port = first; port <= last; port++) ports.add(port);
	}
	return ports;
}

function listen(host: string, port: number): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen({ host, port, exclusive: true }, () => {
			server.removeListener('error', reject);
			resolve(server);
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

/** Fresh setup only: persist concrete choices, never an ongoing auto-port mode. */
export async function chooseInstallPorts(config: StackConfig): Promise<StackConfig> {
	// Docker can publish through firewall rules without a listening host process.
	// Offline installation still works when Docker is absent or stopped.
	const docker = await runDocker(['ps', '--format', '{{.Ports}}'], { timeoutMs: 5_000 });
	const published = docker.ok ? publishedTcpPorts(docker.stdout) : new Set<number>();
	const services = [config.assistant, config.gateway];
	let listeners: Server[] = [];
	try {
		if (services.every((service) => !published.has(service.port))) {
			try {
				for (const service of services) {
					listeners.push(await listen(service.bindAddress, service.port));
				}
				return structuredClone(config);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
				await Promise.all(listeners.map(close));
				listeners = [];
			}
		}
		const selected: number[] = [];
		for (const service of services) {
			let found = false;
			for (let attempt = 0; attempt < 16; attempt++) {
				const server = await listen(service.bindAddress, 0);
				const address = server.address();
				if (!address || typeof address === 'string') {
					await close(server);
					throw new Error('Could not determine an available connection port.');
				}
				if (published.has(address.port) || selected.includes(address.port)) {
					await close(server);
					continue;
				}
				listeners.push(server);
				selected.push(address.port);
				found = true;
				break;
			}
			if (!found) throw new Error('Could not find free connection ports. Try setup again.');
		}
		const result = structuredClone(config);
		[result.assistant.port, result.gateway.port] = selected as [number, number];
		return result;
	} catch (error) {
		throw new Error(
			`Could not check connection ports: ${error instanceof Error ? error.message : String(error)}`
		);
	} finally {
		await Promise.all(listeners.map(close));
	}
}

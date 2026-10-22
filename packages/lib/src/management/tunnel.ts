import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, connect, isIP } from 'node:net';
import { sshArgs } from '../hosting/ssh-native.js';
import { hostingFailure } from '../hosting/process.js';
import type { HostingConnection } from '../hosting/types.js';

async function availablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (!address || typeof address === 'string')
		throw Error('Could not allocate a local connection port.');
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve()))
	);
	return address.port;
}
function listening(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(port, '127.0.0.1');
		socket.once('connect', () => {
			socket.destroy();
			resolve(true);
		});
		socket.once('error', () => resolve(false));
	});
}

/** App-scoped native SSH forwarding, not a proxy server or a remote exposed port. */
export class SshTunnel {
	private child?: ChildProcess;
	private signature = '';
	private ports: number[] = [];
	constructor(private connection: Extract<HostingConnection, { kind: 'ssh-docker' }>) {}
	async ensure(targets: Array<{ bind: string; port: number }>): Promise<number[]> {
		const signature = JSON.stringify(targets);
		if (this.child && signature === this.signature) return this.ports;
		await this.close();
		const ports = await Promise.all(targets.map(() => availablePort()));
		const native = sshArgs(this.connection);
		const forwards = targets.flatMap((target, index) => {
			const bind =
				target.bind === '0.0.0.0' ? '127.0.0.1' : target.bind === '::' ? '::1' : target.bind;
			return [
				'-L',
				`127.0.0.1:${ports[index]}:${isIP(bind) === 6 ? `[${bind}]` : bind}:${target.port}`
			];
		});
		const child = spawn(
			'ssh',
			[
				...native.slice(0, -1),
				'-N',
				'-o',
				'ExitOnForwardFailure=yes',
				'-o',
				'ServerAliveInterval=30',
				'-o',
				'ServerAliveCountMax=3',
				...forwards,
				this.connection.host
			],
			{ stdio: ['ignore', 'ignore', 'pipe'] }
		);
		this.child = child;
		let error: Error | undefined;
		let stderr = '';
		child.stderr?.on('data', (chunk) => {
			stderr = (stderr + String(chunk)).slice(-8192);
		});
		child.once('error', (failure) => {
			error = Error(hostingFailure('ssh', (failure as NodeJS.ErrnoException).code, '', stderr));
		});
		child.once('close', (code) => {
			error = Error(hostingFailure('ssh', code, '', stderr));
			if (this.child === child) this.child = undefined;
		});
		for (let attempt = 0; attempt < 100; attempt++) {
			if (error) throw error;
			if ((await Promise.all(ports.map(listening))).every(Boolean)) {
				this.signature = signature;
				this.ports = ports;
				return ports;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		await this.close();
		throw Error('The SSH forward did not open. Check this host connection and retry.');
	}
	async close(): Promise<void> {
		const child = this.child;
		this.child = undefined;
		this.signature = '';
		this.ports = [];
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		await new Promise<void>((resolve) => {
			child.once('close', () => resolve());
			child.kill('SIGTERM');
		});
	}
}

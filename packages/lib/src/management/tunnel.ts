import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, connect, isIP } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sshArgs } from '../control-plane/ssh-native.js';
import {
	hostingFailure,
	runHostingProcess,
	type HostingProcess
} from '../control-plane/process.js';
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
	private controlDirectory?: string;
	private pending?: Promise<number[]>;
	constructor(
		private connection: Extract<HostingConnection, { kind: 'ssh-docker' }>,
		private native: { spawn?: typeof spawn; run?: HostingProcess } = {}
	) {}
	async ensure(
		targets: Array<{ bind: string; port: number; localPort?: number }>
	): Promise<number[]> {
		const pending = (this.pending?.catch(() => []) ?? Promise.resolve()).then(() =>
			this.open(targets)
		);
		this.pending = pending;
		try {
			return await pending;
		} finally {
			if (this.pending === pending) this.pending = undefined;
		}
	}
	private async open(
		targets: Array<{ bind: string; port: number; localPort?: number }>
	): Promise<number[]> {
		const signature = JSON.stringify(targets);
		if (this.child && signature === this.signature) return this.ports;
		await this.close();
		const ports = await Promise.all(targets.map((target) => target.localPort ?? availablePort()));
		const native = sshArgs(this.connection);
		// A fixed port may already belong to another process. Only native SSH's
		// forwarding acknowledgement can establish ownership before sending a token.
		const fixed = targets.some((target) => target.localPort !== undefined);
		if (fixed && process.platform === 'win32')
			throw new Error('AKM UI over SSH requires OpenSSH multiplexing on Linux or macOS.');
		const control = fixed
			? join((this.controlDirectory = mkdtempSync(join(tmpdir(), 'fh-ssh-'))), 'c')
			: undefined;
		const forwards = targets.flatMap((target, index) => {
			const bind =
				target.bind === '0.0.0.0' ? '127.0.0.1' : target.bind === '::' ? '::1' : target.bind;
			return [
				'-L',
				`127.0.0.1:${ports[index]}:${isIP(bind) === 6 ? `[${bind}]` : bind}:${target.port}`
			];
		});
		const child = (this.native.spawn ?? spawn)(
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
				...(control ? ['-M', '-S', control, '-o', 'ControlPersist=no'] : forwards),
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
		try {
			for (let attempt = 0; attempt < 100; attempt++) {
				if (error) throw error;
				if (this.child !== child) throw new Error('The SSH connection was closed.');
				let ready = false;
				if (control) {
					try {
						await (this.native.run ?? runHostingProcess)(
							'ssh',
							[...native.slice(0, -1), '-S', control, '-O', 'check', this.connection.host],
							{ timeoutMs: 1500 }
						);
						ready = true;
					} catch {
						/* The foreground master is still connecting. */
					}
				} else ready = (await Promise.all(ports.map(listening))).every(Boolean);
				if (ready) {
					if (control) {
						await (this.native.run ?? runHostingProcess)(
							'ssh',
							[
								...native.slice(0, -1),
								'-S',
								control,
								'-O',
								'forward',
								...forwards,
								this.connection.host
							],
							{ timeoutMs: 5000 }
						);
						if (this.child !== child || error) throw new Error('The SSH connection was closed.');
					}
					this.signature = signature;
					this.ports = ports;
					return ports;
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			throw Error('The SSH forward did not open. Check this host connection and retry.');
		} catch (error) {
			await this.close();
			throw error;
		}
	}
	async close(): Promise<void> {
		const child = this.child;
		this.child = undefined;
		this.signature = '';
		this.ports = [];
		if (child && child.exitCode === null && child.signalCode === null)
			await new Promise<void>((resolve) => {
				child.once('close', () => resolve());
				child.kill('SIGTERM');
			});
		if (this.controlDirectory) rmSync(this.controlDirectory, { recursive: true, force: true });
		this.controlDirectory = undefined;
	}
}

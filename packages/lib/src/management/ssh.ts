import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isIP } from 'node:net';
import { sshArgs } from '../hosting/ssh-native.js';
import { hostingFailure, runHostingProcess } from '../hosting/process.js';
import { packTransfer, unpackTransfer, preserveTransferMetadata } from './transfer.js';
import type { HostingConnection } from '../hosting/types.js';
import type {
	InstanceManagement,
	ManagementMethod,
	ManagedSnapshot,
	ManagementRequestArgs,
	ManagementRequestMap
} from './types.js';
import { SshTunnel } from './tunnel.js';

export const SSH_MANAGEMENT_COMMAND = 'PATH="$HOME/.local/bin:$PATH" exec fhold hosting session';
export type ManagementRequest = {
	id: number;
	homeDir: string;
	setupName?: string;
	method: ManagementMethod;
	value?: unknown;
	extra?: unknown[];
};
export type ManagementResponse =
	| { id: number; ok: true; value: unknown }
	| { id: number; ok: false; error: string }
	| { event: 'open-url'; url: string };

/** One native SSH stdin/stdout session; no remote daemon or listening management port. */
export class SshInstanceManagement implements InstanceManagement {
	private child?: ChildProcessWithoutNullStreams;
	private pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	private serial = 0;
	private nativeSetup = false;
	private closing = false;
	private imports = new Map<string, { root: string; source: string }>();
	private tunnel?: SshTunnel;
	constructor(
		readonly connection: Extract<HostingConnection, { kind: 'ssh-docker' }>,
		readonly homeDir: string,
		private options: {
			setupName?: string;
			openUrl?: (url: string) => void;
			spawn?: typeof spawn;
		} = {}
	) {}
	private connect(): void {
		if (this.closing) throw Error('This instance connection is closed. Open the instance again.');
		if (this.child) return;
		const native = sshArgs(this.connection);
		const child = (this.options.spawn ?? spawn)(
			'ssh',
			[
				...native.slice(0, -1),
				'-o',
				'ServerAliveInterval=30',
				'-o',
				'ServerAliveCountMax=3',
				this.connection.host,
				SSH_MANAGEMENT_COMMAND
			],
			{ stdio: 'pipe' }
		);
		this.child = child;
		let stderr = '';
		child.stderr.on('data', (chunk) => {
			stderr = (stderr + String(chunk)).slice(-8192);
		});
		const lines = createInterface({ input: child.stdout });
		lines.on('line', (line) => {
			try {
				const response = JSON.parse(line) as ManagementResponse;
				if ('event' in response) {
					if (response.event === 'open-url' && typeof response.url === 'string')
						this.options.openUrl?.(response.url);
					return;
				}
				const pending = this.pending.get(response.id);
				if (!pending) return;
				this.pending.delete(response.id);
				if (response.ok) pending.resolve(response.value);
				else pending.reject(Error(response.error));
			} catch {
				this.fail(
					Error(
						'Remote management returned unexpected output. Check the remote CLI and shell startup messages.'
					)
				);
				child.stdin.end();
			}
		});
		child.stdin.on('error', () => {
			/* child completion reports the transport error */
		});
		child.on('error', (error) =>
			this.fail(Error(hostingFailure('ssh', (error as NodeJS.ErrnoException).code, '', stderr)))
		);
		child.on('close', (code) => {
			lines.close();
			if (this.child === child) this.child = undefined;
			this.fail(
				Error(
					`${hostingFailure('ssh', code, '', stderr)} If a change was submitted, check its current state before repeating it.`
				)
			);
		});
	}
	private fail(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
	private async request(
		method: ManagementMethod,
		value?: unknown,
		...extra: unknown[]
	): Promise<unknown> {
		this.connect();
		const id = ++this.serial;
		const result = await new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.child!.stdin.write(
				`${JSON.stringify({ id, homeDir: this.homeDir, setupName: this.options.setupName, method, value, extra } satisfies ManagementRequest)}\n`
			);
		});
		if (method === 'remote' && result && typeof result === 'object' && 'running' in result)
			this.nativeSetup = result.running === true;
		return result;
	}
	async rpc<M extends ManagementMethod>(
		method: M,
		...args: ManagementRequestArgs<M>
	): Promise<ManagementRequestMap[M]['result']> {
		return (await this.request(method, ...args)) as ManagementRequestMap[M]['result'];
	}
	private location(path: string): string {
		const at = this.connection.host.lastIndexOf('@');
		const user = at >= 0 ? this.connection.host.slice(0, at + 1) : '';
		const host = this.connection.host.slice(at + 1);
		return `${user}${isIP(host) === 6 ? `[${host}]` : host}:${path}`;
	}
	async copyFile(local: string, remote: string, upload: boolean): Promise<void> {
		const args = [
			'-q',
			'-o',
			'BatchMode=yes',
			'-o',
			'ConnectTimeout=10',
			'-o',
			'ServerAliveInterval=30',
			'-o',
			'ServerAliveCountMax=3',
			...(this.connection.port ? ['-P', String(this.connection.port)] : []),
			'--'
		];
		args.push(...(upload ? [local, this.location(remote)] : [this.location(remote), local]));
		await runHostingProcess('scp', args, { timeoutMs: 0 });
	}
	async uploadFile(local: string): Promise<string> {
		if (!lstatSync(local).isFile()) throw Error('Choose a regular input file on this computer.');
		const root = await this.rpc('transferCreate');
		const target = join(root, 'input');
		await this.copyFile(local, target, true);
		return target;
	}
	async call<M extends ManagementMethod>(
		method: M,
		...args: ManagementRequestArgs<M>
	): Promise<ManagementRequestMap[M]['result']>;
	async call(method: ManagementMethod, value?: unknown, ...extra: unknown[]): Promise<unknown> {
		if (method === 'backup') {
			if (
				!value ||
				typeof value !== 'object' ||
				!('destination' in value) ||
				typeof value.destination !== 'string'
			)
				throw Error('Choose an export directory on this computer.');
			const destination = resolve(value.destination);
			const exists = lstatSync(destination, { throwIfNoEntry: false });
			if (exists && (!exists.isDirectory() || readdirSync(destination).length))
				throw Error('Choose an empty export directory.');
			const root = await this.rpc('transferCreate');
			const local = mkdtempSync(join(tmpdir(), 'fhold-transfer-download-'));
			try {
				const result = await this.request(
					method,
					{ ...value, destination: join(root, 'export') },
					...extra
				);
				const archive = await this.rpc('transferPack', root);
				await this.copyFile(join(local, 'transfer.tgz'), archive, false);
				await unpackTransfer(join(local, 'transfer.tgz'), join(local, 'unpacked'));
				mkdirSync(destination, { recursive: true, mode: 0o700 });
				chmodSync(destination, 0o700);
				const payload = join(local, 'unpacked', 'payload');
				for (const entry of readdirSync(payload))
					cpSync(join(payload, entry), join(destination, entry), {
						recursive: true,
						dereference: false,
						verbatimSymlinks: true,
						preserveTimestamps: true,
						force: false,
						errorOnExist: true
					});
				preserveTransferMetadata(payload, destination);
				chmodSync(destination, 0o700);
				return result;
			} finally {
				rmSync(local, { recursive: true, force: true });
				await this.rpc('transferRelease', root).catch(() =>
					console.warn(
						'Temporary export cleanup could not be confirmed; the original instance and selected export are unchanged.'
					)
				);
			}
		}
		if (method === 'restoreData' || method === 'restoreInstance') {
			if (
				!value ||
				typeof value !== 'object' ||
				!('sourceHome' in value) ||
				typeof value.sourceHome !== 'string'
			)
				throw Error('Choose an export on this computer.');
			const source = resolve(value.sourceHome);
			const apply = 'apply' in value && value.apply === true;
			let staged = this.imports.get(source);
			if (!apply) {
				if (staged) {
					await this.rpc('transferRelease', staged.root);
					this.imports.delete(source);
				}
				const root = await this.rpc('transferCreate');
				const local = mkdtempSync(join(tmpdir(), 'fhold-transfer-upload-'));
				try {
					await packTransfer(source, join(local, 'transfer.tgz'));
					await this.copyFile(join(local, 'transfer.tgz'), join(root, 'transfer.tgz'), true);
					staged = { root, source: await this.rpc('transferUnpack', root) };
					this.imports.set(source, staged);
				} finally {
					rmSync(local, { recursive: true, force: true });
				}
			}
			if (!staged) throw Error('Preview this import before applying it.');
			const result = await this.request(method, { ...value, sourceHome: staged.source }, ...extra);
			if (!result || typeof result !== 'object' || Array.isArray(result))
				throw new Error(
					'Remote import returned an invalid plan. Inspect the selected instance before retrying.'
				);
			return { ...result, sourceHome: source };
		}
		return this.request(method, value, ...extra);
	}
	/**
	 * Acquire a browser route deliberately. Status reads remain transport-only:
	 * creating a forward is observable local resource ownership, not inspection.
	 */
	async acquireForward(): Promise<ManagedSnapshot> {
		const snapshot = await this.rpc('snapshot');
		if (snapshot.connectionDetails) {
			this.tunnel ??= new SshTunnel(this.connection);
			try {
				const apps = (['opencode', 'mcp'] as const).filter(
					(app) => snapshot.connectionDetails![app].url
				);
				if (!apps.length) {
					await this.tunnel.close();
					return snapshot;
				}
				const targets = apps.map((app) => {
					const url = new URL(snapshot.connectionDetails![app].url);
					return { bind: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 80) };
				});
				const ports = await this.tunnel.ensure(targets);
				for (const [index, app] of apps.entries())
					snapshot.connectionDetails[app].url =
						`http://127.0.0.1:${ports[index]}${app === 'mcp' ? '/mcp' : ''}`;
				snapshot.connectionDetails.claude.url = snapshot.connectionDetails.mcp.url;
				snapshot.connectionDetails.opencode.note = `Connected through ${this.connection.label}. Keep Admin open while using this browser connection.`;
			} catch (error) {
				snapshot.connectionError =
					error instanceof Error ? error.message : 'Browser forwarding is unavailable.';
				for (const details of Object.values(snapshot.connectionDetails)) {
					details.url = '';
					details.note = `SSH management remains available. ${snapshot.connectionError}`;
				}
			}
		}
		return snapshot;
	}
	/**
	 * Passive status for composed snapshots. Unlike `call('snapshot')`, this
	 * deliberately does not acquire a loopback browser forward.
	 */
	async inspectPassive(): Promise<ManagedSnapshot> {
		return this.rpc('snapshot');
	}
	busy(): boolean {
		return this.nativeSetup;
	}
	async close(): Promise<void> {
		this.closing = true;
		await this.tunnel?.close();
		const child = this.child;
		if (!child) return;
		await new Promise<void>((resolve) => {
			child.once('close', () => resolve());
			child.stdin.end();
		});
	}
}

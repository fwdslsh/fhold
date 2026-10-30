import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { SshTunnel } from './tunnel.js';

test('closing cancels a queued SSH open before a native process starts', async () => {
	let starts = 0;
	const tunnel = new SshTunnel(
		{ kind: 'ssh-docker', id: 'test', label: 'test', host: 'test', roots: [] },
		{
			spawn: (() => {
				starts++;
				throw new Error('Must not start');
			}) as typeof spawn
		}
	);
	const opening = tunnel.ensure([{ bind: '172.18.0.2', port: 43210, localPort: 43210 }]);
	const result = opening.catch((error) => error);
	await tunnel.close();
	expect((await result).message).toContain('closed');
	expect(starts).toBe(0);
});

test('closing waits for an in-flight SSH acknowledgement without opening a forward afterward', async () => {
	let release!: () => void;
	let entered!: () => void;
	const checking = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	let forwarded = false;
	let child: ChildProcess | undefined;
	const tunnel = new SshTunnel(
		{ kind: 'ssh-docker', id: 'test', label: 'test', host: 'test', roots: [] },
		{
			spawn: (() => {
				child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
					stdio: ['ignore', 'ignore', 'pipe']
				});
				return child;
			}) as typeof spawn,
			run: async (_binary, args) => {
				if (args.includes('forward')) forwarded = true;
				entered();
				await hold;
				return 'Master running';
			}
		}
	);
	const opening = tunnel.ensure([{ bind: '172.18.0.2', port: 43210, localPort: 43210 }]);
	const result = opening.catch((error) => error);
	await checking;
	let closed = false;
	const closing = tunnel.close().then(() => {
		closed = true;
	});
	await Promise.resolve();
	expect(closed).toBe(false);
	release();
	await closing;
	expect((await result).message).toContain('closed');
	expect(forwarded).toBe(false);
	expect(child?.signalCode).toBe('SIGTERM');
});

test('a fixed port needs SSH ownership acknowledgement even when another service is listening', async () => {
	const occupied = createServer((socket) => socket.end());
	await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
	const address = occupied.address();
	if (!address || typeof address === 'string') throw new Error('Missing test port');
	let child: ChildProcess | undefined;
	let socket = '';
	const commands: string[][] = [];
	const tunnel = new SshTunnel(
		{ kind: 'ssh-docker', id: 'test', label: 'test', host: 'test', roots: [] },
		{
			spawn: ((_binary, args) => {
				socket = args[args.indexOf('-S') + 1];
				child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
					stdio: ['ignore', 'ignore', 'pipe']
				});
				return child;
			}) as typeof spawn,
			run: async (_binary, args) => {
				commands.push(args);
				if (args.includes('forward')) throw new Error('Port already occupied');
				return 'Master running';
			}
		}
	);
	try {
		await expect(
			tunnel.ensure([{ bind: '172.18.0.2', port: address.port, localPort: address.port }])
		).rejects.toThrow('occupied');
		expect(commands.some((args) => args.includes('forward'))).toBe(true);
		expect(child?.signalCode).toBe('SIGTERM');
		expect(existsSync(socket)).toBe(false);
	} finally {
		await tunnel.close();
		await new Promise<void>((resolve) => occupied.close(() => resolve()));
	}
});

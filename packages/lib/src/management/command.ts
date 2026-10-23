import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isAbsolute } from 'node:path';
import { isInstanceName } from '../control-plane/stack-config.js';
import { sshArgs } from '../hosting/ssh-native.js';
import { hostingFailure } from '../hosting/process.js';
import type { HostingConnection } from '../hosting/types.js';
import { SshInstanceManagement } from './ssh.js';

export type SshCommandFiles = {
	uploadFile(local: string): Promise<string>;
	close(): Promise<void>;
};

/** Transport-only input-file staging for an ordinary native SSH CLI command. */
export function createSshCommandFiles(
	connection: Extract<HostingConnection, { kind: 'ssh-docker' }>,
	homeDir: string
): SshCommandFiles {
	const transport = new SshInstanceManagement(connection, homeDir);
	return {
		uploadFile: (path) => transport.uploadFile(path),
		close: () => transport.close()
	};
}

const READY = 'FH_COMMAND_READY';
const STARTED = 'FH_COMMAND_STARTED';
export const SSH_COMMAND =
	'if test -t 0; then stty -echo; fi; PATH="$HOME/.local/bin:$PATH" exec fhold hosting command';

/** Invoke only the ordinary fhold CLI, not a shell/exec API. Native prompts keep their SSH PTY. */
export async function serveHostingCommand(run: (argv: string[]) => Promise<void>): Promise<void> {
	const reader = createInterface({ input: process.stdin, terminal: false });
	process.stdout.write(`${READY}\n`);
	const first = await reader[Symbol.asyncIterator]().next();
	reader.close();
	process.stdin.pause();
	if (first.done) throw Error('A fhold command request is required.');
	const request = JSON.parse(first.value) as { name?: unknown; argv?: unknown };
	if (
		typeof request.name !== 'string' ||
		(!isAbsolute(request.name) && !isInstanceName(request.name)) ||
		!Array.isArray(request.argv) ||
		!request.argv.every((arg) => typeof arg === 'string') ||
		!request.argv.length ||
		request.argv[0] === 'hosting'
	)
		throw Error('Choose a fhold instance and ordinary CLI command.');
	if (process.stdin.isTTY) spawnSync('stty', ['echo'], { stdio: 'inherit' });
	process.stdout.write(`${STARTED}\n`);
	await run(['--name', request.name, ...request.argv]);
}

export async function runSshCommand(
	connection: Extract<HostingConnection, { kind: 'ssh-docker' }>,
	name: string,
	argv: string[]
): Promise<void> {
	if (!argv.length || argv[0] === 'hosting')
		throw Error('Choose an ordinary instance-management command.');
	const terminal = !!process.stdin.isTTY && !!process.stdout.isTTY;
	const native = sshArgs(connection);
	const child = spawn(
		'ssh',
		[
			...native.slice(0, -1),
			...(terminal ? ['-tt'] : []),
			'-o',
			'ServerAliveInterval=30',
			'-o',
			'ServerAliveCountMax=3',
			connection.host,
			SSH_COMMAND
		],
		{ stdio: 'pipe' }
	);
	let phase = 0,
		buffer = '',
		stderr = '';
	const wasRaw = process.stdin.isRaw;
	child.stdin.on('error', () => {
		/* native completion reports failed delivery */
	});
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		if (phase === 2) {
			process.stdout.write(chunk);
			return;
		}
		buffer += chunk;
		if (phase === 0) {
			const marker = buffer.match(/FH_COMMAND_READY\r?\n/);
			if (!marker) return;
			buffer = buffer.slice(buffer.indexOf(marker[0]) + marker[0].length);
			phase = 1;
			child.stdin.write(`${JSON.stringify({ name, argv })}\n`);
		}
		if (phase === 1) {
			const marker = buffer.match(/FH_COMMAND_STARTED\r?\n/);
			if (!marker) return;
			buffer = buffer.slice(buffer.indexOf(marker[0]) + marker[0].length);
			phase = 2;
			if (terminal) process.stdin.setRawMode(true);
			process.stdin.pipe(child.stdin);
			if (buffer) process.stdout.write(buffer);
			buffer = '';
		}
	});
	child.stderr.on('data', (chunk) => {
		stderr = (stderr + String(chunk)).slice(-8192);
		if (phase === 2) process.stderr.write(chunk);
	});
	try {
		await new Promise<void>((resolve, reject) => {
			child.once('error', (error) =>
				reject(Error(hostingFailure('ssh', (error as NodeJS.ErrnoException).code, '', stderr)))
			);
			child.once('close', (code) => {
				if (code === 0 && phase === 2) resolve();
				else
					reject(
						Error(
							phase < 2
								? 'The remote CLI could not start this command. Check the connection and update its fhold CLI. No local instance was changed.'
								: `The remote command exited with status ${code ?? 'unknown'}. No local instance was changed.`
						)
					);
			});
		});
	} finally {
		process.stdin.unpipe(child.stdin);
		process.stdin.pause();
		if (terminal) process.stdin.setRawMode(wasRaw);
	}
}

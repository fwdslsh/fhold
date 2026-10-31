import {
	createNativeAgentRequest,
	type NativeAgentAccess,
	type NativeAgentRequestOptions
} from './native-agent.js';

export type NativePtySession = {
	input(value: string): void;
	cancel(): Promise<void>;
	done: Promise<{ output: string; exitCode: number }>;
};
export type NativePtyOptions = NativeAgentRequestOptions & {
	webSocket?: (url: string) => WebSocket;
	output?: (text: string) => void;
	/** Existing native program cancellation input, never a replayable command. */
	cancelInput?: string;
};

// A one-shot native terminal preamble, not an installed script. Native PTYs echo
// input by default and retain their output; never send private input before this
// handshake. Non-canonical input also avoids the terminal's 4 KiB line limit.
const PRIVATE_INPUT = `import { spawnSync } from 'node:child_process';
const mode=spawnSync('stty',['-echo','-icanon','min','1','time','0'],{stdio:['inherit','ignore','ignore']});
if(mode.status!==0) process.exit(73);
process.stdout.write('FH_PRIVATE_INPUT_READY\\n');
`;

/** Internal native transport for the fixed management commands in native-management. */
export async function startNativePty(
	access: NativeAgentAccess,
	source: string,
	options: NativePtyOptions = {}
): Promise<NativePtySession> {
	options.signal?.throwIfAborted();
	const request = createNativeAgentRequest(access, options);
	const query = '?location[directory]=/work';
	const value = await request('/pty' + query, {
		method: 'POST',
		body: JSON.stringify({
			command: 'node',
			args: ['--input-type=module', '-e', PRIVATE_INPUT + source],
			cwd: '/work',
			title: 'fhold native setup'
		})
	});
	const info = (value as { data?: { id?: unknown } })?.data;
	if (typeof info?.id !== 'string' || !/^pty[A-Za-z0-9_-]{1,200}$/.test(info.id))
		throw new Error(
			'OpenCode did not return a native terminal identity. The command was not retried.'
		);
	const path = `/pty/${encodeURIComponent(info.id)}`;
	// Cleanup must survive cancellation of the operation signal. It targets only
	// this exact native PTY, never the deployment or its worker startup settings.
	const cleanup = createNativeAgentRequest(access, { fetch: options.fetch, timeoutMs: 5_000 });
	let socket: WebSocket | undefined;
	let finished = false;
	let ready = false;
	let buffer = '';
	let output = '';
	let resolveReady!: () => void;
	let rejectReady!: (error: Error) => void;
	const handshake = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	// WebSocket construction can fail before execution reaches `await handshake`.
	// Keep that rejected deferred promise observed in that path as well.
	void handshake.catch(() => {});
	let resolveDone!: (value: { output: string; exitCode: number }) => void;
	let rejectDone!: (error: Error) => void;
	const done = new Promise<{ output: string; exitCode: number }>((resolve, reject) => {
		resolveDone = resolve;
		rejectDone = reject;
	});
	// A caller may still be waiting for the handshake when the transport fails.
	void done.catch(() => {});
	let timer: ReturnType<typeof setTimeout> | undefined;
	let cancellation: Error | undefined;
	let cancelTimer: ReturnType<typeof setTimeout> | undefined;
	const remove = async () => {
		await cleanup(path + query, { method: 'DELETE' }).catch(() => {});
	};
	const finish = async (error?: Error, exitCode?: number) => {
		if (finished) return;
		finished = true;
		clearTimeout(timer);
		clearTimeout(cancelTimer);
		options.signal?.removeEventListener('abort', abort);
		socket?.close();
		await remove();
		if (error) {
			rejectReady(error);
			rejectDone(error);
		} else if (!ready) {
			const failure = new Error('Native terminal exited before private input was ready.');
			rejectReady(failure);
			rejectDone(failure);
		} else resolveDone({ output, exitCode: exitCode! });
	};
	const cancel = (error: Error) => {
		if (finished || cancellation) return;
		cancellation = error;
		if (ready && socket?.readyState === 1) {
			// Give the image-baked setup script its normal child-process cleanup.
			socket.send(options.cancelInput ?? '\x03');
			cancelTimer = setTimeout(() => {
				void finish(error);
			}, 3_000);
		} else void finish(error);
	};
	const abort = () =>
		cancel(
			new Error(
				'Native setup was interrupted. Its input was not replayed; reconnect and start again.'
			)
		);
	try {
		const token = await request(path + '/connect-token' + query, {
			method: 'POST',
			headers: { 'x-opencode-ticket': '1' }
		});
		const ticket = (token as { data?: { ticket?: unknown } })?.data?.ticket;
		if (typeof ticket !== 'string' || !ticket || ticket.length > 4_096)
			throw new Error('Native terminal ticket is unavailable.');
		const url = new URL('/api' + path + '/connect', access.endpoint);
		url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		url.searchParams.set('location[directory]', '/work');
		url.searchParams.set('ticket', ticket);
		socket = (options.webSocket ?? ((value) => new WebSocket(value)))(url.href);
		socket.binaryType = 'arraybuffer';
		socket.addEventListener('message', (event) => {
			if (finished) return;
			const bytes =
				typeof event.data === 'string' ? undefined : new Uint8Array(event.data as ArrayBuffer);
			// OpenCode's documented NUL + JSON frame is cursor metadata, not output.
			if (bytes?.[0] === 0) return;
			const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(bytes);
			if (!ready) {
				buffer += text;
				if (buffer.length > 4_096) {
					abort();
					return;
				}
				const marker = 'FH_PRIVATE_INPUT_READY\r\n';
				const plain = 'FH_PRIVATE_INPUT_READY\n';
				const found = buffer.indexOf(marker) >= 0 ? marker : plain;
				const index = buffer.indexOf(found);
				if (index < 0) return;
				ready = true;
				buffer = buffer.slice(index + found.length);
				resolveReady();
			} else buffer = text;
			output += buffer;
			if (Buffer.byteLength(output) > (options.maxResponseBytes ?? 2 * 1024 * 1024)) {
				abort();
				return;
			}
			options.output?.(buffer);
			buffer = '';
		});
		socket.addEventListener('error', abort, { once: true });
		socket.addEventListener(
			'close',
			() => {
				if (finished) return;
				void request(path + query)
					.then((value) => {
						const info = (value as { data?: { status?: unknown; exitCode?: unknown } })?.data;
						if (info?.status === 'exited' && typeof info.exitCode === 'number')
							void finish(cancellation, info.exitCode);
						else abort();
					})
					.catch(abort);
			},
			{ once: true }
		);
		timer = setTimeout(abort, options.timeoutMs ?? 30_000);
		options.signal?.addEventListener('abort', abort, { once: true });
		if (options.signal?.aborted) abort();
		await handshake;
		return {
			input(value) {
				if (finished || cancellation || socket?.readyState !== 1)
					throw new Error(
						'This native setup process is no longer connected. Input was not replayed.'
					);
				if (Buffer.byteLength(value) > 2 * 1024 * 1024)
					throw new Error('Native input exceeds its size limit.');
				socket.send(value);
			},
			cancel: async () => {
				cancel(new Error('Native setup cancelled. Deployment preferences were not changed.'));
				await done.catch(() => {});
			},
			done
		};
	} catch (error) {
		// A WebSocket implementation can include its URL in its error message. That
		// URL carries the one-use native ticket, so never surface the original
		// transport error outside this boundary. Preserve an explicit cancellation
		// message, which contains no transport data and tells the caller that input
		// was not replayed.
		const failure =
			cancellation ??
			new Error('Native terminal could not be connected. The command was not retried.');
		await finish(failure);
		throw failure;
	}
}

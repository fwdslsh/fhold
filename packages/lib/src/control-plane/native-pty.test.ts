import { describe, expect, it } from 'bun:test';
import { startNativePty } from './native-pty.js';
import { createHttpsNativeAgentService } from './native-agent.js';
import { createNativeManagement } from './native-management.js';

class Socket extends EventTarget {
	readyState = 1;
	binaryType = '';
	sent: string[] = [];
	onSend?: (value: string) => void;
	send(value: string) {
		this.sent.push(value);
		this.onSend?.(value);
	}
	close() {
		this.readyState = 3;
	}
	message(value: string | ArrayBuffer) {
		this.dispatchEvent(new MessageEvent('message', { data: value }));
	}
	end() {
		this.close();
		this.dispatchEvent(new Event('close'));
	}
}

function fixture(ready = true, exitCode = 7) {
	const socket = new Socket();
	const requests: Array<{ path: string; method: string; body: string }> = [];
	let status = 'exited';
	const options = {
		fetch: (async (input, init) => {
			const request = new Request(input, init),
				path = new URL(request.url).pathname;
			requests.push({ path, method: request.method, body: await request.text() });
			if (request.method === 'DELETE') return new Response(null, { status: 204 });
			if (path === '/api/info') return Response.json({ version: '2.2.2' });
			if (path.endsWith('/connect-token'))
				return Response.json({ data: { ticket: 'native-one-use-ticket' } });
			if (request.method === 'POST') return Response.json({ data: { id: 'pty_fixture' } });
			return Response.json({ data: { status, exitCode } });
		}) as typeof fetch,
		webSocket(url: string) {
			expect(url).not.toContain('private-password');
			expect(new URL(url).searchParams.get('ticket')).toBe('native-one-use-ticket');
			if (ready)
				setTimeout(() => {
					socket.message(new Uint8Array([0, ...new TextEncoder().encode('{"cursor":0}')]).buffer);
					socket.message('FH_PRIVATE_');
					socket.message('INPUT_READY\r\n');
				}, 0);
			return socket as unknown as WebSocket;
		}
	};
	return {
		socket,
		requests,
		options,
		running() {
			status = 'running';
		}
	};
}
const access = {
	endpoint: 'https://agent.example.test',
	authorization: () => 'Basic private-password'
};

describe('native private terminal transport', () => {
	it('preserves UTF-8 preferences split across binary frames and cursor metadata', async () => {
		const f = fixture(true, 0),
			chunks: string[] = [];
		const session = await startNativePty(access, 'process.stdin.resume();', {
			...f.options,
			output: (text) => chunks.push(text)
		});
		const expected = JSON.stringify({ label: '東京 café 🐢' }) + '\r\n';
		for (const byte of new TextEncoder().encode(expected)) {
			f.socket.message(new Uint8Array([byte]).buffer);
			f.socket.message(new Uint8Array([0, ...new TextEncoder().encode('{"cursor":1}')]).buffer);
		}
		f.socket.end();
		expect(await session.done).toEqual({ output: expected, exitCode: 0 });
		expect(chunks.join('')).toBe(expected);
	});
	it('uses the same native API on a newer patch without a version gate', async () => {
		const f = fixture(true, 0);
		f.socket.onSend = () =>
			setTimeout(() => {
				f.socket.message('{"claude":true,"codex":false,"sandbox":"workspace-write"}\r\n');
				f.socket.end();
			}, 0);
		const service = createHttpsNativeAgentService({
			endpoint: access.endpoint,
			password: 'private-password',
			fetch: f.options.fetch
		});
		const management = createNativeManagement(access, service, f.options);
		expect(await management.remoteSettings()).toEqual({
			claude: true,
			codex: false,
			sandbox: 'workspace-write'
		});
	});
	it('waits for echo-disabled readiness, ignores cursor metadata, and uses retained exit status', async () => {
		const f = fixture();
		const session = await startNativePty(access, 'process.stdin.resume();', f.options);
		session.input('private-code\n');
		expect(f.socket.sent).toEqual(['private-code\n']);
		expect(JSON.stringify(f.requests)).not.toContain('private-code');
		expect(f.requests[0]?.body).toContain('stty');
		f.socket.message('answer\r\n');
		f.socket.end();
		expect(await session.done).toEqual({ output: 'answer\r\n', exitCode: 7 });
		expect(f.requests.at(-1)?.method).toBe('DELETE');
	});
	it('never reconnects or replays input after an abnormal disconnect', async () => {
		const f = fixture();
		f.running();
		const session = await startNativePty(access, 'process.stdin.resume();', f.options);
		session.input('one-use-code\n');
		f.socket.end();
		await expect(session.done).rejects.toThrow('not replayed');
		expect(f.socket.sent).toEqual(['one-use-code\n']);
		expect(f.requests.filter((r) => r.path === '/api/pty' && r.method === 'POST')).toHaveLength(1);
		expect(() => session.input('again')).toThrow('no longer connected');
	});
	it('cancels before private readiness without sending any input', async () => {
		const f = fixture(false),
			controller = new AbortController();
		const opening = startNativePty(access, 'process.stdin.resume();', {
			...f.options,
			signal: controller.signal
		});
		setTimeout(() => controller.abort(), 10);
		await expect(opening).rejects.toThrow('interrupted');
		expect(f.socket.sent).toEqual([]);
		expect(f.requests.at(-1)?.method).toBe('DELETE');
	});
	it('does not expose a one-use ticket when WebSocket construction fails', async () => {
		const f = fixture(false);
		const failure = new Error(
			'WebSocket rejected wss://agent.example.test/api/pty/pty_fixture/connect?ticket=native-one-use-ticket'
		);
		await expect(
			startNativePty(access, 'process.stdin.resume();', {
				...f.options,
				webSocket() {
					throw failure;
				}
			})
		).rejects.toThrow('could not be connected');
		await expect(
			startNativePty(access, 'process.stdin.resume();', {
				...f.options,
				webSocket() {
					throw failure;
				}
			})
		).rejects.not.toThrow('native-one-use-ticket');
	});
	it('does not treat plaintext HTTP authentication failure as cold start', async () => {
		let requests = 0;
		const agent = createHttpsNativeAgentService({
			endpoint: access.endpoint,
			username: 'custom-native-user',
			password: 'secret',
			fetch: (async (_url, init) => {
				requests++;
				expect(new Headers(init?.headers).get('authorization')).toBe(
					'Basic ' + Buffer.from('custom-native-user:secret').toString('base64')
				);
				return new Response('Unauthorized', { status: 401 });
			}) as typeof fetch
		});
		await expect(agent.waitForReady({ timeoutMs: 60_000 })).rejects.toThrow('authentication');
		expect(requests).toBe(1);
	});
});

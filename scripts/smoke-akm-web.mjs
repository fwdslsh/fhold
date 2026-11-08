// Published akm-web, native auth and a real browser, with only disposable data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { get } from 'node:http';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(
	process.env.FH_BROWSER_TOOLS_MANIFEST || '/opt/fhold/tools/package.json'
);
const { chromium } = require('playwright');
const browser = await chromium.launch();
try {
	for (const forwarded of [false, true]) {
		const root = mkdtempSync(join(tmpdir(), 'fhold-akm-web-'));
		const env = { PATH: process.env.PATH, HOME: join(root, 'home') };
		for (const name of ['CONFIG', 'DATA', 'STATE', 'CACHE']) {
			env[`XDG_${name}_HOME`] = join(root, name.toLowerCase());
			env[`AKM_${name}_DIR`] = join(root, 'akm', name.toLowerCase());
		}
		env.AKM_BUNDLE_DIR = join(root, 'bundle');
		for (const value of Object.values(env).slice(1)) mkdirSync(value, { recursive: true });
		let forward;
		let port;
		const sockets = new Set();
		if (forwarded) {
			// Model native SSH's unchanged TCP forwarding, including distinct bind/origin.
			forward = createServer((socket) => {
				const remote = connect(port, '127.0.0.2');
				for (const peer of [socket, remote]) {
					sockets.add(peer);
					peer.on('error', () => {
						socket.destroy();
						remote.destroy();
					});
					peer.on('close', () => sockets.delete(peer));
				}
				socket.pipe(remote).pipe(socket);
			});
			forward.listen(0, '127.0.0.1');
			await once(forward, 'listening');
			port = forward.address().port;
		}
		const args = ['--host', forwarded ? '127.0.0.2' : '127.0.0.1'];
		if (forwarded) args.push('--port', String(port), '--origin', `http://127.0.0.1:${port}`);
		const server = spawn('akm-web', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
		let output = '';
		let launchError;
		server.on('error', (error) => {
			launchError = error;
		});
		server.stdout.on('data', (chunk) => {
			output = (output + chunk).slice(-8192);
		});
		server.stderr.resume(); // Never emit launch tokens or private native diagnostics.
		let context;
		try {
			const deadline = Date.now() + 15000;
			while (!output.includes('\n')) {
				if (launchError) throw launchError;
				assert(server.exitCode === null && Date.now() < deadline, 'akm-web failed to start');
				await delay(50);
			}
			const ready = JSON.parse(output.split('\n')[0]);
			assert.equal(ready.type, 'ready');
			const origin = new URL(ready.url).origin;
			assert.equal(ready.origin, origin);
			assert(new URL(ready.url).searchParams.has('desktop_session'));
			assert.equal((await fetch(origin)).status, 401);
			const invalidHost = await new Promise((resolve, reject) => {
				get(ready.url, { headers: { Host: 'untrusted.invalid' } }, (response) => {
					response.resume();
					resolve(response.statusCode);
				}).once('error', reject);
			});
			assert.equal(invalidHost, 403);
			context = await browser.newContext();
			const page = await context.newPage();
			page.setDefaultTimeout(10000);
			await page.goto(ready.url);
			await page.getByRole('link', { name: 'Library', exact: true }).waitFor();
			assert(!new URL(page.url()).searchParams.has('desktop_session'));
			const cookies = await context.cookies();
			assert(cookies.some((cookie) => cookie.httpOnly && cookie.sameSite === 'Strict'));
			const cookie = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
			assert.equal(
				(
					await fetch(origin, {
						method: 'POST',
						headers: { Cookie: cookie, Origin: 'http://untrusted.invalid' }
					})
				).status,
				403
			);
			await page.reload();
			await page.getByRole('link', { name: 'Library', exact: true }).waitFor();
			console.log(
				`akm-web native browser, cookie, Host and Origin checks passed (${forwarded ? 'forwarded' : 'direct'})`
			);
		} finally {
			await context?.close();
			if (server.exitCode === null && server.signalCode === null) {
				const closed = once(server, 'close');
				server.kill('SIGTERM');
				await closed;
			}
			for (const socket of sockets) socket.destroy();
			if (forward) await new Promise((resolve) => forward.close(resolve));
			rmSync(root, { recursive: true, force: true });
		}
	}
} finally {
	await browser.close();
}

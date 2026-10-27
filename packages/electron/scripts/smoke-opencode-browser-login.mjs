#!/usr/bin/env bun
// Native pairing + a real fresh browser, without a model request or a live home.
// OPENCODE_BIN=<pinned executable> bun packages/electron/scripts/smoke-opencode-browser-login.mjs
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '../../../containers/assistant/tools/node_modules/playwright/index.mjs';
import { createNativeAgentService } from '../../lib/src/control-plane/native-agent.ts';

if (!process.env.OPENCODE_BIN)
	throw new Error('OPENCODE_BIN must identify the pinned native OpenCode executable.');
const root = mkdtempSync(join(tmpdir(), 'fhold-browser-pairing-'));
const password = randomBytes(32).toString('hex');
const home = join(root, 'home');
const work = join(root, 'work');
mkdirSync(home);
mkdirSync(work);
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
const port = reservation.port;
await reservation.stop(true);
const endpoint = `http://127.0.0.1:${port}`;
const server = Bun.spawn(
	[resolve(process.env.OPENCODE_BIN), 'serve', '--hostname', '127.0.0.1', '--port', String(port)],
	{
		cwd: work,
		env: {
			PATH: process.env.PATH,
			HOME: home,
			XDG_CONFIG_HOME: join(root, 'config'),
			XDG_DATA_HOME: join(root, 'data'),
			XDG_STATE_HOME: join(root, 'state'),
			XDG_CACHE_HOME: join(root, 'cache'),
			OPENCODE_SERVER_PASSWORD: password
		},
		stdout: Bun.file(join(root, 'server.log')),
		stderr: Bun.file(join(root, 'server-error.log'))
	}
);
let browser;
try {
	const service = createNativeAgentService({
		endpoint,
		authorization: () => `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
	});
	await service.waitForReady({ timeoutMs: 30000 });
	assert.equal((await fetch(`${endpoint}/api/info`)).status, 401);
	const first = await service.browserLink();
	const second = await service.browserLink();
	assert.notEqual(first.url, second.url);
	assert.ok(!first.url.includes(password));
	browser = await chromium.launch({
		executablePath: process.env.FH_ADMIN_PROVIDER_CHROME || '/usr/bin/google-chrome',
		headless: true,
		args: ['--no-sandbox']
	});
	const context = await browser.newContext();
	assert.deepEqual(await context.cookies(), []);
	const page = await context.newPage();
	await page.goto(first.url, { waitUntil: 'domcontentloaded' });
	const authenticated = () => page.evaluate(async () => (await fetch('/api/info')).status);
	assert.equal(await authenticated(), 200);
	assert.ok(!page.url().includes('/auth/connect/'));
	const cookie = (await context.cookies()).find((item) => item.name === `opencode_session_${port}`);
	assert.ok(cookie?.httpOnly);
	assert.equal(cookie.sameSite, 'Lax');
	await page.reload({ waitUntil: 'domcontentloaded' });
	assert.equal(await authenticated(), 200);
	assert.equal((await fetch(first.url, { redirect: 'manual' })).status, 401);
	await context.clearCookies();
	assert.equal(await authenticated(), 401);
	await page.goto(second.url, { waitUntil: 'domcontentloaded' });
	assert.equal(await authenticated(), 200);
	const report = {
		ok: true,
		nativePairing: 'single-use links and session cookie',
		browser: 'fresh Chromium, reload and reconnect',
		modelRequests: 0
	};
	writeFileSync(join(root, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify({ ...report, evidence: root }));
} finally {
	await browser?.close();
	server.kill('SIGTERM');
	const stopped = await Promise.race([
		server.exited.then(() => true),
		Bun.sleep(5000).then(() => false)
	]);
	if (!stopped) {
		server.kill('SIGKILL');
		await server.exited;
	}
}

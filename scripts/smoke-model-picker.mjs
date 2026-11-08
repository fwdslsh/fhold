// Real OpenCode UI, fresh browser storage and a disposable native configuration.
// No model calls, visibility injection, vendor patches or real credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(process.env.FH_BROWSER_TOOLS_MANIFEST || '/opt/fhold/tools/package.json');
const { chromium } = require('playwright');
const root = mkdtempSync(join(tmpdir(), 'fhold-model-picker-'));
for (const name of ['home', 'config', 'data', 'state', 'cache', 'project'])
	mkdirSync(join(root, name));
const password = 'synthetic-model-picker-fixture';
const config = {
	providers: {
		fixture: {
			package: '@opencode/ai/providers/openai-compatible',
			settings: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'synthetic' },
			models: {
				'unknown-date': {
					name: 'Fhold unknown date',
					capabilities: { tools: true, input: ['text'], output: ['text'] }
				}
			}
		}
	}
};
const server = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
	cwd: join(root, 'project'),
	env: {
		PATH: process.env.PATH,
		...(process.env.BUN_OPTIONS ? { BUN_OPTIONS: process.env.BUN_OPTIONS } : {}),
		HOME: join(root, 'home'),
		XDG_CONFIG_HOME: join(root, 'config'),
		XDG_DATA_HOME: join(root, 'data'),
		XDG_STATE_HOME: join(root, 'state'),
		XDG_CACHE_HOME: join(root, 'cache'),
		OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
		OPENCODE_SERVER_PASSWORD: password
	},
	stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
let launchError;
server.on('error', (error) => { launchError = error; });
const captureLog = (data) => { log = (log + data).slice(-8192); };
server.stdout.on('data', captureLog);
server.stderr.on('data', captureLog);
let browser;
try {
	const deadline = Date.now() + 60_000;
	while (!log.match(/http:\/\/127\.0\.0\.1:\d+/)) {
		if (launchError) throw launchError;
		assert(server.exitCode === null && Date.now() < deadline, `OpenCode startup failed: ${log}`);
		await delay(100);
	}
	const url = log.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
	browser = await chromium.launch();
	const newPage = async () => {
		const context = await browser.newContext();
		const response = await fetch(`${url}/api/pair`, {
			method: 'POST',
			headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` }
		});
		assert(response.ok, 'Native browser pairing failed');
		const { code } = await response.json();
		const page = await context.newPage();
		page.setDefaultTimeout(15_000);
		await page.goto(`${url}/auth/connect/${code}`);
		await page.getByRole('button', { name: 'New session', exact: true }).click();
		return page;
	};
	const picker = async (page) => {
		await page.locator('[data-action="composer-model"]').click();
		await page.getByPlaceholder('Search models', { exact: true }).fill('Fhold unknown');
		return page.getByText('Fhold unknown date', { exact: true });
	};
	const toggle = async (page, expected) => {
		await page.getByRole('button', { name: 'Manage models', exact: true }).click();
		const control = page.getByRole('switch', { name: 'Fhold unknown date', exact: true });
		assert.equal(await control.isChecked(), !expected);
		// The styled switch overlays its input; use its native keyboard interaction.
		await control.press('Space');
		assert.equal(await control.isChecked(), expected);
		await page.keyboard.press('Escape');
		await page.reload();
		await page.getByRole('button', { name: 'New session', exact: true }).click();
	};
	const page = await newPage();
	await (await picker(page)).waitFor({ state: 'visible' });
	await toggle(page, false);
	await picker(page);
	await page.getByText('No model results', { exact: true }).waitFor();
	await toggle(page, true);
	await (await picker(page)).click();
	assert.match(await page.locator('[data-action="composer-model"]').textContent(), /Fhold unknown date/);
	const fresh = await newPage();
	await (await picker(fresh)).waitFor({ state: 'visible' });
	console.log('Model picker passed: fresh unknown-date visibility, explicit hide/show after reload, selection and independent fresh profile');
} catch (error) {
	for (const context of browser?.contexts() || [])
		for (const page of context.pages()) console.error(await page.locator('body').textContent());
	throw error;
} finally {
	await browser?.close();
	if (server.exitCode === null && server.pid) {
		const exited = once(server, 'exit');
		server.kill('SIGTERM');
		const killTimer = setTimeout(() => server.kill('SIGKILL'), 5000);
		await exited;
		clearTimeout(killTimer);
	}
	rmSync(root, { recursive: true, force: true });
}

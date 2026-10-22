// Opt-in packaged Admin qualification. Selects an existing disposable SSH instance;
// never replaces the preload API or signs in. An optional fifth argument installs
// a separate new instance through the real wizard into an empty remote folder.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';

const [appImage, cli, host, home, installHome] = process.argv.slice(2);
assert(
	appImage && cli && host && home?.startsWith('/'),
	'Usage: node smoke-ssh-admin.mjs <AppImage> <CLI> <SSH-alias> <absolute-disposable-home>'
);
const root = mkdtempSync(join(tmpdir(), 'fhold-admin-ssh-smoke-'));
const env = { ...process.env, XDG_CONFIG_HOME: join(root, 'config') };
mkdirSync(env.XDG_CONFIG_HOME, { mode: 0o700 });
await promisify(execFile)(
	resolve(cli),
	[
		'hosting',
		'add',
		'qa',
		'--provider',
		'ssh-docker',
		'--host',
		host,
		'--label',
		'Test server',
		'--roots',
		JSON.stringify([dirname(home)])
	],
	{ env }
);
const listener = createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const app = spawn(
	resolve(appImage),
	['--appimage-extract-and-run', `--remote-debugging-port=${port}`],
	{ env, stdio: ['ignore', 'pipe', 'pipe'] }
);
let output = '';
for (const stream of [app.stdout, app.stderr])
	stream.on('data', (chunk) => {
		output = (output + String(chunk)).slice(-8192);
	});
let socket;
const pending = new Map();
let nextId = 0;
async function wait(check, label, timeout = 60000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw Error(`Timed out: ${label}. ${output.slice(-1000)}`);
}
async function command(method, params = {}) {
	return new Promise((resolve, reject) => {
		const id = ++nextId;
		pending.set(id, { resolve, reject });
		socket.send(JSON.stringify({ id, method, params }));
	});
}
async function evaluate(expression) {
	const result = await command('Runtime.evaluate', {
		expression,
		awaitPromise: true,
		returnByValue: true
	});
	if (result.exceptionDetails)
		throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
	return result.result?.value;
}
async function shot(name) {
	const result = await command('Page.captureScreenshot');
	writeFileSync(join(root, `${name}.png`), Buffer.from(result.data, 'base64'));
}
try {
	let target;
	await wait(async () => {
		try {
			const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
			target = tabs.find((tab) => tab.type === 'page' && tab.url.includes('index.html'));
			return !!target;
		} catch {
			return false;
		}
	}, 'packaged Admin debugger');
	socket = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		socket.addEventListener('open', resolve, { once: true });
		socket.addEventListener('error', reject, { once: true });
	});
	socket.addEventListener('message', (event) => {
		const value = JSON.parse(String(event.data));
		const entry = pending.get(value.id);
		if (!entry) return;
		pending.delete(value.id);
		if (value.error) entry.reject(Error(value.error.message));
		else entry.resolve(value.result || {});
	});
	socket.addEventListener('close', () => {
		for (const request of pending.values()) request.reject(Error('The Admin window closed.'));
		pending.clear();
	});
	await wait(() => evaluate("document.body?.dataset.phase==='welcome'"), 'Welcome');
	const geometry = await evaluate('({width:outerWidth,height:outerHeight})');
	await evaluate("document.querySelector('#connect-host').click()");
	await wait(
		() =>
			evaluate(
				"!document.querySelector('#open-hosting').hidden && !document.querySelector('#hosting-connection').disabled"
			),
		'computer picker'
	);
	await evaluate(
		"const picker=document.querySelector('#hosting-connection');picker.value='qa';picker.dispatchEvent(new Event('change'));"
	);
	await wait(
		() =>
			evaluate(
				`!document.querySelector('#hosting-connection').disabled && [...document.querySelectorAll('#hosting-instance-list button')].some(button=>button.textContent.includes(${JSON.stringify(home)}))`
			),
		'automatic discovery'
	);
	await shot('instances');
	await evaluate(
		`[...document.querySelectorAll('#hosting-instance-list button')].find(button=>button.textContent.includes(${JSON.stringify(home)})).click()`
	);
	await wait(
		() =>
			evaluate(
				`document.body?.dataset.phase==='ready' && !document.querySelector('#app-shell').hidden && document.querySelector('#overview-home').textContent===${JSON.stringify(home)}`
			),
		'full SSH Admin overview'
	);
	assert.equal(await evaluate("document.querySelector('#mobile-navigation').hidden"), false);
	assert.deepEqual(
		await evaluate('({width:outerWidth,height:outerHeight})'),
		geometry,
		'Selecting SSH must not resize the window'
	);
	await shot('overview');
	for (const [page, selector] of [
		['provider', 'view-provider'],
		['connections', 'view-connections'],
		['system', 'view-system']
	]) {
		await evaluate(`document.querySelector('[data-view="${page}"]').click()`);
		await wait(() => evaluate(`!document.querySelector('#${selector}').hidden`), page);
		await shot(page);
	}
	await evaluate(
		"document.querySelector('#instance-picker').value='manage-hosting';document.querySelector('#instance-picker').dispatchEvent(new Event('change'));"
	);
	await wait(
		() =>
			evaluate(
				"document.querySelector('#hosting-manager').open && document.querySelector('#hosting-manager-list').children.length>0"
			),
		'connection manager'
	);
	await shot('connections');
	await evaluate(
		"document.querySelector('#hosting-manager-close').click();document.querySelector('#instance-picker').value='open-another';document.querySelector('#instance-picker').dispatchEvent(new Event('change'));"
	);
	await wait(() => evaluate("document.body?.dataset.phase==='welcome'"), 'return to Welcome');
	await evaluate("document.querySelector('#connect-host').click()");
	await wait(
		() =>
			evaluate(
				"!document.querySelector('#open-hosting').hidden && !document.querySelector('#hosting-connection').disabled"
			),
		'reopened picker'
	);
	await evaluate(
		"const picker=document.querySelector('#hosting-connection');picker.value='qa';picker.dispatchEvent(new Event('change'));"
	);
	await wait(
		() =>
			evaluate(
				"!document.querySelector('#hosting-connection').disabled && !document.querySelector('#hosting-open-folder').hidden"
			),
		'remote folder action'
	);
	await evaluate("document.querySelector('#hosting-open-folder').click()");
	await wait(
		() =>
			evaluate(
				"document.querySelector('#remote-directory-dialog').open && document.querySelector('#remote-directory-path').value.startsWith('/')"
			),
		'native SSH folder listing'
	);
	await shot('remote-folders');
	assert.equal(
		await evaluate("document.querySelector('#remote-directory-select').disabled"),
		false
	);
	await evaluate("document.querySelector('#remote-directory-cancel').click()");
	await wait(
		() => evaluate("!document.querySelector('#remote-directory-dialog').open"),
		'folder cancellation'
	);
	await evaluate("document.querySelector('#hosting-install').click()");
	await wait(
		() =>
			evaluate(
				"!document.querySelector('#install-section').hidden && !document.querySelector('#install').disabled"
			),
		'remote install wizard and background prerequisites'
	);
	await evaluate(
		"const name=document.querySelector('#install-instance-name');name.value='ssh-install-qa';name.dispatchEvent(new Event('input',{bubbles:true}));"
	);
	assert.equal(
		await evaluate(
			"document.querySelector('#install-home').value.endsWith('/fhold/instances/ssh-install-qa')"
		),
		true
	);
	assert.equal(await evaluate("document.querySelector('#install-advanced').open"), false);
	assert.deepEqual(
		await evaluate('({width:outerWidth,height:outerHeight})'),
		geometry,
		'Opening remote setup must not resize the window'
	);
	await shot('remote-setup');
	if (installHome) {
		assert(
			installHome.startsWith('/'),
			'The optional install destination must be an absolute empty remote folder.'
		);
		await evaluate(
			`document.querySelector('#install-advanced').open=true;const folder=document.querySelector('#install-home');folder.value=${JSON.stringify(installHome)};folder.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#install').click();`
		);
		await wait(
			() =>
				evaluate(
					"document.body?.dataset.phase==='setup_incomplete' && !document.querySelector('#app-shell').hidden && document.querySelector('#services').textContent.includes('Running normally')"
				),
			'normal remote install and healthy startup',
			300000
		);
		const installed = await evaluate('window.fholdAdmin.snapshot()');
		assert.equal(installed.homeDir, installHome);
		assert.equal(installed.config.deployment.projectName, 'ssh-install-qa');
		assert.notEqual(
			installed.config.assistant.port,
			3810,
			'Occupied default port must be replaced automatically'
		);
		assert.deepEqual(
			await evaluate('({width:outerWidth,height:outerHeight})'),
			geometry,
			'Installing remotely must not resize the window'
		);
		await shot('remote-installed');
	}
	writeFileSync(
		join(root, 'report.json'),
		JSON.stringify(
			{
				ok: true,
				geometry,
				home,
				host,
				checks: [
					'packaged preload',
					'native SSH discovery',
					'normal Overview/Agent settings/Apps/System',
					'no automatic window resize',
					'connection manager',
					'remote directory picker and cancellation',
					'remote wizard defaults and prerequisite checks'
				]
			},
			null,
			2
		),
		{ mode: 0o600 }
	);
	console.log(`Packaged SSH Admin passed. Screenshots and report: ${root}`);
} finally {
	if (socket?.readyState === WebSocket.OPEN) await command('Page.close').catch(() => {});
	socket?.close();
	app.kill('SIGTERM');
	app.stdout.destroy();
	app.stderr.destroy();
	app.unref();
}

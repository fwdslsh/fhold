// Real Electron request interception against disposable HTTP fixtures.
// This verifies fhold's boundary, not unpublished AKM server behavior.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, WebContentsView } from 'electron';
import { AdminKnowledge } from './admin-knowledge.js';

const profile = mkdtempSync(join(tmpdir(), 'fhold-knowledge-auth-'));
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
const secret = 'a'.repeat(64);
const requests: Array<{ path: string; authorized: boolean }> = [];
const foreignHeaders: Array<string | undefined> = [];
const foreign = createServer((request, response) => {
	foreignHeaders.push(request.headers.authorization);
	response.setHeader('Access-Control-Allow-Origin', '*');
	response.end('foreign');
});
let foreignOrigin = '';
const native = createServer((request, response) => {
	requests.push({
		path: request.url ?? '',
		authorized: request.headers.authorization === `Bearer ${secret}`
	});
	if (request.url === '/redirect') {
		response.writeHead(302, { Location: `${foreignOrigin}/redirected` });
		response.end();
	} else {
		response.setHeader('Content-Type', 'text/html');
		response.end('<!doctype html><title>AKM fixture</title><p>Library</p>');
	}
});
async function listen(server: Server) {
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	assert(address && typeof address !== 'string');
	return `http://127.0.0.1:${address.port}`;
}
let owner: BrowserWindow | undefined;
let view: AdminKnowledge | undefined;
async function main() {
	const timeout = setTimeout(() => {
		console.error('AKM view auth timed out');
		app.exit(1);
	}, 30_000);
	try {
		await app.whenReady();
		foreignOrigin = await listen(foreign);
		const origin = await listen(native);
		owner = new BrowserWindow({
			show: false,
			webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
		});
		await owner.loadURL(
			'data:text/html,<body data-phase="ready"><div id="knowledge-viewport" style="width:600px;height:400px"></div></body>'
		);
		view = new AdminKnowledge(owner, origin, secret);
		await view.open(origin);
		const embedded = owner.contentView.children.find(
			(child) => child instanceof WebContentsView
		) as WebContentsView;
		assert(embedded);
		const storage = embedded.webContents.session;
		assert(requests.find((request) => request.path === '/')?.authorized);
		assert.equal(
			await embedded.webContents.executeJavaScript('typeof window.fholdAdmin'),
			'undefined'
		);
		await embedded.webContents.executeJavaScript(`fetch('/api/session').then(r=>r.text())`);
		assert(requests.find((request) => request.path === '/api/session')?.authorized);
		await embedded.webContents.executeJavaScript(
			`fetch('/redirect', {mode:'no-cors'}).then(()=>true)`
		);
		await embedded.webContents.executeJavaScript(
			`fetch(${JSON.stringify(`${foreignOrigin}/external`)}, {mode:'no-cors'}).then(()=>true)`
		);
		assert(foreignHeaders.length >= 2);
		assert(foreignHeaders.every((header) => header === undefined));
		const unrelated = new WebContentsView({
			webPreferences: { partition: 'fhold-auth-unrelated', sandbox: true }
		});
		await unrelated.webContents.loadURL(`${origin}/unrelated`);
		assert.equal(requests.find((request) => request.path === '/unrelated')?.authorized, false);
		unrelated.webContents.close();
		view.close();
		await storage.fetch(`${origin}/after-close`);
		assert.equal(requests.find((request) => request.path === '/after-close')?.authorized, false);
		console.log(
			'AKM view auth: native requests, cross-origin redirects, external requests, unrelated partitions, and close cleanup passed.'
		);
	} catch (error) {
		console.error(error instanceof Error ? error.message : 'AKM view auth failed');
		process.exitCode = 1;
	} finally {
		clearTimeout(timeout);
		view?.close();
		owner?.destroy();
		native.closeAllConnections();
		foreign.closeAllConnections();
		native.close();
		foreign.close();
		rmSync(profile, { recursive: true, force: true });
		app.exit(process.exitCode ?? 0);
	}
}
void main();

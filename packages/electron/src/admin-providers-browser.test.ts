import { expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultStackConfig } from '@fhold/lib';

type DebuggerResult = {
	result?: { value?: unknown };
	exceptionDetails?: { text: string; exception?: { description?: string } };
	data?: string;
	cssContentSize?: { width: number; height: number };
};

// Explicit focused Chromium qualification, not a Docker/provider end-to-end test.
// Invoke directly with FH_ADMIN_PROVIDER_CHROME pointing to an installed browser.
it('qualifies AI account controls in real headless Chromium with the actual renderer modules', async () => {
	const chrome = process.env.FH_ADMIN_PROVIDER_CHROME || '/usr/bin/google-chrome';
	const root = mkdtempSync(join(tmpdir(), 'fhold-provider-chromium-'));
	const admin = join(import.meta.dir, '..', 'admin');
	const hashSources = () =>
		Object.fromEntries(
			readdirSync(admin)
				.filter((name) => /\.(?:js|css|html)$/.test(name))
				.map((name) => [
					name,
					createHash('sha256')
						.update(readFileSync(join(admin, name)))
						.digest('hex')
				])
		);
	const sourceHashes = hashSources();
	const html = readFileSync(join(admin, 'index.html'), 'utf8').replace(
		'src="admin.js"',
		'src="provider-qa.js"'
	);
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
			if (path === '/provider-qa.js')
				return new Response('window.providerQaReady = true;', {
					headers: { 'content-type': 'text/javascript' }
				});
			if (!/^\/[a-z0-9.-]+\.(js|css|svg|png|ico)$/.test(path))
				return new Response('Not found', { status: 404 });
			const file = Bun.file(join(admin, path.slice(1)));
			if (!(await file.exists())) return new Response('Not found', { status: 404 });
			return new Response(file);
		}
	});
	const processHandle = Bun.spawn(
		[
			chrome,
			'--headless=new',
			'--no-sandbox',
			'--disable-dev-shm-usage',
			'--no-first-run',
			'--remote-debugging-port=0',
			`--user-data-dir=${join(root, 'profile')}`,
			'about:blank'
		],
		{ stdout: 'ignore', stderr: 'pipe' }
	);
	let socket: WebSocket | undefined;
	const pending = new Map<
		number,
		{ resolve: (value: DebuggerResult) => void; reject: (error: Error) => void }
	>();
	let nextId = 0;
	let debugOutput = '';
	try {
		const reader = processHandle.stderr.getReader();
		const decoder = new TextDecoder();
		while (!/DevTools listening on (ws:\/\/[^\s]+)/.test(debugOutput)) {
			const read = await reader.read();
			if (read.done) throw new Error(`Chromium did not start: ${debugOutput.slice(-2000)}`);
			debugOutput += decoder.decode(read.value);
		}
		const browserSocket = debugOutput.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
		if (!browserSocket) throw new Error('Missing Chromium debugger address');
		const debuggerHttp = browserSocket.replace('ws://', 'http://').split('/devtools/')[0];
		const targets = (await (await fetch(`${debuggerHttp}/json/list`)).json()) as Array<{
			type: string;
			webSocketDebuggerUrl: string;
		}>;
		const target = targets.find((entry) => entry.type === 'page');
		if (!target) throw new Error('Chromium did not create a page');
		socket = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise<void>((resolve, reject) => {
			socket?.addEventListener('open', () => resolve(), { once: true });
			socket?.addEventListener(
				'error',
				() => reject(new Error('Chromium debugger connection failed')),
				{ once: true }
			);
		});
		socket.addEventListener('message', (event) => {
			const value = JSON.parse(String(event.data)) as {
				id?: number;
				error?: { message: string };
				result?: DebuggerResult;
			};
			if (!value.id) return;
			const waiting = pending.get(value.id);
			pending.delete(value.id);
			if (value.error) waiting?.reject(new Error(value.error.message));
			else waiting?.resolve(value.result ?? {});
		});
		const command = (
			method: string,
			params: Record<string, unknown> = {}
		): Promise<DebuggerResult> =>
			new Promise((resolve, reject) => {
				const id = ++nextId;
				pending.set(id, { resolve, reject });
				socket?.send(JSON.stringify({ id, method, params }));
			});
		const evaluate = async (expression: string) => {
			const result = await command('Runtime.evaluate', {
				expression,
				awaitPromise: true,
				returnByValue: true
			});
			if (result.exceptionDetails)
				throw new Error(
					result.exceptionDetails.exception?.description || result.exceptionDetails.text
				);
			return result.result?.value;
		};
		const keyboardTrace: Array<{ key: string; modifiers: number; focus: string }> = [];
		const keypress = async (
			key: string,
			code: string,
			windowsVirtualKeyCode: number,
			modifiers = 0
		) => {
			await command('Input.dispatchKeyEvent', {
				type: 'keyDown',
				key,
				code,
				windowsVirtualKeyCode,
				modifiers,
				...(key === 'Enter' ? { text: '\r' } : key === ' ' ? { text: ' ' } : {})
			});
			await command('Input.dispatchKeyEvent', {
				type: 'keyUp',
				key,
				code,
				windowsVirtualKeyCode,
				modifiers
			});
			keyboardTrace.push({
				key,
				modifiers,
				focus: String(
					await evaluate(
						'document.activeElement.id || document.activeElement.dataset.providerId || document.activeElement.tagName'
					)
				)
			});
		};
		await command('Page.enable');
		await command('Emulation.setDeviceMetricsOverride', {
			width: 1120,
			height: 780,
			deviceScaleFactor: 1,
			mobile: false
		});
		await command('Page.navigate', { url: `http://127.0.0.1:${server.port}/` });
		const deadline = Date.now() + 10_000;
		while (!(await evaluate('window.providerQaReady === true'))) {
			if (Date.now() > deadline) throw new Error('Renderer fixture module did not load');
			await Bun.sleep(50);
		}
		const snapshot = {
			phase: 'ready',
			homeDir: '/disposable-provider-fixture',
			configPath: '/disposable-provider-fixture/state/stack.json',
			config: defaultStackConfig(),
			services: [],
			credentials: [],
			portalMappings: { discord: { users: {} }, slack: { users: {} } },
			portalSecrets: {},
			pendingRestart: { required: true }
		};
		await evaluate(`(async () => {
			const { state } = await import('./state.js');
			const { render } = await import('./snapshot.js');
			const { showView, bindUiEvents } = await import('./ui.js');
			const providers = await import('./providers.js');
			window.providerQa = { state, providers, restartPrompts: 0 };
			state.api = {
				snapshot: async () => (${JSON.stringify(snapshot)}),
				readiness: async () => ({ ok: true, provider: 'anthropic', model: 'sonnet', response: 'FH_READY' }),
				confirmRestart: async () => { window.providerQa.restartPrompts++; return false; }
			};
			state.providersLoaded = true;
			render(${JSON.stringify(snapshot)});
			document.querySelector('#loading-state').hidden = true;
			document.querySelector('#instance-welcome').hidden = true;
			showView('provider');
			bindUiEvents();
			providers.bindProvidersEvents();
			providers.renderProviders([
				{ id: 'anthropic', name: 'Anthropic', authenticated: true, connected: true, authMethods: [{ index: 0, type: 'api', label: 'API key' }] },
				{ id: 'opencode', name: 'OpenCode', authenticated: false, connected: true, authMethods: [{ index: 0, type: 'api', label: 'API key' }] },
				{ id: 'uncommon-provider', name: 'Uncommon Provider', authenticated: false, connected: false, authMethods: [{ index: 0, type: 'api', label: 'API key' }] }
			]);
		})()`);
		const capture = async (name: string, fullPage = false) => {
			const metrics = fullPage ? await command('Page.getLayoutMetrics') : undefined;
			const size = metrics?.cssContentSize;
			const result = await command('Page.captureScreenshot', {
				format: 'png',
				captureBeyondViewport: fullPage,
				...(size ? { clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } } : {})
			});
			if (typeof result.data !== 'string') throw new Error('Chromium did not return a screenshot');
			writeFileSync(join(root, name), Buffer.from(result.data, 'base64'));
		};
		await capture('account-configured-unverified.png', true);
		await evaluate("document.querySelector('[data-provider-id=anthropic]').focus()");
		await keypress('Enter', 'Enter', 13);
		expect(await evaluate('document.activeElement.id')).toBe('test-provider');
		await keypress('Tab', 'Tab', 9, 8);
		expect(await evaluate('document.activeElement.id')).toBe('provider-key-heading');
		await keypress('Enter', 'Enter', 13);
		expect(await evaluate("document.querySelector('#api-key-fields').open")).toBe(true);
		await keypress(' ', 'Space', 32);
		expect(await evaluate("document.querySelector('#api-key-fields').open")).toBe(false);
		await keypress(' ', 'Space', 32);
		expect(await evaluate("document.querySelector('#api-key-fields').open")).toBe(true);
		for (const id of [
			'provider-key',
			'provider-key-submit',
			'test-provider',
			'provider-search',
			'provider',
			'show-all-providers'
		]) {
			await keypress('Tab', 'Tab', 9);
			expect(await evaluate('document.activeElement.id')).toBe(id);
		}
		await capture('account-configured-selected-unverified.png', true);
		expect(
			await evaluate(
				"!!document.querySelector('#provider-result, #automatic-memory, #agent-timezone')"
			)
		).toBe(false);
		expect(
			await evaluate(
				"[...document.querySelector('#provider').options].some(option => /connected|verified/i.test(option.textContent))"
			)
		).toBe(false);
		await evaluate(
			"document.querySelector('#provider-search').value = 'uncommon'; document.querySelector('#provider-search').dispatchEvent(new Event('input', {bubbles:true}));"
		);
		expect(
			await evaluate(
				"[...document.querySelector('#provider').options].filter(option => option.value).map(option => option.value)"
			)
		).toEqual(['uncommon-provider']);
		await evaluate("document.querySelector('#provider-search').focus()");
		await command('Input.dispatchKeyEvent', {
			type: 'keyDown',
			key: 'Tab',
			code: 'Tab',
			windowsVirtualKeyCode: 9
		});
		await command('Input.dispatchKeyEvent', {
			type: 'keyUp',
			key: 'Tab',
			code: 'Tab',
			windowsVirtualKeyCode: 9
		});
		expect(await evaluate('document.activeElement.id')).toBe('provider');
		await command('Input.dispatchKeyEvent', {
			type: 'keyDown',
			key: 'Tab',
			code: 'Tab',
			windowsVirtualKeyCode: 9,
			modifiers: 8
		});
		await command('Input.dispatchKeyEvent', {
			type: 'keyUp',
			key: 'Tab',
			code: 'Tab',
			windowsVirtualKeyCode: 9,
			modifiers: 8
		});
		expect(await evaluate('document.activeElement.id')).toBe('provider-search');
		await evaluate(
			"document.querySelector('#provider-search').value = 'not-a-real-provider'; document.querySelector('#provider-search').dispatchEvent(new Event('input', {bubbles:true}));"
		);
		expect(
			await evaluate(
				"[...document.querySelector('#provider').options].filter(option => option.value).length"
			)
		).toBe(0);
		expect(await evaluate("document.querySelector('#provider').value")).toBe('');
		expect(await evaluate("document.querySelector('#test-provider').hidden")).toBe(true);
		await capture('account-search-empty.png', true);
		await evaluate(
			"document.querySelector('#provider-search').value = 'uncommon'; document.querySelector('#provider-search').dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('#provider').value = 'uncommon-provider'; document.querySelector('#provider').dispatchEvent(new Event('change', {bubbles:true}));"
		);
		expect(await evaluate("document.querySelector('#api-key-fields').open")).toBe(true);
		expect(await evaluate("document.querySelector('#provider-key-heading').textContent")).toBe(
			'Add API key'
		);
		await capture('account-key-add.png', true);
		await evaluate(
			"document.querySelector('#provider-search').value = ''; document.querySelector('#provider-search').dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('#provider-key').value = 'synthetic-transient-key'; document.querySelector('#oauth-code').value = 'synthetic-transient-code'; document.querySelector('#provider').value = 'opencode'; document.querySelector('#provider').dispatchEvent(new Event('change', {bubbles:true}));"
		);
		expect(
			await evaluate(
				"[document.querySelector('#provider-key').value, document.querySelector('#oauth-code').value, window.providerQa.state.activeOAuth]"
			)
		).toEqual(['', '', null]);
		await evaluate(
			"document.querySelector('#provider').value = 'anthropic'; document.querySelector('#provider').dispatchEvent(new Event('change', {bubbles:true})); document.querySelector('#api-key-fields').open = true;"
		);
		expect(await evaluate("document.querySelector('#provider-key-heading').textContent")).toBe(
			'Replace API key'
		);
		expect(await evaluate("document.querySelector('#provider-key').value")).toBe('');
		await capture('account-key-replace.png', true);
		await evaluate("document.querySelector('#test-provider').click();");
		while (await evaluate('window.providerQa.state.operationInFlight')) await Bun.sleep(25);
		expect(await evaluate('window.providerQa.state.currentView')).toBe('provider');
		expect(await evaluate('window.providerQa.restartPrompts')).toBe(0);
		expect(
			String(await evaluate("document.querySelector('#provider-status').textContent")).toLowerCase()
		).toContain('verified');
		await capture('account-verified.png', true);
		await evaluate(
			"window.providerQa.state.api.readiness = () => new Promise(resolve => {window.providerQa.resolveCheck = resolve;}); document.querySelector('#test-provider').click();"
		);
		expect(await evaluate('window.providerQa.state.operationInFlight')).toBe(true);
		expect(await evaluate("document.querySelector('#provider-badge').textContent")).not.toBe(
			'Verified'
		);
		expect(
			await evaluate(
				"document.querySelector('[data-provider-id=anthropic] .provider-account-state').textContent"
			)
		).not.toBe('Verified in this check');
		expect(
			await evaluate(
				"['provider','provider-search','provider-key','provider-method'].map(id=>document.getElementById(id).disabled)"
			)
		).toEqual([true, true, true, true]);
		await evaluate(
			"window.providerQa.resolveCheck({ok:false,error:'Check your account access and try again.'})"
		);
		while (await evaluate('window.providerQa.state.operationInFlight')) await Bun.sleep(25);
		expect(await evaluate("document.querySelector('#provider-status').getAttribute('role')")).toBe(
			'alert'
		);
		expect(await evaluate("document.querySelector('#notice').hidden")).toBe(true);
		expect(
			await evaluate(
				"document.querySelector('[data-provider-id=anthropic] .provider-account-state').textContent"
			)
		).toBe('Last check failed');
		await capture('account-error.png', true);
		await evaluate("document.documentElement.style.fontSize = '200%';");
		await command('Emulation.setDeviceMetricsOverride', {
			width: 620,
			height: 900,
			deviceScaleFactor: 1,
			mobile: false
		});
		expect(await evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
		await capture('account-error-narrow-200pct-text.png', true);
		await evaluate(`(async () => {
			const {render} = await import('./snapshot.js');
			const {showView} = await import('./ui.js');
			document.documentElement.style.fontSize = '';
			window.providerQa.state.lastReadiness = null;
			render({...${JSON.stringify(snapshot)}, phase:'setup_incomplete'});
			showView('provider');
			window.providerQa.state.api.readiness = async () => ({ok:true,provider:'anthropic',model:'sonnet',response:'FH_READY'});
			await window.providerQa.providers.verifyProvider('Checking setup account', () => window.providerQa.state.api.readiness());
		})()`);
		await command('Emulation.setDeviceMetricsOverride', {
			width: 1120,
			height: 780,
			deviceScaleFactor: 1,
			mobile: false
		});
		expect(await evaluate('window.providerQa.state.currentView')).toBe('provider');
		expect(await evaluate("document.querySelector('#finish-provider-setup').hidden")).toBe(false);
		await capture('account-setup-continue.png', true);
		await evaluate("document.querySelector('#view-title').focus()");
		for (const id of ['apply-pending-restart', 'dismiss-notice', 'finish-provider-setup']) {
			await keypress('Tab', 'Tab', 9);
			expect(await evaluate('document.activeElement.id')).toBe(id);
		}
		await keypress('Enter', 'Enter', 13);
		expect(await evaluate('window.providerQa.state.currentView')).toBe('overview');
		expect(await evaluate('window.providerQa.state.awaitingSetupFinish')).toBe(false);
		await evaluate(`(async () => {
			const {showView} = await import('./ui.js');
			showView('provider');
			window.providerQa.providers.renderProviders([...window.providerQa.state.providerSummaries,
				{id:'oauth-provider',name:'OAuth Provider',authenticated:false,connected:false,authMethods:[{index:0,type:'oauth',label:'Browser sign-in'}]}]);
			window.providerQa.state.api.providerOAuthStart = async () => ({method:'code',instructions:'Return with the synthetic test authorization code.'});
			document.querySelector('#provider-search').value = 'oauth-provider';
			document.querySelector('#provider-search').dispatchEvent(new Event('input',{bubbles:true}));
			document.querySelector('#provider').value = 'oauth-provider';
			document.querySelector('#provider').dispatchEvent(new Event('change',{bubbles:true}));
			document.querySelector('#start-provider-oauth').click();
		})()`);
		while (await evaluate('window.providerQa.state.operationInFlight')) await Bun.sleep(25);
		expect(
			await evaluate(
				"['provider','provider-search','provider-method'].map(id=>document.getElementById(id).disabled)"
			)
		).toEqual([true, true, true]);
		expect(
			await evaluate(
				"['show-all-providers','load-providers'].map(id=>document.getElementById(id).disabled)"
			)
		).toEqual([true, true]);
		expect(await evaluate("document.querySelector('[data-provider-id=anthropic]').disabled")).toBe(
			true
		);
		expect(await evaluate("document.querySelector('#cancel-provider-oauth').hidden")).toBe(false);
		await evaluate("document.querySelector('[data-provider-id=anthropic]').click()");
		expect(await evaluate("document.querySelector('#provider').value")).toBe('oauth-provider');
		await capture('account-native-oauth-pending.png', true);
		await evaluate(
			"document.querySelector('#oauth-code').value = 'synthetic-test-code'; document.querySelector('#cancel-provider-oauth').click()"
		);
		expect(
			await evaluate(
				"['provider','provider-search','provider-method'].map(id=>document.getElementById(id).disabled)"
			)
		).toEqual([false, false, false]);
		expect(
			await evaluate(
				"[window.providerQa.state.activeOAuth,document.querySelector('#oauth-code').value]"
			)
		).toEqual([null, '']);
		expect(hashSources()).toEqual(sourceHashes);
		writeFileSync(
			join(root, 'qa-manifest.json'),
			JSON.stringify(
				{
					browser: await command('Browser.getVersion'),
					sourceHashes,
					keyboardTrace,
					evidence:
						'Actual unmodified renderer modules in headless Chromium; synthetic IPC responses only. No Docker or native provider request.',
					captures: readdirSync(root).filter((name) => name.endsWith('.png'))
				},
				null,
				2
			)
		);
		console.info(`Chromium account QA artifacts: ${root}`);
	} finally {
		socket?.close();
		processHandle.kill();
		server.stop(true);
	}
}, 60_000);

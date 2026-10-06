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
			services: [{ name: 'assistant', state: 'running', health: 'healthy', running: true }],
			credentials: [],
			portalMappings: { discord: { users: {} }, slack: { users: {} } },
			portalSecrets: {},
			pendingRestart: { required: false }
		};
		await evaluate(`(async()=>{
			const {state}=await import('./state.js');const {render}=await import('./snapshot.js');const {showView,bindUiEvents}=await import('./ui.js');const providers=await import('./providers.js');
			const account=(id,extra={})=>({id,name:id,source:'api',authenticated:false,connected:false,configured:false,models:[{id:'first-model',name:'First model'},{id:'team/second-model',name:'Second model'}],authMethods:[{index:0,type:'api',label:'API key'}],...extra});
			window.providerQa={state,providers,calls:[],confirmations:[],confirmRemoval:false,failCheck:false,settings:{providers:[account('current-service',{authenticated:true,connected:true}),account('alphabetical-first',{authenticated:true,connected:true}),account('openai'),account('opencode',{source:'custom',connected:true}),account('uncommon-provider'),account('orphan',{authenticated:true,models:[]}),account('oauth-provider',{authMethods:[{index:0,type:'oauth',label:'Browser'}]})],currentModel:{provider:'current-service',model:'team/second-model'}}};
			const qa=window.providerQa;window.confirm=prompt=>{qa.confirmations.push(prompt);return qa.confirmRemoval;};
			state.api={snapshot:async()=>({...${JSON.stringify(snapshot)},phase:qa.setup?'setup_incomplete':'ready'}),providers:async()=>{qa.calls.push({operation:'list'});return structuredClone(qa.settings);},
				readiness:async value=>{qa.calls.push({operation:'test',...value});if(qa.failCheck)return {ok:false,error:'Check this server address and model access. This model could not respond.'};if(qa.settings.currentModel?.provider===value.provider&&qa.settings.currentModel?.model===value.model)qa.setup=false;return {ok:true,...value,response:'FH_READY'};},
				providerKey:async value=>{qa.calls.push({operation:'key',provider:value.provider});Object.assign(qa.settings.providers.find(item=>item.id===value.provider),{authenticated:true,connected:true});},
				providerOAuthStart:async value=>{qa.calls.push({operation:'oauth-start',provider:value.provider});return {method:'code',instructions:'Return with the authorization code from your provider.'};},
				providerOAuthFinish:async value=>{qa.calls.push({operation:'oauth-save',provider:value.provider});Object.assign(qa.settings.providers.find(item=>item.id===value.provider),{authenticated:true,connected:true});},
				providerModels:async value=>{qa.calls.push({operation:'discover',url:value.url});return ['team/local-model','team/long-model-name-with-an-exact-native-id'];},
				providerEndpoint:async value=>{qa.calls.push({operation:'endpoint-save',provider:value.provider,model:value.model,url:value.url});let item=qa.settings.providers.find(item=>item.id===value.provider);if(!item){item=account(value.provider);qa.settings.providers.push(item);}Object.assign(item,{name:value.name,configured:true,disabled:false,connected:true,source:'config',models:[{id:value.model,name:value.model}],endpoint:{name:value.name,url:value.url,models:[value.model],editable:true}});if(value.key)item.authenticated=true;return structuredClone(qa.settings);},
				providerUse:async value=>{qa.calls.push({operation:'use',...value});if(!qa.rejectUse)qa.settings.currentModel={...value};return structuredClone(qa.settings);},
				providerRemove:async value=>{qa.calls.push({operation:'remove',...value});const item=qa.settings.providers.find(item=>item.id===value.provider);if(value.endpoint){item.disabled=true;item.connected=false;item.models=[];}else item.authenticated=false;return structuredClone(qa.settings);},
				confirmRestart:async()=>{throw new Error('No automatic provider restart');}};
			render(${JSON.stringify(snapshot)});showView('provider');bindUiEvents();providers.bindProvidersEvents();await providers.loadProviders(false,true);
		})()`);
		const idle = async () => {
			const deadline = Date.now() + 10000;
			while (
				await evaluate(
					'window.providerQa.state.operationInFlight || !!window.providerQa.state.providerLoadPromise'
				)
			) {
				if (Date.now() > deadline) throw new Error('Provider action timed out');
				await Bun.sleep(10);
			}
			await Bun.sleep(10);
		};
		const click = async (selector: string) => {
			await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
			await idle();
		};
		const value = async (selector: string, value: string, event = 'input') => {
			await evaluate(
				`(()=>{const control=document.querySelector(${JSON.stringify(selector)});control.value=${JSON.stringify(value)};control.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`
			);
		};
		const count = async (operation: string) =>
			Number(
				await evaluate(
					`window.providerQa.calls.filter(call=>call.operation===${JSON.stringify(operation)}).length`
				)
			);
		const capture = async (name: string) => {
			const size = (await command('Page.getLayoutMetrics')).cssContentSize;
			const result = await command('Page.captureScreenshot', {
				format: 'png',
				captureBeyondViewport: true,
				...(size ? { clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } } : {})
			});
			if (typeof result.data !== 'string') throw new Error('Missing screenshot');
			writeFileSync(join(root, name), Buffer.from(result.data, 'base64'));
		};
		expect(await evaluate("document.querySelector('#provider-default-service').textContent")).toBe(
			'current-service'
		);
		expect(await evaluate("document.querySelector('#provider-default-model').textContent")).toBe(
			'team/second-model'
		);
		expect(await evaluate("document.querySelector('#provider-editor').hidden")).toBe(true);
		expect(await evaluate("document.querySelector('#provider-saved-accounts').open")).toBe(false);
		expect(await count('test')).toBe(0);
		await capture('model-current-unverified.png');
		await click('#test-current-model');
		expect(
			await evaluate("window.providerQa.calls.filter(call=>call.operation==='test').at(-1)")
		).toEqual({ operation: 'test', provider: 'current-service', model: 'team/second-model' });
		expect(await count('use')).toBe(0);
		await capture('model-current-pass.png');
		await evaluate('window.providerQa.failCheck=true');
		await click('#test-current-model');
		expect(
			String(await evaluate("document.querySelector('#provider-default-status').textContent"))
		).toContain('could not respond');
		await capture('model-current-fail.png');
		await evaluate('window.providerQa.failCheck=false');
		await click('#add-provider-service');
		await capture('model-service-choices.png');
		await click('[data-provider-shortcut="other"]');
		await value('#provider-search', 'uncommon');
		expect(
			await evaluate(
				"[...document.querySelector('#provider').options].filter(item=>item.value).map(item=>item.value)"
			)
		).toEqual(['uncommon-provider']);
		await evaluate("document.querySelector('#provider-search').focus()");
		await keypress('Tab', 'Tab', 9);
		expect(await evaluate('document.activeElement.id')).toBe('provider');
		await keypress('Tab', 'Tab', 9, 8);
		expect(await evaluate('document.activeElement.id')).toBe('provider-search');
		await value('#provider-search', 'no-such-service');
		expect(await evaluate("document.querySelector('#provider').value")).toBe('');
		expect(
			await evaluate(
				"[...document.querySelector('#provider').options].filter(item=>item.value).length"
			)
		).toBe(0);
		await capture('model-search-empty.png');
		await click('#cancel-provider-editor');
		await click('#add-provider-service');
		await click('[data-provider-shortcut="openai"]');
		await capture('model-cloud-key.png');
		const beforeKey = await count('test');
		await value('#provider-key', 'synthetic-key-browser-only');
		await click('#provider-key-submit');
		expect(await count('key')).toBe(1);
		expect(await count('test')).toBe(beforeKey);
		expect(await evaluate("document.querySelector('#provider-key').value")).toBe('');
		expect(await evaluate("document.querySelector('#provider-model-step').hidden")).toBe(false);
		expect(await evaluate('window.providerQa.settings.currentModel')).toEqual({
			provider: 'current-service',
			model: 'team/second-model'
		});
		await value('#provider-model', 'first-model', 'change');
		await evaluate("document.querySelector('#provider-model').focus()");
		for (const id of ['load-provider-models', 'provider-model-manual', 'test-provider']) {
			await keypress('Tab', 'Tab', 9);
			expect(await evaluate('document.activeElement.id')).toBe(id);
		}
		await keypress('Enter', 'Enter', 13);
		await idle();
		expect(await evaluate("document.querySelector('#use-provider-model').hidden")).toBe(false);
		expect(await evaluate("document.querySelector('#use-provider-model').disabled")).toBe(false);
		expect(
			await evaluate(
				"!document.querySelector('#provider-badge') || !document.querySelector('#provider-badge').checkVisibility()"
			)
		).toBe(true);
		expect(
			String(await evaluate("document.querySelector('#provider-editor-message').textContent"))
		).not.toMatch(/not.*(?:response.?tested|test)|untested/i);
		expect(await evaluate('window.providerQa.settings.currentModel')).toEqual({
			provider: 'current-service',
			model: 'team/second-model'
		});
		await capture('model-tested-explicit-use.png');
		await value('#provider-model', 'team/second-model', 'change');
		expect(await evaluate("document.querySelector('#use-provider-model').disabled")).toBe(true);
		const uses = await count('use');
		await click('#use-provider-model');
		expect(await count('use')).toBe(uses);
		await click('#test-provider');
		await evaluate("document.querySelector('#test-provider').focus()");
		await keypress('Tab', 'Tab', 9);
		expect(await evaluate('document.activeElement.id')).toBe('use-provider-model');
		await keypress('Enter', 'Enter', 13);
		await idle();
		expect(await evaluate('window.providerQa.settings.currentModel')).toEqual({
			provider: 'openai',
			model: 'team/second-model'
		});
		expect(await evaluate('window.providerQa.state.currentView')).toBe('provider');
		expect(await evaluate("document.querySelector('#provider-editor').hidden")).toBe(true);
		await capture('model-default-after-use.png');
		for (const preset of ['ollama', 'lmstudio', 'llama.cpp', 'custom']) {
			await click('#add-provider-service');
			await click(`[data-provider-shortcut="${preset}"]`);
			expect(await evaluate("document.querySelector('#provider-base-url').value")).toBe('');
			await value('#provider-endpoint-name', `QA ${preset}`);
			await value('#provider-base-url', 'http://192.0.2.30:1234/v1');
			if (preset === 'ollama') await value('#provider-endpoint-key', 'synthetic-fixture-key');
			await capture(`model-${preset}-endpoint.png`);
			await click('#provider-details-next');
			const beforeTest = await count('test');
			const beforeSave = await count('endpoint-save');
			await click('#load-provider-models');
			expect(await count('test')).toBe(beforeTest);
			expect(await count('endpoint-save')).toBe(beforeSave);
			expect(
				await evaluate(
					"[...document.querySelector('#provider-model').options].map(item=>item.value)"
				)
			).toContain('team/local-model');
			await value('#provider-model', 'team/local-model', 'change');
			if (preset === 'custom') await evaluate('window.providerQa.failCheck=true');
			await click('#test-provider');
			expect(await count('endpoint-save')).toBe(beforeSave + 1);
			expect(
				await evaluate("window.providerQa.calls.filter(call=>call.operation==='test').at(-1).model")
			).toBe('team/local-model');
			expect(await evaluate('window.providerQa.settings.currentModel')).toEqual({
				provider: 'openai',
				model: 'team/second-model'
			});
			if (preset === 'custom') {
				expect(
					String(await evaluate("document.querySelector('#provider-editor-message').textContent"))
				).toContain('saved');
				expect(await evaluate("document.querySelector('#use-provider-model').disabled")).toBe(true);
				await capture('model-custom-saved-response-failed.png');
				await evaluate('window.providerQa.failCheck=false');
			}
			await click('#cancel-provider-editor');
		}
		await evaluate("document.querySelector('#provider-saved-accounts').open=true");
		await capture('model-saved-setups.png');
		expect(
			await evaluate(
				"!!document.querySelector('[data-provider-id=orphan][data-provider-action=auth]')"
			)
		).toBe(true);
		const beforeRemove = await count('remove');
		await click('[data-provider-id=orphan][data-provider-action=auth]');
		expect(await count('remove')).toBe(beforeRemove);
		await evaluate('window.providerQa.confirmRemoval=true');
		await click('[data-provider-id=orphan][data-provider-action=auth]');
		expect(
			await evaluate("window.providerQa.calls.filter(call=>call.operation==='remove').at(-1)")
		).toEqual({ operation: 'remove', provider: 'orphan' });
		await click('[data-provider-id=ollama][data-provider-action=edit]');
		expect(await evaluate("document.querySelector('#provider-endpoint-id').readOnly")).toBe(true);
		await evaluate("document.querySelector('#provider-endpoint-id').focus()");
		await command('Input.insertText', { text: 'cannot-change-existing-id' });
		expect(await evaluate("document.querySelector('#provider-endpoint-id').value")).toBe('ollama');
		await value('#provider-base-url', 'http://192.0.2.31:1234/v1');
		await click('#provider-details-next');
		await value('#provider-model', 'team/local-model', 'change');
		await click('#test-provider');
		expect(
			await evaluate(
				"window.providerQa.calls.filter(call=>call.operation==='endpoint-save').at(-1).url"
			)
		).toBe('http://192.0.2.31:1234/v1');
		await click('#cancel-provider-editor');
		await click('[data-provider-id=ollama][data-provider-action=endpoint]');
		expect(
			await evaluate("window.providerQa.calls.filter(call=>call.operation==='remove').at(-1)")
		).toEqual({ operation: 'remove', provider: 'ollama', endpoint: true });
		expect(String(await evaluate('window.providerQa.confirmations.at(-1)'))).toContain('Disable');
		expect(
			await evaluate("window.providerQa.settings.providers.find(item=>item.id==='ollama').disabled")
		).toBe(true);
		expect(
			await evaluate(
				"window.providerQa.settings.providers.find(item=>item.id==='ollama').authenticated"
			)
		).toBe(true);
		expect(
			await evaluate(
				"window.providerQa.settings.providers.find(item=>item.id==='ollama').endpoint.url"
			)
		).toBe('http://192.0.2.31:1234/v1');
		expect(
			String(
				await evaluate(
					"document.querySelector('[data-provider-id=ollama]').closest('li').textContent"
				)
			)
		).toContain('disabled');
		expect(
			await evaluate(
				"!!document.querySelector('[data-provider-id=ollama][data-provider-action=endpoint]')"
			)
		).toBe(false);
		await capture('model-endpoint-disabled.png');
		await click('[data-provider-id=ollama][data-provider-action=edit]');
		await click('#provider-details-next');
		await click('#load-provider-models');
		await value('#provider-model', 'team/local-model', 'change');
		expect(
			String(await evaluate("document.querySelector('#test-provider').textContent"))
		).toContain('Re-enable');
		expect(await evaluate("document.querySelector('#use-provider-model').disabled")).toBe(true);
		const beforeEnable = await count('endpoint-save');
		await click('#test-provider');
		expect(await count('endpoint-save')).toBe(beforeEnable + 1);
		expect(
			await evaluate("window.providerQa.settings.providers.find(item=>item.id==='ollama').disabled")
		).toBe(false);
		expect(await evaluate('window.providerQa.settings.currentModel')).toEqual({
			provider: 'openai',
			model: 'team/second-model'
		});
		await capture('model-endpoint-reenabled-tested.png');
		await evaluate('window.providerQa.rejectUse=true');
		await click('#use-provider-model');
		expect(await evaluate("document.querySelector('#provider-editor').hidden")).toBe(false);
		expect(await evaluate("document.querySelector('#use-provider-model').disabled")).toBe(true);
		expect(await evaluate('window.providerQa.settings.currentModel')).toEqual({
			provider: 'openai',
			model: 'team/second-model'
		});
		expect(
			String(await evaluate("document.querySelector('#provider-editor-message').textContent"))
		).toContain('did not confirm this model as its default');
		await capture('model-default-use-refused.png');
		await evaluate('window.providerQa.rejectUse=false');
		await click('#cancel-provider-editor');
		await click('#add-provider-service');
		await click('[data-provider-shortcut="other"]');
		await value('#provider-search', 'oauth-provider');
		await value('#provider', 'oauth-provider', 'change');
		await click('#start-provider-oauth');
		expect(await evaluate('!!window.providerQa.state.activeOAuth')).toBe(true);
		expect(await evaluate("document.querySelector('#provider-method').disabled")).toBe(true);
		await capture('model-oauth-pending.png');
		await value('#oauth-code', 'synthetic-authorization-code');
		const beforeOauth = await count('test');
		await click('#finish-provider-oauth');
		expect(await count('oauth-save')).toBe(1);
		expect(await count('test')).toBe(beforeOauth);
		expect(await evaluate("document.querySelector('#oauth-code').value")).toBe('');
		expect(await evaluate("document.querySelector('#provider-model-step').hidden")).toBe(false);
		await click('#cancel-provider-editor');
		await evaluate(
			"(async()=>{window.providerQa.setup=true;const {refresh}=await import('./snapshot.js');await refresh();})()"
		);
		await click('#test-current-model');
		expect(await evaluate("document.querySelector('#finish-provider-setup').hidden")).toBe(false);
		await capture('model-setup-explicit-continue.png');
		await evaluate("document.querySelector('#test-current-model').focus()");
		for (const id of ['change-provider-model', 'add-provider-service', 'finish-provider-setup']) {
			await keypress('Tab', 'Tab', 9);
			expect(await evaluate('document.activeElement.id')).toBe(id);
		}
		await keypress('Enter', 'Enter', 13);
		await idle();
		expect(await evaluate('window.providerQa.state.currentView')).toBe('overview');
		await evaluate(
			`(async()=>{const {showView}=await import('./ui.js');showView('provider');window.providerQa.setup=false;window.providerQa.settings.currentModel=undefined;await window.providerQa.providers.loadProviders(false,true);})()`
		);
		await capture('model-no-default.png');
		expect(await evaluate("document.querySelector('#test-current-model').disabled")).toBe(true);
		await click('#add-provider-service');
		await click('[data-provider-shortcut="custom"]');
		await value(
			'#provider-endpoint-name',
			'Long local service name for narrow viewport qualification'
		);
		await value('#provider-base-url', 'http://192.0.2.30:1234/v1');
		await click('#provider-details-next');
		await click('#load-provider-models');
		await value('#provider-model', 'team/long-model-name-with-an-exact-native-id', 'change');
		await evaluate('window.providerQa.failCheck=true');
		await click('#test-provider');
		await evaluate("document.documentElement.style.fontSize='200%'");
		await command('Emulation.setDeviceMetricsOverride', {
			width: 620,
			height: 900,
			deviceScaleFactor: 1,
			mobile: false
		});
		expect(await evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
		await capture('model-narrow-200pct-error.png');
		expect(
			await evaluate(
				"!!document.querySelector('#provider-result,#automatic-memory,#agent-timezone')"
			)
		).toBe(false);
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

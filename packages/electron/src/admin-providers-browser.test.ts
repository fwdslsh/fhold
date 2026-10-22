import { expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultStackConfig } from '@fhold/lib';
import { FH_RUNTIME_VERSION } from '../../lib/src/control-plane/release.js';

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
			// Full-page captures start at the page origin so offscreen fixed
			// controls are not composited into the middle of a tall screenshot.
			await evaluate('window.scrollTo(0, 0)');
			const size = (await command('Page.getLayoutMetrics')).cssContentSize;
			const result = await command('Page.captureScreenshot', {
				format: 'png',
				captureBeyondViewport: true,
				...(size ? { clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } } : {})
			});
			if (typeof result.data !== 'string') throw new Error('Missing screenshot');
			writeFileSync(join(root, name), Buffer.from(result.data, 'base64'));
		};
		// Actual Overview renderer, with synthetic read-only status rather than a live instance.
		await evaluate(`(async()=>{
			const {state}=await import('./state.js'); const {render}=await import('./snapshot.js');
			state.currentView='overview';
			const overview=window.overviewQa={...${JSON.stringify(snapshot)},
				homeDir:'/home/user/fhold/instances/april', updateImageTag:${JSON.stringify(FH_RUNTIME_VERSION)},
				connectionDetails:{opencode:{url:'http://127.0.0.1:3810'},mcp:{url:'http://127.0.0.1:3830/mcp'},claude:{url:'http://127.0.0.1:3830/mcp'}},
				services:[
					{name:'assistant',state:'running',health:'healthy',image:'fwdslsh/fhold-assistant:0.2.2610211-beta.13'},
					{name:'guardian',state:'running',health:'healthy',image:'fwdslsh/fhold-guardian:${FH_RUNTIME_VERSION}'},
					{name:'discord',state:'running',health:'healthy',image:'fwdslsh/fhold-portal:${FH_RUNTIME_VERSION}'}]};
			overview.config.deployment.projectName='april'; overview.config.gateway.enabled=true;
			overview.config.portals.discord.enabled=true; render(overview,{preserveDirty:false});
		})()`);
		expect(await evaluate("document.querySelector('#update-image-tag').textContent")).toBe(FH_RUNTIME_VERSION);
		expect(await evaluate("[...document.querySelectorAll('#services .service-image code')].map(item=>item.textContent)")).toEqual(['0.2.2610211-beta.13', FH_RUNTIME_VERSION, FH_RUNTIME_VERSION]);
		expect(await evaluate("document.querySelector('#services .service-image').title")).toBe('fwdslsh/fhold-assistant:0.2.2610211-beta.13');
		expect(await evaluate("document.querySelector('#update-stack').closest('.runtime-update-action').contains(document.querySelector('#update-image-tag'))")).toBe(true);
		expect(await evaluate("document.querySelector('#start-stack').closest('.runtime-update-action')")).toBeNull();
		await capture('overview-desktop.png');
		expect(await evaluate("document.querySelector('.sidebar .brand-mark')")).toBeNull();
		expect(await evaluate("Math.abs(document.querySelector('#instance-picker').getBoundingClientRect().width-document.querySelector('.sidebar-instance').getBoundingClientRect().width)<1")).toBe(true);
		await evaluate(`(async()=>{const {renderServices}=await import('./runtime.js');renderServices({...window.overviewQa,updateImageTag:undefined,target:{kind:'ssh-docker',connectionId:'krang',remoteHome:'/opt/stacks/agent'},services:[{name:'assistant',state:'running',health:'healthy'}]});})()`);
		expect(await evaluate("document.querySelector('#runtime-version-settings').hidden")).toBe(false);
		expect(await evaluate("document.querySelector('#runtime-version-help').textContent")).toContain('older fhold CLI');
		expect(await evaluate("document.querySelector('#update-stack').disabled")).toBe(false);
		await capture('overview-older-host-cli.png');
		await evaluate(`window.overviewQa.services[0].image='registry.example.com:5000/team/assistant:long-custom-image-tag-for-multiple-release-channels-2026';
			import('./runtime.js').then(({renderServices})=>renderServices(window.overviewQa));`);
		await command('Emulation.setDeviceMetricsOverride', { width: 620, height: 900, deviceScaleFactor: 1, mobile: false });
		expect(await evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
		await capture('overview-narrow.png');
		await evaluate("document.documentElement.style.fontSize='200%'");
		expect(await evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
		await capture('overview-200pct.png');
		await command('Emulation.setDeviceMetricsOverride', { width: 1120, height: 780, deviceScaleFactor: 1, mobile: false });
		await evaluate(`(async()=>{
			document.documentElement.style.fontSize=''; const {renderServices}=await import('./runtime.js');
			renderServices({...window.overviewQa,services:[],dockerError:'Cannot connect to Docker.'});
		})()`);
		expect(await evaluate("document.querySelector('#assistant-summary').textContent")).toBe('Status unavailable');
		expect(await evaluate("document.querySelector('#update-stack').disabled")).toBe(true);
		await capture('overview-unavailable.png');
		await evaluate(`(async()=>{const {state}=await import('./state.js');const {render}=await import('./snapshot.js');
			state.currentView='provider';render(${JSON.stringify(snapshot)},{preserveDirty:false});})()`);
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
		// Reproduce the real installer retry race without Docker or a billed request.
		// Only IPC is controlled; clicks go through Chromium's native pointer events.
		await command('Emulation.setDeviceMetricsOverride', { width: 1120, height: 780, deviceScaleFactor: 1, mobile: false });
		await evaluate(`(async()=>{
			document.documentElement.style.fontSize='';
			const {state,createAdminState}=await import('./state.js');
			const {renderWelcome,renderInstallationReadiness,bindInstanceEvents}=await import('./instances.js');
			const {bindRuntimeEvents}=await import('./runtime.js');
			Object.assign(state,createAdminState());
			const qa=window.installQa={names:[],reads:0,installs:0,readPending:false,release:null,name:'duplicate-name'};
			const snapshot=()=>({...${JSON.stringify(snapshot)},phase:'not_installed',homeDir:'/disposable-installs/'+qa.name,services:[],installationReadiness:{ok:true},config:{...${JSON.stringify(snapshot.config)},deployment:{...${JSON.stringify(snapshot.config.deployment)},projectName:qa.name}}});
			state.api={
				installationReadiness:async()=>({ok:true}),
				prepareNewInstance:async value=>{if(qa.readPending)throw Error('Wait for the current operation to finish');qa.name=value.name;qa.names.push(value.name);},
				snapshot:async()=>{if(++qa.reads===2){qa.readPending=true;return new Promise(resolve=>{qa.release=()=>{qa.readPending=false;resolve(snapshot());};});}return snapshot();},
				install:async()=>{if(++qa.installs===1)throw Error('Instance name is already in use.');return {...snapshot(),phase:'setup_incomplete',services:[{name:'assistant',state:'running',health:'healthy',running:true}]};},
				providers:async()=>({providers:[]})};
			renderWelcome({defaultInstance:{homeDir:'/disposable-installs/default',available:false},instancesDirectory:'/disposable-installs',recentInstances:[]});
			renderInstallationReadiness({ok:true});bindInstanceEvents();bindRuntimeEvents();
		})()`);
		const pointerClick = async (selector: string) => {
			const point = await evaluate(`(()=>{const target=document.querySelector(${JSON.stringify(selector)});target.scrollIntoView({block:'center'});const r=target.getBoundingClientRect();if(!r.width||!r.height)throw Error('Pointer target is not rendered');return {x:r.left+r.width/2,y:r.top+r.height/2};})()`) as { x: number; y: number };
			await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
			await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
		};
		const waitInstall = async (expression: string) => {
			const deadline = Date.now() + 10000;
			while (!await evaluate(expression)) {
				if (Date.now() > deadline) throw new Error(`Install renderer did not settle: ${expression}`);
				await Bun.sleep(10);
			}
		};
		await pointerClick('#begin-new-instance');
		await value('#install-instance-name', 'duplicate-name');
		await pointerClick('#install');
		await waitInstall('window.installQa.readPending');
		expect(await evaluate("!document.querySelector('#install-section').hidden && document.querySelector('#install').getBoundingClientRect().height>0")).toBe(true);
		expect(await evaluate("document.querySelector('#install').disabled && document.body.dataset.busy==='true'")).toBe(true);
		await capture('install-failure-recovery-busy.png');
		await pointerClick('#install');
		expect(await evaluate('window.installQa.names')).toEqual(['duplicate-name']);
		await evaluate('window.installQa.release(); void 0');
		await waitInstall("document.body.dataset.busy==='false' && document.querySelector('#install-status').getAttribute('role')==='alert'");
		expect(await evaluate("!document.querySelector('#install-status').hidden && document.querySelector('#install-status').textContent")).toBe('Instance name is already in use.');
		expect(await evaluate("document.querySelector('#install').disabled")).toBe(false);
		await capture('install-failure-retry-ready.png');
		await value('#install-instance-name', 'distinct-name');
		await pointerClick('#install');
		await waitInstall("document.body.dataset.busy==='false' && document.body.dataset.phase==='setup_incomplete'");
		expect(await evaluate('window.installQa.names')).toEqual(['duplicate-name', 'distinct-name']);
		expect(await evaluate('window.installQa.installs')).toBe(2);
		expect(await evaluate('window.installQa.reads')).toBe(3);
		await capture('install-distinct-retry-passed.png');
		// The hosted view consumes the same actual renderer, but deliberately does
		// not qualify SSH/Azure connectivity or any native account/deployment.
		await evaluate(`(async()=>{
			const {state}=await import('./state.js');
			const {render}=await import('./snapshot.js');
			state.api.providers=async()=>{throw Error('Remote view attempted local provider discovery');};
			render({phase:'remote',hosting:{ref:{kind:'azure-container-apps',connectionId:'cloud',resourceId:'/subscriptions/example/resourceGroups/agents/providers/Microsoft.App/containerApps/agent'},name:'cloud-agent',location:'/subscriptions/example/resourceGroups/agents/providers/Microsoft.App/containerApps/agent',services:[],warnings:[],platformState:'Scaled to zero',capabilities:{start:{supported:true},stop:{supported:true},restart:{supported:false,reason:'Ordered replacement uses deployment tooling.'},settings:{supported:false,reason:'Manage settings in deployment tooling.'},transfer:{supported:false,reason:'No local instance folder.'}},clientUrl:'https://agent.example.com'}});
		})()`);
		expect(await evaluate("!document.querySelector('#view-hosted').hidden && document.querySelector('#view-system').hidden && document.querySelector('#view-provider').hidden")).toBe(true);
		expect(await evaluate("document.querySelector('[data-hosted-action=restart]').hidden")).toBe(true);
		expect(await evaluate("document.querySelector('#instance-picker').selectedOptions[0].textContent")).toBe('cloud-agent · cloud');
		await evaluate(`(async()=>{
			const {state}=await import('./state.js');
			const {bindHostingEvents}=await import('./hosting.js');
			window.hostingQa={actions:0,approved:false,dialogFails:true};
			state.api.confirmRestart=async()=>{if(window.hostingQa.dialogFails) throw Error('Native confirmation unavailable'); return window.hostingQa.approved;};
			state.api.action=async()=>{window.hostingQa.actions++;return {...state.currentSnapshot,hosting:{...state.currentSnapshot.hosting,warnings:['Azure accepted start. Agent readiness remains unverified.']}};};
			bindHostingEvents();
		})()`);
		await click('[data-hosted-action=start]');
		expect(await evaluate("document.querySelector('#notice-message').textContent")).toBe('Native confirmation unavailable');
		expect(await evaluate("document.body.dataset.busy")).toBe('false');
		await evaluate('window.hostingQa.dialogFails=false');
		await click('[data-hosted-action=start]');
		expect(await evaluate('window.hostingQa.actions')).toBe(0);
		await evaluate('window.hostingQa.approved=true');
		await click('[data-hosted-action=start]');
		expect(await evaluate('window.hostingQa.actions')).toBe(1);
		expect(await evaluate("document.querySelector('#notice-message').textContent")).toBe('Request submitted. Check platform status.');
		expect(await evaluate("document.querySelector('#hosted-warnings').textContent")).toContain('readiness remains unverified');
		await capture('hosted-agent-desktop.png');
		await command('Emulation.setDeviceMetricsOverride', { width: 620, height: 900, deviceScaleFactor: 1, mobile: false });
		expect(await evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
		await capture('hosted-agent-narrow.png');
		await evaluate(`(async()=>{
			const {state}=await import('./state.js');
			const {render}=await import('./snapshot.js');
			render({phase:'remote',hosting:{...state.currentSnapshot.hosting,ref:{kind:'ssh-docker',connectionId:'lab',remoteHome:'/opt/stacks/agent'},location:'/opt/stacks/agent',services:[{name:'assistant',state:'running',health:'healthy'}],pendingRestart:{required:true},capabilities:{...state.currentSnapshot.hosting.capabilities,restart:{supported:true}}}});
		})()`);
		expect(await evaluate("!document.querySelector('#pending-restart').hidden && document.querySelector('#pending-restart-title').textContent==='Pending restart'")).toBe(true);
		expect(await evaluate("document.querySelector('#instance-picker').selectedOptions[0].textContent")).toBe('cloud-agent · lab');
		await evaluate(`(async()=>{const {bindRestartEvents}=await import('./restart.js');bindRestartEvents();})()`);
		await click('#apply-pending-restart');
		expect(await evaluate('window.hostingQa.actions')).toBe(2);
		expect(await evaluate("!document.querySelector('#view-hosted').hidden && !document.querySelector('#pending-restart').hidden")).toBe(true);
		// App settings is a page, independent of the selected remote/local instance.
		await command('Emulation.setDeviceMetricsOverride', { width: 1120, height: 780, deviceScaleFactor: 1, mobile: false });
		await evaluate(`(async()=>{
			const {state}=await import('./state.js');const {manageHostingConnections}=await import('./hosting.js');
			const {bindAdminSettingsEvents}=await import('./settings.js');
			window.appQa={snapshot:{settings:{updates:{channel:'stable',automatic:true}},update:{version:'0.3.261001-beta',supported:true,phase:'idle'}},installs:0};
			state.api.appSettings=async()=>structuredClone(window.appQa.snapshot);
			state.api.saveAppSettings=async settings=>{window.appQa.snapshot.settings=settings;return structuredClone(window.appQa.snapshot);};
			state.api.onAppUpdate=listener=>{window.appQa.emit=listener;return()=>{};};
			state.api.checkAppUpdate=async()=>{window.appQa.snapshot.update={...window.appQa.snapshot.update,phase:'ready',availableVersion:'0.3.261002-beta'};return structuredClone(window.appQa.snapshot);};
			state.api.installAppUpdate=async()=>{window.appQa.installs++;};
			window.connectionQa={connections:[{kind:'local-docker',id:'local',label:'This computer'},{kind:'ssh-docker',id:'krang',label:'Krang',host:'krang',roots:[]}],saved:0,removed:0,repair:0,approve:false,checkFails:true};const qa=window.connectionQa;
			state.api.hostingConnections=async()=>structuredClone(qa.connections);
			state.api.hostingSaveConnection=async value=>{qa.saved++;qa.connections.push(value);return value;};
			state.api.hostingUpdateConnection=async(id,value)=>{qa.saved++;qa.connections=qa.connections.map(item=>item.id===id?value:item);return value;};
			state.api.hostingRemoveConnection=async id=>{if(!qa.approve)return false;qa.removed++;qa.connections=qa.connections.filter(item=>item.id!==id);return true;};
			state.api.hostingCheckConnection=async()=>({ok:!qa.checkFails,repairable:true,instances:[],checks:[{name:'SSH',ok:true,detail:'Connected to krang.'},{name:'Remote CLI',ok:!qa.checkFails,detail:qa.checkFails?'Missing CLI. Install / update remote CLI.':'CLI ready.'}]});
			state.api.hostingRepairConnection=async()=>{qa.repair++;qa.checkFails=false;return 'Remote CLI updated. No containers changed.';};
			state.api.hostingFeatures=async()=>({installation:true});
			state.api.hostingInstances=async()=>{throw Error('SSH sign-in failed. Review native SSH configuration.');};
			bindAdminSettingsEvents();await manageHostingConnections();
		})()`);
		expect(await evaluate("!document.querySelector('#admin-settings').hidden && document.body.dataset.adminSettings==='true'")).toBe(true);
		expect(await evaluate("document.querySelector('#admin-update-channel').value")).toBe('stable');
		expect(await evaluate("document.querySelector('#app-shell').inert")).toBe(true);
		expect(await evaluate("document.querySelector('#hosting-manager').closest('#admin-settings')!==null")).toBe(true);
		await capture('admin-settings-stable-desktop.png');
		await evaluate("document.querySelector('#admin-settings-back').focus()");
		for (const label of ['Open instances Krang', 'Edit Krang', 'Check Krang', 'Remove Krang']) {
			await keypress('Tab', 'Tab', 9);
			expect(await evaluate('document.activeElement.getAttribute("aria-label")')).toBe(label);
		}
		await keypress('Tab', 'Tab', 9);
		expect(await evaluate('document.activeElement.id')).toBe('hosting-new');
		for (const id of ['admin-update-channel', 'admin-update-automatic', 'admin-updates-save', 'admin-update-check']) {
			await keypress('Tab', 'Tab', 9);
			expect(await evaluate('document.activeElement.id')).toBe(id);
		}
		await value('#admin-update-channel','beta','change');
		await click('#admin-updates-save');
		expect(await evaluate('window.appQa.snapshot.settings.updates.channel')).toBe('beta');
		await click('#admin-update-check');
		expect(await evaluate("document.querySelector('#admin-update-install').hidden")).toBe(false);
		expect(await evaluate('window.appQa.installs')).toBe(0);
		await capture('admin-settings-update-ready.png');
		await click('#admin-update-install');
		expect(await evaluate('window.appQa.installs')).toBe(1);
		await click('button[aria-label="Check Krang"]');
		expect(await evaluate("document.querySelector('#hosting-manager-status').textContent")).toContain('needs attention');
		await click('#hosting-check-details button');
		expect(await evaluate('window.connectionQa.repair')).toBe(1);
		expect(await evaluate("document.querySelector('#hosting-manager-status').textContent")).toContain('ready');
		await click('button[aria-label="Edit Krang"]');
		await capture('hosting-connection-editor-desktop.png');
		expect(await evaluate("document.querySelector('#hosting-id').readOnly")).toBe(true);
		await value('#hosting-label','Krang lab');
		await value('#hosting-roots','/opt/stacks');
		await click('#hosting-save');
		expect(await evaluate('window.connectionQa.connections.find(item=>item.id==="krang").roots')).toEqual(['/opt/stacks']);
		expect(await evaluate("document.querySelector('#hosting-connection').value")).toBe('krang');
		await capture('hosting-connections-desktop.png');
		await click('button[aria-label="Remove Krang lab"]');
		expect(await evaluate('window.connectionQa.removed')).toBe(0);
		await click('#hosting-new');
		await value('#hosting-label','Second host'); await value('#hosting-host','second'); await click('#hosting-save');
		expect(await evaluate('window.connectionQa.connections.find(item=>item.id==="second-host").host')).toBe('second');
		await evaluate('window.connectionQa.approve=true');
		await click('button[aria-label="Remove Second host"]');
		expect(await evaluate('window.connectionQa.removed')).toBe(1);
		await command('Emulation.setDeviceMetricsOverride', { width: 620, height: 900, deviceScaleFactor: 1, mobile: false });
		expect(await evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
		await capture('hosting-connections-narrow.png');
		await evaluate("document.documentElement.style.fontSize='200%'");
		expect(await evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
		await capture('admin-settings-narrow-200pct.png');
		await evaluate("document.documentElement.style.fontSize=''");
		await click('#admin-settings-back');
		expect(await evaluate("document.querySelector('#admin-settings').hidden && !document.querySelector('#app-shell').inert")).toBe(true);
		await evaluate("document.querySelector('#app-shell').hidden=true;document.querySelector('#instance-welcome').hidden=false;document.querySelector('#instance-options').hidden=true;document.querySelector('#open-hosting').hidden=false");
		await click('#hosting-discover');
		expect(await evaluate("document.querySelector('#hosting-status').textContent")).toContain('SSH sign-in failed');
		expect(await evaluate("document.querySelector('#hosting-status').hidden")).toBe(false);
		expect(await evaluate("document.querySelector('#hosting-instance-list').children.length")).toBe(0);
		await capture('hosting-discovery-error.png');
		await evaluate(`(async()=>{
			const {state}=await import('./state.js');
			state.api.hostingInstances=()=>new Promise((_resolve,reject)=>window.rejectOldDiscovery=reject);
			document.querySelector('#hosting-discover').click();
		})()`);
		await evaluate(`document.querySelector('#hosting-connection').value='local';document.querySelector('#hosting-connection').dispatchEvent(new Event('change'));window.rejectOldDiscovery(Error('Old connection failure'));`);
		expect(await evaluate("document.querySelector('#hosting-status').hidden")).toBe(true);
		expect(await evaluate("document.querySelector('#hosting-instance-list').children.length")).toBe(0);
		// Walk the real chooser/creation/import controls. Only native IPC is a fixture;
		// no host, selected instance, container or user directory is changed.
		await evaluate(`(async()=>{
			const {state,createAdminState}=await import('./state.js');const {renderWelcome}=await import('./instances.js');
			const {bindInstanceRestoreEvents}=await import('./backup.js');
			const api=state.api;Object.assign(state,createAdminState());state.api=api;
			window.instanceQa={opens:[],prepares:[],imports:0,confirmations:0,discoveries:[],approve:false};const qa=window.instanceQa;
			state.api.installationReadiness=async()=>({ok:true});
			state.api.hostingInstances=async id=>{qa.discoveries.push(id);return [{name:id==='local'?'april':'lab-agent',location:id==='local'?'/home/user/fhold/instances/april':'/opt/stacks/lab-agent',ref:id==='local'?{kind:'local-docker',connectionId:'local',homeDir:'/home/user/fhold/instances/april'}:{kind:'ssh-docker',connectionId:id,remoteHome:'/opt/stacks/lab-agent'}}];};
			state.api.hostingInfo=async id=>({instancesDirectory:id==='local'?'/home/user/fhold/instances':'/opt/stacks',defaultHome:id==='local'?'/home/user/fhold/instances/default':'/opt/stacks/default'});
			state.api.chooseDirectory=async()=>undefined;
			state.api.openInstance=async target=>{qa.opens.push(target);throw Error('This instance is not available. Choose another instance or check its host connection.');};
			state.api.prepareNewInstance=async target=>{qa.prepares.push(target);};
			state.api.restoreInstance=async input=>{if(input.apply)qa.imports++;return {projectName:'restored-agent',sourceHome:input.sourceHome,destinationHome:'/home/user/fhold/instances/restored-agent',copyCount:142,skipped:[],warnings:['The source export must remain private: it includes sign-ins and access keys.'],digest:'fixture-preview'};};
			state.api.confirmRestart=async()=>{qa.confirmations++;return qa.approve;};
			window.instanceQaWelcome={instancesDirectory:'/home/user/fhold/instances',defaultInstance:{kind:'local',homeDir:'/home/user/fhold/instances/default',available:false},recentInstances:[]};
			state.recentInstances=[];renderWelcome(window.instanceQaWelcome);bindInstanceRestoreEvents();
			document.querySelector('#install-instance-name').value='personal-agent';
		})()`);
		await command('Emulation.setDeviceMetricsOverride', { width:1120, height:780, deviceScaleFactor:1, mobile:false });
		await capture('instances-first-use-desktop.png');
		// Browsing from a cloud instance preserves its view behind the chooser;
		// finishing discovery must refresh controls, not navigate back to that view.
		await evaluate(`(async()=>{const {state}=await import('./state.js');const {render}=await import('./snapshot.js');render({phase:'remote',hosting:{ref:{kind:'azure-container-apps',connectionId:'cloud',resourceId:'/agent'},name:'cloud-agent',location:'/agent',services:[],warnings:[],capabilities:{start:{supported:true},stop:{supported:true},restart:{supported:false},settings:{supported:false},transfer:{supported:false}}}});state.dirtyForms.add('preferences-form');})()`);
		await value('#instance-picker','open-another','change');
		expect(await evaluate("!document.querySelector('#open-hosting').hidden && document.querySelector('#app-shell').hidden")).toBe(true);
		expect(await evaluate("document.querySelector('#hosting-connection').value")).toBe('local');
		expect(await evaluate("document.querySelector('#hosting-instance-list .instance-name').textContent")).toBe('april');
		expect(await evaluate("document.querySelector('#instance-welcome').getAttribute('aria-busy')")).toBe('false');
		expect(await evaluate("window.providerQa.state.currentSnapshot.hosting.name")).toBe('cloud-agent');
		await capture('instances-from-aca-desktop.png');
		await click('#hosting-back');
		expect(await evaluate("document.querySelector('#instance-welcome').hidden && !document.querySelector('#view-hosted').hidden")).toBe(true);
		expect(await evaluate("window.providerQa.state.dirtyForms.has('preferences-form')")).toBe(true);
		await evaluate(`(async()=>{const {state}=await import('./state.js');const {renderWelcome}=await import('./instances.js');state.currentSnapshot=null;state.dirtyForms.clear();renderWelcome(window.instanceQaWelcome);})()`);
		expect(await evaluate("document.querySelector('#begin-new-instance').classList.contains('primary')")).toBe(true);
		await click('#connect-host');
		expect(await evaluate("document.querySelector('#hosting-connection').value")).toBe('local');
		expect(await evaluate("!document.querySelector('#choose-instance').hidden && document.querySelector('#hosting-open-folder').hidden")).toBe(true);
		await capture('instances-local-chooser-desktop.png');
		await click('#choose-instance');
		expect(await evaluate('window.instanceQa.opens.length')).toBe(0);
		await click('#hosting-back');
		expect(await evaluate('document.activeElement.id')).toBe('connect-host');
		await evaluate(`(async()=>{const {state}=await import('./state.js');const {renderWelcome}=await import('./instances.js');const welcome={...window.instanceQaWelcome,recentInstances:[{kind:'local',name:'april',homeDir:'/home/user/fhold/instances/april',available:true},{kind:'hosted',name:'lab-agent',connectionLabel:'Krang',ref:{kind:'ssh-docker',connectionId:'krang',remoteHome:'/opt/stacks/lab-agent'},available:true}]};state.recentInstances=welcome.recentInstances;renderWelcome(welcome);})()`);
		await capture('instances-recents-desktop.png');
		await click('#recent-instances button');
		expect(await evaluate('window.instanceQa.opens.at(-1).homeDir')).toBe('/home/user/fhold/instances/april');
		expect(await evaluate("document.querySelector('#instance-preference-warning').hidden")).toBe(false);
		await capture('instances-open-error.png');
		await click('#connect-host');
		expect(await evaluate("document.querySelector('#instance-preference-warning').hidden")).toBe(true);
		await value('#hosting-connection','krang','change');
		expect(await evaluate("!document.querySelector('#hosting-open-folder').hidden && document.querySelector('#choose-instance').hidden")).toBe(true);
		await capture('instances-ssh-chooser-desktop.png');
		await click('#hosting-instance-list button');
		expect(await evaluate('window.instanceQa.opens.at(-1).ref')).toEqual({kind:'ssh-docker',connectionId:'krang',remoteHome:'/opt/stacks/lab-agent'});
		await capture('instances-ssh-open-error.png');
		await evaluate("import('./hosting.js').then(({showHostingChooser})=>showHostingChooser('krang'))");
		expect(await evaluate("document.querySelector('#instance-preference-warning').hidden")).toBe(true);
		await command('Emulation.setDeviceMetricsOverride', { width:620,height:900,deviceScaleFactor:1,mobile:false });
		expect(await evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
		await capture('instances-ssh-chooser-narrow.png');
		await evaluate("document.documentElement.style.fontSize='200%'");
		expect(await evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
		await capture('instances-ssh-chooser-200pct.png');
		await evaluate("document.documentElement.style.fontSize=''");
		await command('Emulation.setDeviceMetricsOverride', { width:1120,height:780,deviceScaleFactor:1,mobile:false });
		await click('#hosting-manage');
		expect(await evaluate("document.querySelector('#hosting-connection').value")).toBe('krang');
		const discoveryCount = await evaluate('window.instanceQa.discoveries.length') as number;
		await click('#admin-settings-back');
		expect(await evaluate('window.instanceQa.discoveries.length')).toBeGreaterThan(discoveryCount);
		expect(await evaluate("document.querySelector('#open-hosting').hidden")).toBe(false);
		await click('#hosting-install');
		expect(await evaluate("document.querySelector('#install-home').value")).toBe('/opt/stacks/personal-agent');
		expect(await evaluate("document.querySelector('#install-section [data-setup-location]').textContent")).toBe('On Krang lab');
		expect(await evaluate('window.instanceQa.prepares.length')).toBe(0);
		await capture('instances-new-ssh-desktop.png');
		await evaluate(`(async()=>{const {state}=await import('./state.js');const {renderWelcome}=await import('./instances.js');state.installConnection=undefined;renderWelcome(window.instanceQaWelcome);})()`);
		await click('#begin-instance-import');
		expect(await evaluate("document.querySelector('#instance-restore-back').hidden")).toBe(true);
		await value('#instance-restore-source','/home/user/fhold/backups/april-export');
		await value('#instance-restore-home','/home/user/fhold/instances/restored-agent');
		await capture('instances-import-choose-desktop.png');
		await click('#preview-instance-restore');
		expect(await evaluate('window.instanceQa.prepares.at(-1)')).toEqual({kind:'local',homeDir:'/home/user/fhold/instances/restored-agent'});
		expect(await evaluate("document.querySelector('#instance-import-review').hidden")).toBe(false);
		expect(await evaluate('window.instanceQa.imports')).toBe(0);
		await capture('instances-import-review-desktop.png');
		await click('#apply-instance-restore');
		expect(await evaluate('window.instanceQa.confirmations')).toBe(1);
		expect(await evaluate('window.instanceQa.imports')).toBe(0);
		await click('#instance-restore-back');
		expect(await evaluate("document.querySelector('#instance-restore-source').value")).toBe('/home/user/fhold/backups/april-export');
		expect(await evaluate("document.querySelector('#instance-restore-home').value")).toBe('/home/user/fhold/instances/restored-agent');
		expect(await evaluate("document.querySelector('#apply-instance-restore').disabled")).toBe(true);
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

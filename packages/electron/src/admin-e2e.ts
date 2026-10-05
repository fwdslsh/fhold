import { app, dialog, shell, type BrowserWindow } from 'electron';
import axe from 'axe-core';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createServer, type Server } from 'node:net';

import {
	createBackup,
	defaultStackConfig,
	markInstalled,
	MANAGED_FILES,
	SEEDED_FILES,
	createFholdState,
	deactivateComposeCommand,
	runDocker,
	testAssistantReadiness
} from '@fhold/lib';
import { installFromAdmin } from './admin-domain.js';

import { adminSnapshot, createAdminWindow, registerAdminIpc, runAdminAction } from './admin-app.js';

type RendererWaitState = { ready: boolean; error: string };

const visualAudits: Array<Record<string, unknown>> = [];

async function sizeViewport(
	window: BrowserWindow,
	width: number,
	height: number,
	zoom = 1
): Promise<void> {
	window.webContents.setZoomFactor(zoom);
	window.setContentSize(width, height);
	await waitForRenderer(
		window,
		`Math.abs(innerWidth - ${width / zoom}) < 2 && Math.abs(innerHeight - ${height / zoom}) < 2`,
		'actual test viewport dimensions',
		10_000,
		true
	);
}

async function keyboardNavigation(window: BrowserWindow): Promise<void> {
	const press = async (keyCode: string, modifiers: Array<'shift'> = []) => {
		window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
		if (keyCode === 'Return' || keyCode === 'Space')
			window.webContents.sendInputEvent({ type: 'char', keyCode, modifiers });
		window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
		await window.webContents.executeJavaScript(
			'new Promise(resolve => requestAnimationFrame(resolve))'
		);
	};
	await window.webContents.executeJavaScript(
		'document.body.tabIndex=-1; document.body.focus(); window.scrollTo(0,0)'
	);
	// Traverse from document start with actual keyboard events, not programmatic focus.
	await waitForRenderer(
		window,
		"!document.querySelector('#mobile-navigation').open",
		'collapsed narrow navigation',
		10_000,
		true
	);
	await press('Tab');
	await press('Tab');
	assert(
		await window.webContents.executeJavaScript("document.activeElement?.hasAttribute('data-instance-switch')"),
		'Keyboard did not reach the labeled instance switch after the skip link.'
	);
	await press('Tab');
	assert(
		await window.webContents.executeJavaScript(
			"document.activeElement?.id === 'mobile-navigation-label'"
		),
		'Keyboard did not reach collapsed navigation after the skip link.'
	);
	await press('Return');
	assert(
		await window.webContents.executeJavaScript("document.querySelector('#mobile-navigation').open"),
		'Enter did not expand navigation.'
	);
	await press('Space');
	assert(
		await window.webContents.executeJavaScript(
			"!document.querySelector('#mobile-navigation').open"
		),
		'Space did not collapse navigation.'
	);
	await press('Tab', ['shift']);
	assert(
		await window.webContents.executeJavaScript("document.activeElement?.hasAttribute('data-instance-switch')"),
		'Reverse traversal did not reach the instance switch.'
	);
	await press('Tab', ['shift']);
	assert(
		await window.webContents.executeJavaScript("document.activeElement?.id === 'skip-link'"),
		'Reverse traversal did not reach the skip link.'
	);
	await press('Tab');
	await press('Tab');
	await press('Return');
	await press('Tab');
	await press('Tab');
	await press('Tab');
	assert(
		await window.webContents.executeJavaScript(
			"document.activeElement?.dataset.view === 'connections'"
		),
		'Navigation task order is inconsistent.'
	);
	await press('Return');
	assert(
		await window.webContents.executeJavaScript(
			"!document.querySelector('#mobile-navigation').open && !document.querySelector('#view-connections').hidden && document.activeElement?.id === 'view-title'"
		),
		'Selecting a page did not close navigation and focus its heading.'
	);
	visualAudits.push({ keyboard: 'Tab, Shift+Tab, instance switch, Enter, Space, page selection', passed: true });
}

function requiredEnvironment(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required for the Admin E2E test.`);
	return value;
}

function requiredPort(name: string): number {
	const value = Number(requiredEnvironment(name));
	if (!Number.isInteger(value) || value < 1 || value > 65_535) {
		throw new Error(`${name} must be an integer from 1 through 65535.`);
	}
	return value;
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function progress(value: string): void {
	process.stdout.write(`[admin-e2e] ${value}\n`);
}

async function waitForAppReady(): Promise<void> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			app.whenReady(),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() => reject(new Error('Electron did not become ready within 30 seconds.')),
					30_000
				);
			})
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function waitForLoad(window: BrowserWindow): Promise<void> {
	if (!window.webContents.isLoading()) return;
	await new Promise<void>((resolve, reject) => {
		window.webContents.once('did-finish-load', () => resolve());
		window.webContents.once('did-fail-load', (_event, code, description) => {
			reject(new Error(`Admin renderer failed to load (${code}): ${description}`));
		});
	});
}

async function waitForRenderer(
	window: BrowserWindow,
	expression: string,
	description: string,
	timeoutMs = 180_000,
	allowError = false
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (window.webContents.isLoading()) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			continue;
		}
		const state = (await window.webContents.executeJavaScript(`(async () => {
			const notice = document.querySelector('#notice');
			return {
				ready: Boolean(await (${expression})),
				error: notice && !notice.hidden && notice.classList.contains('error') ? notice.textContent || 'Unknown Admin error' : ''
			};
		})()`)) as RendererWaitState;
		if (state.error && !allowError) throw new Error(`Admin renderer reported: ${state.error}`);
		if (state.ready) return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	const diagnostics = await window.webContents.executeJavaScript(`({
		busy: document.body.dataset.busy,
		notice: document.querySelector('#notice-message')?.textContent,
		restoreSummary: document.querySelector('#restore-summary')?.textContent,
		restoreDisabled: document.querySelector('#apply-restore')?.disabled
	})`);
	throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(diagnostics)}.`);
}

async function capture(
	window: BrowserWindow,
	directory: string,
	name: string,
	preserveFocus = false
): Promise<string> {
	const path = join(directory, name);
	progress(`capturing ${name}`);
	if (!preserveFocus)
		await window.webContents.executeJavaScript(
			'document.activeElement?.blur(); window.scrollTo(0, 0)'
		);
	await window.webContents.executeJavaScript(
		'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
	);
	// Let the 120ms control transitions finish before recording presentation pixels.
	await new Promise((resolve) => setTimeout(resolve, 180));
	await window.webContents.executeJavaScript(axe.source);
	const audit = await window.webContents.executeJavaScript(`(async () => {
		const result = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21aa','wcag22aa'] } });
		return { width: innerWidth, height: innerHeight, zoom: ${window.webContents.getZoomFactor()}, overflow: document.documentElement.scrollWidth - innerWidth,
			violations: result.violations.map(({id,impact,nodes}) => ({id,impact,targets:nodes.map(node=>node.target)})),
			incomplete: result.incomplete.map(({id,nodes}) => ({id,targets:nodes.map(node=>node.target)})) };
	})()`);
	visualAudits.push({ screenshot: name, ...audit });
	assert(audit.overflow <= 1, `Screenshot ${name} has horizontal overflow.`);
	assert(
		!audit.violations.some((item: { impact: string }) =>
			['critical', 'serious'].includes(item.impact)
		),
		`Accessibility blockers in ${name}: ${JSON.stringify(audit.violations)}`
	);
	let timeout: NodeJS.Timeout | undefined;
	const image = await Promise.race([
		window.webContents.capturePage(),
		new Promise<never>((_resolve, reject) => {
			timeout = setTimeout(() => reject(new Error(`Screenshot timed out: ${name}`)), 10_000);
		})
	]).finally(() => {
		if (timeout) clearTimeout(timeout);
	});
	writeFileSync(path, image.toPNG());
	return path;
}

async function assertRenderedFloor(window: BrowserWindow, label: string): Promise<void> {
	// Exercise real keyboard modality; focus-visible should not decorate mouse clicks.
	window.focus();
	window.webContents.focus();
	window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
	window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
	await window.webContents.executeJavaScript(
		'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
	);
	const result = (await window.webContents.executeJavaScript(`(() => {
		const visible = (element) => {
			const modal = document.querySelector('dialog[open]');
			if (modal && !modal.contains(element)) return false;
			if (element.tagName !== 'SUMMARY' && element.closest('details:not([open])')) return false;
			const style = getComputedStyle(element);
			const rect = element.getBoundingClientRect();
			return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
		};
		const controls = [...document.querySelectorAll('button,input,select,summary')].filter(visible);
		const undersized = controls
			.map((element) => {
				const rect = element.getBoundingClientRect();
				return { tag: element.tagName, id: element.id, width: rect.width, height: rect.height };
			})
			.filter((item) => item.width < 24 || item.height < 24);
		const focusTarget = document.activeElement;
		const focusStyle = focusTarget ? getComputedStyle(focusTarget) : null;
		return {
			overflow: document.documentElement.scrollWidth - window.innerWidth,
			overflowing: [...document.querySelectorAll('body *')].filter(element => {
				const rect = element.getBoundingClientRect();
				return rect.width > 0 && rect.right > window.innerWidth + 1;
			}).map(element => ({ id: element.id, tag: element.tagName, right: element.getBoundingClientRect().right })),
			undersized,
			focus: focusStyle ? { id: focusTarget.id, tag: focusTarget.tagName, style: focusStyle.outlineStyle, width: focusStyle.outlineWidth } : null
		};
	})()`)) as {
		overflow: number;
		undersized: Array<{ tag: string; id: string; width: number; height: number }>;
		overflowing: Array<{ id: string; tag: string; right: number }>;
		focus: { style: string; width: string } | null;
	};
	assert(
		result.overflow <= 1,
		`${label} has ${result.overflow}px of horizontal overflow: ${JSON.stringify(result.overflowing)}.`
	);
	assert(
		result.undersized.length === 0,
		`${label} has undersized controls: ${JSON.stringify(result.undersized)}`
	);
	assert(
		result.focus !== null && result.focus.style !== 'none' && result.focus.width !== '0px',
		`${label} does not expose a visible focus outline: ${JSON.stringify(result.focus)}`
	);
}

async function verifySidebar(window: BrowserWindow, outputDir: string): Promise<string[]> {
	const originalSize = window.getSize().join('x');
	const viewport = await window.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})');
	const screenshots: string[] = [];
	try {
		assert(await window.webContents.executeJavaScript(`(async () => {
			const snapshot = await window.fholdAdmin.snapshot();
			const path = document.querySelector('#selected-instance-path');
			const name = document.querySelector('#sidebar-instance-name');
			const refresh = document.querySelector('#refresh');
			return name.textContent === snapshot.config.deployment.projectName && path.textContent === snapshot.homeDir &&
				path.title === snapshot.homeDir && getComputedStyle(path).whiteSpace === 'nowrap' &&
				getComputedStyle(path).textOverflow === 'ellipsis' && refresh.textContent === 'Refresh' &&
				refresh.getAttribute('aria-label') === 'Refresh status' && refresh.getBoundingClientRect().height >= 44 &&
				document.querySelector('#stack-status').textContent === 'Assistant running';
		})()`), 'Sidebar did not expose the saved identity, complete folder or compact runtime controls.');
		await window.webContents.executeJavaScript("document.querySelector('[data-view=system]').click()");
		screenshots.push(await capture(window, outputDir, '04d-sidebar-system.png'));

		// Presentation-only extremes use the ordinary renderer. They never alter
		// the selected home, Docker, account policy or persisted configuration.
		await window.webContents.executeJavaScript(`(async () => {
			const {render} = await import('./snapshot.js');
			const snapshot = await window.fholdAdmin.snapshot();
			render({...snapshot, homeDir:'/home/person/fhold/instances/' + 'long-folder-'.repeat(14),
				config:{...snapshot.config,deployment:{...snapshot.config.deployment,projectName:'personal-agent-' + 'a'.repeat(48)}}});
		})()`);
		assert(await window.webContents.executeJavaScript(`(() => {
			const path = document.querySelector('#selected-instance-path');
			const name = document.querySelector('#sidebar-instance-name');
			return path.title === path.textContent && path.scrollWidth > path.clientWidth &&
				path.getBoundingClientRect().height < 28 && name.scrollWidth > name.clientWidth &&
				document.querySelector('.sidebar').scrollWidth <= document.querySelector('.sidebar').clientWidth + 1;
		})()`), 'Long identity/path spilled into navigation or lost the full folder.');
		screenshots.push(await capture(window, outputDir, '04e-sidebar-long-path.png'));
		await window.webContents.executeJavaScript("document.querySelector('#refresh').click()");
		await waitForRenderer(window, "document.querySelector('#refresh').dataset.state === 'current'", 'sidebar refresh completion');
		assert(await window.webContents.executeJavaScript(`(async () => {
			const {state} = await import('./state.js');
			const {refresh} = await import('./snapshot.js');
			const original = state.api;
			try {
				state.api = {...original,snapshot:async () => {throw new Error('Isolated renderer transport-failure fixture');}};
				await refresh(true);
				return document.querySelector('#stack-status').textContent === 'Status unavailable' &&
					!document.querySelector('#stack-status').classList.contains('success') &&
					document.querySelector('#refresh').dataset.state === 'stale' &&
					document.querySelector('#status-detail').textContent.includes('last known');
			} finally {state.api = original;}
		})()`), 'Failed refresh kept a misleading healthy sidebar.');
		screenshots.push(await capture(window, outputDir, '04f-sidebar-stale-status.png'));
		await window.webContents.executeJavaScript("document.querySelector('#dismiss-notice').click(); document.querySelector('#refresh').click()");
		await waitForRenderer(window, "document.querySelector('#refresh').dataset.state === 'current'", 'sidebar recovers after a failed refresh');
		for (const zoom of [1, 2]) {
			await sizeViewport(window, 640, 640, zoom);
			await window.webContents.executeJavaScript("document.querySelector('#mobile-navigation').open=true; window.scrollTo(0,0)");
			assert(await window.webContents.executeJavaScript(`(() => {
				const visible = (element) => {
					const box = element.getBoundingClientRect();
					return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
				};
				return visible(document.querySelector('#sidebar-instance-name')) &&
					visible(document.querySelector('.sidebar [data-instance-switch]')) && visible(document.querySelector('#refresh')) &&
					[...document.querySelectorAll('.sidebar button')].filter(visible).every(button => button.getBoundingClientRect().height >= 44);
			})()`), `Sidebar lost identity/actions or touch targets at ${zoom * 100}% zoom.`);
			await assertRenderedFloor(window, `expanded sidebar at ${zoom * 100}% zoom`);
			// Keyboard focus can scroll the long System view. Show the actual sidebar
			// header in responsive screenshots without clearing its tested focus state.
			await window.webContents.executeJavaScript('window.scrollTo(0, 0)');
			screenshots.push(await capture(window, outputDir, zoom === 1 ? '04g-sidebar-narrow.png' : '04h-sidebar-zoom.png', true));
		}
	} finally {
		await sizeViewport(window, viewport.width, viewport.height);
		await window.webContents.executeJavaScript(`(async () => {
			const {refresh} = await import('./snapshot.js');
			await refresh(false);
			document.querySelector('[data-view=overview]').click();
		})()`);
	}
	assert(window.getSize().join('x') === originalSize, 'Sidebar interaction changed the user window size.');
	progress('sidebar: real identity/runtime, long-path and stale-status fixtures, labeled actions, narrow/200% zoom and stable size passed');
	return screenshots;
}

function rpcPayload(text: string): Record<string, unknown> | null {
	try {
		const value = JSON.parse(text) as unknown;
		return value !== null && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		for (const line of text.split(/\r?\n/)) {
			if (!line.startsWith('data:')) continue;
			try {
				const value = JSON.parse(line.slice(5).trim()) as unknown;
				if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
					return value as Record<string, unknown>;
				}
			} catch {
				// Continue to the next server-sent event.
			}
		}
	}
	return null;
}

async function guardianRequest(
	url: string,
	body: Record<string, unknown>,
	key?: string,
	timeoutMs = 15_000
): Promise<{ status: number; text: string; payload: Record<string, unknown> | null }> {
	const headers = new Headers({
		accept: 'application/json, text/event-stream',
		'content-type': 'application/json',
		'mcp-protocol-version': '2025-06-18'
	});
	if (key) headers.set('authorization', `Bearer ${key}`);
	const response = await fetch(url, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs)
	});
	const text = await response.text();
	return { status: response.status, text, payload: rpcPayload(text) };
}

function toolNames(payload: Record<string, unknown> | null): string[] {
	const result = payload?.result;
	if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
	const tools = (result as Record<string, unknown>).tools;
	if (!Array.isArray(tools)) return [];
	return tools
		.map((tool) =>
			tool && typeof tool === 'object' && !Array.isArray(tool)
				? (tool as Record<string, unknown>).name
				: undefined
		)
		.filter((name): name is string => typeof name === 'string');
}

async function connectProviderUi(
	window: BrowserWindow,
	provider: string,
	key: string
): Promise<Record<string, unknown>> {
	await waitForRenderer(
		window,
		"(await import('./state.js')).state.providersLoaded && !(await import('./state.js')).state.providerLoadPromise && document.body.dataset.busy !== 'true'",
		'provider discovery before sign-in',
		240_000
	);
	await window.webContents.executeJavaScript(`(() => {
		document.querySelector('#provider-search').value = ${JSON.stringify(provider)};
		document.querySelector('#provider-search').dispatchEvent(new Event('input', { bubbles: true }));
	})()`);
	assert(
		await window.webContents.executeJavaScript(
			`[...document.querySelectorAll('#provider option')].some(option => option.value === ${JSON.stringify(provider)})`
		),
		`Provider ${provider} was not discovered by OpenCode.`
	);
	await window.webContents.executeJavaScript(`(() => {
		document.querySelector('#provider').value = ${JSON.stringify(provider)};
		document.querySelector('#provider').dispatchEvent(new Event('change', { bubbles: true }));
		const apiMethod = [...document.querySelectorAll('#provider-method option')].find(option => /api/i.test(option.textContent));
		if (apiMethod) {
			document.querySelector('#provider-method').value = apiMethod.value;
			document.querySelector('#provider-method').dispatchEvent(new Event('change', { bubbles: true }));
		}
		document.querySelector('#provider-key').value = ${JSON.stringify(key)};
		document.querySelector('#provider-form').requestSubmit();
	})()`);
	await waitForRenderer(
		window,
		"document.querySelector('#notice-message')?.textContent === 'Provider verified. Your personal agent is ready.' && document.querySelector('#view-overview')?.hidden === false",
		'provider readiness',
		180_000
	);
	const readiness = (await window.webContents.executeJavaScript(
		"JSON.parse(document.querySelector('#provider-result').value)"
	)) as Record<string, unknown>;
	assert(readiness.ok === true, `Provider readiness failed: ${JSON.stringify(readiness)}`);
	return readiness;
}

async function run(): Promise<Record<string, unknown>> {
	const homeDir = requiredEnvironment('FH_HOME');
	const projectName = requiredEnvironment('FH_PROJECT_NAME');
	const outputDir = requiredEnvironment('FH_ADMIN_E2E_OUTPUT');
	const assistantPort = requiredPort('FH_ADMIN_E2E_ASSISTANT_PORT');
	const guardianPort = requiredPort('FH_ADMIN_E2E_GUARDIAN_PORT');
	let secondAssistantPort = 0;
	let secondGuardianPort = 0;
	const portBlockers: Server[] = [];
	const ingressSubnet = process.env.FH_ADMIN_E2E_INGRESS_SUBNET?.trim() || '';
	const keepRunning = process.env.FH_ADMIN_E2E_KEEP_RUNNING === 'true';
	const provider = process.env.FH_ADMIN_E2E_PROVIDER?.trim() || '';
	const keyFile = process.env.FH_ADMIN_E2E_PROVIDER_KEY_FILE;
	const providerKey = keyFile
		? readFileSync(keyFile, 'utf8').trim()
		: process.env.FH_ADMIN_E2E_PROVIDER_KEY || '';
	assert(Boolean(provider) === Boolean(providerKey), 'Set both E2E provider variables or neither.');
	mkdirSync(outputDir, { recursive: true });
	app.setName('fhold Admin E2E');
	app.setPath('userData', join(outputDir, 'electron-profile'));

	progress(
		`waiting for Electron ${process.versions.electron ?? 'unknown'} (${process.type ?? 'unknown process'})`
	);
	app.once('will-finish-launching', () => progress('Electron will finish launching'));
	app.once('ready', () => progress('Electron ready event received'));
	await waitForAppReady();
	progress('opening the real Admin renderer');
	registerAdminIpc();
	const window = createAdminWindow({ show: true });
	window.setTitle('fhold Admin — automated UI test');
	window.on('page-title-updated', (event) => event.preventDefault());
	const otherHome = join(outputDir, 'other-empty-instance');
	const fullRestoredHome = join(outputDir, 'full-restored-instance');
	const originalMessageBox = dialog.showMessageBox;
	const confirmations: number[] = [];
	const prompts: string[] = [];
	const waitForPrompt = async (count: number) => {
		const deadline = Date.now() + 10_000;
		while (prompts.length < count && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 50));
		assert(prompts.length === count, 'Expected native confirmation was not presented.');
	};
	// Only replace the human's native dialog response. Save, IPC, Compose and
	// health checks below all exercise the real application and Docker daemon.
	dialog.showMessageBox = (async (...args: unknown[]) => {
		const prompt = args.at(-1) as Electron.MessageBoxOptions;
		assert(prompt.defaultId === 0 && prompt.cancelId === 0, 'Interrupting action did not default to postponement.');
		assert(prompt.buttons?.length === 2, 'Restart choice is missing.');
		const response = confirmations.shift();
		assert(response !== undefined, `Unexpected interruption prompt: ${prompt.message}`);
		prompts.push(prompt.message);
		return { response, checkboxChecked: false };
	}) as typeof dialog.showMessageBox;
	let succeeded = false;
	try {
		await waitForLoad(window);
		await waitForRenderer(
			window,
			"document.body.dataset.phase === 'welcome'",
			'the instance welcome screen'
		);
		assert(
			!existsSync(join(homeDir, 'state')),
			'Welcome seeded the default home before selection.'
		);
		await assertRenderedFloor(window, 'instance welcome');
		const welcomeScreenshot = await capture(window, outputDir, '00-instance-welcome.png');
		await sizeViewport(window, 640, 640);
		await assertRenderedFloor(window, 'narrow instance welcome');
		const narrowWelcomeScreenshot = await capture(
			window,
			outputDir,
			'00b-instance-welcome-narrow.png'
		);
		await sizeViewport(window, 1120, 780);
		const originalPicker = dialog.showOpenDialog;
		const incompatibleHome = join(outputDir, 'legacy-instance');
		mkdirSync(otherHome);
		mkdirSync(incompatibleHome);
		writeFileSync(join(incompatibleHome, 'user-data'), 'preserve this');
		await window.webContents.executeJavaScript(
			"document.querySelector('#new-instance-details').open = true"
		);
		await assertRenderedFloor(window, 'create-instance folder form');
		const newInstanceScreenshot = await capture(window, outputDir, '00c-new-instance-folder.png');
		const suggestedHome = await window.webContents.executeJavaScript("document.querySelector('#new-instance-home').value");
		try {
			dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
			await window.webContents.executeJavaScript(
				"document.querySelector('#choose-instance').click()"
			);
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert(
				await window.webContents.executeJavaScript("document.body.dataset.phase === 'welcome'"),
				'Cancelled folder selection left welcome.'
			);
			await window.webContents.executeJavaScript(
				"document.querySelector('#new-instance-browse').click()"
			);
			await waitForRenderer(
				window,
				"document.body.dataset.busy === 'false'",
				'cancelled new-instance folder picker'
			);
			assert(
				await window.webContents.executeJavaScript(
					`document.querySelector('#new-instance-home').value === ${JSON.stringify(suggestedHome)} && document.body.dataset.phase === 'welcome'`
				),
				'Cancelling new-instance folder selection changed the selection.'
			);
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [incompatibleHome] });
			await window.webContents.executeJavaScript(
				"document.querySelector('#choose-instance').click()"
			);
			await waitForRenderer(
				window,
				"document.body.dataset.busy === 'false' && document.querySelector('#notice-message').textContent.includes('not a compatible fhold')",
				'incompatible folder rejection',
				10_000,
				true
			);
			assert(!existsSync(join(incompatibleHome, 'state')), 'Invalid folder was modified.');
			await window.webContents.executeJavaScript(`(() => {
				document.querySelector('#new-instance-home').value = ${JSON.stringify(incompatibleHome)};
				document.querySelector('#new-instance-form').requestSubmit();
			})()`);
			await waitForRenderer(
				window,
				"document.body.dataset.busy === 'false' && document.querySelector('#notice-message').textContent.includes('empty or new folder')",
				'new-instance populated-folder rejection',
				10_000,
				true
			);
			assert(
				readFileSync(join(incompatibleHome, 'user-data'), 'utf8') === 'preserve this' &&
					!existsSync(join(incompatibleHome, 'state')),
				'Creating a new instance touched a populated folder.'
			);
			await window.webContents.executeJavaScript(
				"document.querySelector('#dismiss-notice').click()"
			);
			await waitForRenderer(
				window,
				"document.querySelector('#notice').hidden",
				'the dismissed folder error',
				10_000
			);
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [otherHome] });
			await window.webContents.executeJavaScript(
				"document.querySelector('#new-instance-browse').click()"
			);
			await waitForRenderer(
				window,
				`document.body.dataset.busy === 'false' && document.querySelector('#new-instance-home').value === ${JSON.stringify(otherHome)}`,
				'the chosen new-instance folder'
			);
			assert(
				!existsSync(join(otherHome, 'state')),
				'Browsing installed the new instance before confirmation.'
			);
			await window.webContents.executeJavaScript(
				"document.querySelector('#new-instance-form').requestSubmit()"
			);
			await waitForRenderer(
				window,
				`document.body.dataset.phase === 'not_installed' && document.querySelector('#install-home').textContent === ${JSON.stringify(otherHome)}`,
				'the selected empty folder'
			);
			await window.webContents.executeJavaScript(
				"document.querySelector('#install-section [data-instance-switch]').click()"
			);
			await waitForRenderer(
				window,
				"document.body.dataset.phase === 'welcome' && document.querySelector('#open-recent-instance').textContent === 'Open previous instance'",
				'recent-instance welcome'
			);
			const preferences = readFileSync(join(app.getPath('userData'), 'instances.json'), 'utf8');
			assert(preferences.includes(otherHome), 'Recent instance was not persisted.');
			await window.webContents.executeJavaScript(
				"document.querySelector('#open-default-instance').click()"
			);
		} finally {
			dialog.showOpenDialog = originalPicker;
		}
		await waitForRenderer(
			window,
			"document.querySelector('#install-section')?.hidden === false && document.querySelector('#install')?.disabled === false",
			'the fresh-install screen'
		);
		progress('fresh-install screen loaded');
		const initialScreenshot = await capture(window, outputDir, '01-fresh-install.png');
		const automaticPorts = (await window.webContents.executeJavaScript(
			"!document.querySelector('#install-advanced').open && document.querySelector('#install-automatic-ports').checked && document.querySelector('#install-assistant-port').disabled && document.querySelector('#install-gateway-port').disabled"
		)) as boolean;
		assert(
			automaticPorts,
			'Fresh setup did not default to automatic ports under collapsed Advanced.'
		);
		assert(
			await window.webContents.executeJavaScript(
				"document.querySelector('#install').getBoundingClientRect().bottom <= innerHeight"
			),
			'Install button requires scrolling at the default window size.'
		);
		await assertRenderedFloor(window, 'fresh setup');
		assert(
			await window.webContents.executeJavaScript(`(() => {
				const name = document.querySelector('#install-instance-name');
				name.value = 'Invalid Name';
				document.querySelector('#install-form').requestSubmit();
				return name.validity.patternMismatch && document.body.dataset.busy !== 'true';
			})()`),
			'Invalid instance names were not blocked by browser form validation.'
		);
		assert(!existsSync(join(homeDir, 'state')), 'Invalid name validation materialized the home.');

		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('#install-instance-name').value = ${JSON.stringify(projectName)};
			document.querySelector('#install-advanced').open = true;
			document.querySelector('#install-automatic-ports').checked = false;
			document.querySelector('#install-automatic-ports').dispatchEvent(new Event('change'));
			document.querySelector('#install-assistant-port').value = ${JSON.stringify(String(assistantPort))};
			document.querySelector('#install-gateway-port').value = ${JSON.stringify(String(guardianPort))};
			})()`);
		const advancedPortsScreenshot = await capture(window, outputDir, '01a-advanced-ports.png');
		await window.webContents.executeJavaScript(
			"document.querySelector('#install-form').requestSubmit()"
		);
		const installLocked = (await window.webContents.executeJavaScript(
			"document.body.dataset.busy === 'true' && document.querySelector('#install').disabled"
		)) as boolean;
		assert(installLocked, 'Install did not lock duplicate operations while pending.');
		await waitForRenderer(
			window,
			`document.querySelector('#notice-message')?.textContent === 'fhold is installed. Next, connect your AI provider.' &&
					document.querySelector('#view-provider')?.hidden === false &&
					getComputedStyle(document.querySelector('#primary-nav')).display === 'none' &&
					[...document.querySelectorAll('#services .service')].some((row) =>
						row.textContent.includes('assistant') && row.textContent.includes('Running normally'))`,
			'the Assistant to become healthy'
		);
		progress('Assistant is healthy and provider setup is active');
		assert(
			JSON.parse(readFileSync(join(homeDir, 'state/stack.json'), 'utf8')).deployment.projectName ===
				projectName,
			'The E2E project intent was not persisted.'
		);
		if (ingressSubnet) {
			// Test-only override in this freshly installed disposable fixture, never product defaults.
			const overlay = join(homeDir, 'config/stack/custom.compose.yml');
			const seeded = readFileSync(overlay, 'utf8');
			assert(
				/\nservices: \{\}\s*$/.test(seeded) && !/^networks:/m.test(seeded),
				'Refusing to replace a non-seeded test overlay.'
			);
			writeFileSync(
				overlay,
				`${seeded}\nnetworks:\n  ingress_net:\n    ipam:\n      config:\n        - subnet: ${JSON.stringify(ingressSubnet)}\n`
			);
			progress(`test-only ingress subnet: ${ingressSubnet}; Compose validates the CIDR`);
		}
		const assistantScreenshot = await capture(window, outputDir, '02-provider-required.png');
		await assertRenderedFloor(window, 'provider setup');

		const sourceFixture = join(homeDir, '..', 'restore-source-fixture');
		const restoreFixture = join(homeDir, '..', 'restore-backup-fixture');
		await installFromAdmin(defaultStackConfig(sourceFixture), sourceFixture);
		writeFileSync(join(sourceFixture, 'knowledge/restore-test.md'), 'synthetic preservation test');
		writeFileSync(join(sourceFixture, 'data/assistant/runtime-artifact'), 'not portable');
		await createBackup({ sourceHome: sourceFixture, destination: restoreFixture });
		await waitForRenderer(
			window,
			"(await import('./state.js')).state.providersLoaded && !(await import('./state.js')).state.providerLoadPromise && document.body.dataset.busy !== 'true'",
			'initial provider discovery and automatic readiness',
			240_000
		);
		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('.restore-panel').open = true;
			const input=document.querySelector('#restore-source');
			input.value=${JSON.stringify(restoreFixture)};
			input.dispatchEvent(new Event('input',{bubbles:true}));
			document.querySelector('#preview-restore').click();
		})()`);
		await waitForRenderer(
			window,
			"document.body.dataset.busy !== 'true' && !document.querySelector('#restore-acknowledge-row').hidden && document.querySelector('#apply-restore').disabled",
			'restore omissions and acknowledgement gate'
		);
		assert(
			await window.webContents.executeJavaScript(
				"document.querySelector('#restore-preservation').textContent.includes('Native history')"
			),
			'Restore history omission was hidden in technical details.'
		);
		await window.webContents.executeJavaScript(
			"document.querySelector('#restore-acknowledge').click()"
		);
		assert(
			await window.webContents.executeJavaScript(
				"!document.querySelector('#apply-restore').disabled"
			),
			'Reviewed omission acknowledgement did not allow the portable copy.'
		);
		await window.webContents.executeJavaScript(
			"document.querySelector('.restore-panel').scrollIntoView({block:'start'})"
		);
		const restoreScreenshot = await capture(
			window,
			outputDir,
			'02c-restore-preservation.png',
			true
		);
		await waitForRenderer(
			window,
			"document.body.dataset.busy !== 'true' && !document.querySelector('#apply-restore').disabled",
			'reviewed restore action to be available'
		);
		await window.webContents.executeJavaScript(
			"window.confirm = () => true; document.querySelector('#apply-restore').click()"
		);
		await waitForRenderer(
			window,
			"document.body.dataset.busy !== 'true' && document.querySelector('#restore-summary').textContent.includes('does not restore native conversations')",
			'verified portable restore receipt'
		);
		assert(
			readFileSync(join(homeDir, 'knowledge/restore-test.md'), 'utf8') ===
				'synthetic preservation test',
			'Portable restore did not preserve fixture content.'
		);
		assert(
			!existsSync(join(homeDir, 'data/assistant/runtime-artifact')),
			'Portable restore activated an old runtime artifact.'
		);
		await window.webContents.executeJavaScript(
			"document.querySelector('.restore-panel').open = false"
		);
		progress('restore preservation preview, acknowledgement and verified portable copy passed');
		await waitForRenderer(
			window,
			"!(await import('./state.js')).state.providerLoadPromise && document.body.dataset.busy !== 'true'",
			'provider discovery after restore'
		);

		await runAdminAction('stop');
		await window.webContents.executeJavaScript("document.querySelector('#refresh').click()");
		await waitForRenderer(
			window,
			`document.querySelector('#setup-recovery')?.hidden === false &&
					document.querySelector('#recovery-assistant-port')?.value === ${JSON.stringify(String(assistantPort))}`,
			'the visible startup recovery controls'
		);
		const recoveryScreenshot = await capture(window, outputDir, '02b-startup-recovery.png');
		assert(
			await window.webContents.executeJavaScript(
				"document.querySelector('#provider-connection').hidden && !/running locally/.test(document.querySelector('#setup-runtime').textContent)"
			),
			'Recovery contradicts the agent status.'
		);
		confirmations.push(1);
		await window.webContents.executeJavaScript(
			"document.querySelector('#recovery-form').requestSubmit()"
		);
		await waitForRenderer(
			window,
			`document.querySelector('#notice-message')?.textContent === 'fhold started. Saved settings applied.' &&
					document.querySelector('#setup-recovery')?.hidden === true &&
					[...document.querySelectorAll('#services .service')].some((row) => row.textContent.includes('Running normally'))`,
			'the Assistant to recover through setup'
		);
		progress('visible startup recovery passed');
		window.setSize(640, 720);
		await new Promise((resolve) => setTimeout(resolve, 300));
		await assertRenderedFloor(window, 'provider setup at minimum width');
		window.webContents.setZoomFactor(2);
		await new Promise((resolve) => setTimeout(resolve, 300));
		await assertRenderedFloor(window, 'provider setup at 200% zoom');
		assert(
			await window.webContents.executeJavaScript(
				"document.querySelector('.sidebar').getBoundingClientRect().height < 70 && document.querySelector('#provider-connection').getBoundingClientRect().top < innerHeight * 0.65"
			),
			'Setup chrome crowds out the account form at 200% zoom.'
		);
		const reflowScreenshot = await capture(window, outputDir, '03-provider-reflow.png');
		window.webContents.setZoomFactor(1);
		window.setSize(1120, 780);
		await new Promise((resolve) => setTimeout(resolve, 300));

		await window.webContents.executeJavaScript("document.querySelector('#load-providers').click()");
		await waitForRenderer(
			window,
			"document.querySelector('#provider-result')?.value.trim().startsWith('[')",
			'OpenCode provider discovery',
			60_000
		);
		const providerCatalog = (await window.webContents.executeJavaScript(
			"JSON.parse(document.querySelector('#provider-result').value)"
		)) as Array<Record<string, unknown>>;
		progress(`OpenCode discovered ${providerCatalog.length} providers`);
		// Discovery can launch an automatic existing-sign-in check. Wait for it before
		// submitting another operation through the deliberately locked setup form.
		await waitForRenderer(
			window,
			"document.body.dataset.busy !== 'true'",
			'the existing-sign-in check to finish',
			180_000,
			true
		);

		let readiness: Record<string, unknown> = { attempted: false };
		const providerPickerScreenshot = await capture(window, outputDir, '03a-provider-picker.png');
		let readyScreenshot: string | undefined;
		if (provider && providerKey) {
			readiness = await connectProviderUi(window, provider, providerKey);
			progress('provider readiness passed');
			readyScreenshot = await capture(window, outputDir, '04-agent-ready.png');
		} else {
			await window.webContents.executeJavaScript(`(() => {
				const provider = document.querySelector('#provider');
				if (!provider.value) {
					if (!document.querySelector('#test-provider').hidden) throw new Error('Verification appears before choosing a provider.');
					provider.value = [...provider.options].find(option => option.value === 'anthropic')?.value || [...provider.options].find(option => option.value)?.value;
					provider.dispatchEvent(new Event('change', { bubbles: true }));
				}
				if (document.querySelector('#test-provider').hidden) throw new Error('Verification is unavailable after provider selection.');
				if (!document.querySelector('#test-provider').disabled) document.querySelector('#test-provider').click();
			})()`);
			await waitForRenderer(
				window,
				`document.querySelector('#notice')?.hidden === true &&
						document.querySelector('#provider-status')?.classList.contains('error') &&
						document.querySelector('#view-provider')?.hidden === false`,
				'a truthful provider-required error',
				60_000,
				true
			);
			readiness = (await window.webContents.executeJavaScript(
				"JSON.parse(document.querySelector('#provider-result').value)"
			)) as Record<string, unknown>;
			assert(
				readiness.ok === false,
				`Expected provider readiness to fail: ${JSON.stringify(readiness)}`
			);
			progress('provider failure remained an incomplete setup error');
			markInstalled(homeDir);
			await window.webContents.executeJavaScript("document.querySelector('#refresh').click()");
			await waitForRenderer(
				window,
				`document.querySelector('#view-overview')?.hidden === false &&
						document.querySelector('#primary-nav')?.hidden === false &&
						document.querySelector('#refresh')?.dataset.state === 'current'`,
				'the isolated management UI fixture',
				60_000,
				true
			);
			progress('entered ready management UI through an explicit test-only fixture');
		}

		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('#dismiss-notice').click();
			document.querySelector('[data-view=connections]').click();
			document.querySelector('#native-connections > summary').click();
			document.querySelector('[data-remote-enable=codex]').focus();
			document.querySelector('[data-remote-enable=codex]').click();
			if (!document.querySelector('#remote-dialog').open) throw new Error('Remote setup dialog did not open.');
			if (document.querySelector('#remote-trust').checked) throw new Error('Native trust was preaccepted.');
			if (document.querySelector('#remote-sandbox-field').hidden) throw new Error('Codex sandbox choice is missing.');
			if (document.querySelector('#remote-advanced').open || document.querySelector('#remote-sandbox').value !== 'workspace-write') throw new Error('Safe sandbox default is not tucked into Advanced settings.');
			if (!document.querySelector('#remote-send').hidden) throw new Error('An irrelevant native answer control is exposed before setup.');
			const isolation = document.querySelector('#remote-sandbox');
			if (![...isolation.options].some(option => option.value === 'danger-full-access' && /container isolation/i.test(option.textContent))) throw new Error('Explicit container isolation is unavailable.');
			isolation.value = 'danger-full-access';
			isolation.dispatchEvent(new Event('change'));
			if (!document.querySelector('#remote-sandbox-help').textContent.includes('every file, credential')) throw new Error('Full container access warning is missing.');
			if (document.querySelector('#remote-trust').checked) throw new Error('Selecting container isolation preaccepted trust.');
			isolation.value = 'workspace-write';
			isolation.dispatchEvent(new Event('change'));
		})()`);
		await waitForRenderer(
			window,
			`document.querySelector('#remote-recall-status')?.textContent === 'Managed · ready' && document.querySelector('#remote-recall').disabled`,
			'native AKM hook review',
			60_000,
			!provider
		);
		assert(
			await window.webContents.executeJavaScript(
				"document.querySelector('#remote-recall').checked && !document.querySelector('#remote-recall-field').hidden"
			),
			'Managed recall was not reported as operator-controlled in Codex setup.'
		);
		await assertRenderedFloor(window, 'native remote setup dialog');
		const nativeRemoteScreenshot = await capture(window, outputDir, '04-native-remote-setup.png');
		await sizeViewport(window, 640, 640, 2);
		await assertRenderedFloor(window, 'native consent at 200%');
		for (const consentId of ['remote-trust', 'remote-recall']) {
			await window.webContents.executeJavaScript(
				`document.querySelector('#${consentId}').closest('label').scrollIntoView({block:'start'})`
			);
			assert(
				await window.webContents.executeJavaScript(`(() => {
				const label = document.querySelector('#${consentId}').closest('label').getBoundingClientRect();
				const dialog = document.querySelector('#remote-dialog').getBoundingClientRect();
				const footer = document.querySelector('#remote-form > .button-row');
				return label.top >= dialog.top && label.bottom <= dialog.bottom &&
					getComputedStyle(footer).position === 'static' && footer.getBoundingClientRect().top >= label.bottom;
			})()`),
				`${consentId} consent is obscured by dialog actions at 200% zoom.`
			);
		}
		const narrowConsentScreenshot = await capture(
			window,
			outputDir,
			'04j-native-consent-reflow.png'
		);
		await window.webContents.executeJavaScript(
			"document.querySelector('#remote-begin').scrollIntoView({block:'end'})"
		);
		assert(
			await window.webContents.executeJavaScript(`(() => {
				const dialog = document.querySelector('#remote-dialog').getBoundingClientRect();
				return ['remote-begin','remote-cancel'].every(id => {
					const rect = document.getElementById(id).getBoundingClientRect();
					return rect.top >= dialog.top && rect.bottom <= dialog.bottom && rect.height >= 44;
				});
			})()`),
			'Consent actions cannot both be reached at 200% zoom.'
		);
		const narrowConsentActionsScreenshot = await capture(
			window,
			outputDir,
			'04m-native-consent-actions.png'
		);
		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('#remote-advanced').open = true;
			const isolation = document.querySelector('#remote-sandbox');
			isolation.value = 'danger-full-access';
			isolation.dispatchEvent(new Event('change'));
			isolation.scrollIntoView({block:'center'});
		})()`);
		await assertRenderedFloor(window, 'container isolation choice at 200%');
		const narrowIsolationScreenshot = await capture(
			window,
			outputDir,
			'04n-native-container-isolation.png'
		);
		await window.webContents.executeJavaScript(`(() => {
			const isolation = document.querySelector('#remote-sandbox');
			isolation.value = 'workspace-write';
			isolation.dispatchEvent(new Event('change'));
			document.querySelector('#remote-advanced').open = false;
		})()`);
		await sizeViewport(window, 1120, 780);
		window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
		window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
		await waitForRenderer(
			window,
			"!document.querySelector('#remote-dialog').open && document.activeElement?.dataset.remoteEnable === 'codex'",
			'Escape closes consent and restores trigger focus',
			10_000,
			true
		);
		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('[data-remote-enable=claude]').click();
			if (!document.querySelector('#remote-sandbox-field').hidden) throw new Error('Codex-only sandbox option appears for Claude.');
			document.querySelector('#remote-cancel').click();
		})()`);
		progress(
			'native remote setup opens from Admin with explicit trust and safe sandbox choices; no subscription login was performed'
		);
		const remoteStartupBeforeRecall = (await adminSnapshot()).config.assistant.codexRemote;
		await window.webContents.executeJavaScript(
			"document.querySelector('[data-codex-recall-review]').click()"
		);
		await waitForRenderer(
			window,
			"document.querySelector('#remote-recall').disabled && document.querySelector('#remote-recall-status').textContent === 'Managed · ready'",
			'standalone native recall review',
			60_000,
			!provider
		);
		await window.webContents.executeJavaScript(`(async () => {
			const review = await window.fholdAdmin.codexRecall({action:'review'});
			if (!review.managed || review.status !== 'ready') throw new Error('Managed recall was not ready.');
			for (const action of ['approve', 'disable']) {
				let rejected = false;
				try { await window.fholdAdmin.codexRecall({action,digest:review.digest,confirmed:true}); } catch { rejected = true; }
				if (!rejected) throw new Error('Personal approval changed managed hooks.');
			}
		})()`);
		const recallScreenshot = await capture(window, outputDir, '04a-codex-knowledge-recall.png');
		await window.webContents.executeJavaScript("document.querySelector('#remote-cancel').click()");
		await runAdminAction('restart');
		await window.webContents.executeJavaScript("document.querySelector('#refresh').click()");
		await waitForRenderer(
			window,
			"document.querySelector('#codex-recall-status').textContent === 'Not checked' && document.querySelector('#refresh').dataset.state === 'current'",
			'read-only refresh clears the prior explicit recall review',
			60_000,
			!provider
		);
		const recallSnapshot = await adminSnapshot();
		assert(
			recallSnapshot.codexRecall === undefined &&
				recallSnapshot.config.assistant.codexRemote === remoteStartupBeforeRecall,
			'Status implicitly reviewed native hooks or enabled remote startup.'
		);
		await window.webContents.executeJavaScript(
			"document.querySelector('[data-codex-recall-review]').click()"
		);
		await waitForRenderer(
			window,
			"document.querySelector('#remote-recall-disable').hidden && document.querySelector('#remote-recall').disabled && document.querySelector('#remote-recall-status').textContent === 'Managed · ready' && document.querySelector('#codex-recall-status').textContent === 'Managed · ready'",
			'explicit native review verifies managed recall persisted after recreation',
			60_000,
			!provider
		);
		await window.webContents.executeJavaScript("document.querySelector('#remote-cancel').click()");
		progress(
			'managed AKM recall stayed ready across recreation without personal approval, remote startup or vendor login'
		);
		await window.webContents.executeJavaScript(
			"document.querySelector('#native-connections').open = false"
		);
		await window.webContents.executeJavaScript(
			"document.querySelector('[data-view=overview]').click()"
		);
		const overviewScreenshot = await capture(window, outputDir, '04b-overview.png');
		const sidebarScreenshots = await verifySidebar(window, outputDir);
		assert(
			await window.webContents.executeJavaScript(
				"document.querySelector('#stop-stack').getBoundingClientRect().bottom < innerHeight && !document.querySelector('#starter-heading') && !document.querySelector('.choice-grid')"
			),
			'Overview still crowds out service controls or duplicates the connection catalog.'
		);
		await assertRenderedFloor(window, 'overview');
		assert(
			await window.webContents.executeJavaScript(
				"document.querySelector('#view-title').focus(); getComputedStyle(document.querySelector('#view-title')).outlineStyle === 'none'"
			),
			'Programmatically focused headings have a decorative outline.'
		);
		await window.webContents.executeJavaScript(
			"document.querySelector('[data-view=connections]').click()"
		);
		const connectionsScreenshot = await capture(window, outputDir, '04c-connections.png');
		await assertRenderedFloor(window, 'connections');
		assert(
			await window.webContents.executeJavaScript(`(() => {
			return !document.querySelector('#native-connections').open && !document.querySelector('#portal-tokens').open &&
				document.querySelector('#direct-url').tagName === 'A' &&
				document.querySelector('#direct-url').href === document.querySelector('#overview-opencode-link').href &&
				getComputedStyle(document.querySelector('[data-client-setup][aria-pressed="true"]')).backgroundColor !== getComputedStyle(document.querySelector('.primary-link')).backgroundColor;
		})()`),
			'Optional connections are not collapsed, OpenCode links disagree, or client selection looks like a primary action.'
		);
		await window.webContents.executeJavaScript(
			"document.querySelector('[data-view=system]').click()"
		);
		assert(
			await window.webContents.executeJavaScript(`(() => {
				const cards = [...document.querySelectorAll('#view-system > details')];
				return cards.map(card => card.id).join(',') === 'installation-details,recent-logs,import-export,runtime-recovery' &&
					cards.every(card => !card.open) &&
					cards[2].querySelector('summary').textContent.startsWith('Import / export') &&
					cards[3].querySelector('summary').textContent.startsWith('Ephemeral container support');
			})()`),
			'System sections are not in the requested order, collapsed by default, or consistently named.'
		);
		await assertRenderedFloor(window, 'System section order');
		const systemScreenshot = await capture(window, outputDir, '04k-system.png');
		await window.webContents.executeJavaScript(
			"document.querySelector('#import-export').open=true; document.querySelector('#import-export').scrollIntoView({block:'start'})"
		);
		await assertRenderedFloor(window, 'import and export');
		const backupScreenshot = await capture(window, outputDir, '04d-backup.png');
		await window.webContents.executeJavaScript(
			"document.querySelector('#import-export').open=false; document.querySelector('#installation-details').open=true; document.querySelector('#installation-details').scrollIntoView({block:'start'})"
		);
		await assertRenderedFloor(window, 'troubleshooting');
		const troubleshootingScreenshot = await capture(window, outputDir, '04e-troubleshooting.png');
		assert(
			await window.webContents.executeJavaScript(`(() => {
				const link = document.querySelector('#assistant-url-detail');
				return link?.tagName === 'A' && link.href === 'http://127.0.0.1:${assistantPort}/' &&
					link.tabIndex === 0 &&
					document.querySelector('label[for="gateway-bind"]')?.textContent.includes('Guardian MCP') &&
					document.querySelector('#guardian-mcp-url-detail')?.textContent === 'http://127.0.0.1:${guardianPort}/mcp' &&
					document.querySelector('#guardian-health-url-detail')?.textContent === 'http://127.0.0.1:${guardianPort}/health';
			})()`),
			'Network details omitted clear MCP endpoints or a keyboard-accessible OpenCode link.'
		);
		const openedUrls: string[] = [];
		const originalOpenExternal = shell.openExternal;
		const adminPageUrl = window.webContents.getURL();
		// Exercise a normal link through Electron's existing window opener;
		// intercept only the OS browser launch.
		shell.openExternal = async (url) => {
			openedUrls.push(url);
		};
		const waitForBrowserOpen = async (count: number) => {
			const deadline = Date.now() + 10_000;
			while (openedUrls.length < count && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert(openedUrls.length === count, 'OpenCode link did not dispatch to the browser.');
		};
		try {
			await window.webContents.executeJavaScript(
				"document.querySelector('#assistant-url-detail').focus()"
			);
			window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
			window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
			await waitForBrowserOpen(1);
			await window.webContents.executeJavaScript(
				"document.querySelector('#assistant-url-detail').click()"
			);
			await waitForBrowserOpen(2);
			assert(
				openedUrls.length === 2 &&
					openedUrls.every((url) => url === `http://127.0.0.1:${assistantPort}/`),
				'OpenCode link did not open the displayed address.'
			);
			assert(
				await window.webContents.executeJavaScript(
					"window.fholdAdmin.openExternal('file:///tmp/private').then(() => false, () => true)"
				),
				'Browser dispatch accepted a non-web URL.'
			);
			assert(
				window.webContents.getURL() === adminPageUrl,
				'OpenCode link navigated the Admin renderer.'
			);
		} finally {
			shell.openExternal = originalOpenExternal;
		}
		progress('MCP details and normal OpenCode link verified with real keyboard/click events');
		await window.webContents.executeJavaScript(
			"document.querySelector('[data-view=provider]').click()"
		);

		const containerId = async () => {
			const result = await runDocker(['inspect', '--format', '{{.Id}}', `${projectName}-assistant-1`]);
			assert(result.ok, 'Could not inspect the isolated Assistant.');
			return result.stdout.trim();
		};
		const runtimeSettings = async () => {
			const result = await runDocker(['exec', `${projectName}-assistant-1`, 'printenv', 'TZ', 'FH_AUTOMATIC_MEMORY']);
			assert(result.ok, 'Could not read non-secret runtime settings.');
			return result.stdout.trim();
		};
		const beforeDeferredSave = { id: await containerId(), settings: await runtimeSettings() };
		const sizeBeforeSave = window.getSize();
		confirmations.push(0);
		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('#agent-preferences > summary').click();
			document.querySelector('#agent-timezone').value = 'Europe/London';
			document.querySelector('#automatic-memory').checked = false;
			document.querySelector('#agent-timezone').dispatchEvent(new Event('input', { bubbles: true }));
			document.querySelector('#preferences-form').requestSubmit();
		})()`);
		await waitForRenderer(
			window,
			`document.querySelector('#notice-message')?.textContent === 'Agent preferences saved.' &&
				document.body.dataset.busy !== 'true' && !document.querySelector('#pending-restart').hidden &&
				document.querySelector('#agent-timezone')?.value === 'Europe/London' &&
				document.querySelector('#automatic-memory')?.checked === false`,
			'agent preferences saved without restarting'
		);
		assert(await containerId() === beforeDeferredSave.id, 'Postponed save recreated Assistant.');
		assert(await runtimeSettings() === beforeDeferredSave.settings, 'Postponed save applied runtime settings.');
		assert((await adminSnapshot()).pendingRestart?.required, 'Pending state was not saved with the instance.');
		await window.webContents.executeJavaScript("document.querySelector('.sidebar [data-instance-switch]').click()");
		await waitForRenderer(window, "document.body.dataset.phase === 'welcome'", 'return to Welcome with saved changes');
		await window.webContents.executeJavaScript("document.querySelector('#open-recent-instance').click()");
		await waitForRenderer(window, "document.body.dataset.phase === 'ready' && !document.querySelector('#pending-restart').hidden", 'pending restart after reopening the instance');
		assert(JSON.stringify(window.getSize()) === JSON.stringify(sizeBeforeSave), 'Saving/reopening changed the user window size.');
		const pendingRestartScreenshot = await capture(window, outputDir, '04o-pending-restart.png');
		confirmations.push(1);
		await window.webContents.executeJavaScript("document.querySelector('#apply-pending-restart').click()");
		await waitForRenderer(window,
			"document.body.dataset.busy !== 'true' && document.querySelector('#pending-restart').hidden && document.querySelector('#notice-message').textContent === 'fhold restarted. Saved settings applied.'",
			'confirmed restart applies saved settings');
		assert(await containerId() !== beforeDeferredSave.id, 'Confirmed apply did not recreate Assistant.');
		assert(await runtimeSettings() === 'Europe/London\n0', 'Recreated Assistant did not load saved settings.');
		assert(!(await adminSnapshot()).pendingRestart?.required, 'Successful apply left a pending alert.');
		progress('defer, reopen, persistent alert and confirmed apply verified against real container ID and settings');
		await window.webContents.executeJavaScript("document.querySelector('[data-view=provider]').click(); document.querySelector('#agent-preferences').open = true");
		await window.webContents.executeJavaScript("document.querySelector('#dismiss-notice').click()");
		const agentSettingsScreenshot = await capture(window, outputDir, '04i-agent-settings.png');

		await window.webContents.executeJavaScript(
			"document.querySelector('[data-view=connections]').click(); document.querySelector('[data-client-setup=opencode]').click()"
		);
		await waitForRenderer(
			window,
			`document.querySelector('#view-connections')?.hidden === false &&
					document.querySelector('#client-opencode')?.hidden === false &&
					document.querySelector('#direct-url')?.textContent.startsWith('http://') &&
					document.querySelector('#direct-username')?.textContent === 'user'`,
			'the complete OpenCode connection recipe'
		);
		await window.webContents.executeJavaScript(`(() => {
			window.confirm = () => true;
			document.querySelector('#load-direct-password').click();
		})()`);
		await waitForRenderer(
			window,
			"document.querySelector('#direct-password')?.value.length >= 32",
			'the explicit OpenCode password reveal'
		);
		await window.webContents.executeJavaScript(
			"document.querySelector('[data-client-setup=claude]').click()"
		);
		const claudeRecipe = (await window.webContents.executeJavaScript(`(() => ({
			url: document.querySelector('#claude-url')?.textContent,
			credential: document.querySelector('#claude-credential')?.value,
			extension: document.querySelector('#claude-extension-help')?.textContent,
			download: document.querySelector('#claude-extension-download')?.getAttribute('href'),
			downloadHidden: document.querySelector('#claude-extension-download')?.hidden
		}))()`)) as {
			url?: string;
			credential?: string;
			extension?: string;
			download?: string;
			downloadHidden?: boolean;
		};
		assert(claudeRecipe.url?.endsWith('/mcp'), 'Claude recipe omitted the MCP endpoint.');
		assert(claudeRecipe.credential === 'owner', 'Claude recipe omitted its access identity.');
		assert(
			claudeRecipe.extension?.includes('matching GitHub release') &&
				claudeRecipe.download?.startsWith('https://github.com/fwdslsh/fhold/releases/download/') &&
				claudeRecipe.download.endsWith('.mcpb') &&
				claudeRecipe.downloadHidden === false,
			'Claude recipe omitted the matching public extension download.'
		);
		await assertRenderedFloor(window, 'Claude Desktop recipe');
		const claudeScreenshot = await capture(window, outputDir, '04f-claude-desktop.png');
		await window.webContents.executeJavaScript(
			"document.querySelector('[data-client-setup=mcp]').click()"
		);
		assert(
			(await window.webContents.executeJavaScript(
				"document.querySelector('#mcp-url')?.textContent.endsWith('/mcp') && document.querySelector('#mcp-credential')?.value === 'owner'"
			)) as boolean,
			'The generic MCP recipe was incomplete.'
		);
		progress('all three complete client connection recipes rendered');
		await assertRenderedFloor(window, 'MCP connection recipe');
		const mcpScreenshot = await capture(window, outputDir, '04g-mcp.png');
		await sizeViewport(window, 640, 640, 2);
		await keyboardNavigation(window);
		await assertRenderedFloor(window, 'MCP recipe at minimum size and 200% zoom');
		const narrowMcpScreenshot = await capture(window, outputDir, '04h-mcp-reflow.png');
		await sizeViewport(window, 1120, 780);

		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('#discord').checked = true;
			document.querySelector('#discord').dispatchEvent(new Event('change', { bubbles: true }));
			document.querySelector('#connections-form').requestSubmit();
		})()`);
		await waitForRenderer(
			window,
			`document.querySelector('#notice')?.classList.contains('error') &&
					document.querySelector('#discord-access-disclosure')?.open === true &&
					document.activeElement?.id === 'discord-users'`,
			'the Discord access-scope guidance',
			10_000,
			true
		);
		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('#discord-users').value = '123456789012345678';
			document.querySelector('#discord-users').dispatchEvent(new Event('input', { bubbles: true }));
			document.querySelector('#connections-form').requestSubmit();
		})()`);
		await waitForRenderer(
			window,
			`document.querySelector('#notice-message')?.textContent === 'Store a Discord bot token before enabling Discord.' &&
					document.querySelector('#token-portal')?.value === 'discord' &&
					document.querySelector('#portal-tokens')?.open === true &&
					document.activeElement?.id === 'bot-token'`,
			'the Discord private-token guidance',
			10_000,
			true
		);
		progress('portal setup errors opened and focused the required controls');
		await window.webContents.executeJavaScript(
			"document.querySelector('#dismiss-notice').click(); document.querySelector('#chat-apps').scrollIntoView({block:'start'})"
		);
		const chatAppsScreenshot = await capture(window, outputDir, '04l-chat-apps.png', true);
		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('#discord').checked = false;
			document.querySelector('#discord-users').value = '';
			document.querySelector('#discord').dispatchEvent(new Event('change', { bubbles: true }));
		})()`);

		confirmations.push(1);
		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('#gateway').checked = true;
			document.querySelector('#gateway').dispatchEvent(new Event('change', { bubbles: true }));
			document.querySelector('#connections-form').requestSubmit();
		})()`);
		await waitForRenderer(
			window,
			`document.querySelector('#notice-message')?.textContent === 'fhold restarted. Saved settings applied.' &&
					[...document.querySelectorAll('#services .service')].some((row) =>
						row.textContent.includes('guardian') && row.textContent.includes('Running normally'))`,
			'the Guardian to become healthy'
		);
		progress('Guardian is healthy');

		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('[data-view=access]').click();
			document.querySelector('#create-credential').open=true;
			document.querySelector('#credential-username').value = 'e2e-reader';
			document.querySelector('#credential-policy').value = 'read';
			document.querySelector('#credential-form').requestSubmit();
		})()`);
		await waitForRenderer(
			window,
			`document.querySelector('#notice-message')?.textContent.includes('Access for e2e-reader created.') &&
					[...document.querySelectorAll('#credential-action-name option')].some((option) => option.value === 'e2e-reader')`,
			'the read credential to be created'
		);
		progress('read credential created');

		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('#chat-user-access > summary').click();
			document.querySelector('#mapping-portal').value = 'discord';
			document.querySelector('#mapping-user').value = '123456789012345678';
			document.querySelector('#mapping-credential').value = 'e2e-reader';
			document.querySelector('#mapping-form').requestSubmit();
		})()`);
		await waitForRenderer(
			window,
			`document.querySelector('#notice-message')?.textContent === 'Individual user access saved.' &&
					document.querySelector('#mappings').textContent.includes('e2e-reader')`,
			'the Discord identity mapping to persist'
		);
		progress('Discord identity mapping persisted');
		const guardianScreenshot = await capture(window, outputDir, '05-people-access.png');
		await sizeViewport(window, 640, 640);
		await assertRenderedFloor(window, 'people and access at minimum size');
		const narrowAccessScreenshot = await capture(window, outputDir, '05a-people-access-narrow.png');
		const keyboardScreenshot = await capture(window, outputDir, '05b-keyboard-focus.png', true);
		await sizeViewport(window, 1120, 780);

		confirmations.push(1);
		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('[data-view=overview]').click();
			document.querySelector('[data-action=restart]').click();
		})()`);
		await waitForRenderer(
			window,
			`document.querySelector('#notice-message')?.textContent === 'fhold restarted. Saved settings applied.' &&
					document.querySelectorAll('#services .service').length === 2 &&
					[...document.querySelectorAll('#services .service')].every((row) => row.textContent.includes('Running normally'))`,
			'a healthy stack restart'
		);
		progress('stack restart passed');

		const reloaded = new Promise<void>((resolve, reject) => {
			window.webContents.once('did-finish-load', () => resolve());
			window.webContents.once('did-fail-load', (_event, code, description) => {
				reject(new Error(`Admin renderer failed to reload (${code}): ${description}`));
			});
		});
		window.webContents.reload();
		await reloaded;
		await waitForRenderer(
			window,
			`document.querySelector('#install-section')?.hidden === true &&
					document.querySelector('#app-shell')?.hidden === false &&
					document.querySelector('#assistant-port')?.value === ${JSON.stringify(String(assistantPort))} &&
				document.querySelector('#gateway-port')?.value === ${JSON.stringify(String(guardianPort))} &&
				document.querySelector('#agent-timezone')?.value === 'Europe/London' &&
				document.querySelector('#automatic-memory')?.checked === false &&
				document.querySelector('#mappings')?.textContent.includes('e2e-reader')`,
			'persistent configuration after renderer reload'
		);
		progress('renderer reload preserved configuration');

		const guardianUrl = `http://127.0.0.1:${guardianPort}`;
		const health = await fetch(`${guardianUrl}/health`, { signal: AbortSignal.timeout(5_000) });
		assert(health.ok, `Guardian health returned HTTP ${health.status}.`);
		const initialize = {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'fhold-admin-e2e', version: '1' }
			}
		};
		const unauthorized = await guardianRequest(`${guardianUrl}/mcp`, initialize);
		assert(unauthorized.status === 401, `Unauthenticated MCP returned ${unauthorized.status}.`);
		const key = readFileSync(
			join(homeDir, 'state', 'credentials', 'e2e-reader', 'key'),
			'utf8'
		).trim();
		const authorized = await guardianRequest(`${guardianUrl}/mcp`, initialize, key);
		assert(
			authorized.status === 200,
			`Authenticated MCP initialize returned ${authorized.status}.`
		);
		const listed = await guardianRequest(
			`${guardianUrl}/mcp`,
			{ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
			key
		);
		assert(listed.status === 200, `Authenticated MCP tools/list returned ${listed.status}.`);
		const tools = toolNames(listed.payload);
		assert(
			tools.includes('fhold.workspace.read'),
			'The read policy did not expose workspace.read.'
		);
		assert(
			!tools.includes('fhold.session.delete'),
			'The read policy exposed full-only session.delete.'
		);
		progress('Guardian authentication and read-policy MCP catalog passed');
		let providerRuntime: Record<string, unknown> | undefined;
		if (provider) {
			const native = await testAssistantReadiness(homeDir);
			assert(native.ok, 'The installed default provider failed a real request after restart.');
			let response = await guardianRequest(
				`${guardianUrl}/mcp`,
				{
					jsonrpc: '2.0',
					id: 3,
					method: 'tools/call',
					params: {
						name: 'fhold.agent.run',
						arguments: {
							message: 'Reply with exactly FH_MCP_READY. Do not use any tools.',
							waitMs: 30_000
						}
					}
				},
				key,
				45_000
			);
			const output = (rpc: typeof response): Record<string, unknown> => {
				assert(rpc.status === 200 && !rpc.payload?.error, 'The live MCP request failed.');
				const result = rpc.payload?.result as Record<string, unknown> | undefined;
				assert(result && !result.isError, 'Guardian rejected the live MCP request.');
				return result.structuredContent as Record<string, unknown>;
			};
			let result = output(response);
			const deadline = Date.now() + 120_000;
			while (result.status === 'running' && Date.now() < deadline) {
				response = await guardianRequest(
					`${guardianUrl}/mcp`,
					{
						jsonrpc: '2.0',
						id: 4,
						method: 'tools/call',
						params: {
							name: 'fhold.job.get',
							arguments: { job: result.job, waitMs: 30_000 }
						}
					},
					key,
					45_000
				);
				result = output(response);
			}
			assert(
				result.status === 'completed' && String(result.text).includes('FH_MCP_READY'),
				'The installed agent did not complete a real MCP response after restart.'
			);
			providerRuntime = {
				nativeDefaultVerified: true,
				provider: native.provider,
				model: native.model,
				mcpAgentVerified: true
			};
			progress('installed default provider and live MCP agent response passed after restart');
		}

		const savedPreferences = await adminSnapshot();
		assert(
			savedPreferences.config.assistant.timezone === 'Europe/London' &&
				savedPreferences.config.assistant.automaticMemory === false,
			'Agent preferences were not persisted after restart and renderer reload.'
		);
		confirmations.push(1);
		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('[data-view=overview]').click();
			document.querySelector('#automatic-memory').checked = true;
			document.querySelector('#automatic-memory').dispatchEvent(new Event('change', { bubbles: true }));
			document.querySelector('#preferences-form').requestSubmit();
		})()`);
		await waitForRenderer(
			window,
			`document.querySelector('#notice-message')?.textContent === 'fhold restarted. Saved settings applied.' &&
				document.querySelector('#automatic-memory')?.checked === true &&
				[...document.querySelectorAll('#services .service')].every((row) => row.textContent.includes('Running normally'))`,
			'automatic memory to be restored for runtime acceptance'
		);
		progress('automatic memory re-enabled after verifying the persisted opt-out');
		const finalSnapshot = await adminSnapshot();
		assert(finalSnapshot.config.gateway.enabled, 'Guardian configuration was not persisted.');
		assert(finalSnapshot.config.assistant.automaticMemory, 'Automatic memory was not restored.');
		assert(
			finalSnapshot.portalMappings.discord?.users['123456789012345678'] === 'e2e-reader',
			'Discord credential mapping was not persisted.'
		);
		const originalConfig = readFileSync(join(homeDir, 'state', 'stack.json'), 'utf8');
		const managedWindowSize = window.getSize();
		await window.webContents.executeJavaScript(`(() => {
			window.confirm = () => true;
			document.querySelector('#provider-key').value = 'transient-key-must-not-survive';
			document.querySelector('#credential-key').value = 'transient-credential-must-not-survive';
			document.querySelector('.sidebar [data-instance-switch]').click();
		})()`);
		await waitForRenderer(
			window,
			"document.body.dataset.phase === 'welcome'",
			'instance switching from management'
		);
		assert(
			window.getSize().join('x') === managedWindowSize.join('x'),
			'Returning to welcome resized Admin.'
		);
		const recentScreenshot = await capture(window, outputDir, '06-recent-instances.png');
		await sizeViewport(window, 640, 640);
		await assertRenderedFloor(window, 'narrow recent-instance list');
		window.setSize(managedWindowSize[0], managedWindowSize[1]);
		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('#new-instance-details').open = true;
			document.querySelector('#new-instance-home').value = ${JSON.stringify(otherHome)};
			document.querySelector('#new-instance-form').requestSubmit();
		})()`);
		await waitForRenderer(
			window,
			`document.body.dataset.phase === 'not_installed' && document.querySelector('#install-home').textContent === ${JSON.stringify(otherHome)}`,
			'separate instance setup'
		);
		assert(
			window.getSize().join('x') === managedWindowSize.join('x'),
			'Opening another instance resized Admin.'
		);
		assert(
			await window.webContents.executeJavaScript(`(() => {
			return !document.querySelector('#provider-key').value && !document.querySelector('#credential-key').value;
		})()`),
			'Transient keys survived the instance switch.'
		);
		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('#install-instance-name').value = ${JSON.stringify(projectName)};
			document.querySelector('#install-form').requestSubmit();
		})()`);
		await waitForRenderer(
			window,
			"document.body.dataset.busy === 'false' && document.querySelector('#notice-message').textContent.includes('already in use')",
			'duplicate instance-name rejection',
			10_000,
			true
		);
		assert(!existsSync(join(otherHome, 'state')), 'A duplicate name materialized the second home.');
		assert(
			readFileSync(join(homeDir, 'state', 'stack.json'), 'utf8') === originalConfig,
			'A duplicate name changed the original instance.'
		);
		const secondProject = `${projectName}-other`;
		const previousSkeleton = process.env.FH_SKELETON_DIR;
		try {
			// Own disposable listeners prove automatic fallback on any test host.
			// Existing listeners are observed, never stopped or replaced.
			for (const port of [3810, 3830]) {
				const server = createServer();
				try {
					await new Promise<void>((resolve, reject) => {
						server.once('error', reject);
						server.listen(port, '127.0.0.1', resolve);
					});
					portBlockers.push(server);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
				}
			}
			const subnet = process.env.FH_ADMIN_E2E_SECOND_AGENT_SUBNET?.trim();
			if (subnet) {
				assert(
					/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(subnet),
					'Invalid test-only second-instance subnet.'
				);
				// Test-only seed: no daemon settings or operator overlays are changed.
				const source =
					previousSkeleton || join(requiredEnvironment('FH_REPO_ROOT'), 'packages', 'skeleton');
				const seed = join(outputDir, 'second-instance-skeleton');
				for (const path of [...MANAGED_FILES, ...SEEDED_FILES]) {
					mkdirSync(dirname(join(seed, path)), { recursive: true });
					copyFileSync(join(source, path), join(seed, path));
				}
				const custom = join(seed, 'config/stack/custom.compose.yml');
				writeFileSync(
					custom,
					`${readFileSync(custom, 'utf8')}\nnetworks:\n  agent_net:\n    ipam:\n      config:\n        - subnet: ${JSON.stringify(subnet)}\n`
				);
				process.env.FH_SKELETON_DIR = seed;
			}
			await window.webContents.executeJavaScript(`(() => {
				document.querySelector('#install-instance-name').value = ${JSON.stringify(secondProject)};
				document.querySelector('#install-form').requestSubmit();
			})()`);
			await waitForRenderer(
				window,
				"document.body.dataset.phase === 'setup_incomplete' && [...document.querySelectorAll('#services .service')].some(row => row.textContent.includes('Running normally'))",
				'second named instance startup'
			);
			const selected = JSON.parse(readFileSync(join(otherHome, 'state', 'stack.json'), 'utf8'));
			secondAssistantPort = selected.assistant.port;
			secondGuardianPort = selected.gateway.port;
			assert(
				secondAssistantPort !== 3810 && secondGuardianPort !== 3830,
				'Automatic setup reused occupied default ports.'
			);
			assert(
				new Set([assistantPort, guardianPort, secondAssistantPort, secondGuardianPort]).size === 4,
				'Automatic second-instance ports were not distinct from the running primary.'
			);
			assert(
				await window.webContents.executeJavaScript(
					"!document.querySelector('#install-advanced').open"
				),
				'Automatic second-instance setup required opening Advanced.'
			);
		} finally {
			await Promise.all(
				portBlockers
					.splice(0)
					.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
			);
			if (previousSkeleton === undefined) delete process.env.FH_SKELETON_DIR;
			else process.env.FH_SKELETON_DIR = previousSkeleton;
		}
		if (provider && providerKey) await connectProviderUi(window, provider, providerKey);
		else {
			markInstalled(otherHome);
			await window.webContents.executeJavaScript("document.querySelector('#refresh').click()");
			await waitForRenderer(
				window,
				"document.body.dataset.phase === 'ready'",
				'second management-only fixture'
			);
		}
		const secondInstanceScreenshot = await capture(
			window,
			outputDir,
			'06b-second-instance-ready.png'
		);
		const firstContainer = `${projectName}-assistant-1`;
		const secondContainer = `${secondProject}-assistant-1`;
		for (const [container, hostname] of [
			[firstContainer, projectName],
			[secondContainer, secondProject]
		]) {
			const inspected = await runDocker(['inspect', '--format', '{{json .}}', container]);
			assert(inspected.ok, `Could not inspect named container ${container}.`);
			const actual = JSON.parse(inspected.stdout);
			assert(
				actual.Name === `/${container}` &&
					actual.Config.Hostname === hostname &&
					actual.State.Health.Status === 'healthy',
				`Container name, hostname or health did not match ${container}.`
			);
			const osHostname = await runDocker(['exec', container, 'cat', '/etc/hostname']);
			assert(
				osHostname.ok && osHostname.stdout.trim() === hostname,
				`The actual OS hostname did not match ${hostname}.`
			);
		}
		assert(
			window.getSize().join('x') === managedWindowSize.join('x'),
			'Creating another instance resized Admin.'
		);
		progress(
			'two named agents are healthy simultaneously with distinct ports and matching OS hostnames'
		);
		await window.webContents.executeJavaScript(
			"window.fholdAdmin.credential({ action: 'create', username: 'other-instance-only', policy: 'read' })"
		);
		assert(
			readFileSync(join(homeDir, 'state', 'stack.json'), 'utf8') === originalConfig,
			'A second-instance operation changed the first instance.'
		);
		assert(
			readFileSync(join(otherHome, 'state', 'stack.json'), 'utf8').includes('other-instance-only'),
			'The credential was not written to the selected instance.'
		);
		assert(
			await window.webContents.executeJavaScript(
				"window.fholdAdmin.providerOAuthFinish({provider:'openai',method:0}).then(() => false, () => true)"
			),
			'A stale sign-in step was accepted after switching.'
		);
		await window.webContents.executeJavaScript(
			"document.querySelector('.sidebar [data-instance-switch]').click()"
		);
		await waitForRenderer(
			window,
			"document.body.dataset.phase === 'welcome'",
			'returning to the instance list'
		);
		await window.webContents.executeJavaScript(
			"document.querySelector('#open-default-instance').click()"
		);
		await waitForRenderer(
			window,
			`document.body.dataset.phase === 'ready' && document.querySelector('#home').textContent === ${JSON.stringify(homeDir)}`,
			'returning to the original instance'
		);
		assert(
			(await adminSnapshot()).services.every((service) => service.state === 'running'),
			'Switching stopped the original stack.'
		);
		assert(process.env.FH_HOME === homeDir, 'Instance selection mutated the global FH_HOME.');
		assert(
			window.getSize().join('x') === managedWindowSize.join('x'),
			'Returning to the original instance resized Admin.'
		);
		progress('two-instance isolation, renderer key reset and stale sign-in rejection verified');
		// Exercise the actual managed recovery path, not a separately wired container.
		const checkpointDirectory = join(outputDir, 'runtime-checkpoints');
		const beforeRecoverySave = await containerId();
		const recoveryWindowSize = window.getSize().join('x');
		const recoveryViewport = await window.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})');
		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('[data-view=system]').click();
			document.querySelector('#runtime-recovery').open = true;
			document.querySelector('#runtime-recovery').scrollIntoView({block:'start'});
		})()`);
		await assertRenderedFloor(window, 'portable versus runtime recovery');
		const runtimeRecoveryOffScreenshot = await capture(window, outputDir, '07-runtime-recovery-off.png');
		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('#runtime-recovery-enabled').checked = true;
			document.querySelector('#runtime-recovery-enabled').dispatchEvent(new Event('change', {bubbles:true}));
			document.querySelector('#runtime-recovery-directory').value = ${JSON.stringify(checkpointDirectory)};
			document.querySelector('#runtime-recovery-paths').value = '/tmp/fhold-custom-client';
			document.querySelector('#runtime-recovery-sqlite').value = '/tmp/fhold-custom-client/state.sqlite';
			document.querySelector('#runtime-recovery-interval').value = '2';
			document.querySelector('#runtime-recovery-max-unsaved').value = '120';
			document.querySelector('#runtime-recovery-directory').dispatchEvent(new Event('input', {bubbles:true}));
			document.querySelector('#runtime-recovery-form').requestSubmit();
		})()`);
		await waitForRenderer(window,
			"document.body.dataset.busy !== 'true' && document.querySelector('#notice-message').textContent.startsWith('Checkpoint settings saved.') && !document.querySelector('#pending-restart').hidden",
			'saved recovery settings without initializing or restarting');
		assert(await containerId() === beforeRecoverySave, 'Saving recovery restarted the Assistant.');
		assert(!existsSync(join(checkpointDirectory, 'descriptor.json')), 'Saving settings initialized the namespace.');
		assert(await window.webContents.executeJavaScript("document.querySelector('#initialize-recovery').disabled && document.querySelector('#restore-runtime-recovery').disabled"), 'Offline actions were enabled with live writers.');
		assert(await window.webContents.executeJavaScript("window.fholdAdmin.recovery({action:'init',confirmed:true}).then(() => false, error => error.message.includes('Stop this instance'))"), 'Backend initialized with live writers.');
		confirmations.push(1);
		await window.webContents.executeJavaScript("document.querySelector('#stop-stack').click()");
		await waitForRenderer(window,
			"document.body.dataset.busy !== 'true' && document.querySelector('#notice-message').textContent.startsWith('fhold stopped.') && !document.querySelector('#initialize-recovery').disabled",
			'confirmed stop enables offline recovery operations');
		confirmations.push(0);
		const promptsBeforeInitCancellation = prompts.length;
		await window.webContents.executeJavaScript("document.querySelector('#initialize-recovery').click()");
		await waitForPrompt(promptsBeforeInitCancellation + 1);
		await waitForRenderer(window, "document.body.dataset.busy !== 'true'", 'cancelled recovery remains idle');
		assert(!existsSync(join(checkpointDirectory, 'descriptor.json')), 'Cancelling initialized the namespace.');
		confirmations.push(1);
		await window.webContents.executeJavaScript("document.querySelector('#initialize-recovery').click()");
		await waitForRenderer(window,
			"document.body.dataset.busy !== 'true' && document.querySelector('#notice-message').textContent.startsWith('New destination initialized.')",
			'explicit initialization of an unused destination');
		assert(existsSync(join(checkpointDirectory, 'descriptor.json')), 'Native namespace was not initialized.');
		const initializedDescriptor = readFileSync(join(checkpointDirectory, 'descriptor.json'));
		assert(await window.webContents.executeJavaScript("window.fholdAdmin.recovery({action:'init',confirmed:true}).then(() => false, () => true)"), 'Native initialization accepted an existing namespace.');
		assert(readFileSync(join(checkpointDirectory, 'descriptor.json')).equals(initializedDescriptor), 'Refused reinitialization modified checkpoint authority.');
		const operatorContainers = await runDocker(['ps', '-a', '--filter', `label=com.docker.compose.project=${projectName}`, '--format', '{{.Names}}']);
		assert(operatorContainers.ok && !operatorContainers.stdout.includes('-recovery-'), 'A failed operator run left its container behind.');
		await window.webContents.executeJavaScript("document.querySelector('#inspect-recovery').click()");
		await waitForRenderer(window,
			"document.body.dataset.busy !== 'true' && document.querySelector('#runtime-recovery-details').value.startsWith('{')",
			'read-only image coverage inspection');
		confirmations.push(1);
		await window.webContents.executeJavaScript("document.querySelector('#start-stack').click()");
		await waitForRenderer(window,
			"document.body.dataset.busy !== 'true' && document.querySelector('#notice-message').textContent.startsWith('fhold started.') && document.querySelector('#pending-restart').hidden",
			'starting initialized recovery with saved settings');
		const customState = await runDocker(['exec', `${projectName}-assistant-1`, 'bun', '--no-env-file', '-e',
			`const fs=require('node:fs');const {Database}=require('bun:sqlite');fs.mkdirSync('/tmp/fhold-custom-client',{recursive:true});fs.writeFileSync('/tmp/fhold-custom-client/settings.json','preserved operator settings');const db=new Database('/tmp/fhold-custom-client/state.sqlite');db.exec("PRAGMA journal_mode=WAL;CREATE TABLE state(value TEXT);INSERT INTO state VALUES('preserved SQLite data')");db.close();`]);
		assert(customState.ok, 'Could not create synthetic custom state using native SQLite.');
		const publishedBefore = Date.now();
		await window.webContents.executeJavaScript(`(async () => {
			const deadline = Date.now() + 90000;
			while (Date.now() < deadline) {
				document.querySelector('#check-recovery-status').click();
				await new Promise(resolve => setTimeout(resolve, 1500));
				const status = JSON.parse(document.querySelector('#runtime-recovery-details').value);
				if (status.healthy === true && status.lastPublishedAt >= ${publishedBefore}) return;
			}
			throw new Error('No fresh accepted checkpoint of the custom state.');
		})()`);
		assert(await window.webContents.executeJavaScript("document.querySelector('#runtime-recovery-status').textContent.includes('Checkpoint accepted.')"), 'Admin did not display actual accepted publication.');
		await window.webContents.executeJavaScript("document.querySelector('#runtime-recovery').open = true; document.querySelector('#runtime-recovery-enabled').focus()");
		await assertRenderedFloor(window, 'running runtime recovery');
		assert(await window.webContents.executeJavaScript("document.querySelector('#runtime-recovery').open && document.querySelector('#runtime-recovery-storage').getBoundingClientRect().height > 0"), 'Runtime recovery controls were not visible for their rendered audit.');
		const runtimeRecoveryReadyScreenshot = await capture(window, outputDir, '07b-runtime-recovery-ready.png', true);
		await window.webContents.executeJavaScript("document.querySelector('#runtime-recovery').open = true; document.querySelector('#runtime-recovery-advanced').open = true; document.querySelector('#runtime-recovery-instance-id').focus()");
		await assertRenderedFloor(window, 'additional runtime paths and SQLite coverage');
		assert(await window.webContents.executeJavaScript("document.querySelector('#runtime-recovery-advanced').open && document.querySelector('#runtime-recovery-sqlite').getBoundingClientRect().height > 0"), 'Additional SQLite controls were not visible for their rendered audit.');
		assert(await window.webContents.executeJavaScript("document.querySelector('#runtime-recovery-interval').value === '2' && document.querySelector('#runtime-recovery-max-unsaved').value === '120'"), 'Keyboard traversal changed saved recovery timing fields.');
		const runtimeRecoveryAdvancedScreenshot = await capture(window, outputDir, '07c-runtime-recovery-advanced.png', true);
		await sizeViewport(window, 640, 640, 2);
		await assertRenderedFloor(window, 'runtime recovery at minimum size and 200% zoom');
		assert(await window.webContents.executeJavaScript("document.querySelector('#runtime-recovery-interval').value === '2' && document.querySelector('#runtime-recovery-max-unsaved').value === '120'"), 'Recovery timing fields changed during narrow keyboard traversal.');
		const runtimeRecoveryNarrowScreenshot = await capture(window, outputDir, '07d-runtime-recovery-reflow.png', true);
		await sizeViewport(window, recoveryViewport.width, recoveryViewport.height);
		await window.webContents.executeJavaScript("document.querySelector('#runtime-recovery-advanced').open = false");
		const priorContainer = await containerId();
		confirmations.push(1);
		await window.webContents.executeJavaScript("document.querySelector('#stop-stack').click()");
		await waitForRenderer(window, "document.body.dataset.busy !== 'true' && document.querySelector('#notice-message').textContent.startsWith('fhold stopped.')", 'final managed checkpoint and stopped writers');
		confirmations.push(0);
		const promptsBeforeRestoreCancellation = prompts.length;
		await window.webContents.executeJavaScript("document.querySelector('#restore-runtime-recovery').click()");
		await waitForPrompt(promptsBeforeRestoreCancellation + 1);
		await waitForRenderer(window, "document.body.dataset.busy !== 'true'", 'cancelled offline restore');
		confirmations.push(1);
		await window.webContents.executeJavaScript("document.querySelector('#restore-runtime-recovery').click()");
		await waitForRenderer(window, "document.body.dataset.busy !== 'true' && document.querySelector('#notice-message').textContent.startsWith('Recovery validated.')", 'native offline restore leaves writers stopped');
		assert((await adminSnapshot()).services.length === 0, 'Offline validation started a service.');
		confirmations.push(1);
		await window.webContents.executeJavaScript("document.querySelector('#start-stack').click()");
		await waitForRenderer(window, "document.body.dataset.busy !== 'true' && document.querySelector('#notice-message').textContent.startsWith('fhold started.')", 'transparent same-instance recovery after container removal');
		assert(await containerId() !== priorContainer, 'Recovery reused the old container.');
		const restoredCustomState = await runDocker(['exec', `${projectName}-assistant-1`, 'bun', '--no-env-file', '-e',
			`const fs=require('node:fs');const {Database}=require('bun:sqlite');if(fs.readFileSync('/tmp/fhold-custom-client/settings.json','utf8')!=='preserved operator settings')throw Error('settings lost');const db=new Database('/tmp/fhold-custom-client/state.sqlite',{readonly:true});if(db.query('PRAGMA integrity_check').get().integrity_check!=='ok'||db.query('SELECT value FROM state').get().value!=='preserved SQLite data')throw Error('database lost');console.log('custom state restored');db.close();`]);
		assert(restoredCustomState.ok && restoredCustomState.stdout.includes('custom state restored'), 'Custom files/SQLite did not survive fresh containers.');
		assert(window.getSize().join('x') === recoveryWindowSize, 'Recovery controls resized the Admin window.');
		progress('real managed recovery: deferred save, stop/cancel/init/inspect/start/checkpoint/offline restore and cold custom-file/SQLite resume passed');

		// Exercise full import/export through the real renderer and IPC. Only
		// human dialog choices are simulated, never Docker or native databases.
		const instanceAuth = Buffer.from(`user:${readFileSync(join(homeDir, 'state/secrets/fhold_opencode_password'), 'utf8').trim()}`).toString('base64');
		const nativeSession = await fetch(`http://127.0.0.1:${assistantPort}/session`, {
			method: 'POST', headers: { authorization: `Basic ${instanceAuth}`, 'content-type': 'application/json' },
			body: JSON.stringify({ title: 'Full-instance preservation check' }), signal: AbortSignal.timeout(10_000)
		});
		assert(nativeSession.ok, 'Could not create the native preservation session.');
		const savedSession = await nativeSession.json() as { id: string; title: string };
		const fullExport = join(outputDir, 'full-instance-export');
		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('[data-view=system]').click();
			document.querySelector('#import-export').open=true;
			document.querySelector('#backup-scope').value='instance';
			document.querySelector('#backup-scope').dispatchEvent(new Event('change'));
			document.querySelector('#backup-destination').value=${JSON.stringify(fullExport)};
		})()`);
		confirmations.push(1);
		await window.webContents.executeJavaScript("document.querySelector('#backup-form').requestSubmit()");
		await waitForRenderer(window, "document.body.dataset.busy!=='true' && document.querySelector('#notice-message').textContent.includes('all containers stopped')", 'full export rejects live writers', 30_000, true);
		assert(!existsSync(fullExport), 'Live export wrote a destination.');
		confirmations.push(1);
		await window.webContents.executeJavaScript("document.querySelector('[data-view=overview]').click(); document.querySelector('#stop-stack').click()");
		await waitForRenderer(window, "document.body.dataset.busy!=='true' && document.querySelectorAll('#services .service').length===0", 'stopped source before full export');
		const sourceIntent = readFileSync(join(homeDir, 'state/stack.json'));
		const sourceKey = readFileSync(join(homeDir, 'state/secrets/fhold_opencode_password'));
		await window.webContents.executeJavaScript("document.querySelector('[data-view=system]').click(); document.querySelector('#import-export').open=true");
		confirmations.push(0);
		const cancelledExportPrompt = prompts.length + 1;
		await window.webContents.executeJavaScript("document.querySelector('#backup-form').requestSubmit()");
		await waitForPrompt(cancelledExportPrompt);
		assert(!existsSync(fullExport), 'Cancelled full export wrote a destination.');
		confirmations.push(1);
		await window.webContents.executeJavaScript("document.querySelector('#backup-form').requestSubmit()");
		await waitForRenderer(window, "document.body.dataset.busy!=='true' && document.querySelector('#backup-summary').textContent.includes('full-instance items exported')", 'full stopped export');
		assert(JSON.parse(readFileSync(join(fullExport, 'fhold-backup.json'), 'utf8')).scope === 'instance', 'Full export did not publish its manifest.');
		await window.webContents.executeJavaScript("document.querySelector('#backup-form').scrollIntoView({block:'start'})");
		const fullExportScreenshot = await capture(window, outputDir, '08-full-instance-export.png', true);
		await window.webContents.executeJavaScript(`(async () => {
			await window.fholdAdmin.closeInstance();
			await window.fholdAdmin.prepareNewInstance({kind:'local',homeDir:${JSON.stringify(fullRestoredHome)}});
			location.reload();
		})()`);
		await waitForRenderer(window, "document.body.dataset.phase==='not_installed'", 'full import uses an empty folder, before installation');
		await window.webContents.executeJavaScript(`(() => {
			document.querySelector('#instance-restore-panel').open=true;
			document.querySelector('#instance-restore-source').value=${JSON.stringify(fullExport)};
			document.querySelector('#instance-restore-source').dispatchEvent(new Event('input'));
			document.querySelector('#preview-instance-restore').click();
		})()`);
		await waitForRenderer(window, "document.body.dataset.busy!=='true' && !document.querySelector('#apply-instance-restore').disabled", 'full import preview');
		assert(!existsSync(fullRestoredHome), 'Full import preview seeded the target.');
		assert(await window.webContents.executeJavaScript("document.querySelector('#install-form').hidden"), 'Fresh installation remained available while full import was selected.');
		await window.webContents.executeJavaScript("document.querySelector('#instance-restore-panel').scrollIntoView({block:'start'})");
		const fullImportScreenshot = await capture(window, outputDir, '08a-full-instance-import.png', true);
		confirmations.push(0);
		const cancelledImportPrompt = prompts.length + 1;
		await window.webContents.executeJavaScript("document.querySelector('#apply-instance-restore').click()");
		await waitForPrompt(cancelledImportPrompt);
		assert(!existsSync(fullRestoredHome), 'Cancelled full import changed its destination.');
		confirmations.push(1);
		await window.webContents.executeJavaScript("document.querySelector('#apply-instance-restore').click()");
		await waitForRenderer(window, "document.body.dataset.phase==='ready' && document.body.dataset.busy!=='true'", 'full import preserves the completed instance, without setup or startup');
		assert(readFileSync(join(fullRestoredHome, 'state/stack.json')).equals(sourceIntent), 'Full import changed instance intent.');
		assert(readFileSync(join(fullRestoredHome, 'state/secrets/fhold_opencode_password')).equals(sourceKey), 'Full import replaced the native account key.');
		assert((await adminSnapshot()).services.length === 0, 'Full import started a service.');
		confirmations.push(1);
		await window.webContents.executeJavaScript("document.querySelector('[data-view=overview]').click(); document.querySelector('#start-stack').click()");
		await waitForRenderer(window, "document.body.dataset.busy!=='true' && document.querySelector('#notice-message').textContent.startsWith('fhold started.')", 'explicit start of the restored instance');
		const restoredSession = await fetch(`http://127.0.0.1:${assistantPort}/session/${savedSession.id}`, { headers: { authorization: `Basic ${instanceAuth}` }, signal: AbortSignal.timeout(10_000) });
		assert(restoredSession.ok && (await restoredSession.json() as { title: string }).title === savedSession.title, 'Native session was not visible after full import/start.');
		assert(window.getSize().join('x') === recoveryWindowSize, 'Full import/export resized the Admin window.');
		progress('full stopped instance: live-writer refusal, cancel/confirm, export, empty-folder preview/import, unchanged keys/intent and native session after explicit startup passed');
		assert(confirmations.length === 0, 'An expected interruption prompt was not shown.');
		succeeded = true;
		return {
			ok: true,
			homeDir,
			projectName,
			assistantPort,
			guardianPort,
			...(ingressSubnet ? { testIngressSubnet: ingressSubnet } : {}),
			services: finalSnapshot.services,
			providersDiscovered: providerCatalog.length,
			providerReadiness: readiness,
			...(providerRuntime ? { providerRuntime } : {}),
			visibleSetupJourneyComplete: Boolean(provider && providerKey),
			managementUiFixtureUsed: !provider,
			startupRecoveryVerified: true,
			restorePreservationVerified: true,
			fullInstanceVerified: { liveWriterRefused: true, cancelledOperationsPreserved: true, previewReadOnly: true, containersStayStopped: true, identityAndKeysPreserved: true, nativeSessionResumed: true, home: fullRestoredHome },
			sidebarVerified: { savedIdentity: true, fullPathAccessible: true, runtimeNotProviderReadiness: true, staleStatusFixture: true, longPathFixture: true, labeledActions: true, narrowAndZoom: true, windowSizeStable: true },
			instanceWelcomeVerified: {
				defaultOneClick: true,
				folderSelectionAndCancellation: true,
				invalidFolderPreserved: true,
				recentFoldersPersisted: true,
				switchReloadsRenderer: true,
				twoInstanceIsolation: true,
				transientKeysCleared: true,
				staleSignInRejected: true,
				windowSizeStable: true
			},
			newInstanceVerified: {
				folderPickerCancellation: true,
				populatedFolderPreserved: true,
				typedFolder: true,
				duplicateNameRejectedBeforeInstall: true,
				twoRunningNamedAgents: true,
				osHostnamesVerified: true,
				automaticPortFallbackWithoutAdvanced: true,
				secondProviderVerified: Boolean(provider && providerKey),
				secondHome: otherHome,
				secondProject,
				secondAssistantPort,
				secondGuardianPort
			},
			nativeRemoteSetup: {
				dialogVerified: true,
				explicitTrust: true,
				sandboxChoices: ['workspace-write', 'read-only', 'danger-full-access'],
				subscriptionLoginVerified: false
			},
			codexRecall: {
				managedPolicy: true,
				personalApprovalRejected: true,
				restartPersistence: true,
				noRemoteStartup: true
			},
			restartConfirmation: { prompts, deferredSave: true, pendingAfterReopen: true, realContainerRecreated: true, runtimeSettingsVerified: true, windowSizePreserved: true },
			runtimeRecoveryVerified: { savedWithoutRestart: true, noAutomaticInitialization: true, liveWriterRefused: true, cancelVerified: true, readOnlyInspect: true, acceptedPublication: true, stoppedRestore: true, coldContainerCustomFilesAndSqlite: true, windowSizeStable: true },
			agentPreferencesVerified: {
				timezone: 'Europe/London',
				memoryOptOutPersisted: true,
				automaticMemoryRestored: true
			},
			connectionRecipesVerified: ['opencode', 'claude', 'mcp'],
			networkDetailsVerified: {
				mcpApiLabels: true,
				fullMcpAndHealthUrls: true,
				openCodeKeyboardAndClick: true,
				standardBrowserLink: true,
				rendererNavigationPrevented: true
			},
			credential: { username: 'e2e-reader', policy: 'read' },
			portalMapping: { portal: 'discord', user: '123456789012345678' },
			visualAudits,
			guardian: {
				healthStatus: health.status,
				unauthenticatedStatus: unauthorized.status,
				authenticatedInitializeStatus: authorized.status,
				toolsListStatus: listed.status,
				toolCount: tools.length
			},
			screenshots: [
				...sidebarScreenshots,
				fullExportScreenshot,
				fullImportScreenshot,
				welcomeScreenshot,
				narrowWelcomeScreenshot,
				newInstanceScreenshot,
				secondInstanceScreenshot,
				recentScreenshot,
				initialScreenshot,
				advancedPortsScreenshot,
				assistantScreenshot,
				recoveryScreenshot,
				reflowScreenshot,
				providerPickerScreenshot,
				nativeRemoteScreenshot,
				recallScreenshot,
				overviewScreenshot,
				connectionsScreenshot,
				backupScreenshot,
				systemScreenshot,
				agentSettingsScreenshot,
				pendingRestartScreenshot,
				chatAppsScreenshot,
				narrowConsentScreenshot,
				narrowConsentActionsScreenshot,
				narrowIsolationScreenshot,
				restoreScreenshot,
				troubleshootingScreenshot,
				claudeScreenshot,
				mcpScreenshot,
				narrowMcpScreenshot,
				...(readyScreenshot ? [readyScreenshot] : []),
				guardianScreenshot,
				narrowAccessScreenshot,
				keyboardScreenshot,
				runtimeRecoveryOffScreenshot,
				runtimeRecoveryReadyScreenshot,
				runtimeRecoveryAdvancedScreenshot,
				runtimeRecoveryNarrowScreenshot
			],
			keptRunning: keepRunning,
			homeRetained: process.env.FH_ADMIN_E2E_KEEP_HOME === 'true'
		};
	} finally {
		dialog.showMessageBox = originalMessageBox;
		await Promise.all(
			portBlockers
				.splice(0)
				.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
		);
		if (existsSync(join(otherHome, 'system', 'stack', 'stack.compose.yml'))) {
			await deactivateComposeCommand(createFholdState(otherHome));
		}
		if (existsSync(join(fullRestoredHome, 'system/stack/stack.compose.yml'))) {
			await deactivateComposeCommand(createFholdState(fullRestoredHome));
		}
		if (!keepRunning || !succeeded) {
			try {
				await deactivateComposeCommand(createFholdState(homeDir));
			} catch {
				// The runner performs a targeted Compose cleanup if setup failed early.
			}
		}
		window.destroy();
	}
}

async function main(): Promise<void> {
	const outputDir = process.env.FH_ADMIN_E2E_OUTPUT?.trim();
	try {
		const report = await run();
		if (outputDir)
			writeFileSync(join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		app.exit(0);
	} catch (error) {
		const failure = {
			ok: false,
			error: message(error),
			homeDir: process.env.FH_HOME,
			homeRetained: process.env.FH_ADMIN_E2E_KEEP_HOME === 'true'
		};
		if (outputDir) {
			mkdirSync(outputDir, { recursive: true });
			writeFileSync(join(outputDir, 'failure.json'), `${JSON.stringify(failure, null, 2)}\n`);
		}
		process.stderr.write(`Admin E2E failed: ${failure.error}\n`);
		app.exit(1);
	}
}

void main();

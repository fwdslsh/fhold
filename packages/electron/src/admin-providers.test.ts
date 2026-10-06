import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultStackConfig } from '@fhold/lib';
import {
	bindProvidersEvents,
	renderProviders,
	renderReadiness,
	loadProviders,
	verifyProvider
} from '../admin/providers.js';
import { createAdminState, state } from '../admin/state.js';

// Renderer decision tests; these doubles are not evidence of Chromium layout or live provider readiness.
class Control {
	id = '';
	tagName = 'INPUT';
	type = 'text';
	value = '';
	checked = false;
	disabled = false;
	hidden = false;
	textContent = '';
	className = '';
	open = false;
	dataset: Record<string, string> = {};
	children: Control[] = [];
	attributes = new Map<string, string>();
	listeners = new Map<string, (event: unknown) => unknown>();
	get options() {
		return this.children;
	}
	setAttribute(name: string, value: string) {
		this.attributes.set(name, value);
	}
	getAttribute(name: string) {
		return this.attributes.get(name) ?? null;
	}
	toggleAttribute(name: string, enabled: boolean) {
		if (enabled) this.attributes.set(name, '');
		else this.attributes.delete(name);
	}
	addEventListener(name: string, listener: (event: unknown) => unknown) {
		this.listeners.set(name, listener);
	}
	append(...children: Control[]) {
		this.children.push(...children);
	}
	replaceChildren(...children: Control[]) {
		this.children = children;
	}
	querySelectorAll() {
		return this.children;
	}
	querySelector() {
		return this.children[0] ?? new Control();
	}
	contains(child: Control) {
		return this.children.includes(child);
	}
	focus() {}
	scrollIntoView() {}
}
const html = readFileSync(join(import.meta.dir, '..', 'admin', 'index.html'), 'utf8');
const globals = {
	document: globalThis.document,
	window: globalThis.window,
	HTMLInputElement: globalThis.HTMLInputElement
};
let controls: Map<string, Control>;
function control(id: string): Control {
	const result = controls.get(id);
	if (!result) throw new Error(`Unknown Admin control: ${id}`);
	return result;
}
beforeEach(() => {
	Object.assign(state, createAdminState());
	controls = new Map(
		[...html.matchAll(/\bid="([^"]+)"/g)].map((match) => {
			const element = new Control();
			element.id = match[1];
			return [element.id, element];
		})
	);
	control('install-section').hidden = true;
	control('instance-import-section').hidden = true;
	globalThis.document = {
		body: new Control(),
		getElementById: (id: string) => controls.get(id) ?? null,
		querySelectorAll: () => [],
		querySelector: () => null,
		createElement: () => new Control()
	} as unknown as Document;
	globalThis.HTMLInputElement = Control as unknown as typeof HTMLInputElement;
	globalThis.window = { confirm: () => false } as unknown as Window & typeof globalThis;
});
afterEach(() => {
	clearTimeout(state.noticeTimer);
	Object.assign(globalThis, globals);
});
describe('AI account renderer regressions', () => {
	function snapshot(phase = 'ready') {
		return {
			phase,
			homeDir: '/disposable-provider-fixture',
			configPath: '/disposable-provider-fixture/state/stack.json',
			config: defaultStackConfig(),
			services: [],
			credentials: [],
			portalMappings: { discord: { users: {} }, slack: { users: {} } },
			portalSecrets: {},
			pendingRestart: { required: true }
		};
	}
	function account(id: string, authenticated = false, connected = false) {
		return {
			id,
			name: id,
			authenticated,
			connected,
			authMethods: [{ index: 0, type: 'api', label: 'API key' }]
		};
	}

	it('never calls a native catalog-active provider a saved or verified account', () => {
		state.currentSnapshot = { phase: 'setup_incomplete' };
		renderProviders([account('opencode', false, true)]);
		expect(
			control('provider')
				.options.map((option) => option.textContent)
				.join(' ')
		).not.toMatch(/connected|verified|sign-in found/i);
		expect(
			control('provider-status')
				.children.map((child) => child.textContent)
				.join(' ')
		).not.toContain('sign-in found');
		expect(control('provider-badge').textContent).not.toBe('Connected');
	});

	it('distinguishes a saved native sign-in from a verified model response', () => {
		control('provider').value = 'anthropic';
		renderProviders([account('anthropic', true, true)]);
		expect(
			control('provider')
				.options.map((option) => option.textContent)
				.join(' ')
		).not.toMatch(/connected|verified/i);
		expect(control('provider-badge').textContent).not.toBe('Connected');
		expect(control('test-provider').hidden).toBe(false);
	});

	it('searches uncommon providers, removes nonmatching selections and reports no matches', () => {
		renderProviders([account('anthropic', true, true), account('uncommon-provider')]);
		bindProvidersEvents();
		control('provider-search').value = 'uncommon';
		control('provider-search').listeners.get('input')?.({});
		expect(
			control('provider')
				.options.filter((option) => option.value)
				.map((option) => option.value)
		).toEqual(['uncommon-provider']);
		control('provider-search').value = 'no-such-provider';
		control('provider-search').listeners.get('input')?.({});
		expect(control('provider').options.filter((option) => option.value)).toHaveLength(0);
		expect(control('provider').value).toBe('');
		expect(control('test-provider').hidden).toBe(true);
	});

	it('clears transient credentials and abandoned code fields when changing the selected account', () => {
		renderProviders([account('anthropic'), account('openai')]);
		bindProvidersEvents();
		control('provider-key').value = 'synthetic-transient-key';
		control('oauth-code').value = 'synthetic-transient-code';
		control('provider').value = 'openai';
		control('provider').listeners.get('change')?.({});
		expect(control('provider-key').value).toBe('');
		expect(control('oauth-code').value).toBe('');
		expect(state.activeOAuth).toBeNull();
	});

	it('does not automatically verify native catalog activation as an account sign-in', async () => {
		state.currentSnapshot = { phase: 'setup_incomplete' };
		let attempts = 0;
		state.api = {
			providers: async () => [account('opencode', false, true)],
			readiness: async () => {
				attempts++;
				return { ok: false, error: 'No stored account' };
			}
		};
		await loadProviders(false);
		await new Promise((resolve) => queueMicrotask(resolve));
		expect(attempts).toBe(0);
	});

	it('keeps management verification on AI account without offering a container restart', async () => {
		const ready = snapshot();
		state.currentSnapshot = ready;
		state.currentView = 'provider';
		state.providersLoaded = true;
		let restartPrompts = 0;
		state.api = {
			snapshot: async () => ready,
			confirmRestart: async () => {
				restartPrompts++;
				return false;
			}
		};
		const verified = await verifyProvider('Checking provider', async () => ({
			ok: true,
			provider: 'anthropic',
			model: 'sonnet',
			response: 'FH_READY'
		}));
		expect(verified).toBe(true);
		expect(state.currentView).toBe('provider');
		expect(restartPrompts).toBe(0);
	});

	it('invalidates setup Continue when choosing a different account or clearing its selection', async () => {
		state.currentSnapshot = snapshot('setup_incomplete');
		state.currentView = 'provider';
		state.providersLoaded = true;
		state.api = { snapshot: async () => snapshot() };
		control('provider').value = 'anthropic';
		renderProviders([account('anthropic', true), account('openai', true)]);
		bindProvidersEvents();
		await verifyProvider('Checking setup', async () => ({
			ok: true,
			provider: 'anthropic',
			model: 'sonnet',
			response: 'FH_READY'
		}));
		expect(control('finish-provider-setup').hidden).toBe(false);
		control('provider').value = 'openai';
		control('provider').listeners.get('change')?.({});
		expect(control('finish-provider-setup').hidden).toBe(true);
		control('finish-provider-setup').listeners.get('click')?.({});
		expect(state.currentView).toBe('provider');
		control('provider-search').value = 'no-match';
		control('provider-search').listeners.get('input')?.({});
		expect(control('finish-provider-setup').hidden).toBe(true);
	});

	it('does not retain a green verified badge while checking or after a thrown verification error', async () => {
		state.currentSnapshot = snapshot();
		renderReadiness({ ok: true, provider: 'anthropic', model: 'sonnet' });
		let fail!: (error: Error) => void;
		const checking = verifyProvider(
			'Checking account',
			() =>
				new Promise((_, reject) => {
					fail = reject;
				})
		);
		expect(control('provider-badge').textContent).not.toBe('Verified');
		fail(new Error('Assistant connection unavailable'));
		expect(await checking).toBe(false);
		expect(control('provider-badge').textContent).toBe('Needs attention');
		expect(control('provider-status').getAttribute('role')).toBe('alert');
	});

	it('refreshes saved-account evidence after a successful native credential write even when already loaded', async () => {
		state.currentSnapshot = snapshot();
		state.providersLoaded = true;
		control('provider').value = 'anthropic';
		renderProviders([account('anthropic', false)]);
		let discoveries = 0;
		state.api = {
			providers: async () => {
				discoveries++;
				return [account('anthropic', true)];
			},
			snapshot: async () => snapshot()
		};
		await verifyProvider(
			'Saving sign-in',
			async () => ({ ok: true, provider: 'anthropic', model: 'sonnet', response: 'FH_READY' }),
			{ savedAuth: true }
		);
		expect(discoveries).toBe(1);
		expect(
			state.providerSummaries.find((provider) => provider.id === 'anthropic')?.authenticated
		).toBe(true);
		expect(control('provider-account-help').textContent.toLowerCase()).not.toContain(
			'not verified'
		);
	});
});

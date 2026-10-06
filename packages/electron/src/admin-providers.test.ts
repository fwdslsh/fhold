import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultStackConfig } from '@fhold/lib';
import {
	bindProvidersEvents,
	closeProviderEditor,
	loadProviders,
	openProviderEditor,
	renderProviders,
	resetProviderState,
	verifyProvider
} from '../admin/providers.js';
import { createAdminState, state } from '../admin/state.js';

// Decision/action tests, not evidence of browser layout or live native inference.
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
		if (this.tagName === 'SELECT') this.value = children[0]?.value ?? '';
	}
	querySelectorAll() {
		return this.children;
	}
	querySelector() {
		return this.children[0] ?? null;
	}
	closest() {
		return this;
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
let shortcuts: Control[];
function control(id: string) {
	const found = controls.get(id);
	if (!found) throw new Error(`Unknown actual Admin control: ${id}`);
	return found;
}
function descendants(root: Control): Control[] {
	return root.children.flatMap((child) => [child, ...descendants(child)]);
}
function content(root: Control): string {
	return [root.textContent, ...root.children.map(content)].join(' ');
}
function account(id: string, options: Record<string, unknown> = {}) {
	return {
		id,
		name: id,
		source: 'api',
		authenticated: true,
		connected: true,
		configured: false,
		models: [
			{ id: 'first-model', name: 'First model' },
			{ id: 'team/second-model', name: 'Second model' }
		],
		authMethods: [{ index: 0, type: 'api', label: 'API key' }],
		...options
	};
}
function settings() {
	return {
		providers: [
			account('alphabetical-first'),
			account('current-service'),
			account('orphan', { connected: false, models: [] }),
			account('public', { authenticated: false, source: 'custom' }),
			account('uncommon', { authenticated: false, connected: false })
		],
		currentModel: { provider: 'current-service', model: 'team/second-model' }
	};
}
function snapshot(homeDir = '/disposable-provider-fixture') {
	return {
		phase: 'ready',
		homeDir,
		configPath: `${homeDir}/state/stack.json`,
		config: defaultStackConfig(),
		services: [],
		credentials: [],
		portalMappings: { discord: { users: {} }, slack: { users: {} } },
		portalSecrets: {},
		pendingRestart: { required: false }
	};
}
function fire(id: string, event = 'click', value: unknown = {}) {
	return control(id).listeners.get(event)?.(value);
}
async function settled() {
	for (let index = 0; index < 50; index++)
		await new Promise<void>((resolve) => queueMicrotask(resolve));
	expect(state.operationInFlight).toBe(false);
}
beforeEach(() => {
	Object.assign(state, createAdminState());
	controls = new Map(
		[...html.matchAll(/<([a-z0-9]+)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)].map((match) => {
			const element = new Control();
			element.id = match[3];
			element.tagName = match[1].toUpperCase();
			element.hidden = /\bhidden\b/.test(match[2]);
			element.disabled = /\bdisabled\b/.test(match[2]);
			return [element.id, element];
		})
	);
	shortcuts = [...html.matchAll(/data-provider-shortcut="([^"]+)"/g)].map((match) => {
		const button = new Control();
		button.tagName = 'BUTTON';
		button.dataset.providerShortcut = match[1];
		return button;
	});
	control('install-section').hidden = true;
	control('instance-import-section').hidden = true;
	const query = (selector: string) => {
		const dynamic = descendants(control('provider-saved-list'));
		if (selector === '[data-provider-shortcut]') return shortcuts;
		if (selector.includes('[data-provider-id]'))
			return dynamic.filter((element) => element.dataset.providerId);
		if (selector === 'button')
			return [...controls.values(), ...shortcuts, ...dynamic].filter(
				(element) => element.tagName === 'BUTTON'
			);
		if (selector.includes('#provider-editor'))
			return [...controls.values()].filter(
				(element) =>
					/^provider-|^oauth-/.test(element.id) && ['INPUT', 'SELECT'].includes(element.tagName)
			);
		return [];
	};
	globalThis.document = {
		body: new Control(),
		getElementById: (id: string) => controls.get(id) ?? null,
		querySelectorAll: query,
		querySelector: () => null,
		createElement: (tag: string) => {
			const element = new Control();
			element.tagName = tag.toUpperCase();
			return element;
		}
	} as unknown as Document;
	globalThis.HTMLInputElement = Control as unknown as typeof HTMLInputElement;
	globalThis.window = { confirm: () => false } as unknown as Window & typeof globalThis;
	state.currentSnapshot = snapshot();
	state.api = { snapshot: async () => state.currentSnapshot, providers: async () => settings() };
	bindProvidersEvents();
	renderProviders(settings());
});
afterEach(() => {
	clearTimeout(state.noticeTimer);
	Object.assign(globalThis, globals);
});

describe('Model-first provider manager', () => {
	it('shows the actual current model, not the first saved account, and keeps inventory collapsed', () => {
		expect(control('provider-default-service').textContent).toBe('current-service');
		expect(control('provider-default-model').textContent).toBe('team/second-model');
		expect(control('provider-saved-accounts').open).toBe(false);
		expect(control('provider-editor').hidden).toBe(true);
		expect(content(control('provider-default-status'))).not.toMatch(/verified|connected/i);
	});
	it('includes orphan saved auth but excludes anonymous availability from saved setups', () => {
		const ids = descendants(control('provider-saved-list'))
			.filter((row) => row.dataset.providerAction === 'edit')
			.map((row) => row.dataset.providerId);
		expect(ids).toContain('orphan');
		expect(ids).not.toContain('public');
		expect(content(control('provider-saved-list'))).not.toMatch(/verified|connected/i);
	});
	it('opens native catalog search only in the explicit add another-provider flow', () => {
		fire('add-provider-service');
		expect(state.providerEditor.stage).toBe('service');
		expect(control('provider-catalog').hidden).toBe(true);
		shortcuts
			.find((button) => button.dataset.providerShortcut === 'other')
			?.listeners.get('click')?.({});
		expect(control('provider-catalog').hidden).toBe(false);
		control('provider-search').value = 'uncommon';
		fire('provider-search', 'input');
		expect(
			control('provider')
				.options.filter((option) => option.value)
				.map((option) => option.value)
		).toEqual(['uncommon']);
		control('provider-search').value = 'no-such-service';
		fire('provider-search', 'input');
		expect(control('provider').value).toBe('');
		expect(control('provider').options.filter((option) => option.value)).toHaveLength(0);
	});
	it('lists and refreshes settings without sending an inference request', async () => {
		let billed = 0;
		state.api.readiness = async () => {
			billed++;
		};
		await loadProviders(false, true);
		await loadProviders(true, true);
		expect(billed).toBe(0);
	});
	it('saves a key and shows model choices without testing or switching the default', async () => {
		const calls: unknown[] = [];
		state.api.providerKey = async (value: unknown) => {
			calls.push(value);
		};
		state.api.readiness = async () => {
			throw new Error('Save must not call readiness');
		};
		state.api.providerUse = async () => {
			throw new Error('Save must not choose default');
		};
		openProviderEditor('edit', 'current-service');
		control('provider-key').value = 'synthetic-new-key';
		fire('provider-form', 'submit', { preventDefault() {} });
		await settled();
		expect(calls).toEqual([{ provider: 'current-service', key: 'synthetic-new-key' }]);
		expect(control('provider-key').value).toBe('');
		expect(state.providerEditor.stage).toBe('model');
		expect(state.providerCurrentModel).toEqual(settings().currentModel);
		expect(control('use-provider-model').disabled).toBe(true);
	});
	it('verifies the exact selected model and allows only explicit matching Use', async () => {
		const calls: unknown[] = [];
		state.currentView = 'provider';
		state.api.readiness = async (value: { provider: string; model: string }) => {
			calls.push(value);
			return { ok: true, ...value, response: 'FH_READY' };
		};
		state.api.providerUse = async (value: { provider: string; model: string }) => {
			calls.push({ use: value });
			return { ...settings(), currentModel: value };
		};
		openProviderEditor('change', 'current-service');
		control('provider-model').value = 'first-model';
		fire('provider-model', 'change');
		fire('test-provider');
		await settled();
		expect(calls).toEqual([{ provider: 'current-service', model: 'first-model' }]);
		expect(state.providerCurrentModel).toEqual(settings().currentModel);
		expect(control('use-provider-model').disabled).toBe(false);
		control('provider-model').value = 'team/second-model';
		fire('provider-model', 'change');
		expect(control('use-provider-model').disabled).toBe(true);
		fire('use-provider-model');
		await settled();
		expect(calls).toHaveLength(1);
		fire('test-provider');
		await settled();
		fire('use-provider-model');
		await settled();
		expect(calls.at(-1)).toEqual({
			use: { provider: 'current-service', model: 'team/second-model' }
		});
		expect(state.currentView).toBe('provider');
	});
	it('rejects a native result for a different model rather than enabling Use', async () => {
		openProviderEditor('change', 'current-service');
		control('provider-model').value = 'first-model';
		fire('provider-model', 'change');
		expect(
			await verifyProvider('Test selected', async () => ({
				ok: true,
				provider: 'current-service',
				model: 'other-model'
			}))
		).toBe(false);
		expect(control('use-provider-model').disabled).toBe(true);
		expect(content(control('provider-status'))).toContain('different model');
	});
	it('invalidates passing readiness on failed recheck and never automatically advances management', async () => {
		state.currentView = 'provider';
		openProviderEditor('change', 'current-service');
		control('provider-model').value = 'first-model';
		await verifyProvider('Pass', async () => ({
			ok: true,
			provider: 'current-service',
			model: 'first-model'
		}));
		expect(control('use-provider-model').disabled).toBe(false);
		await verifyProvider('Fail', async () => {
			throw new Error('Test account denied');
		});
		expect(control('use-provider-model').disabled).toBe(true);
		expect(content(control('provider-status'))).toContain('Test account denied');
		expect(state.currentView).toBe('provider');
	});
	it('requires confirmation and sends an exact auth-only removal request', async () => {
		const calls: unknown[] = [];
		state.api.providerRemove = async (value: unknown) => {
			calls.push(value);
			return settings();
		};
		const target = new Control();
		target.dataset = { providerId: 'orphan', providerAction: 'auth' };
		fire('provider-saved-list', 'click', { target });
		await settled();
		expect(calls).toHaveLength(0);
		window.confirm = () => true;
		fire('provider-saved-list', 'click', { target });
		await settled();
		expect(calls).toEqual([{ provider: 'orphan' }]);
	});
	it('does not publish a slow prior-instance inventory into the newly selected home', async () => {
		let finish!: (value: unknown) => void;
		state.api.providers = () =>
			new Promise((resolve) => {
				finish = resolve;
			});
		const loading = loadProviders(false, true);
		state.currentSnapshot = snapshot('/another-isolated-home');
		resetProviderState();
		finish(settings());
		await loading;
		expect(state.providerSummaries).toEqual([]);
		expect(state.providerCurrentModel).toBeUndefined();
	});
	it('retains the same-instance initial catalog when Add then Cancel happens before it resolves', async () => {
		resetProviderState();
		let finish!: (value: unknown) => void;
		state.api.providers = () =>
			new Promise((resolve) => {
				finish = resolve;
			});
		const loading = loadProviders(false);
		fire('add-provider-service');
		expect(state.providerEditor.stage).toBe('service');
		fire('cancel-provider-editor');
		finish(settings());
		await loading;
		expect(state.providerEditor).toBeNull();
		expect(state.providersLoaded).toBe(true);
		expect(state.providerCurrentModel).toEqual(settings().currentModel);
		expect(state.providerSummaries.some((provider) => provider.id === 'uncommon')).toBe(true);
	});
	it('forced catalog refresh supersedes a pending pre-save read without reverting returned settings', async () => {
		let finishOld!: (value: unknown) => void;
		let reads = 0;
		const latest = {
			...settings(),
			currentModel: { provider: 'current-service', model: 'first-model' }
		};
		state.api.providers = () => {
			reads++;
			return reads === 1
				? new Promise((resolve) => {
						finishOld = resolve;
					})
				: Promise.resolve(latest);
		};
		const oldRead = loadProviders(false, true);
		const freshRead = loadProviders(false, true);
		await freshRead;
		expect(reads).toBe(2);
		finishOld(settings());
		await oldRead;
		expect(state.providerCurrentModel).toEqual(latest.currentModel);
		expect(state.providerLoadPromise).toBeUndefined();
	});
	it('does not overwrite effective returned settings with a late pre-mutation catalog response', async () => {
		let finishOld!: (value: unknown) => void;
		state.api.providers = () =>
			new Promise((resolve) => {
				finishOld = resolve;
			});
		const oldRead = loadProviders(false, true);
		const effective = {
			...settings(),
			currentModel: { provider: 'current-service', model: 'first-model' }
		};
		renderProviders(effective);
		finishOld(settings());
		await oldRead;
		expect(state.providerCurrentModel).toEqual(effective.currentModel);
		expect(state.providerLoadPromise).toBeUndefined();
	});
	it('does not send a paid response request when endpoint save fails to confirm it enabled', async () => {
		openProviderEditor('add');
		shortcuts
			.find((button) => button.dataset.providerShortcut === 'custom')
			?.listeners.get('click')?.({});
		control('provider-endpoint-name').value = 'Disposable server';
		control('provider-base-url').value = 'http://192.0.2.1:8080/v1';
		fire('provider-details-next');
		control('provider-model-manual').checked = true;
		fire('provider-model-manual', 'change');
		control('provider-model-id').value = 'team/test-model';
		fire('provider-model-id', 'input');
		const provider = state.providerEditor.provider;
		state.api.providerEndpoint = async () => ({
			...settings(),
			providers: [
				...settings().providers,
				account(provider, { disabled: true, configured: true, models: [] })
			]
		});
		let requests = 0;
		state.api.readiness = async () => {
			requests++;
			return { ok: true, provider, model: 'team/test-model' };
		};
		fire('test-provider');
		await settled();
		expect(requests).toBe(0);
		expect(control('use-provider-model').disabled).toBe(true);
		expect(state.providerEditor.saved).toBe(false);
		expect(content(control('provider-status'))).toContain(
			'did not confirm this endpoint as enabled'
		);
	});
	it('ignores a pending exact response after editor cancellation or instance change', async () => {
		openProviderEditor('change', 'current-service');
		control('provider-model').value = 'first-model';
		let finish!: (value: unknown) => void;
		const checking = verifyProvider(
			'Test pending',
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		);
		state.currentSnapshot = snapshot('/another-isolated-home');
		resetProviderState();
		closeProviderEditor({ focus: false });
		finish({ ok: true, provider: 'current-service', model: 'first-model' });
		expect(await checking).toBe(false);
		expect(state.lastReadiness).toBeNull();
		expect(state.providerCurrentModel).toBeUndefined();
	});
	it('does not chain a response test after endpoint save completes for a previous instance', async () => {
		openProviderEditor('add');
		shortcuts
			.find((button) => button.dataset.providerShortcut === 'custom')
			?.listeners.get('click')?.({});
		control('provider-endpoint-name').value = 'Disposable server';
		control('provider-base-url').value = 'http://192.0.2.1:8080/v1';
		fire('provider-details-next');
		control('provider-model-manual').checked = true;
		fire('provider-model-manual', 'change');
		control('provider-model-id').value = 'team/test-model';
		fire('provider-model-id', 'input');
		let finish!: (value: unknown) => void;
		let tests = 0;
		state.api.providerEndpoint = () =>
			new Promise((resolve) => {
				finish = resolve;
			});
		state.api.readiness = async () => {
			tests++;
			return { ok: true };
		};
		fire('test-provider');
		expect(typeof finish).toBe('function');
		state.currentSnapshot = snapshot('/another-isolated-home');
		resetProviderState();
		finish(settings());
		// Instance switching normally reloads the page and is blocked while busy.
		// Simulate an externally changed home here to exercise request ownership;
		// the obsolete request must not clear another operation's busy state.
		for (let index = 0; index < 50; index++)
			await new Promise<void>((resolve) => queueMicrotask(resolve));
		expect(tests).toBe(0);
		expect(state.providerSummaries).toEqual([]);
		expect(state.providerCurrentModel).toBeUndefined();
		expect(state.lastReadiness).toBeNull();
	});
});

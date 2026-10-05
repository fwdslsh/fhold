import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clearClientKey, renderCredentials } from '../admin/access.js';
import {
	restoreInput,
	restoreSignature,
	invalidateRestorePreview,
	renderRestorePlan
} from '../admin/backup.js';
import { bindBackupEvents, bindInstanceRestoreEvents, updateBackupScope } from '../admin/backup.js';
import {
	bindConnectionsEvents,
	loadClientKey,
	renderConnectionDetails,
	renderNetworkDetails,
	showPortalTokenForm
} from '../admin/connections.js';
import { bindConfigurationEvents } from '../admin/configuration.js';
import { offerRestart, renderRestartStatus, requestStackAction } from '../admin/restart.js';
import { endpoint, isHealthy, promptVisible } from '../admin/model.js';
import { bindPreferencesEvents, renderPreferences } from '../admin/preferences.js';
import { bindRecoveryEvents, recoveryInput, renderRecovery, renderRecoveryStatus, updateRecoveryFields } from '../admin/recovery.js';
import {
	bindRemoteEvents,
	renderRemoteStatus,
	remoteStageText,
	recallStatusLabel
} from '../admin/remote.js';
import { resetOAuthAttempt, renderProviders, loadProviders } from '../admin/providers.js';
import { bindRuntimeEvents, renderPhase, renderServices } from '../admin/runtime.js';
import { render, refresh } from '../admin/snapshot.js';
import { createAdminState, state } from '../admin/state.js';
import {
	initializeAdmin,
	renderWelcome,
	bindInstanceEvents,
	showInstances
} from '../admin/instances.js';
import {
	captureDirtyForms,
	operation,
	restoreDirtyForms,
	setFormClean,
	showClient,
	showView
} from '../admin/ui.js';

const admin = join(import.meta.dir, '..', 'admin');
const html = readFileSync(join(admin, 'index.html'), 'utf8');

// A small DOM double exercises renderer decisions without installing a browser DOM library.
// The real Chromium layout, keyboard, IPC and Docker journey runs in admin:e2e.
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
	dataset: Record<string, string> = {};
	children: Control[] = [];
	elements?: Control[];
	form?: Control;
	attributes = new Map<string, string>();
	listeners = new Map<string, (event: unknown) => unknown>();
	focused = false;
	open = false;
	get options() {
		return this.children;
	}
	showModal() {
		this.open = true;
	}
	close() {
		this.open = false;
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
	contains(control: Control) {
		return this.children.includes(control);
	}
	focus() {
		this.focused = true;
	}
	scrollIntoView() {}
}

let controls: Map<string, Control>;
let selectors: Map<string, Control[]>;
const savedGlobals = {
	document: globalThis.document,
	window: globalThis.window,
	HTMLInputElement: globalThis.HTMLInputElement
};
function control(id: string): Control {
	const result = controls.get(id);
	if (!result) throw new Error(`Unknown Admin control: ${id}`);
	return result;
}
function selector(name: string, ...elements: Control[]) {
	selectors.set(name, elements);
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
	selectors = new Map();
	control('install-automatic-ports').checked = true;
	control('new-instance-name').value = 'personal-agent';
	control('install-assistant-port').disabled = true;
	control('install-gateway-port').disabled = true;
	globalThis.document = {
		body: new Control(),
		getElementById: (id: string) => control(id),
		querySelectorAll: (name: string) => selectors.get(name) ?? [],
		createElement: () => new Control()
	} as unknown as Document;
	globalThis.HTMLInputElement = Control as unknown as typeof HTMLInputElement;
	globalThis.window = { confirm: () => false } as unknown as Window & typeof globalThis;
});
afterEach(() => {
	clearTimeout(state.noticeTimer);
	Object.assign(globalThis, savedGlobals);
});

describe('Admin static security boundary', () => {
	it('explains and exposes whole-instance snapshot/import as a separate stopped choice', async () => {
		expect(html).toContain('Entire instance (must be stopped)');
		expect(html).toContain('Import an entire instance instead');
		expect(html).toContain('do not install first');
		expect(html).toContain('The original instance must be stopped');
		control('backup-scope').value = 'instance';
		updateBackupScope();
		expect(control('backup-full-help').hidden).toBe(false);
		expect(control('backup-sensitive-options').hidden).toBe(true);
		expect(control('export-backup').textContent).toBe('Export entire instance');
		let exported = false;
		state.api = { confirmRestart: async () => false, backup: async () => { exported = true; } };
		bindBackupEvents();
		await control('backup-form').listeners.get('submit')?.({ preventDefault() {} });
		expect(exported).toBe(false);
	});
	it('requires a reviewed, unchanged full-instance preview and native confirmation before import', async () => {
		let imported = false;
		state.api = { restoreInstance: async () => { imported = true; }, confirmRestart: async () => false };
		bindInstanceRestoreEvents();
		control('instance-restore-panel').open = true;
		control('instance-restore-panel').listeners.get('toggle')?.({});
		expect(control('install-form').hidden).toBe(true);
		control('instance-restore-source').value = '/export';
		await control('apply-instance-restore').listeners.get('click')?.({});
		expect(imported).toBe(false);
		state.instanceRestorePreview = { sourceHome: '/export', digest: 'a'.repeat(64) };
		await control('apply-instance-restore').listeners.get('click')?.({});
		expect(imported).toBe(false);
		control('instance-restore-source').listeners.get('input')?.({});
		expect(state.instanceRestorePreview).toBeNull();
		expect(control('apply-instance-restore').disabled).toBe(true);
		control('instance-restore-panel').open = false;
		control('instance-restore-panel').listeners.get('toggle')?.({});
		expect(control('install-form').hidden).toBe(false);
	});
	it('explains portable content versus same-instance runtime recovery and keeps storage credentials out of saved settings', () => {
		expect(html).toContain('Import / export');
		expect(html).toContain('Ephemeral container support');
		expect(html).toContain('different formats and are not interchangeable');
		expect(html).toContain('No native conversations or remote sign-ins');
		expect(html).toContain('native tool versions must match');
		expect(html).toContain('Guardian/portal state');
		expect(html).toContain('Initialize new destination');
		expect(html).toContain('To import portable content, create a fresh instance');
		expect(html).toContain('never overwrites surviving local data');
		expect(html).toContain('id="runtime-recovery-connection-string" type="password"');
	});
	it('puts installation and logs before import/export and keeps ephemeral support last in one System view', () => {
		const start = html.indexOf('<section id="view-system"');
		const system = html.slice(start, html.indexOf('</main>', start));
		const ids = ['installation-details', 'recent-logs', 'import-export', 'runtime-recovery'];
		const positions = ids.map((id) => system.indexOf(`<details id="${id}"`));
		expect(positions.every((position) => position >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
		expect((html.match(/data-view-panel="system"/g) || []).length).toBe(1);
		expect(html).toContain('data-view="system" aria-controls="view-system"');
		expect(html).not.toContain('id="view-diagnostics"');
		expect(html).not.toContain('id="backup-overview-heading"');
		expect(html).toContain('Import from an fhold export');
		expect(html).toContain('Export portable content');
	});
	it('never programmatically resizes production windows; size changes exist only in the E2E harness', () => {
		const sourceDirectory = join(import.meta.dir);
		const productionSources = readdirSync(sourceDirectory)
			.filter(
				(name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'admin-e2e.ts'
			)
			.map((name) => join(sourceDirectory, name));
		const rendererSources = readdirSync(admin)
			.filter((name) => name.endsWith('.js'))
			.map((name) => join(admin, name));
		for (const path of [...productionSources, ...rendererSources]) {
			expect(readFileSync(path, 'utf8')).not.toMatch(
				/\.\s*(?:setSize|setContentSize|setBounds|resizeTo|resizeBy|maximize|unmaximize|setFullScreen)\s*\(/
			);
		}
		const main = readFileSync(join(sourceDirectory, 'admin-app.ts'), 'utf8');
		expect(main).toContain('width: 1120');
		expect(main).toContain('height: 780');
		expect(main).not.toContain('resizable: false');
	});
	it('shows previous, default and recent instances without fetching a stack snapshot', async () => {
		state.api = {
			welcome: async () => ({
				defaultInstance: { kind: 'local', homeDir: '/default' },
				recentInstances: [
					{ kind: 'local', homeDir: '/previous' },
					{ kind: 'local', homeDir: '/other' }
				]
			}),
			snapshot: async () => {
				throw new Error('must not fetch before selection');
			}
		};
		await initializeAdmin();
		expect(control('instance-welcome').hidden).toBe(false);
		expect(control('app-shell').hidden).toBe(true);
		expect(control('primary-instance-path').textContent).toBe('/previous');
		expect(control('open-recent-instance').textContent).toBe('Open previous instance');
		expect(control('default-instance-option').hidden).toBe(false);
		expect(control('recent-instances').children.length).toBe(1);
		expect(control('skip-link').getAttribute('href')).toBe('#instance-welcome');
	});

	it('offers default setup on first launch and cancelling the folder picker does nothing', async () => {
		renderWelcome({ defaultInstance: { kind: 'local', homeDir: '/default' }, recentInstances: [] });
		expect(control('open-recent-instance').textContent).toBe('Open default instance');
		expect(control('default-instance-option').hidden).toBe(true);
		let opened = false;
		state.api = {
			chooseDirectory: async () => undefined,
			openInstance: async () => {
				opened = true;
			}
		};
		bindInstanceEvents();
		await control('choose-instance').listeners.get('click')?.({});
		expect(opened).toBe(false);
	});

	it('does not switch with unsaved changes unless the user confirms', async () => {
		state.dirtyForms.add('connections-form');
		let closed = false;
		state.api = {
			closeInstance: async () => {
				closed = true;
			}
		};
		await showInstances();
		expect(closed).toBe(false);
	});
	it('waits for background provider discovery before switching instances', async () => {
		let finish!: () => void;
		state.providerLoadPromise = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let closed = false;
		state.api = {
			closeInstance: async () => {
				closed = true;
			}
		};
		const switching = showInstances();
		expect(closed).toBe(false);
		expect(state.operationInFlight).toBe(true);
		finish();
		await switching;
		expect(closed).toBe(true);
		expect(state.operationInFlight).toBe(false);
	});
	it('allows switching once a failed background provider lookup settles', async () => {
		state.providerLoadPromise = Promise.reject(new Error('agent restarting'));
		let closed = false;
		state.api = {
			closeInstance: async () => {
				closed = true;
			}
		};
		await showInstances();
		expect(closed).toBe(true);
		expect(state.operationInFlight).toBe(false);
	});
	it('choosing or cancelling a new folder does not install or select it', async () => {
		let prepared = false;
		state.api = {
			chooseDirectory: async ({ purpose }) => {
				expect(purpose).toBe('new-instance');
				return '/new-instance';
			},
			prepareNewInstance: async () => {
				prepared = true;
			}
		};
		bindInstanceEvents();
		await control('new-instance-browse').listeners.get('click')?.({});
		expect(control('new-instance-home').value).toBe('/new-instance');
		expect(prepared).toBe(false);
		state.api.chooseDirectory = async () => undefined;
		await control('new-instance-browse').listeners.get('click')?.({});
		expect(control('new-instance-home').value).toBe('/new-instance');
		expect(prepared).toBe(false);
	});
	it('continues new setup only after submitting the folder and reloads the renderer', async () => {
		let reloads = 0;
		globalThis.window = {
			location: {
				reload: () => {
					reloads++;
				}
			}
		} as unknown as Window & typeof globalThis;
		let target: unknown;
		state.api = {
			prepareNewInstance: async (value) => {
				target = value;
			},
			openInstance: async () => {
				throw new Error('must use the fresh-setup boundary');
			},
			install: async () => {
				throw new Error('must wait for install confirmation');
			}
		};
		control('new-instance-home').value = ' /chosen/new-instance ';
		bindInstanceEvents();
		await control('new-instance-form').listeners.get('submit')?.({ preventDefault() {} });
		expect(target).toEqual({
			kind: 'local',
			homeDir: '/chosen/new-instance',
			name: 'personal-agent'
		});
		expect(reloads).toBe(1);
		expect(state.operationInFlight).toBe(false);
	});
	it('suggests a named default folder and leaves manually chosen folders alone', () => {
		bindInstanceEvents();
		renderWelcome({
			defaultInstance: { kind: 'local', homeDir: '/user/fhold/instances/default' },
			instancesDirectory: '/user/fhold/instances',
			recentInstances: []
		});
		expect(control('new-instance-home').value).toBe('/user/fhold/instances/personal-agent');
		control('new-instance-name').value = 'april';
		control('new-instance-name').listeners.get('input')?.({});
		expect(control('new-instance-home').value).toBe('/user/fhold/instances/april');
		control('new-instance-home').value = '/custom/my-agent';
		control('new-instance-name').value = 'may';
		control('new-instance-name').listeners.get('input')?.({});
		expect(control('new-instance-home').value).toBe('/custom/my-agent');
	});
	it('keeps the new folder input after rejection and blocks duplicate submissions', async () => {
		let calls = 0;
		state.api = {
			prepareNewInstance: async () => {
				calls++;
				throw new Error('Choose an empty folder.');
			}
		};
		control('new-instance-home').value = '/already-installed';
		bindInstanceEvents();
		const submit = control('new-instance-form').listeners.get('submit');
		await submit?.({ preventDefault() {} });
		expect(control('new-instance-home').value).toBe('/already-installed');
		expect(control('notice-message').textContent).toBe('Choose an empty folder.');
		state.operationInFlight = true;
		await submit?.({ preventDefault() {} });
		expect(calls).toBe(1);
	});
	it('requires Docker readiness before installing and refreshes quietly without clearing errors', async () => {
		const snapshot = {
			phase: 'not_installed',
			config: {
				deployment: { projectName: 'fhold-test' },
				assistant: { port: 4096 },
				gateway: { port: 9180 }
			},
			installationReadiness: { ok: false, message: 'Docker is stopped.' }
		};
		render(snapshot);
		expect(control('install').disabled).toBe(true);
		expect(control('install-prerequisite').textContent).toBe('Docker is stopped.');
		expect(control('check-prerequisites').hidden).toBe(false);
		state.api = { snapshot: async () => ({ ...snapshot, installationReadiness: { ok: true } }) };
		control('notice').className = 'notice error';
		control('notice').hidden = false;
		await refresh(true);
		expect(control('install').disabled).toBe(false);
		expect(control('check-prerequisites').hidden).toBe(true);
		expect(control('notice').hidden).toBe(false);
		expect(control('refresh').textContent).toBe('Status up to date');
	});
	it('retains a chosen instance name and ports while rechecking prerequisites', () => {
		const snapshot = {
			phase: 'not_installed',
			config: {
				deployment: { projectName: 'default-name' },
				assistant: { port: 3810 },
				gateway: { port: 3830 }
			}
		};
		render(snapshot);
		control('install-instance-name').value = 'my-agent';
		control('install-automatic-ports').checked = false;
		control('install-assistant-port').value = '3910';
		control('install-gateway-port').value = '3930';
		render(snapshot);
		expect(control('install-instance-name').value).toBe('my-agent');
		expect(control('install-assistant-port').value).toBe('3910');
		expect(control('install-gateway-port').value).toBe('3930');
		expect(control('install-automatic-ports').checked).toBe(false);
	});
	it('hides port controls in Advanced and keeps automatic and manual install choices separate', async () => {
		expect(html).toContain('<details id="install-advanced" class="disclosure">');
		expect(html).toContain('id="install-automatic-ports" type="checkbox" checked');
		const config = {
			deployment: { projectName: 'agent' },
			assistant: { port: 3810 },
			gateway: { port: 3830 }
		};
		state.currentConfig = config;
		control('install-instance-name').value = 'my-agent';
		control('install-assistant-port').value = '49110';
		control('install-gateway-port').value = '49130';
		const calls: unknown[] = [];
		state.api = {
			install: async (...args) => {
				calls.push(args);
				return { ok: true };
			}
		};
		bindRuntimeEvents();
		await control('install-form').listeners.get('submit')?.({ preventDefault() {} });
		expect(calls[0]).toEqual([{ ...config, deployment: { projectName: 'my-agent' } }, true]);
		control('install-automatic-ports').checked = false;
		control('install-automatic-ports').listeners.get('change')?.({});
		expect(control('install-assistant-port').disabled).toBe(false);
		expect(control('install-gateway-port').disabled).toBe(false);
		await control('install-form').listeners.get('submit')?.({ preventDefault() {} });
		expect(calls[1]).toEqual([
			{
				...config,
				deployment: { projectName: 'my-agent' },
				assistant: { port: 49110 },
				gateway: { port: 49130 }
			},
			false
		]);
		control('install-gateway-port').value = '49110';
		await control('install-form').listeners.get('submit')?.({ preventDefault() {} });
		expect(calls).toHaveLength(2);
		expect(control('install-gateway-port').focused).toBe(true);
	});

	it('prioritizes startup recovery without claiming that the agent is running', () => {
		renderServices({
			phase: 'setup_incomplete',
			services: [],
			config: {
				gateway: { enabled: false },
				portals: { discord: { enabled: false }, slack: { enabled: false } }
			}
		});
		expect(control('setup-recovery').hidden).toBe(false);
		expect(control('provider-connection').hidden).toBe(true);
		expect(control('setup-runtime').textContent).toBe('Agent startup needs attention.');
		expect(control('view-title').textContent).toBe('Start your agent');
	});

	it('selects an existing native account and hides a redundant single sign-in method', () => {
		renderProviders([
			{
				id: 'example',
				name: 'Example',
				authenticated: true,
				authMethods: [{ index: 0, type: 'api', label: 'API key' }]
			}
		]);
		expect(control('provider').value).toBe('example');
		expect(control('provider-method').value).toBe('0');
		expect(control('provider-method-field').hidden).toBe(true);
		expect(control('provider-status').children[1].textContent).toContain('Verify connection');
		expect(control('test-provider').hidden).toBe(false);
	});

	it('offers verification after account selection, not before it', () => {
		state.currentSnapshot = { phase: 'setup_incomplete' };
		renderProviders([
			{ id: 'example', name: 'Example', authMethods: [{ index: 0, type: 'api', label: 'API key' }] }
		]);
		expect(control('provider').value).toBe('');
		expect(control('test-provider').hidden).toBe(true);
		expect(html.indexOf('id="test-provider"')).toBeGreaterThan(html.indexOf('id="provider-form"'));
	});

	it('keeps provider transport failures in technical details and offers a recovery action', async () => {
		state.api = {
			providers: async () => {
				throw new Error('Error invoking remote method admin:providers: fetch failed');
			}
		};
		await loadProviders(false);
		expect(control('provider-status').children[0].textContent).toBe('Cannot reach your agent.');
		expect(control('provider-status').children[1].textContent).toContain('Refresh accounts');
		expect(control('provider-status').children[1].textContent).not.toContain(
			'invoking remote method'
		);
		expect(control('provider-result').value).toContain('fetch failed');
		expect(state.providerLoadPromise).toBeUndefined();
		await loadProviders(true);
		expect(control('notice-message').textContent).toBe(
			'Cannot reach your agent. Check that it is running, then refresh accounts.'
		);
	});

	it('opens optional portal tokens before focusing a validation or setup target', async () => {
		control('token-portal').value = 'discord';
		showPortalTokenForm('discord');
		await Bun.sleep(0);
		expect(control('portal-tokens').open).toBe(true);
		expect(control('bot-token').focused).toBe(true);
	});

	it('offers per-identity management without revealing or retaining a previous key', () => {
		const snapshot = {
			config: {
				credentials: { owner: { policy: 'full' }, guest: { policy: 'chat' } },
				portals: { discord: { credential: 'guest' }, slack: { credential: 'guest' } }
			}
		};
		state.currentSnapshot = snapshot;
		renderCredentials(snapshot);
		const row = control('credential-policies').children[0];
		expect(row.children).toHaveLength(4);
		expect(row.children[0].textContent).toBe('guest');
		control('credential-key').value = 'previous-private-key';
		control('credential-key').type = 'text';
		control('show-credential-key').checked = true;
		row.children[3].listeners.get('click')?.({});
		expect(control('key-manager-details').open).toBe(true);
		expect(control('credential-action-name').value).toBe('guest');
		expect(control('credential-key').value).toBe('');
		expect(control('credential-key').type).toBe('password');
		expect(control('credential-action-name').focused).toBe(true);
	});

	it('uses human-readable remote stages and never equates startup with connection readiness', () => {
		expect(recallStatusLabel({ status: 'installed' })).toBe('Installed');
		expect(recallStatusLabel({ status: 'approval-needed' })).toBe('Approval needed');
		expect(recallStatusLabel({ status: 'ready' })).toBe('Ready');
		expect(recallStatusLabel({ status: 'ready', managed: true })).toBe('Managed · ready');
		expect(recallStatusLabel({ status: 'installed', managed: true })).toBe('Managed · disabled');
		expect(recallStatusLabel({ status: 'approval-needed', managed: true })).toBe(
			'Managed · needs attention'
		);
		expect(recallStatusLabel(undefined)).toBe('Not checked');
		expect(remoteStageText({ stage: 'sandbox' })).toContain('safely run Codex');
		expect(remoteStageText({ stage: 'container-isolation' })).toContain('explicitly selected');
		expect(remoteStageText({ stage: 'enabling', enabled: true })).toContain(
			'verify a real request'
		);
		expect(remoteStageText({ error: 'Native failure' })).toBe('Native failure');
	});
	it('keeps workspace isolation as the default and explains an explicit full-container choice without accepting trust', () => {
		expect(html).toContain(
			'<option value="danger-full-access">Container isolation (full container access)</option>'
		);
		expect(html).toContain('aria-describedby="remote-sandbox-help"');
		bindRemoteEvents();
		control('remote-sandbox').value = 'danger-full-access';
		control('remote-sandbox').listeners.get('change')?.({});
		expect(control('remote-sandbox-help').textContent).toContain('every file, credential');
		expect(control('remote-sandbox-help').textContent).toContain(
			'Task permissions follow the instance policy'
		);
		expect(control('remote-trust').checked).toBe(false);
		control('remote-sandbox').value = 'workspace-write';
		control('remote-sandbox').listeners.get('change')?.({});
		expect(control('remote-sandbox-help').textContent).toContain('native sandbox');
	});

	it('labels both native remote workers experimental without labeling Claude Desktop MCP', () => {
		for (const name of ['Claude Code', 'Codex'])
			expect(html).toContain(`<h3>${name} <span class="card-label">Experimental</span></h3>`);
		expect(html).toContain('<h3>Claude Desktop</h3>');
		for (const tool of ['claude', 'codex']) {
			const button = new Control();
			button.dataset.remoteConnect = tool;
			selector('[data-remote-enable], [data-remote-connect], [data-codex-recall-review]', button);
			bindRemoteEvents();
			button.listeners.get('click')?.({});
			expect(control('remote-heading').textContent).toContain('(experimental)');
		}
	});

	it('requires explicit remote trust, reports setup failure, and clears native answers before IPC', async () => {
		const button = new Control();
		button.dataset.remoteEnable = 'claude';
		selector('[data-remote-enable], [data-remote-connect], [data-codex-recall-review]', button);
		let calls = 0;
		let answer: unknown;
		let confirmed = false;
		state.api = {
			confirmRestart: async () => confirmed,
			remote: async (request: { action: string; input?: string }) => {
				calls++;
				if (request.action === 'input') {
					answer = request.input;
					expect(control('remote-answer').value).toBe('');
					return {};
				}
				throw new Error('Native setup prerequisite failed.');
			}
		};
		bindRemoteEvents();
		button.listeners.get('click')?.({});
		expect(control('remote-dialog').open).toBe(true);
		expect(control('remote-heading').textContent).toBe(
			'Enable Claude Remote Control (experimental)'
		);
		expect(control('remote-trust').checked).toBe(false);
		expect(control('remote-sandbox-field').hidden).toBe(true);
		expect(control('remote-prompts').hidden).toBe(true);
		expect(control('remote-advanced').open).toBe(false);
		expect(control('remote-send').hidden).toBe(true);
		await control('remote-form').listeners.get('submit')?.({ preventDefault() {} });
		expect(calls).toBe(0);
		control('remote-trust').checked = true;
		await control('remote-form').listeners.get('submit')?.({ preventDefault() {} });
		expect(calls).toBe(0);
		expect(control('remote-stage').textContent).toContain('postponed');
		expect(state.operationInFlight).toBe(false);
		confirmed = true;
		await control('remote-form').listeners.get('submit')?.({ preventDefault() {} });
		expect(control('remote-stage').textContent).toBe('Native setup prerequisite failed.');
		expect(state.operationInFlight).toBe(false);
		control('remote-answer').value = 'private-native-code';
		await control('remote-send').listeners.get('click')?.({});
		expect(answer).toBe('private-native-code');
		await control('remote-cancel').listeners.get('click')?.({});
		expect(control('remote-dialog').open).toBe(false);
	});

	it('requires an explicit Codex recall choice, sends only the current digest, and rejects stale reviews', async () => {
		const button = new Control();
		button.dataset.codexRecallReview = '';
		selector('[data-remote-enable], [data-remote-connect], [data-codex-recall-review]', button);
		const review = {
			status: 'approval-needed',
			digest: 'a'.repeat(64),
			hooks: [
				{
					event: 'sessionStart',
					command: 'literal <script> is text',
					sourcePath: '/plugin',
					hash: 'sha256:abc',
					trust: 'modified',
					enabled: true
				}
			]
		};
		const calls: unknown[] = [];
		state.api = {
			codexRecall: async (request: { action: string; digest?: string }) => {
				calls.push(request);
				if (request.action === 'review') return review;
				throw new Error('AKM hooks changed since review.');
			}
		};
		bindRemoteEvents();
		button.listeners.get('click')?.({});
		await Bun.sleep(1);
		expect(control('remote-recall').checked).toBe(false);
		expect(control('remote-trust-field').hidden).toBe(true);
		expect(control('remote-recall-heading').hidden).toBe(true);
		expect(control('remote-recall-definitions').value).toContain('literal <script> is text');
		expect(control('remote-recall-status').textContent).toContain('definitions changed');
		expect(control('codex-recall-status').textContent).toBe('Approval needed');
		renderRemoteStatus({ config: { assistant: {} } });
		expect(control('codex-recall-status').textContent).toBe('Not checked');
		await control('remote-form').listeners.get('submit')?.({ preventDefault() {} });
		expect(calls).toEqual([{ action: 'review' }]);
		control('remote-recall').checked = true;
		await control('remote-form').listeners.get('submit')?.({ preventDefault() {} });
		expect(calls).toEqual([
			{ action: 'review' },
			{ action: 'approve', digest: review.digest, confirmed: true },
			{ action: 'review' }
		]);
		expect(control('remote-stage').textContent).toContain('changed since review');
		expect(control('remote-recall').checked).toBe(false);
		await control('remote-cancel').listeners.get('click')?.({});
	});
	it('shows managed recall without offering personal hook approval or disable', async () => {
		const button = new Control();
		button.dataset.codexRecallReview = '';
		selector('[data-remote-enable], [data-remote-connect], [data-codex-recall-review]', button);
		const calls: string[] = [];
		state.api = {
			codexRecall: async (request: { action: string }) => {
				calls.push(request.action);
				return {
					managed: true,
					status: 'ready',
					digest: 'a'.repeat(64),
					hooks: [
						{
							event: 'sessionStart',
							command: 'managed handler',
							sourcePath: '/etc/codex/hooks.json',
							trust: 'managed',
							enabled: true
						}
					]
				};
			}
		};
		bindRemoteEvents();
		button.listeners.get('click')?.({});
		await Bun.sleep(1);
		expect(control('remote-recall').disabled).toBe(true);
		expect(control('remote-recall').required).toBe(false);
		expect(control('remote-begin').hidden).toBe(true);
		expect(control('remote-recall-disable').hidden).toBe(true);
		expect(control('codex-recall-status').textContent).toBe('Managed · ready');
		await control('remote-form').listeners.get('submit')?.({ preventDefault() {} });
		await control('remote-recall-disable').listeners.get('click')?.({});
		expect(calls).toEqual(['review']);
		await control('remote-cancel').listeners.get('click')?.({});
	});
	it('loads local modules under a closed CSP with no renderer network access', () => {
		const csp = html.match(/content="([^"]+)"/)?.[1] ?? '';
		expect(csp).toContain("default-src 'self'");
		expect(csp).toContain("script-src 'self'");
		expect(csp).toContain("connect-src 'none'");
		expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:/);
		const scripts = [...html.matchAll(/<script\b([^>]*)>/g)];
		expect(scripts).toHaveLength(1);
		expect(scripts[0][1]).toMatch(/\btype="module"/);
		expect(scripts[0][1]).toMatch(/\bsrc="admin\.js"/);
	});

	it('keeps every credential display masked initially', () => {
		for (const id of [
			'provider-key',
			'bot-token',
			'app-token',
			'credential-key',
			'direct-password',
		'claude-key',
		'mcp-key',
		'runtime-recovery-connection-string'
		]) {
			const input = [...html.matchAll(/<input\b[^>]*>/g)].find((match) =>
				match[0].includes(`id="${id}"`)
			)?.[0];
			expect(input).toBeDefined();
			expect(input).toMatch(/\btype="password"/);
			expect(input).toMatch(/\bautocomplete="off"/);
		}
	});

	it('keeps installer and management hidden until the first snapshot', () => {
		for (const id of ['install-section', 'app-shell']) {
			const element = [...html.matchAll(/<[^>]+>/g)].find((match) =>
				match[0].includes(`id="${id}"`)
			)?.[0];
			expect(element).toMatch(/\bhidden\b/);
		}
	});
});

	describe('Admin runtime recovery controls', () => {
	function fixture(running = true) {
		const settings = { enabled: false, destination: '', instanceId: 'my-agent', intervalSeconds: 60, maxUnsavedSeconds: 300, operationTimeoutSeconds: 120, authentication: 'connection-string', clientId: '' };
		const recovery = { settings, selection: { version: 1, paths: [], sqlite: [], excludePaths: [], externalMounts: [], recoverMounts: [], autoExcludeNetworkMounts: false }, digest: 'reviewed-digest', credentialConfigured: false, policyPath: '/home/config/recovery/include.json' };
		state.currentSnapshot = { config: { recovery: settings }, recovery, services: running ? [{ name: 'assistant', state: 'running', health: 'healthy' }] : [] };
		renderRecovery(state.currentSnapshot);
		return state.currentSnapshot;
	}
	it('defaults off, hides advanced storage fields and refuses offline operations while writers run', () => {
		const snapshot = fixture();
		expect(control('runtime-recovery-settings').hidden).toBe(true);
		expect(control('runtime-recovery-status').children[0].textContent).toContain('off');
		snapshot.config.recovery.enabled = true;
		renderRecovery(snapshot);
		expect(control('runtime-recovery-settings').hidden).toBe(false);
		expect(control('initialize-recovery').disabled).toBe(true);
		expect(control('restore-runtime-recovery').disabled).toBe(true);
		snapshot.services = [];
		updateRecoveryFields();
		expect(control('initialize-recovery').disabled).toBe(false);
	});
	it('recomputes offline controls after a completed lifecycle operation rather than restoring stale disabled flags', async () => {
		const snapshot = fixture();
		snapshot.config.recovery.enabled = true;
		renderRecovery(snapshot);
		selector('button', control('initialize-recovery'), control('restore-runtime-recovery'));
		await operation('Stopping', async () => {
			snapshot.services = [];
			updateRecoveryFields();
			expect(control('initialize-recovery').disabled).toBe(true);
			return 'stopped';
		});
		expect(control('initialize-recovery').disabled).toBe(false);
		expect(control('restore-runtime-recovery').disabled).toBe(false);
		snapshot.services = [{ name: 'assistant', state: 'paused', health: '' }];
		updateRecoveryFields();
		expect(control('initialize-recovery').disabled).toBe(true);
	});
	it('supports a directory with spaces and arbitrary path/database lists without copying credentials into the payload', () => {
		fixture();
		control('runtime-recovery-enabled').checked = true;
		control('runtime-recovery-directory').value = '/private/my backups#1?test';
		control('runtime-recovery-paths').value = '/home/fhold/.my-client\n/work/additional';
		control('runtime-recovery-sqlite').value = '/home/fhold/.my-client/state.sqlite';
		control('runtime-recovery-connection-string').value = 'secret must not enter settings';
		const value = recoveryInput();
		expect(value.settings.destination).toBe('file:///private/my%20backups%231%3Ftest');
		expect(value.selection.paths).toEqual(['/home/fhold/.my-client', '/work/additional']);
		expect(value.selection.sqlite).toEqual(['/home/fhold/.my-client/state.sqlite']);
		expect(value.baselineDigest).toBe('reviewed-digest');
		expect(JSON.stringify(value)).not.toContain('secret must');
	});
	it('shows Blob credential presence without revealing it and guides deployment identity without host auth discovery', () => {
		const snapshot = fixture();
		snapshot.config.recovery.enabled = true;
		snapshot.config.recovery.destination = 'azblob://account123/private/my-agent';
		snapshot.recovery.credentialConfigured = true;
		renderRecovery(snapshot);
		expect(control('runtime-recovery-directory-field').hidden).toBe(true);
		expect(control('runtime-recovery-blob-field').hidden).toBe(false);
		expect(control('runtime-recovery-credential-status').textContent).toContain('value is not shown');
		expect(control('runtime-recovery-credential-form').hidden).toBe(false);
		control('runtime-recovery-auth').value = 'managed-identity';
		updateRecoveryFields();
		expect(control('runtime-recovery-client-id-field').hidden).toBe(false);
		expect(control('runtime-recovery-credential-form').hidden).toBe(true);
	});
	it('requires native confirmation for init/restore; cancel performs no recovery operation', async () => {
		const snapshot = fixture(false);
		snapshot.config.recovery.enabled = true;
		const calls: string[] = [];
		state.api = { confirmRestart: async (action: string) => { calls.push(action); return false; }, recovery: async () => { throw new Error('must not run after cancellation'); } };
		bindRecoveryEvents();
		await control('initialize-recovery').listeners.get('click')?.({});
		await control('restore-runtime-recovery').listeners.get('click')?.({});
		expect(calls).toEqual(['recovery-init', 'recovery-restore']);
	});
	it('never claims checkpoint readiness from configuration or a stopped worker', () => {
		fixture();
		renderRecoveryStatus({ state: 'configured' });
		expect(control('runtime-recovery-status').children[0].textContent).toContain('not checked');
		renderRecoveryStatus({ state: 'stopped' });
		expect(control('runtime-recovery-status').children[0].textContent).toContain('stopped');
		renderRecoveryStatus({ state: 'ready', lastPublishedAt: Date.now() });
		expect(control('runtime-recovery-status').children[0].textContent).toBe('Checkpoint accepted.');
	});
});

describe('Admin renderer behavior', () => {
	it('keeps pending changes visible when restart is postponed, refreshed or navigation changes', async () => {
		state.currentSnapshot = {
			phase: 'ready', services: [{ name: 'assistant', state: 'running', health: 'healthy' }],
			pendingRestart: { required: true }
		};
		let applies = 0;
		state.api = {
			confirmRestart: async () => false,
			action: async () => { applies++; }
		};
		renderRestartStatus(state.currentSnapshot);
		await offerRestart();
		expect(applies).toBe(0);
		expect(control('pending-restart').hidden).toBe(false);
		expect(control('pending-restart-title').textContent).toBe('Pending restart');
		showView('system');
		expect(control('pending-restart').hidden).toBe(false);
		renderRestartStatus(structuredClone(state.currentSnapshot));
		expect(control('pending-restart').hidden).toBe(false);
	});

	it('applies only after confirmation, retains the alert on failure, and handles stopped instances', async () => {
		state.currentSnapshot = { phase: 'ready', services: [], pendingRestart: { required: true } };
		const calls: unknown[] = [];
		state.api = {
			confirmRestart: async (action) => { calls.push(action); return true; },
			action: async (...args) => { calls.push(args); throw new Error('Startup failed'); },
			snapshot: async () => { throw new Error('Docker unavailable'); }
		};
		renderRestartStatus(state.currentSnapshot);
		expect(control('apply-pending-restart').textContent).toBe('Start to apply');
		await offerRestart();
		expect(calls).toEqual(['start', ['start', true]]);
		expect(control('pending-restart').hidden).toBe(false);
		state.api.action = async (...args) => { calls.push(args); return { ok: true }; };
		await requestStackAction('restart');
		expect(calls.at(-1)).toEqual(['restart', true]);
		renderRestartStatus({ services: [], pendingRestart: { required: false } });
		expect(control('pending-restart').hidden).toBe(true);
	});
	it('groups settings by task and removes the duplicate overview catalog', () => {
		expect(html).not.toContain('Things to try');
		expect(html).not.toContain('choice-grid');
		expect([...html.matchAll(/data-view="/g)].length).toBe(5);
		expect(html).toContain('data-view="system"');
		expect(html.indexOf('id="agent-preferences"')).toBeGreaterThan(
			html.indexOf('id="view-provider"')
		);
		expect(html.indexOf('id="network-settings"')).toBeLessThan(html.indexOf('id="view-access"'));
	});

	it('captures and restores externally associated MCP configuration controls', () => {
		const form = control('connections-form');
		const gateway = control('gateway');
		form.elements = [gateway];
		gateway.form = form;
		gateway.type = 'checkbox';
		gateway.checked = true;
		state.dirtyForms.add('connections-form');
		const drafts = captureDirtyForms();
		expect(drafts['connections-form'].gateway).toEqual({ checked: true });
		gateway.checked = false;
		restoreDirtyForms(drafts);
		expect(gateway.checked).toBe(true);
	});
	it('labels Guardian as an MCP API and keeps diagnostic endpoints copy-only', () => {
		expect(html).not.toContain('Protected-access');
		expect(html).toContain('Guardian MCP bind address');
		expect(html).toContain('not a website');
		expect(html).toContain('selected access key’s policy');
		for (const id of ['guardian-mcp-url-detail', 'guardian-health-url-detail']) {
			expect(html).toContain(`data-copy-field="${id}"`);
			expect(html).toContain(`<code id="${id}">`);
		}
		const link = html.match(/<a\b[^>]*id="assistant-url-detail"[^>]*>/)?.[0];
		expect(link).toContain('href="about:blank"');
		expect(link).toContain('target="_blank"');
		expect(link).toContain('rel="noreferrer"');
		expect(link).toContain('hidden');
		expect(link).not.toContain('data-external-url');
		expect(link).not.toContain('onclick');
		const css = readFileSync(join(admin, 'admin.css'), 'utf8');
		expect(css).toContain(
			':where(a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])):focus-visible'
		);
		expect(css).toContain('.field textarea {');
	});

	it('renders a normal browser link and copyable dialable Guardian endpoints', async () => {
		const link = control('assistant-url-detail');
		link.hidden = true;
		const copy = new Control();
		copy.dataset.copyField = 'guardian-mcp-url-detail';
		selector('[data-copy-field]', copy);
		const copied: string[] = [];
		state.api = {
			copyText: async (value: string) => {
				copied.push(value);
			}
		};
		bindConnectionsEvents();
		expect(link.hidden).toBe(true);
		expect(link.listeners.has('click')).toBe(false);
		renderNetworkDetails({
			config: {
				assistant: { bindAddress: '192.0.2.10', port: 3810 },
				gateway: { bindAddress: '::', port: 3830, enabled: false }
			}
		});
		expect(link.textContent).toBe('http://192.0.2.10:3810');
		expect(link.getAttribute('href')).toBe(link.textContent);
		expect(link.hidden).toBe(false);
		expect(link.getAttribute('tabindex')).toBeNull();
		expect(control('guardian-url').textContent).toBe('http://[::1]:3830/mcp');
		expect(control('guardian-mcp-url-detail').textContent).toBe('http://[::1]:3830/mcp');
		expect(control('guardian-health-url-detail').textContent).toBe('http://[::1]:3830/health');
		expect(control('guardian-api-status').textContent).toContain('disabled');
		await copy.listeners.get('click')?.({});
		expect(copied).toEqual(['http://[::1]:3830/mcp']);
		renderNetworkDetails({
			config: {
				assistant: { bindAddress: '::1', port: 3810 },
				gateway: { bindAddress: '0.0.0.0', port: 3830, enabled: true }
			}
		});
		expect(link.getAttribute('href')).toBe('http://[::1]:3810');
		expect(control('guardian-health-url-detail').textContent).toBe('http://127.0.0.1:3830/health');
		expect(control('guardian-api-status').textContent).toContain('enabled');
	});

	it('offers the matching public MCPB download and hides unavailable links', () => {
		state.currentSnapshot = { config: { gateway: { enabled: false } } };
		const note =
			'Download the extension from the matching GitHub release and install it in Claude Desktop.';
		const extension =
			'https://github.com/fwdslsh/fhold/releases/download/0.1.2610041911-alpha.4/fhold-claude-desktop-0.1.2610041911-alpha.4.mcpb';
		const snapshot = {
			connectionDetails: {
				opencode: { url: 'http://127.0.0.1:3810', username: 'user' },
				claude: {
					url: 'http://127.0.0.1:3830/mcp',
					note,
					extension: extension as string | undefined
				},
				mcp: { url: 'http://127.0.0.1:3830/mcp' }
			}
		};
		renderConnectionDetails(snapshot);
		expect(control('claude-extension-help').textContent).toBe(note);
		expect(control('claude-extension-download').getAttribute('href')).toBe(extension);
		expect(control('claude-extension-download').hidden).toBe(false);
		expect(html).toContain('data-copy-field="claude-extension-help"');
		snapshot.connectionDetails.claude.extension = undefined;
		renderConnectionDetails(snapshot);
		expect(control('claude-extension-download').hidden).toBe(true);
		expect(control('claude-extension-download').getAttribute('href')).toBe('about:blank');
	});

	it('uses dialable wildcard and IPv6 addresses and reports unhealthy services', () => {
		expect(endpoint('0.0.0.0', 4096)).toBe('http://127.0.0.1:4096');
		expect(endpoint('::', 9180, '/mcp')).toBe('http://[::1]:9180/mcp');
		expect(endpoint('::1', 4096)).toBe('http://[::1]:4096');
		expect(isHealthy({ state: 'running', health: 'unhealthy' })).toBe(false);
		expect(isHealthy({ state: 'running', health: 'healthy' })).toBe(true);
		expect(isHealthy({ state: 'exited', health: 'healthy' })).toBe(false);
	});

	it('locks duplicate operations and restores controls when the request completes', async () => {
		const enabled = new Control();
		const previouslyDisabled = new Control();
		previouslyDisabled.disabled = true;
		selector('button', enabled, previouslyDisabled);
		let complete!: (value: string) => void;
		const pending = operation(
			'Saving',
			() =>
				new Promise<string>((resolve) => {
					complete = resolve;
				})
		);
		expect(state.operationInFlight).toBe(true);
		expect(enabled.disabled).toBe(true);
		expect(document.body.dataset.busy).toBe('true');
		expect(control('instance-welcome').getAttribute('aria-busy')).toBe('true');
		let duplicateCalled = false;
		expect(
			await operation('Duplicate', () => {
				duplicateCalled = true;
			})
		).toBeUndefined();
		expect(duplicateCalled).toBe(false);
		complete('saved');
		expect(await pending).toBe('saved');
		expect(state.operationInFlight).toBe(false);
		expect(enabled.disabled).toBe(false);
		expect(previouslyDisabled.disabled).toBe(true);
	});

	it('treats failed readiness and thrown errors as persistent accessible failures', async () => {
		const failed = await operation('Checking', async () => ({
			ok: false,
			error: 'Sign-in expired'
		}));
		expect(failed).toBeUndefined();
		expect(control('notice').hidden).toBe(true);
		expect(control('provider-status').getAttribute('role')).toBe('alert');
		expect(control('provider-status').getAttribute('aria-live')).toBe('assertive');
		expect(control('provider-badge').textContent).toBe('Needs attention');
		expect(state.noticeTimer).toBeUndefined();
		expect(state.operationInFlight).toBe(false);
		await operation('Saving', async () => {
			throw new Error('Docker unavailable');
		});
		expect(control('notice-message').textContent).toBe('Docker unavailable');
	});

	it('shows exactly the appropriate setup shell and gates management navigation', () => {
		const setup = new Control();
		const ready = new Control();
		selector('.setup-only', setup);
		selector('.ready-only', ready);
		renderPhase('not_installed');
		expect(control('install-section').hidden).toBe(false);
		expect(control('app-shell').hidden).toBe(true);
		expect(control('skip-link').getAttribute('href')).toBe('#install-section');
		state.currentSnapshot = { phase: 'setup_incomplete' };
		renderPhase('setup_incomplete');
		expect(control('install-section').hidden).toBe(true);
		expect(control('app-shell').hidden).toBe(false);
		expect(setup.hidden).toBe(false);
		expect(ready.hidden).toBe(true);
		expect(state.currentView).toBe('provider');
		showView('access');
		expect(state.currentView).toBe('provider');
		state.currentSnapshot = { phase: 'ready' };
		renderPhase('ready');
		expect(setup.hidden).toBe(true);
		expect(ready.hidden).toBe(false);
		showView('access', { focus: true });
		expect(state.currentView).toBe('access');
		expect(control('view-title').focused).toBe(true);
	});

	it('switches client recipes with keyboard focus and correct pressed state', () => {
		const openCode = new Control();
		openCode.dataset.clientSetup = 'opencode';
		const claude = new Control();
		claude.dataset.clientSetup = 'claude';
		selector('[data-client-setup]', openCode, claude);
		selector('[data-client-panel]', control('client-opencode'), control('client-claude'));
		control('client-opencode').dataset.clientPanel = 'opencode';
		control('client-claude').dataset.clientPanel = 'claude';
		showClient('claude', { focus: true });
		expect(control('client-opencode').hidden).toBe(true);
		expect(control('client-claude').hidden).toBe(false);
		expect(control('client-claude').focused).toBe(true);
		expect(claude.getAttribute('aria-pressed')).toBe('true');
		expect(openCode.getAttribute('aria-pressed')).toBe('false');
	});

	it('preserves only dirty form drafts, including unchecked preferences', () => {
		control('preferences-form').children = [control('agent-timezone'), control('automatic-memory')];
		control('agent-timezone').value = 'Europe/London';
		control('automatic-memory').type = 'checkbox';
		control('automatic-memory').checked = false;
		state.dirtyForms.add('preferences-form');
		const drafts = captureDirtyForms();
		expect(drafts).toEqual({
			'preferences-form': {
				'agent-timezone': { value: 'Europe/London' },
				'automatic-memory': { checked: false }
			}
		});
		control('agent-timezone').value = 'UTC';
		control('automatic-memory').checked = true;
		restoreDirtyForms(drafts);
		expect(control('agent-timezone').value).toBe('Europe/London');
		expect(control('automatic-memory').checked).toBe(false);
		restoreDirtyForms({ 'preferences-form': { 'assistant-port': { value: '9999' } } });
		expect(control('assistant-port').value).toBe('');
		setFormClean('preferences-form');
		expect(captureDirtyForms()).toEqual({});
	});

	it('requires explicit confirmation before loading a client key and clears revealed values', async () => {
		let loads = 0;
		state.api = {
			credentialKey: async () => {
				loads++;
				return { key: 'private-test-key' };
			}
		};
		control('mcp-credential').value = 'family';
		control('mcp-key').type = 'password';
		await loadClientKey('mcp', false);
		expect(loads).toBe(0);
		globalThis.window.confirm = () => true;
		await loadClientKey('mcp', false);
		expect(loads).toBe(1);
		expect(control('mcp-key').value).toBe('private-test-key');
		expect(control('mcp-key').type).toBe('password');
		control('mcp-key').type = 'text';
		control('show-mcp-key').checked = true;
		clearClientKey('mcp');
		expect(control('mcp-key').value).toBe('');
		expect(control('mcp-key').type).toBe('password');
		expect(control('show-mcp-key').checked).toBe(false);
	});

	it('invalidates restore approval when input changes and excludes opt-ins by default', () => {
		control('restore-source').value = ' /tmp/reviewed-backup ';
		const signature = restoreSignature();
		expect(restoreInput(false)).toEqual({
			sourceHome: '/tmp/reviewed-backup',
			apply: false,
			includeProviderAuth: false,
			includeUserEnv: false,
			includePortalMaps: false,
			includeOAuth: false
		});
		state.restorePreviewDigest = 'reviewed-digest';
		expect(restoreInput(true).previewDigest).toBe('reviewed-digest');
		control('restore-auth').checked = true;
		expect(restoreSignature()).not.toBe(signature);
		invalidateRestorePreview();
		expect(state.restorePreviewDigest).toBeNull();
		expect(control('apply-restore').disabled).toBe(true);
	});
	it('shows missing history outside technical details and never calls portable restore a complete migration', () => {
		const result = {
			copyCount: 3,
			conflicts: 0,
			warnings: [],
			reviewRequired: true,
			preservation: [
				{ category: 'Native history', disposition: 'review-required', note: 'Preserve separately.' }
			]
		};
		renderRestorePlan(result, false);
		const row = control('restore-preservation').children[0];
		expect(row.open).toBe(false);
		expect(row.children[0]?.children[0]?.textContent).toBe('Native history');
		expect(row.children[0]?.children[1]?.textContent).toBe('Separate recovery');
		expect(row.children[1]?.textContent).toBe('Preserve separately.');
		expect(control('restore-acknowledge-row').hidden).toBe(false);
		renderRestorePlan(result, true);
		expect(control('restore-summary').children[1]?.textContent).toContain(
			'does not restore native conversations'
		);
		expect(control('restore-acknowledge-row').hidden).toBe(true);
	});

	it('clears OAuth attempts and evaluates conditional provider prompts', () => {
		const secret = new Control();
		secret.value = 'one-time-value';
		selector('[data-oauth-key]', secret);
		state.activeOAuth = { provider: 'example' };
		control('oauth-code').value = 'one-time-code';
		resetOAuthAttempt();
		expect(state.activeOAuth).toBeNull();
		expect(secret.value).toBe('');
		expect(control('oauth-code').value).toBe('');
		expect(
			promptVisible({ when: { key: 'account', value: 'team', op: 'eq' } }, { account: 'personal' })
		).toBe(false);
		expect(
			promptVisible({ when: { key: 'account', value: 'team', op: 'neq' } }, { account: 'personal' })
		).toBe(true);
	});

	it('renders preferences without duplicate remote toggles or false connection readiness', () => {
		const snapshot = {
			config: {
				assistant: {
					timezone: 'America/Chicago',
					automaticMemory: false,
					codexRemote: true,
					claudeRemote: false
				}
			}
		};
		renderPreferences(snapshot);
		renderRemoteStatus(snapshot);
		expect(control('agent-timezone').value).toBe('America/Chicago');
		expect(control('automatic-memory').checked).toBe(false);
		expect(control('codex-remote-status').textContent).toContain('client connection not checked');
		expect(control('claude-remote-status').textContent).toBe('Startup off');
		expect(html).not.toContain('id="codex-remote"');
		expect(html).not.toContain('id="claude-remote"');
	});

	it('submits agent preferences without changing unrelated settings', async () => {
		state.currentConfig = {
			assistant: {
				bindAddress: '127.0.0.1',
				port: 4096,
				timezone: 'UTC',
				automaticMemory: true,
				codexRemote: true,
				claudeRemote: false
			},
			gateway: { enabled: false }
		};
		let submitted: unknown;
		state.api = {
			saveConfig: async (value: unknown) => {
				submitted = value;
				throw new Error('Controlled test boundary before backend apply');
			}
		};
		control('agent-timezone').value = ' Europe/London ';
		control('automatic-memory').checked = false;
		bindPreferencesEvents();
		await control('preferences-form').listeners.get('submit')?.({ preventDefault() {} });
		expect((submitted as { baseConfig: unknown }).baseConfig).toEqual(state.currentConfig);
		expect((submitted as { config: unknown }).config).toEqual({
			assistant: {
				bindAddress: '127.0.0.1',
				port: 4096,
				timezone: 'Europe/London',
				automaticMemory: false,
				codexRemote: true,
				claudeRemote: false
			},
			gateway: { enabled: false }
		});
		expect(state.currentConfig.assistant.timezone).toBe('UTC');
	});

	it('preserves memory and timezone preferences when network settings change', async () => {
		state.currentConfig = {
			assistant: {
				bindAddress: '127.0.0.1',
				port: 4096,
				timezone: 'Europe/London',
				automaticMemory: false
			},
			gateway: { bindAddress: '127.0.0.1', port: 9180, enabled: true }
		};
		let submitted: unknown;
		state.api = {
			saveConfig: async (value: unknown) => {
				submitted = value;
				throw new Error('Controlled test boundary before backend apply');
			}
		};
		control('assistant-bind').value = '127.0.0.1';
		control('assistant-port').value = '4200';
		control('gateway-bind').value = '127.0.0.1';
		control('gateway-port').value = '9200';
		bindConfigurationEvents();
		await control('network-form').listeners.get('submit')?.({ preventDefault() {} });
		expect((submitted as { baseConfig: unknown }).baseConfig).toEqual(state.currentConfig);
		expect((submitted as { config: unknown }).config).toEqual({
			assistant: {
				bindAddress: '127.0.0.1',
				port: 4200,
				timezone: 'Europe/London',
				automaticMemory: false
			},
			gateway: { bindAddress: '127.0.0.1', port: 9200, enabled: true }
		});
	});
});

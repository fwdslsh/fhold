import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defaultStackConfig } from '@fhold/lib';
import { bindAccessEvents, copyAccessKey, renderCredentials } from '../admin/access.js';
import {
	restoreInput,
	restoreSignature,
	invalidateRestorePreview,
	renderRestorePlan
} from '../admin/backup.js';
import { bindBackupEvents, bindInstanceRestoreEvents, updateBackupScope } from '../admin/backup.js';
import {
	bindConnectionsEvents,
	renderConnectionDetails,
	renderNetworkDetails,
	showPortalTokenForm
} from '../admin/connections.js';
import { bindConfigurationEvents, loadDeploymentSettings } from '../admin/configuration.js';
import { parseDeploymentPatch } from '../../lib/src/control-plane/provisioning-input.js';
import { offerRestart, renderRestartStatus, requestStackAction } from '../admin/restart.js';
import {
	endpoint,
	isHealthy,
	known as observationValue,
	promptVisible,
	serviceImageDetails
} from '../admin/model.js';
import {
	bindRecoveryEvents,
	recoveryInput,
	renderRecovery,
	renderRecoveryStatus,
	updateRecoveryFields
} from '../admin/recovery.js';
import {
	bindRemoteEvents,
	renderRemoteStatus,
	remoteStageText,
	recallStatusLabel
} from '../admin/remote.js';
import {
	resetOAuthAttempt,
	renderProviders,
	loadProviders,
	openProviderEditor,
	verifyProvider
} from '../admin/providers.js';
import { bindRuntimeEvents, renderPhase, renderServices } from '../admin/runtime.js';
import {
	bindProvisioningEvents,
	cloudInstallRequest,
	renderInstallPlacement,
	submitCloudInstall
} from '../admin/provisioning.js';
import {
	bindSnapshotEvents,
	render,
	refresh,
	refreshVisibleStatus,
	showFatalError
} from '../admin/snapshot.js';
import { createAdminState, state } from '../admin/state.js';
import { targetKey, bindHostingEvents, showHostingChooser } from '../admin/hosting.js';
import {
	instanceCapability,
	instancePresentation,
	renderInstanceCapabilities,
	renderInstanceDetails,
	renderPlatformAccess,
	selectedLogOptions
} from '../admin/instance-presentation.js';
import { openAdminSettings, closeAdminSettings, renderAdminSettings } from '../admin/settings.js';
import {
	initializeAdmin,
	renderWelcome,
	renderInstancePicker,
	bindInstanceEvents,
	showInstances
} from '../admin/instances.js';
import {
	captureDirtyForms,
	operation,
	restoreDirtyForms,
	setFormClean,
	showConnectionApp,
	showView
} from '../admin/ui.js';

const admin = join(import.meta.dir, '..', 'admin');
const html = readFileSync(join(admin, 'index.html'), 'utf8');

describe('Admin visual contract', () => {
	const css = readFileSync(join(admin, 'admin.css'), 'utf8');
	const tokens = readFileSync(join(admin, 'design-tokens.css'), 'utf8');
	function color(name: string) {
		const hex = tokens.match(new RegExp(`--${name}:\\s*#([0-9a-f]{6});`))?.[1];
		if (!hex) throw new Error(`Missing color token: ${name}`);
		return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
	}
	function luminance(name: string) {
		const [r, g, b] = color(name).map((value) =>
			value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
		);
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	}
	function contrast(first: string, second: string) {
		const a = luminance(first),
			b = luminance(second);
		return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
	}
	it('uses one token source for typography, control size and theme rather than per-screen values', () => {
		expect(html.indexOf('href="design-tokens.css"')).toBeLessThan(html.indexOf('href="admin.css"'));
		expect(css).not.toMatch(/font-(?:size|weight):\s*[\d.]/);
		expect(tokens).toContain('--control-height: 40px');
		expect(tokens).toContain('@media (pointer: coarse)');
		expect(tokens).toContain('--control-height: 44px');
		expect(css).toContain('var(--control-height)');
		expect(css).toContain('(prefers-reduced-motion: reduce)');
	});
	it('maintains measured AA text and required-boundary contrast for the shared dark palette', () => {
		for (const text of ['ink', 'ink-soft', 'ink-faint'])
			for (const surface of ['canvas', 'surface', 'surface-raised', 'surface-muted'])
				expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5);
		for (const [text, surface] of [
			['on-accent', 'accent'],
			['on-accent', 'accent-hover'],
			['danger', 'danger-soft'],
			['warning', 'warning-soft'],
			['success', 'canvas']
		])
			expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5);
		for (const indicator of ['border', 'focus'])
			for (const surface of ['canvas', 'surface', 'surface-muted'])
				expect(contrast(indicator, surface)).toBeGreaterThanOrEqual(3);
	});
});

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
	removeAttribute(name: string) {
		this.attributes.delete(name);
	}
	toggleAttribute(name: string, enabled: boolean) {
		if (enabled) this.attributes.set(name, '');
		else this.attributes.delete(name);
	}
	addEventListener(name: string, listener: (event: unknown) => unknown) {
		this.listeners.set(name, listener);
	}
	dispatchEvent(event: Event) {
		this.listeners.get(event.type)?.(event);
		return true;
	}
	classList = { contains: (name: string) => this.className.split(' ').includes(name) };
	append(...children: Control[]) {
		for (const child of children) {
			this.children = this.children.filter((item) => item !== child);
			this.children.push(child);
		}
	}
	replaceChildren(...children: Control[]) {
		this.children = children;
	}
	querySelectorAll() {
		return this.children;
	}
	querySelector(_selector?: string) {
		return this.children[0] ?? new Control();
	}
	closest(_selector?: string) {
		return null;
	}
	reportValidity() {
		return true;
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

// Test fixtures deliberately model the public normalized snapshot.  Keeping this
// here makes a missing observation/capability visible to a renderer test instead
// of teaching production renderers about retired management payloads.
const observedAt = '2026-10-22T00:00:00.000Z';
const known = <T>(value: T) => ({ state: 'known' as const, value, observedAt });
const unsupported = (reason = 'Not available for this instance.') => ({
	support: 'unsupported' as const,
	reason
});
const supported = () => ({
	support: 'supported' as const,
	availability: { state: 'ready' as const }
});
function normalizedSnapshot({
	ref = { kind: 'local-docker', homeDir: '/personal-agent' },
	name,
	location,
	lifecycle = 'ready',
	config,
	services = [],
	deployment = {},
	operations = {},
	pending = false,
	installationReadiness,
	apps,
	connections,
	data = {}
}: {
	ref?: Record<string, unknown>;
	name?: string;
	location?: string;
	lifecycle?: 'not-installed' | 'setup-incomplete' | 'ready' | 'deployed';
	config?: ReturnType<typeof defaultStackConfig>;
	services?: Array<Record<string, unknown>>;
	deployment?: Record<string, unknown>;
	operations?: Record<string, unknown>;
	pending?: boolean;
	installationReadiness?: { ok: boolean; message?: string };
	apps?: Record<string, unknown>;
	connections?: Record<string, unknown>;
	data?: Record<string, unknown>;
} = {}) {
	const docker = config
		? {
				homeDir: String((ref as { homeDir?: string }).homeDir || '/personal-agent'),
				configPath: '/personal-agent/state/stack.json',
				config,
				...(installationReadiness ? { installationReadiness } : {})
			}
		: undefined;
	const defaultApps = {
		credentials: {},
		portalMappings: { discord: { default: '', users: {} }, slack: { default: '', users: {} } },
		portalSecrets: { discord: {}, slack: {} }
	};
	return {
		identity: {
			ref,
			name: name || config?.deployment.projectName || 'personal-agent',
			location: location || docker?.homeDir || 'Connected host'
		},
		lifecycle: known(lifecycle),
		deployment: known({ warnings: [], ...deployment }),
		services: known(services),
		operations: {
			'host.start': supported(),
			'host.stop': supported(),
			'host.restart': supported(),
			'host.logs': supported(),
			'host.console': supported(),
			'agent.providers': supported(),
			'agent.connect': unsupported(),
			'agent.remote': supported(),
			'agent.codexRecall': supported(),
			'apps.credentials': supported(),
			'apps.portal': supported(),
			'data.backup': supported(),
			'data.restoreData': supported(),
			'data.restoreInstance': supported(),
			'data.recovery.status': supported(),
			'data.recovery.inspect': supported(),
			'data.recovery.initialize': supported(),
			'data.recovery.restore': supported(),
			'data.recovery.save': supported(),
			'data.recovery.setCredential': supported(),
			...(docker
				? {
						'docker.install': supported(),
						'docker.saveConfig': supported(),
						'host.deployment.update': supported(),
						'docker.directory': supported()
					}
				: {}),
			...operations
		},
		pendingChanges: known({ pending }),
		agent: {
			access: { state: 'not-inspected', reason: 'Connect explicitly.' },
			account: { state: 'not-inspected', reason: 'Connect explicitly.' },
			models: { state: 'not-inspected', reason: 'Connect explicitly.' },
			readiness: { state: 'not-inspected', reason: 'Connect explicitly.' }
		},
		apps: {
			config: known({ ...defaultApps, ...apps }),
			connections: connections
				? known(connections)
				: { state: 'not-inspected', reason: 'Connect to inspect client links.' },
			status: { state: 'not-inspected', reason: 'Not inspected.' }
		},
		data,
		...(docker ? { docker } : {})
	};
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
	selectors = new Map();
	selector(
		'[data-view-panel]',
		...['overview', 'provider', 'knowledge', 'connections', 'system'].map((name) => {
			const panel = control(`view-${name}`);
			panel.dataset.viewPanel = name;
			return panel;
		})
	);
	selector(
		'[data-instance-feature]',
		...[...html.matchAll(/<fieldset id="([^"]+)"[^>]+data-instance-feature="([^"]+)"/g)].map(
			(match) => {
				const fields = control(match[1]);
				fields.dataset.instanceFeature = match[2];
				return fields;
			}
		)
	);
	selector(
		'#install-advanced input',
		control('install-home'),
		control('install-assistant-port'),
		control('install-gateway-port')
	);
	state.installationReadiness = { ok: true };
	control('install-automatic-ports').checked = true;
	control('install-instance-name').value = 'personal-agent';
	control('install-assistant-port').disabled = true;
	control('install-gateway-port').disabled = true;
	globalThis.document = {
		body: new Control(),
		getElementById: (id: string) => controls.get(id) ?? null,
		querySelectorAll: (name: string) => selectors.get(name) ?? [],
		querySelector: (name: string) => selectors.get(name)?.[0] ?? null,
		createElement: () => new Control()
	} as unknown as Document;
	globalThis.HTMLInputElement = Control as unknown as typeof HTMLInputElement;
	globalThis.window = { confirm: () => false, location: { reload() {} } } as unknown as Window &
		typeof globalThis;
});
afterEach(() => {
	clearTimeout(state.noticeTimer);
	Object.assign(globalThis, savedGlobals);
});

describe('Admin static security boundary', () => {
	it('offers a private password fallback when automatic credential resolution is unavailable and preserves Connect setup', async () => {
		const snapshot = normalizedSnapshot({
			ref: { kind: 'azure-container-apps', connectionId: 'cloud', resourceId: '/resource/agent' },
			lifecycle: 'deployed',
			services: []
		});
		snapshot.operations['agent.connect'] = {
			...supported(),
			input: { acceptsPassword: true, requiresPassword: false }
		};
		state.currentSnapshot = snapshot;
		state.awaitingSetupFinish = true;
		const inputs: unknown[] = [];
		state.api = {
			connectAgent: async (input) => {
				inputs.push(input);
				expect(control('native-agent-password').value).toBe('');
				if (!input.password)
					throw new Error('Azure cannot read this native secret. Enter the OpenCode password.');
				return { endpoint: 'https://private.example.test', username: 'custom-user' };
			},
			snapshot: async () => snapshot
		};
		renderConnectionDetails(snapshot);
		bindConnectionsEvents();
		expect(control('native-agent-password-field').hidden).toBe(false);
		await control('provider-connect-agent').listeners.get('click')?.({});
		expect(control('native-agent-password').focused).toBe(true);
		expect(control('native-agent-connect').hidden).toBe(false);
		control('native-agent-password').value = 'private-test-password';
		await control('connect-native-agent').listeners.get('click')?.({});
		expect(inputs).toEqual([{}, { password: 'private-test-password' }]);
		expect(control('native-agent-password').value).toBe('');
		expect(state.awaitingSetupFinish).toBe(true);
		expect(state.currentView).toBe('provider');
	});
	function cloudSetup() {
		state.installConnection = { id: 'cloud', kind: 'azure-container-apps', label: 'Cloud' };
		state.installOptions = {
			kind: 'azure-container-apps',
			location: 'centralus',
			image: 'registry/assistant:pinned',
			timezone: 'America/Chicago',
			environments: [],
			storageAccounts: []
		};
		control('install-section').hidden = false;
		renderInstallPlacement();
		control('install-environment-name').value = 'my-environment';
		control('install-storage-name').value = 'mystorage';
		return {
			ref: { kind: 'azure-container-apps', connectionId: 'cloud', resourceId: '/resource/agent' },
			image: 'registry/assistant:pinned',
			summary: 'Create assistant with private recovery.',
			resources: [{ name: 'my-environment', type: 'environment', action: 'create' }],
			warnings: ['Charges depend on Azure usage.']
		};
	}
	it('uses the shared wizard for cloud preview without preparing a directory or creating resources', async () => {
		const preview = cloudSetup();
		let installs = 0;
		state.api = {
			provisioningPreview: async ({ request }) => {
				expect(request.kind).toBe('azure-container-apps');
				return preview;
			},
			provisioningInstall: async () => {
				installs++;
			},
			prepareNewInstance: async () => {
				throw new Error('No cloud folder');
			}
		};
		await submitCloudInstall();
		expect(installs).toBe(0);
		expect(control('install-review').hidden).toBe(false);
		expect(control('install-directory-placement').hidden).toBe(true);
		await submitCloudInstall();
		expect(installs).toBe(0);
		expect(control('install-cloud-confirm').focused).toBe(true);
		control('install-mounts').value =
			'project-files /work/project\nreference-files /work/reference';
		expect(cloudInstallRequest().mounts).toEqual([
			{ storageName: 'project-files', mountPath: '/work/project' },
			{ storageName: 'reference-files', mountPath: '/work/reference' }
		]);
	});
	it('retains an incomplete cloud result for deliberate continuation and never replays install', async () => {
		const preview = cloudSetup();
		let installs = 0;
		state.api = {
			provisioningPreview: async () => preview,
			provisioningInstall: async () => {
				installs++;
				return {
					ref: preview.ref,
					state: 'unknown',
					step: 'deployment',
					reference: 'native-operation',
					message: 'Inspect Azure progress.'
				};
			},
			openInstance: async () => {
				throw new Error('Incomplete installation must not select an instance');
			}
		};
		await submitCloudInstall();
		control('install-cloud-confirm').checked = true;
		await submitCloudInstall();
		await submitCloudInstall();
		expect(installs).toBe(1);
		expect(control('install-continuation-reference').textContent).toBe('native-operation');
		expect(control('install').disabled).toBe(true);
		expect(control('install-status').textContent).toContain('unknown');
	});
	it('ignores a cloud preview that finishes after another setup connection was selected', async () => {
		const preview = cloudSetup();
		let release: (value: typeof preview) => void = () => {};
		state.api = {
			provisioningPreview: () =>
				new Promise((resolve) => {
					release = resolve;
				})
		};
		const pending = submitCloudInstall();
		state.installConnection = { id: 'other', label: 'Other' };
		state.installOptions = { kind: 'directory' };
		release(preview);
		await pending;
		expect(state.installPreview).toBeNull();
		expect(control('install-review').hidden).toBe(true);
	});
	it.each(['infrastructure', 'initialization', 'application'])(
		'requires a separate confirmed retry for failed %s and ordinary resume never replays it',
		async (step) => {
			const preview = cloudSetup();
			const failed = {
				ref: preview.ref,
				state: 'failed',
				step,
				reference: 'saved-init'
			};
			state.installOptions.continuations = [failed];
			renderInstallPlacement();
			control('install-resume-reference').value = 'saved-init';
			bindProvisioningEvents();
			await control('install-resume-reference').listeners.get('change')?.({});
			expect(control('install-retry-saved-step').hidden).toBe(false);
			const calls: unknown[] = [];
			state.api = {
				provisioningResume: async (input) => {
					calls.push(input);
					return failed;
				}
			};
			await control('install-retry-saved-step').listeners.get('click')?.({});
			expect(calls).toEqual([]);
			window.confirm = () => true;
			await control('install-resume-saved').listeners.get('click')?.({});
			expect(calls).toEqual([{ connectionId: 'cloud', reference: 'saved-init', confirmed: true }]);
			expect(control('install-retry-step').hidden).toBe(false);
			await control('install-retry-step').listeners.get('click')?.({});
			expect(calls.at(-1)).toEqual({
				connectionId: 'cloud',
				reference: 'saved-init',
				confirmed: true,
				retryFailedStep: true
			});
			state.installContinuation = { ...failed, state: 'unknown' };
			await control('install-retry-step').listeners.get('click')?.({});
			expect(calls).toHaveLength(2);
		}
	);
	it('hides cloud continuation and placement controls when returning to directory setup', () => {
		cloudSetup();
		control('install-saved-continuations').hidden = false;
		control('install-continuation').hidden = false;
		state.installOptions = null;
		renderInstallPlacement();
		expect(control('install-saved-continuations').hidden).toBe(true);
		expect(control('install-continuation').hidden).toBe(true);
		expect(control('install-cloud-placement').hidden).toBe(true);
		expect(control('install-directory-placement').hidden).toBe(false);
	});
	it('renders remote targets without a fake local configuration or provider discovery', () => {
		let providers = 0;
		state.api = {
			providers: async () => {
				providers++;
				return { providers: [] };
			}
		};
		const snapshot = normalizedSnapshot({
			ref: { kind: 'azure-container-apps', connectionId: 'cloud', resourceId: '/resource' },
			name: 'cloud-agent',
			location: '/resource',
			lifecycle: 'deployed',
			deployment: {
				warnings: ['Platform observation only'],
				state: 'Scaled to zero',
				clientUrl: 'https://agent.example.com'
			},
			operations: {
				'host.restart': unsupported(),
				'agent.providers': unsupported(),
				'data.restoreData': unsupported(),
				'data.recovery.save': unsupported()
			}
		});
		expect(instancePresentation(snapshot).location).toBe('/resource');
		render(snapshot);
		expect(control('view-overview').hidden).toBe(false);
		expect(control('app-shell').hidden).toBe(false);
		expect(control('overview-name').textContent).toBe('cloud-agent');
		expect(state.currentConfig).toBeNull();
		expect(providers).toBe(0);
		expect(control('overview-opencode-link').hidden).toBe(false);
		expect(control('overview-opencode-link').getAttribute('href')).toBe(
			'https://agent.example.com'
		);
		expect(control('restart-stack').disabled).toBe(true);
		expect(control('provider-fields').disabled).toBe(true);
		expect(control('provider-fields-unavailable').hidden).toBe(false);
		showView('provider');
		expect(control('view-provider').hidden).toBe(false);
		showView('connections');
		expect(control('view-connections').hidden).toBe(false);
		showView('system');
		expect(control('view-system').hidden).toBe(false);
		expect(control('transfer-fields').disabled).toBe(false);
		expect(control('recovery-fields').disabled).toBe(true);
		expect(
			targetKey({
				kind: 'hosted',
				ref: { kind: 'ssh-docker', connectionId: 'one', remoteHome: '/agent' }
			})
		).not.toBe(
			targetKey({
				kind: 'hosted',
				ref: { kind: 'ssh-docker', connectionId: 'two', remoteHome: '/agent' }
			})
		);
	});
	it('uses the observed native username and only unwraps known observations', () => {
		const snapshot = normalizedSnapshot({
			ref: { kind: 'ssh-docker', connectionId: 'remote', remoteHome: '/agent' },
			lifecycle: 'deployed'
		});
		renderPlatformAccess({
			...snapshot,
			agent: { ...snapshot.agent, access: known({ username: 'sam@example.test' }) }
		});
		expect(control('direct-username').textContent).toBe('sam@example.test');
		expect(html).toContain('id="direct-username">Not reported</code>');
		expect(observationValue(known('known value'))).toBe('known value');
		expect(observationValue({ state: 'unavailable', reason: 'Offline' })).toBeUndefined();
	});
	it('shows Knowledge and opens native AKM without taking a URL or token through the renderer', async () => {
		const snapshot = normalizedSnapshot({ operations: { 'data.knowledgeUi': supported() } });
		state.currentSnapshot = snapshot;
		let opened = 0;
		state.api = {
			openKnowledge: async (...args) => {
				expect(args).toEqual([]);
				opened++;
			}
		};
		bindConnectionsEvents();
		renderInstanceCapabilities(snapshot);
		showView('knowledge');
		expect(control('view-knowledge').hidden).toBe(false);
		expect(control('knowledge-fields').disabled).toBe(false);
		await control('open-knowledge').listeners.get('click')?.();
		expect(opened).toBe(1);
		renderInstanceCapabilities(normalizedSnapshot());
		expect(control('knowledge-fields').disabled).toBe(true);
		expect(control('knowledge-fields-unavailable').hidden).toBe(false);
	});
	it('opens authenticated native access without exposing a credential to the renderer', async () => {
		const snapshot = normalizedSnapshot({
			ref: { kind: 'azure-container-apps', connectionId: 'cloud', resourceId: '/resource' },
			lifecycle: 'deployed',
			operations: { 'agent.browserLink': supported() }
		});
		let opened = 0;
		state.currentSnapshot = snapshot;
		state.api = {
			openOpenCode: async () => {
				opened++;
			}
		};
		bindConnectionsEvents();
		renderNetworkDetails(snapshot);
		const link = control('overview-opencode-link');
		expect(link.hidden).toBe(false);
		expect(link.getAttribute('href')).toBe('#');
		await link.listeners.get('click')?.({ currentTarget: link, preventDefault() {} });
		expect(opened).toBe(1);
		for (const id of ['direct-url', 'assistant-url-detail']) {
			await control(id).listeners.get('click')?.({ preventDefault() {} });
		}
		expect(opened).toBe(3);
		expect(control('direct-password').value).toBe('');
	});
	it('takes an unconnected HTTPS agent to native sign-in instead of opening an unauthenticated browser', async () => {
		state.currentSnapshot = normalizedSnapshot({
			lifecycle: 'deployed',
			operations: {
				'agent.connect': { ...supported(), input: { requiresPassword: true } },
				'agent.browserLink': {
					support: 'supported',
					availability: { state: 'unavailable', reason: 'Connect first.' }
				}
			}
		});
		let opened = false;
		state.api = {
			openOpenCode: async () => {
				opened = true;
			}
		};
		bindConnectionsEvents();
		await control('overview-opencode-link').listeners.get('click')?.({ preventDefault() {} });
		expect(opened).toBe(false);
		expect(control('notice-message').textContent).toContain('Connect this agent once');
	});
	it('keeps remote status failures in the selected remote view, with no local fallback', async () => {
		state.currentSnapshot = normalizedSnapshot({
			ref: { kind: 'ssh-docker', connectionId: 'remote', remoteHome: '/agent' },
			lifecycle: 'deployed'
		});
		state.api = {
			snapshot: async () => {
				throw new Error('SSH disconnected');
			}
		};
		await refresh({ statusOnly: true });
		expect(state.currentSnapshot.lifecycle.value).toBe('deployed');
		expect(control('runtime-status-detail').textContent).toContain(
			'Container status is unavailable'
		);
		expect(control('runtime-status-detail').hidden).toBe(false);
	});
	it('uses provider-owned guidance and preserves selected log targets across status refresh', () => {
		const snapshot = normalizedSnapshot({
			ref: { kind: 'azure-container-apps', connectionId: 'cloud', resourceId: '/resource' },
			name: 'agent',
			location: '/resource',
			lifecycle: 'deployed',
			deployment: {
				providerLabel: 'Cloud provider',
				guidance: {
					client: 'Explicit open may wake the agent',
					access: 'Native account setup',
					restart: 'Native restart'
				},
				revisions: [
					{ name: 'one', active: true, health: 'Healthy' },
					{ name: 'two', active: false, health: 'Inactive' }
				],
				containers: [{ name: 'assistant', image: 'image' }],
				portalUrl: 'https://portal.example.com'
			}
		});
		render(snapshot);
		control('log-revision').value = 'two';
		control('log-container').value = 'assistant';
		render(snapshot);
		expect(control('log-revision').value).toBe('two');
		expect(control('log-container').value).toBe('assistant');
		expect(control('deployment-revisions').textContent).toContain('unknown replica(s)');
		expect(control('overview-location').textContent).toBe('Cloud provider');
		expect(control('provider-default-status').textContent).toContain('Connect');
		expect(control('instance-client-guidance').textContent).toBe(
			'Explicit open may wake the agent'
		);
	});
	it('enables the same sections for a managed connection and uses capabilities, not its provider name', () => {
		const config = defaultStackConfig();
		const snapshot = normalizedSnapshot({ config });
		renderInstanceCapabilities(snapshot);
		expect(control('provider-fields').disabled).toBe(false);
		expect(control('transfer-fields').disabled).toBe(false);
		expect(control('provider-fields-unavailable').hidden).toBe(true);
		expect(instanceCapability('host.deployment.update', snapshot).supported).toBe(true);
		expect(instanceCapability('update', snapshot).supported).toBe(false);
		renderInstanceCapabilities(
			normalizedSnapshot({
				lifecycle: 'deployed',
				operations: { 'agent.providers': supported() }
			})
		);
		expect(control('provider-fields').disabled).toBe(false);
		expect(control('transfer-fields').disabled).toBe(false);
	});
	it('omits unsupported log options for both managed and inspect-only connections', () => {
		renderInstanceDetails(normalizedSnapshot({ config: defaultStackConfig() }));
		expect(selectedLogOptions()).toBeUndefined();
		renderInstanceDetails(
			normalizedSnapshot({ lifecycle: 'deployed', name: 'agent', location: '/remote' })
		);
		control('log-source').value = 'system';
		expect(selectedLogOptions()).toBeUndefined();
		renderInstanceDetails(
			normalizedSnapshot({
				lifecycle: 'deployed',
				name: 'agent',
				location: '/remote',
				deployment: {
					logSources: [
						{ type: 'system', label: 'Platform' },
						{ type: 'console', label: 'Agent' }
					],
					revisions: [{ name: 'one', active: true, health: 'Healthy' }]
				}
			})
		);
		control('log-source').value = 'console';
		control('log-revision').value = 'one';
		expect(selectedLogOptions()).toEqual({ type: 'console', revision: 'one' });
	});
	it('shows only a real selected location on opening errors and preserves the recovery actions', async () => {
		state.api = { selectedHome: async () => '/opt/stacks/agent' };
		await showFatalError(Error('Unavailable instance'));
		expect(control('error-home').textContent).toBe('/opt/stacks/agent');
		expect(control('error-home').hidden).toBe(false);
		state.api.selectedHome = async () => {
			throw Error('No selected home');
		};
		await showFatalError(Error('Unavailable connection'));
		expect(control('error-home').hidden).toBe(true);
		expect(control('error-home').textContent).toBe('');
		expect(control('error-state').hidden).toBe(false);
	});
	it('loads Azure choices through native setup, preserves saved scope, and never creates an instance during sign-in', async () => {
		const calls: unknown[] = [];
		const originalSnapshot = state.currentSnapshot;
		control('hosting-subscription').value = 'subscription';
		control('hosting-group').value = 'group';
		control('install-section').hidden = true;
		control('instance-import-section').hidden = true;
		state.api = {
			hostingSetup: async (value: { action: string; field?: string }) => {
				calls.push(value);
				return value.action === 'sign-in'
					? undefined
					: [{ value: 'subscription', label: 'Account' }];
			}
		};
		bindHostingEvents();
		control('hosting-sign-in').listeners.get('click')?.({});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls).toEqual([
			{ provider: 'azure-container-apps', action: 'sign-in' },
			{
				provider: 'azure-container-apps',
				action: 'choices',
				field: 'subscriptionId',
				values: { subscriptionId: 'subscription' }
			}
		]);
		expect(control('hosting-subscription').value).toBe('subscription');
		expect(control('hosting-group').value).toBe('group');
		expect(state.currentSnapshot).toBe(originalSnapshot);
	});
	it('explains and exposes whole-instance snapshot/import as a separate stopped choice', async () => {
		expect(html).toContain('Entire instance (must be stopped)');
		expect(html).toContain('“Open another instance…” → “Import assistant…”');
		expect(html).toContain('Choose a new or empty folder. Nothing is copied until you confirm.');
		expect(html).toContain('The original instance must be stopped');
		control('backup-scope').value = 'instance';
		updateBackupScope();
		expect(control('backup-full-help').hidden).toBe(false);
		expect(control('backup-sensitive-options').hidden).toBe(true);
		expect(control('export-backup').textContent).toBe('Export entire instance');
		let exported = false;
		state.api = {
			confirmRestart: async () => false,
			backup: async () => {
				exported = true;
			}
		};
		bindBackupEvents();
		await control('backup-form').listeners.get('submit')?.({ preventDefault() {} });
		expect(exported).toBe(false);
	});
	it('requires a reviewed, unchanged full-instance preview and native confirmation before import', async () => {
		let imported = false;
		let confirmations = 0;
		state.api = {
			prepareNewInstance: async () => {},
			restoreInstance: async ({ apply }) => {
				if (apply) imported = true;
				return {
					projectName: 'restored',
					sourceHome: '/export',
					destinationHome: '/restored',
					digest: 'a'.repeat(64),
					copyCount: 2,
					warnings: []
				};
			},
			confirmRestart: async () => {
				confirmations++;
				return false;
			}
		};
		bindInstanceRestoreEvents();
		control('begin-instance-import').listeners.get('click')?.({});
		expect(control('instance-import-section').hidden).toBe(false);
		expect(control('install-section').hidden).toBe(true);
		control('instance-restore-source').value = '/export';
		control('instance-restore-home').value = '/restored';
		await control('apply-instance-restore').listeners.get('click')?.({});
		expect(imported).toBe(false);
		expect(confirmations).toBe(0);
		await control('instance-restore-form').listeners.get('submit')?.({ preventDefault() {} });
		expect(control('instance-import-review').hidden).toBe(false);
		await control('apply-instance-restore').listeners.get('click')?.({});
		expect(imported).toBe(false);
		expect(confirmations).toBe(1);
		control('instance-restore-source').listeners.get('input')?.({});
		expect(state.instanceRestorePreview).toBeNull();
		expect(control('apply-instance-restore').disabled).toBe(true);
		expect(control('instance-import-review').hidden).toBe(true);
		expect(control('instance-import-choices').hidden).toBe(false);
	});
	it('explains portable content versus same-instance runtime recovery and keeps storage credentials out of saved settings', () => {
		expect(html).toContain('Import / export');
		expect(html).toContain('Ephemeral container support');
		expect(html).toContain('Their format is not an import/export file');
		expect(html).toContain('No native conversations or remote sign-ins');
		expect(html).toContain('including after ordinary image upgrades');
		expect(html).not.toContain('native tool versions must match');
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
	it('shows Welcome when no launch-time selection is available, without fetching a stack snapshot', async () => {
		state.api = {
			welcome: async () => ({
				defaultInstance: { kind: 'local', homeDir: '/default', available: false },
				recentInstances: [
					{ kind: 'local', homeDir: '/previous', name: 'april', available: true },
					{ kind: 'local', homeDir: '/other', name: 'may', available: true }
				]
			}),
			snapshot: async () => {
				throw new Error('must not fetch before selection');
			}
		};
		await initializeAdmin();
		expect(control('instance-welcome').hidden).toBe(false);
		expect(control('app-shell').hidden).toBe(true);
		expect(control('recent-instances').children.map((row) => row.children[0].textContent)).toEqual([
			'april',
			'may'
		]);
		expect(control('instance-empty').hidden).toBe(true);
		expect(control('hosting-chooser-title').textContent).toBe('Assistants');
		expect(control('install-section').hidden).toBe(true);
		expect(control('skip-link').getAttribute('href')).toBe('#instance-welcome');
	});

	it('offers setup, existing instance and import, not a folder form, and cancelling the picker does nothing', async () => {
		renderWelcome({
			defaultInstance: { kind: 'local', homeDir: '/default', available: false },
			recentInstances: []
		});
		expect(control('instance-empty').hidden).toBe(false);
		expect(control('install-section').hidden).toBe(true);
		expect(control('recent-instances-section').hidden).toBe(true);
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
		expect(state.operationInFlight).toBe(false);
	});

	it('reveals naming only after setup is chosen and Cancel never prepares or installs a home', async () => {
		renderWelcome({
			defaultInstance: { kind: 'local', homeDir: '/default', available: false },
			recentInstances: []
		});
		let closed = 0;
		state.api = {
			closeInstance: async () => {
				closed++;
			},
			prepareNewInstance: async () => {
				throw new Error('Cancel must not prepare a home');
			},
			install: async () => {
				throw new Error('Cancel must not install');
			}
		};
		bindInstanceEvents();
		await control('begin-new-instance').listeners.get('click')?.({});
		expect(control('instance-welcome').hidden).toBe(true);
		expect(control('install-section').hidden).toBe(false);
		expect(control('install-instance-name').focused).toBe(true);
		control('install-instance-name').value = 'april';
		control('install-home').value = '/my/agent';
		await showInstances();
		expect(closed).toBe(1);
		state.operationInFlight = true;
		await showInstances();
		expect(closed).toBe(1);
	});

	it('shows the compatible default once and never opens an unavailable recent row', async () => {
		const target = { kind: 'local', homeDir: '/default', name: 'april', available: true };
		renderWelcome({
			defaultInstance: target,
			recentInstances: [target, { kind: 'local', homeDir: '/gone', available: false }]
		});
		const rows = control('recent-instances').children;
		expect(rows.length).toBe(2);
		expect(rows[0].getAttribute('aria-label')).toBe('Open april at /default');
		expect(rows[1].disabled).toBe(true);
		expect(rows[1].children[1].textContent).toBe('Unavailable');
		state.api = {
			openInstance: async () => {
				throw new Error('Unavailable folder must not open.');
			}
		};
		await rows[1].listeners.get('click')?.({});
		expect(state.operationInFlight).toBe(false);
		// New and browse actions stay in the rail across repeated renders.
		renderWelcome({ defaultInstance: { ...target, available: false }, recentInstances: [] });
		expect(control('instance-empty').hidden).toBe(false);
	});

	it('locks concurrent existing-folder dialogs and recovers from cancellation or error', async () => {
		let finish!: (value: undefined) => void;
		let calls = 0;
		state.api = {
			chooseDirectory: () => {
				calls++;
				return new Promise<undefined>((resolve) => {
					finish = resolve;
				});
			}
		};
		bindInstanceEvents();
		const choose = control('choose-instance').listeners.get('click');
		const pending = choose?.({});
		expect(state.operationInFlight).toBe(true);
		await choose?.({});
		expect(calls).toBe(1);
		finish(undefined);
		await pending;
		expect(state.operationInFlight).toBe(false);
		state.api.chooseDirectory = async () => {
			throw new Error('Cannot open folder picker.');
		};
		await choose?.({});
		expect(state.operationInFlight).toBe(false);
		expect(control('notice-message').textContent).toBe('Cannot open folder picker.');
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
		await control('install-browse').listeners.get('click')?.({});
		expect(control('install-home').value).toBe('/new-instance');
		expect(prepared).toBe(false);
		state.api.chooseDirectory = async () => undefined;
		await control('install-browse').listeners.get('click')?.({});
		expect(control('install-home').value).toBe('/new-instance');
		expect(prepared).toBe(false);
	});
	it('prepares and installs only after the explicit install submission without reloading the renderer', async () => {
		let reloads = 0;
		globalThis.window = {
			location: {
				reload: () => {
					reloads++;
				}
			}
		} as unknown as Window & typeof globalThis;
		let target: unknown;
		const config = defaultStackConfig();
		let installs = 0;
		state.api = {
			prepareNewInstance: async (value) => {
				target = value;
			},
			openInstance: async () => {
				throw new Error('must use the fresh-setup boundary');
			},
			snapshot: async () =>
				normalizedSnapshot({
					lifecycle: 'not-installed',
					config,
					installationReadiness: { ok: true }
				}),
			install: async () => {
				installs++;
				return normalizedSnapshot({ config });
			}
		};
		control('install-home').value = ' /chosen/new-instance ';
		control('install-section').hidden = false;
		bindRuntimeEvents();
		expect(installs).toBe(0);
		await control('install-form').listeners.get('submit')?.({ preventDefault() {} });
		expect(target).toEqual({
			kind: 'local',
			homeDir: '/chosen/new-instance',
			name: 'personal-agent'
		});
		expect(installs).toBe(1);
		expect(reloads).toBe(0);
		expect(state.operationInFlight).toBe(false);
	});
	it('keeps visible Install disabled until a prepared failure recovery read finishes, then accepts a distinct retry', async () => {
		const config = defaultStackConfig();
		const snapshot = normalizedSnapshot({
			ref: { kind: 'local-docker', homeDir: '/new-instance' },
			lifecycle: 'not-installed',
			config,
			installationReadiness: { ok: true }
		});
		let reads = 0;
		let installs = 0;
		const names: string[] = [];
		let release: ((value: typeof snapshot) => void) | undefined;
		state.api = {
			prepareNewInstance: async ({ name }) => {
				names.push(name);
			},
			snapshot: async () =>
				++reads === 2
					? new Promise<typeof snapshot>((resolve) => {
							release = resolve;
						})
					: snapshot,
			install: async () => {
				if (++installs === 1) throw new Error('Instance name is already in use.');
				return normalizedSnapshot({ config });
			}
		};
		selector('button', control('install'));
		control('install-section').hidden = false;
		control('install-home').value = '/new-instance';
		control('install-instance-name').value = 'duplicate-name';
		bindRuntimeEvents();
		const submit = control('install-form').listeners.get('submit');
		const failedAttempt = submit?.({ preventDefault() {} });
		for (let turn = 0; turn < 20 && !release; turn++) await Promise.resolve();
		expect(release).toBeDefined();
		expect(control('install-section').hidden).toBe(false);
		expect(control('install').disabled).toBe(true);
		expect(state.operationInFlight).toBe(true);
		expect(state.snapshotPromise).toBeDefined();
		await submit?.({ preventDefault() {} });
		expect(names).toEqual(['duplicate-name']);
		release?.(snapshot);
		await failedAttempt;
		expect(state.operationInFlight).toBe(false);
		expect(state.snapshotPromise).toBeUndefined();
		expect(control('install').disabled).toBe(false);
		expect(control('install-status').hidden).toBe(false);
		expect(control('install-status').getAttribute('role')).toBe('alert');
		control('install-instance-name').value = 'distinct-name';
		await submit?.({ preventDefault() {} });
		expect(names).toEqual(['duplicate-name', 'distinct-name']);
		expect(installs).toBe(2);
		expect(reads).toBe(3);
	});
	it('suggests a named default folder and leaves manually chosen folders alone', () => {
		bindInstanceEvents();
		renderWelcome({
			defaultInstance: {
				kind: 'local',
				homeDir: '/user/fhold/instances/default',
				available: false
			},
			instancesDirectory: '/user/fhold/instances',
			recentInstances: []
		});
		expect(control('install-home').value).toBe('/user/fhold/instances/personal-agent');
		control('install-instance-name').value = 'april';
		control('install-instance-name').listeners.get('input')?.({});
		expect(control('install-home').value).toBe('/user/fhold/instances/april');
		control('install-home').value = '/custom/my-agent';
		control('install-instance-name').value = 'may';
		control('install-instance-name').listeners.get('input')?.({});
		expect(control('install-home').value).toBe('/custom/my-agent');
	});
	it('keeps the new folder input after rejection and blocks duplicate submissions', async () => {
		let calls = 0;
		state.api = {
			prepareNewInstance: async () => {
				calls++;
				throw new Error('Choose an empty folder.');
			}
		};
		control('install-home').value = '/already-installed';
		control('install-section').hidden = false;
		bindRuntimeEvents();
		const submit = control('install-form').listeners.get('submit');
		await submit?.({ preventDefault() {} });
		expect(control('install-home').value).toBe('/already-installed');
		expect(control('notice-message').textContent).toBe('Choose an empty folder.');
		expect(control('install-advanced').open).toBe(true);
		expect(control('install-home').focused).toBe(true);
		state.operationInFlight = true;
		await submit?.({ preventDefault() {} });
		expect(calls).toBe(1);
	});
	it('reveals the optional folder location when native form validation requires it', () => {
		bindInstanceEvents();
		control('install-home').listeners.get('invalid')?.({});
		expect(control('install-advanced').open).toBe(true);
		expect(html).toMatch(/<details id="install-advanced"[^>]*>/);
		expect(html).not.toContain('id="new-instance-location-preview"');
		expect(html).not.toContain('id="open-recent-instance"');
	});
	it('requires Docker readiness before installing and refreshes quietly without clearing errors', async () => {
		const requirements = control('install-requirements');
		const title = new Control();
		const guidance = new Control();
		const message = new Control();
		const retry = new Control();
		const fields: Record<string, Control> = {
			'[data-requirement-title]': title,
			'[data-requirement-guidance]': guidance,
			'[data-requirement-message]': message,
			'[data-check-prerequisites]': retry
		};
		requirements.querySelector = (name = '') => fields[name];
		selector('[data-install-requirements]', requirements);
		const config = {
			deployment: { projectName: 'fhold-test' },
			assistant: { port: 4096 },
			gateway: { port: 9180 }
		};
		const snapshot = normalizedSnapshot({
			lifecycle: 'not-installed',
			config: config as ReturnType<typeof defaultStackConfig>,
			installationReadiness: { ok: false, message: 'Docker is stopped.' }
		});
		render(snapshot);
		expect(control('install').disabled).toBe(true);
		expect(message.textContent).toBe('Docker is stopped.');
		expect(retry.hidden).toBe(false);
		state.api = {
			snapshot: async () =>
				normalizedSnapshot({
					lifecycle: 'not-installed',
					config: config as ReturnType<typeof defaultStackConfig>,
					installationReadiness: { ok: true }
				})
		};
		control('notice').className = 'notice error';
		control('notice').hidden = false;
		await refresh();
		expect(control('install').disabled).toBe(false);
		expect(requirements.hidden).toBe(true);
		expect(retry.hidden).toBe(true);
		expect(control('notice').hidden).toBe(false);
	});
	it('retains a chosen instance name and ports while rechecking prerequisites', () => {
		const config = {
			deployment: { projectName: 'default-name' },
			assistant: { port: 3810 },
			gateway: { port: 3830 }
		};
		const snapshot = normalizedSnapshot({
			lifecycle: 'not-installed',
			config: config as ReturnType<typeof defaultStackConfig>
		});
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
			prepareNewInstance: async ({ name }) => {
				config.deployment.projectName = name;
			},
			snapshot: async () =>
				normalizedSnapshot({
					lifecycle: 'not-installed',
					config: structuredClone(config) as ReturnType<typeof defaultStackConfig>,
					installationReadiness: { ok: true }
				}),
			install: async (...args) => {
				calls.push(args);
				return normalizedSnapshot({ config: config as ReturnType<typeof defaultStackConfig> });
			}
		};
		control('install-section').hidden = false;
		bindRuntimeEvents();
		await control('install-form').listeners.get('submit')?.({ preventDefault() {} });
		expect(calls[0]).toEqual([{ ...config, deployment: { projectName: 'my-agent' } }, true]);
		control('install-section').hidden = false;
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
		expect(control('install-gateway-port').focused).toBe(false);
	});

	it('prioritizes startup recovery without claiming that the agent is running', () => {
		renderServices(
			normalizedSnapshot({
				lifecycle: 'setup-incomplete',
				services: [],
				config: {
					...defaultStackConfig(),
					gateway: { enabled: false },
					portals: { discord: { enabled: false }, slack: { enabled: false } }
				}
			})
		);
		expect(control('setup-recovery').hidden).toBe(false);
		expect(control('provider-connection').hidden).toBe(true);
		expect(control('setup-runtime').textContent).toBe('Agent startup needs attention.');
		expect(control('view-title').textContent).toBe('Start your agent');
	});

	it('keeps account selection explicit and hides a redundant single sign-in method', () => {
		renderProviders({
			providers: [
				{
					id: 'example',
					name: 'Example',
					authenticated: true,
					models: [{ id: 'text-model', name: 'Text model' }],
					authMethods: [{ index: 0, type: 'api', label: 'API key' }]
				}
			]
		});
		expect(state.providerEditor).toBeNull();
		expect(html).toMatch(/id="provider-editor"[^>]*\bhidden\b/);
		openProviderEditor('edit', 'example');
		expect(control('provider').value).toBe('example');
		expect(control('provider-method').options.map((option) => option.value)).toEqual(['0']);
		expect(control('provider-method-field').hidden).toBe(true);
		expect(state.providerEditor.stage).toBe('details');
		expect(control('provider-model-step').hidden).toBe(true);
		expect(control('use-provider-model').disabled).toBe(true);
	});

	it('offers verification after account selection, not before it', () => {
		state.currentSnapshot = normalizedSnapshot({ lifecycle: 'setup-incomplete' });
		renderProviders({
			providers: [
				{
					id: 'example',
					name: 'Example',
					authMethods: [{ index: 0, type: 'api', label: 'API key' }]
				}
			]
		});
		expect(control('provider').value).toBe('');
		expect(state.providerEditor).toBeNull();
		expect(control('test-current-model').disabled).toBe(true);
		expect(control('provider-default-service').textContent).toBe('No default AI service selected');
		expect(html.indexOf('id="test-provider"')).toBeGreaterThan(html.indexOf('id="provider-form"'));
	});

	it('reports provider transport failures as actionable guidance without raw JSON', async () => {
		state.api = {
			providers: async () => {
				throw new Error('Error invoking remote method admin:providers: fetch failed');
			}
		};
		await loadProviders(false);
		expect(control('provider-default-status').children[0].textContent).toBe(
			'Cannot load AI settings.'
		);
		expect(control('provider-default-status').children[1].textContent).toContain(
			'refresh the setup list'
		);
		expect(control('provider-default-status').children[1].textContent).not.toContain(
			'invoking remote method'
		);
		expect(html).not.toContain('id="provider-result"');
		expect(state.providerLoadPromise).toBeUndefined();
		await loadProviders(true);
		expect(control('notice-message').textContent).toBe(
			'Cannot reach your agent. Check that it is running, then refresh the setup list.'
		);
	});

	it('opens optional portal tokens before focusing a validation or setup target', async () => {
		state.currentSnapshot = normalizedSnapshot({ config: defaultStackConfig() });
		showPortalTokenForm('discord');
		await Bun.sleep(0);
		expect(control('discord-tokens').open).toBe(true);
		expect(control('discord-bot-token').focused).toBe(true);
		expect(control('slack-tokens').open).toBe(false);
	});

	it('offers compact per-identity permission management without key reveal or rotation actions', () => {
		const snapshot = normalizedSnapshot({
			apps: {
				credentials: { owner: { policy: 'full' }, guest: { policy: 'chat' } },
				portalMappings: {
					discord: { default: 'guest', users: {} },
					slack: { default: 'guest', users: {} }
				}
			}
		});
		state.currentSnapshot = snapshot;
		renderCredentials(snapshot);
		const row = control('saved-access').children[0];
		expect(row.children).toHaveLength(2);
		expect(row.children[0].textContent).toBe('guest — Chat only');
		expect(row.children[1].textContent).toBe('Manage');
		expect(row.children[1].dataset.manageSavedAccess).toBe('guest');
		const dialog = html.slice(
			html.indexOf('<dialog id="permissions-dialog"'),
			html.indexOf('<dialog id="remote-dialog"')
		);
		expect(dialog).not.toMatch(/Copy (?:access )?key|Rotate|Remove access|id="credential-key"/);
		expect(html).toContain('id="key-rotation-credential"');
	});
	it('saves an existing client policy through the normalized credential operation only', async () => {
		const snapshot = normalizedSnapshot({
			apps: {
				credentials: { client: { policy: 'read' } },
				portalMappings: { discord: { default: '', users: {} }, slack: { default: '', users: {} } }
			}
		});
		const saved = structuredClone(snapshot);
		saved.apps.config.value.credentials.client.policy = 'full';
		state.currentSnapshot = snapshot;
		const calls: unknown[] = [];
		state.api = {
			credential: async (input: unknown) => {
				calls.push(input);
				return saved;
			},
			saveConfig: async () => {
				throw new Error('Policy changes must not write Docker configuration.');
			}
		};
		window.confirm = () => true;
		control('claude-credential').value = 'client';
		control('claude-policy-full').value = 'full';
		control('claude-policy-full').checked = true;
		selector('input[name="claude-policy"]:checked', control('claude-policy-full'));
		bindAccessEvents();
		expect(calls).toEqual([]);
		control('claude-permissions-form').listeners.get('submit')?.({ preventDefault() {} });
		const deadline = Date.now() + 1_000;
		while (calls.length === 0 && Date.now() < deadline) await Bun.sleep(1);
		expect(calls).toEqual([
			{ action: 'policy', username: 'client', policy: 'full', previousPolicy: 'read' }
		]);
		while (state.currentSnapshot !== saved && Date.now() < deadline) await Bun.sleep(1);
		expect(state.currentSnapshot.apps.config.value.credentials.client.policy).toBe('full');
	});

	it('uses human-readable remote stages and never equates startup with connection readiness', () => {
		expect(recallStatusLabel({ status: 'installed' })).toBe('Installed');
		expect(recallStatusLabel({ status: 'approval-needed' })).toBe('Approval needed');
		expect(recallStatusLabel({ status: 'ready' })).toBe('Ready');
		expect(recallStatusLabel(undefined)).toBe('Not checked');
		expect(remoteStageText({ stage: 'sandbox' })).toContain('safely run Codex');
		expect(remoteStageText({ stage: 'container-isolation' })).toContain('explicitly selected');
		expect(remoteStageText({ stage: 'enabling', enabled: true })).toContain(
			'verify a real request'
		);
		expect(remoteStageText({ stage: 'sign-in', enabled: true, running: true })).toContain(
			'Finish account sign-in'
		);
		expect(remoteStageText({ stage: 'failed', enabled: true })).toContain(
			'existing startup setting was preserved'
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
		for (const name of ['Claude remote connection', 'Codex'])
			expect(html).toMatch(
				new RegExp(
					`<summary><span>${name}<small>[^<]*<\\/small><\\/span><span class="card-label">Experimental<\\/span><\\/summary>`
				)
			);
		expect(html).toMatch(/<summary><span>Desktop chat<small>[^<]*<\/small><\/span><\/summary>/);
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
			'Set up Claude remote connection (experimental)'
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

	it('keeps Cancel available while native setup waits for private terminal readiness', async () => {
		const button = new Control();
		button.dataset.remoteEnable = 'claude';
		selector('[data-remote-enable], [data-remote-connect], [data-codex-recall-review]', button);
		const actions: string[] = [];
		let interrupt!: (error: Error) => void;
		state.api = {
			confirmRestart: async () => true,
			remote: (request: { action: string }) => {
				actions.push(request.action);
				if (request.action === 'enable')
					return new Promise((_, reject) => {
						interrupt = reject;
					});
				if (request.action === 'cancel') {
					interrupt(new Error('Native setup was interrupted. Input was not replayed.'));
					return Promise.resolve({ running: false });
				}
				throw new Error(`Unexpected remote action ${request.action}`);
			}
		};
		bindRemoteEvents();
		button.listeners.get('click')?.({});
		control('remote-trust').checked = true;
		const starting = control('remote-form').listeners.get('submit')?.({ preventDefault() {} });
		await Bun.sleep(0);
		expect(control('remote-cancel').disabled).toBe(false);
		const cancelling = control('remote-cancel').listeners.get('click')?.({});
		await Promise.all([starting, cancelling]);
		expect(actions).toEqual(['enable', 'cancel']);
		expect(control('remote-stage').textContent).toContain('interrupted');
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
	it('shows native approved recall while keeping operator review and disable available', async () => {
		const button = new Control();
		button.dataset.codexRecallReview = '';
		selector('[data-remote-enable], [data-remote-connect], [data-codex-recall-review]', button);
		const calls: string[] = [];
		state.api = {
			codexRecall: async (request: { action: string }) => {
				calls.push(request.action);
				return {
					status: 'ready',
					digest: 'a'.repeat(64),
					hooks: [
						{
							event: 'sessionStart',
							command: 'native plugin handler',
							sourcePath: '/installed/plugin.json',
							trust: 'trusted',
							enabled: true
						}
					]
				};
			}
		};
		bindRemoteEvents();
		button.listeners.get('click')?.({});
		await Bun.sleep(1);
		expect(control('remote-recall').disabled).toBe(false);
		expect(control('remote-recall').required).toBe(true);
		expect(control('remote-begin').hidden).toBe(false);
		expect(control('remote-recall-disable').hidden).toBe(false);
		expect(control('codex-recall-status').textContent).toBe('Ready');
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
			'provider-endpoint-key',
			'discord-bot-token',
			'slack-bot-token',
			'slack-app-token',
			'direct-password',
			'remote-answer',
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

describe('Admin app settings', () => {
	it('opens without selecting an instance and returns without clearing its draft or resizing', async () => {
		const snapshot = normalizedSnapshot({
			ref: { kind: 'local-docker', homeDir: '/unused-test-home' },
			config: defaultStackConfig(),
			services: []
		});
		state.currentSnapshot = snapshot;
		state.dirtyForms.add('discord-connections-form');
		let instanceCalls = 0;
		state.api = {
			desktopStatus: async () => ({
				supported: true,
				installed: false,
				appImage: '/test/fhold-admin.AppImage'
			}),
			appSettings: async () => ({
				settings: { updates: { channel: 'stable', automatic: true } },
				update: { version: '0.3.261001-beta', supported: true, phase: 'idle' }
			}),
			hostingConnections: async () => [
				{ id: 'local', kind: 'local-docker', label: 'This computer' }
			],
			snapshot: async () => {
				instanceCalls++;
				return snapshot;
			}
		};
		await openAdminSettings();
		expect(state.adminSettingsOpen).toBe(true);
		expect(control('admin-settings').hidden).toBe(false);
		expect(control('admin-update-channel').value).toBe('stable');
		expect(instanceCalls).toBe(0);
		closeAdminSettings();
		expect(state.adminSettingsOpen).toBe(false);
		expect(state.currentSnapshot).toBe(snapshot);
		expect(state.dirtyForms.has('discord-connections-form')).toBe(true);
		expect(control('admin-settings').hidden).toBe(true);
	});
	it('shows download readiness separately from container pending restart and keeps manual actions explicit', () => {
		renderAdminSettings({
			settings: { updates: { channel: 'stable', automatic: true } },
			update: {
				version: '0.3.261001-beta',
				supported: true,
				phase: 'ready',
				availableVersion: '0.3.261002'
			}
		});
		expect(control('admin-update-install').hidden).toBe(false);
		expect(control('admin-update-download').hidden).toBe(true);
		expect(control('admin-update-status').textContent).toContain('Admin closes');
		renderAdminSettings({
			settings: { updates: { channel: 'beta', automatic: false } },
			update: {
				version: '0.3.261001-beta',
				supported: true,
				phase: 'available',
				availableVersion: '0.3.261002-beta'
			}
		});
		expect(control('admin-update-install').hidden).toBe(true);
		expect(control('admin-update-download').hidden).toBe(false);
	});
	it('does not poll an instance while its Admin settings page is open', async () => {
		state.currentSnapshot = normalizedSnapshot({
			ref: { kind: 'local-docker', homeDir: '/unused-test-home' },
			config: defaultStackConfig(),
			services: []
		});
		state.adminSettingsOpen = true;
		let calls = 0;
		state.api = {
			snapshot: async () => {
				calls++;
				return state.currentSnapshot;
			}
		};
		await refreshVisibleStatus();
		expect(calls).toBe(0);
	});
});

describe('Admin instance picker and automatic status', () => {
	function emptySnapshot() {
		const homeDir = '/home/person/fhold/instances/a-very-long-personal-instance-folder';
		const config = {
			deployment: { projectName: 'personal-agent' },
			assistant: { port: 3810 },
			gateway: { port: 3830 }
		};
		return normalizedSnapshot({
			ref: { kind: 'local-docker', homeDir },
			lifecycle: 'not-installed',
			config: config as ReturnType<typeof defaultStackConfig>,
			installationReadiness: { ok: true }
		});
	}
	it('opens the launch-time selection directly without another folder choice', async () => {
		const snapshot = emptySnapshot();
		let snapshots = 0;
		state.api = {
			welcome: async () => ({
				defaultInstance: { kind: 'local', homeDir: '/default' },
				recentInstances: [{ kind: 'local', homeDir: snapshot.identity.ref.homeDir }],
				selectedInstance: { kind: 'local', homeDir: snapshot.identity.ref.homeDir }
			}),
			snapshot: async () => {
				snapshots++;
				return snapshot;
			},
			openInstance: async () => {
				throw new Error('Launch already selected the instance');
			}
		};
		await initializeAdmin();
		expect(snapshots).toBe(1);
		expect(control('instance-welcome').hidden).toBe(true);
		expect(state.currentSnapshot).toBe(snapshot);
	});
	it('shows only a named recent-instance picker in the sidebar, with no footer or path', () => {
		const snapshot = emptySnapshot();
		state.recentInstances = [
			{ kind: 'local', homeDir: snapshot.identity.ref.homeDir, name: 'old-name' },
			{ kind: 'local', homeDir: '/custom/folder', name: 'may' },
			{ kind: 'local', homeDir: '/missing/june' }
		];
		render(snapshot);
		expect(control('instance-picker').options.map((option) => option.textContent)).toEqual([
			'personal-agent',
			'may',
			'june',
			'Open another instance…'
		]);
		expect(control('instance-picker').value).toBe(snapshot.identity.ref.homeDir);
		const sidebarStart = html.indexOf('<aside class="sidebar">');
		const sidebar = html.slice(sidebarStart, html.indexOf('</aside>', sidebarStart));
		expect(sidebar).toContain('aria-label="Choose instance"');
		for (const removed of [
			'sidebar-footer',
			'stack-status',
			'id="refresh"',
			'selected-instance-path',
			'sidebar-label'
		])
			expect(sidebar).not.toContain(removed);
		expect(sidebar).not.toContain('brand-subtitle');
		expect(sidebar).not.toContain('brand-mark');
		expect(html).not.toContain('Setup & settings');
		expect(html).toContain('<title>fhold Admin</title>');
		expect(html).toContain('id="overview-home" class="instance-path"');
	});
	it('switches directly to a recent instance through the existing API and reloads transient state', async () => {
		state.currentSnapshot = emptySnapshot();
		state.recentInstances = [{ kind: 'local', homeDir: '/other', name: 'other-agent' }];
		renderInstancePicker(state.currentSnapshot);
		let opened: unknown;
		let reloads = 0;
		window.location = {
			reload: () => {
				reloads++;
			}
		} as unknown as Location;
		state.api = {
			openInstance: async (target) => {
				opened = target;
			}
		};
		bindInstanceEvents();
		control('instance-picker').value = '/other';
		await control('instance-picker').listeners.get('change')?.({});
		expect(opened).toEqual(state.recentInstances[0]);
		expect(reloads).toBe(1);
		expect(control('instance-picker').value).toBe(state.currentSnapshot.identity.ref.homeDir);
	});
	it('browses other instances without discarding selection or drafts, and only confirms an explicit switch', async () => {
		state.currentSnapshot = emptySnapshot();
		state.recentInstances = [{ kind: 'local', homeDir: '/missing', name: 'missing' }];
		let closed = false;
		let reloads = 0;
		window.location = {
			reload: () => {
				reloads++;
			}
		} as unknown as Location;
		state.api = {
			closeInstance: async () => {
				closed = true;
			},
			openInstance: async () => {
				throw new Error('Recent instance is unavailable');
			},
			hostingConnections: async () => [
				{ kind: 'local-docker', id: 'local', label: 'This computer' }
			],
			hostingInstances: async () => [],
			hostingFeatures: async () => ({ installation: true, directory: true })
		};
		bindInstanceEvents();
		const choose = async (value: string) => {
			control('instance-picker').value = value;
			await control('instance-picker').listeners.get('change')?.({});
		};
		state.dirtyForms.add('preferences-form');
		await choose('/missing');
		await choose('open-another');
		expect(closed).toBe(false);
		expect(reloads).toBe(0);
		expect(control('open-hosting').hidden).toBe(false);
		expect(state.dirtyForms.has('preferences-form')).toBe(true);
		expect(control('instance-picker').value).toBe(state.currentSnapshot.identity.ref.homeDir);
		state.dirtyForms.clear();
		await choose('/missing');
		expect(control('notice-message').textContent).toBe('Recent instance is unavailable');
		expect(reloads).toBe(0);
		await choose('open-another');
		expect(closed).toBe(false);
		expect(reloads).toBe(0);
	});
	it('keeps creation and folder actions visible but disabled when a connection cannot install', async () => {
		state.api = {
			hostingConnections: async () => [
				{ id: 'local', label: 'This computer', kind: 'local-docker' },
				{ id: 'cloud', label: 'Cloud', kind: 'azure-container-apps' }
			],
			hostingInstances: async () => [],
			hostingFeatures: async () => ({ installation: false, directory: false })
		};
		await showHostingChooser('cloud');
		for (const id of ['hosting-install', 'hosting-import', 'hosting-open-folder']) {
			expect(control(id).hidden).toBe(false);
			expect(control(id).disabled).toBe(true);
		}
		expect(control('hosting-creation-help').hidden).toBe(false);
	});
	it('waits for an automatic status read before switching and disables the picker while busy', async () => {
		state.currentSnapshot = emptySnapshot();
		let finish!: () => void;
		state.snapshotPromise = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let closed = false;
		window.location = { reload() {} } as unknown as Location;
		state.api = {
			closeInstance: async () => {
				closed = true;
			}
		};
		const switching = showInstances();
		expect(control('instance-picker').disabled).toBe(true);
		expect(closed).toBe(false);
		finish();
		await switching;
		expect(closed).toBe(true);
		expect(control('instance-picker').disabled).toBe(false);
	});
	it('waits for pending status before browsing and returns without losing the target or drafts', async () => {
		const current = normalizedSnapshot({
			ref: { kind: 'azure-container-apps', connectionId: 'cloud', resourceId: '/agent' },
			lifecycle: 'deployed',
			name: 'cloud-agent',
			location: '/agent'
		});
		state.currentSnapshot = current;
		state.dirtyForms.add('preferences-form');
		control('app-shell').hidden = false;
		control('instance-preference-warning').hidden = false;
		let finish!: () => void;
		state.snapshotPromise = new Promise<void>((resolve) => {
			finish = resolve;
		});
		state.api = {
			hostingConnections: async () => [
				{ kind: 'local-docker', id: 'local', label: 'This computer' }
			],
			hostingInstances: async () => [],
			hostingFeatures: async () => ({ installation: true, directory: true })
		};
		bindHostingEvents();
		const browsing = showHostingChooser('local');
		expect(control('app-shell').hidden).toBe(false);
		expect(control('open-hosting').hidden).toBe(true);
		finish();
		await browsing;
		expect(control('app-shell').hidden).toBe(true);
		expect(control('open-hosting').hidden).toBe(false);
		expect(control('instance-preference-warning').hidden).toBe(true);
		expect(state.currentSnapshot).toBe(current);
		expect(state.dirtyForms.has('preferences-form')).toBe(true);
		await control('hosting-back').listeners.get('click')?.({});
		expect(control('app-shell').hidden).toBe(false);
		expect(control('instance-picker').focused).toBe(true);
		expect(state.currentSnapshot).toBe(current);
	});
	function runtimeSnapshot() {
		return normalizedSnapshot({ config: defaultStackConfig() });
	}
	const withServices = (
		snapshot: ReturnType<typeof runtimeSnapshot>,
		values: Array<Record<string, unknown>>
	) => ({ ...snapshot, services: known(values) });
	const withDocker = (
		snapshot: ReturnType<typeof runtimeSnapshot>,
		config: ReturnType<typeof defaultStackConfig>
	) => ({ ...snapshot, docker: { ...snapshot.docker!, config } });
	const withPending = (snapshot: ReturnType<typeof runtimeSnapshot>, pending: boolean) => ({
		...snapshot,
		pendingChanges: known({ pending })
	});
	it('groups the selected assistant identity on Overview and restores the normal heading on other pages', () => {
		const snapshot = runtimeSnapshot();
		snapshot.docker!.config.deployment.projectName = 'april';
		state.currentSnapshot = {
			...snapshot,
			identity: { ...snapshot.identity, name: 'april', location: 'Krang' }
		};
		showView('overview', { focus: true });
		expect(control('instance-page-header').hidden).toBe(true);
		expect(control('overview-name').textContent).toBe('april');
		expect(control('overview-location').textContent).toBe('Krang');
		expect(control('overview-name').focused).toBe(true);
		showView('connections', { focus: true });
		expect(control('instance-page-header').hidden).toBe(false);
		expect(control('view-title').textContent).toBe('Apps');
		expect(control('view-title').focused).toBe(true);
	});
	it('distinguishes actual container image tags from configured and available image tags', () => {
		const snapshot = {
			...withServices(runtimeSnapshot(), [
				{
					name: 'guardian',
					state: 'exited',
					health: '',
					image: 'fwdslsh/fhold-guardian:prior-release'
				},
				{
					name: 'assistant',
					state: 'running',
					health: 'healthy',
					image: 'fwdslsh/fhold-assistant:actually-running'
				}
			]),
			docker: { ...runtimeSnapshot().docker!, updateImageTag: 'available-release' }
		};
		snapshot.docker.config.deployment.images.assistant = 'saved-not-applied';
		renderServices(snapshot);
		const imageInRow = (index: number) =>
			control('services').children[index].children[1].children[1].textContent;
		expect(imageInRow(0)).toBe('actually-running');
		expect(imageInRow(1)).toBe('prior-release');
		expect(snapshot.services.value[0].name).toBe('guardian');
		expect(control('update-image-tag').textContent).toBe('available-release');
		expect(control('update-stack').disabled).toBe(false);
		renderServices(
			withServices(snapshot, [{ name: 'assistant', state: 'running', health: 'healthy' }])
		);
		expect(imageInRow(0)).toBe('Not reported');
		renderServices({ ...snapshot, docker: { ...snapshot.docker, updateImageTag: undefined } });
		expect(control('update-image-tag').textContent).toBe('Not reported');
		expect(control('runtime-version-settings').hidden).toBe(true);
		renderServices({
			...snapshot,
			docker: { ...snapshot.docker, updateImageTag: undefined },
			operations: {
				...snapshot.operations,
				'host.deployment.update': { support: 'unknown', reason: 'Remote CLI must be updated.' }
			}
		});
		expect(control('runtime-version-help').textContent).toContain('Remote CLI must be updated');
		expect(control('runtime-version-help').textContent).toContain('Your agent keeps running.');
		expect(control('runtime-version-settings').hidden).toBe(false);
		expect(control('update-stack').disabled).toBe(true);
		renderServices(snapshot);
		expect(control('runtime-version-settings').hidden).toBe(true);
		expect(control('runtime-version-help').textContent).not.toContain('older');
	});
	it('labels configured deployment image references as non-runtime evidence', () => {
		const snapshot = withServices(runtimeSnapshot(), [
			{
				name: 'assistant',
				state: 'running',
				health: 'healthy',
				imageProvenance: {
					configuredReferences: [
						'registry.example.com/fhold-assistant:blue',
						'registry.example.com/fhold-assistant:green'
					]
				}
			}
		]);
		renderServices(snapshot);
		const image = control('services').children[0].children[1];
		expect(image.children[0].textContent).toBe('Configured · ');
		expect(image.children[1].textContent).toBe('blue, green');
		expect(image.title).toContain('Configured deployment image, not a running-replica observation');
		expect(image.title).toContain('blue');
		expect(image.title).toContain('green');
	});
	it('formats tags, private registry ports and digests without inventing a latest tag', () => {
		expect(serviceImageDetails('registry.test:5000/team/assistant:beta')).toEqual({
			label: 'Image tag',
			value: 'beta'
		});
		expect(serviceImageDetails('registry.test:5000/team/assistant')).toEqual({
			label: 'Image',
			value: 'registry.test:5000/team/assistant'
		});
		const digest = `sha256:${'a'.repeat(64)}`;
		expect(serviceImageDetails(`team/assistant@${digest}`)).toEqual({
			label: 'Image digest',
			value: digest
		});
		expect(serviceImageDetails(`team/assistant:beta@${digest}`)).toEqual({
			label: 'Image tag',
			value: 'beta'
		});
		expect(serviceImageDetails(digest)).toEqual({ label: 'Image digest', value: digest });
		expect(serviceImageDetails(undefined)).toEqual({ label: 'Image tag', value: 'Not reported' });
	});
	it('keeps Update behind confirmation when an available image tag is shown', async () => {
		let updates = 0;
		state.api = {
			confirmRestart: async () => false,
			update: async () => {
				updates++;
			}
		};
		bindRuntimeEvents();
		await control('update-stack').listeners.get('click')?.({});
		expect(updates).toBe(0);
	});
	it('reports actual runtime state on Overview without equating a container with account readiness', () => {
		const snapshot = {
			...runtimeSnapshot()
		};
		for (const [services, label] of [
			[[{ name: 'assistant', state: 'running', health: 'healthy' }], 'Running'],
			[[{ name: 'assistant', state: 'running', health: 'unhealthy' }], 'Needs attention'],
			[[], 'Stopped']
		] as const) {
			renderServices(withServices(snapshot, services));
			expect(control('assistant-summary').textContent).toBe(label);
			expect(control('assistant-summary').textContent).not.toContain('ready');
		}
		renderServices({
			...snapshot,
			services: { state: 'unavailable', reason: 'Docker is not available.' }
		});
		expect(control('assistant-summary').textContent).toBe('Status unavailable');
		expect(control('runtime-status-detail').textContent).toContain('retry automatically');
		expect(control('start-stack').disabled).toBe(false);
		renderServices({
			...snapshot,
			services: { state: 'unavailable', reason: 'Docker is not available.' },
			operations: {
				...snapshot.operations,
				'host.start': unsupported('The host does not support starting this deployment.')
			}
		});
		expect(control('start-stack').disabled).toBe(true);
		expect(control('start-stack').title).toContain('does not support starting');
	});
	it('combines pure operation metadata with observed lifecycle eligibility for disabled actions', () => {
		const snapshot = normalizedSnapshot({
			deployment: {
				lifecycleCapabilities: {
					start: {
						state: 'unavailable',
						reason: 'The platform reports this deployment is inspect-only.'
					}
				}
			}
		});
		expect(snapshot.operations['host.start']).toEqual(supported());
		expect(instanceCapability('host.start', snapshot)).toEqual({
			supported: false,
			reason: 'The platform reports this deployment is inspect-only.'
		});
		renderServices(snapshot);
		expect(control('start-stack').disabled).toBe(true);
		expect(control('start-stack').title).toContain('inspect-only');
	});
	it('shows optional-feature warnings without reporting a usable agent stopped or blocking setup', () => {
		const assistant = {
			name: 'assistant',
			state: 'running',
			health: 'healthy',
			warnings: ['Scheduling is unavailable. Check logs.']
		};
		const snapshot = withServices(runtimeSnapshot(), [assistant]);
		renderServices(snapshot);
		expect(control('assistant-summary').textContent).toBe('Running · needs attention');
		expect(control('assistant-summary').className).toContain('warning');
		expect(control('runtime-status-detail').textContent).toContain('Scheduling is unavailable');
		expect(control('runtime-status-detail').hidden).toBe(false);
		expect(control('setup-recovery').hidden).toBe(true);
		expect(control('restart-stack').disabled).toBe(false);
		renderServices(withServices(snapshot, [{ ...assistant, warnings: [] }]));
		expect(control('assistant-summary').textContent).toBe('Running');
		expect(control('runtime-status-detail').hidden).toBe(true);
	});
	it('coalesces overlapping snapshot reads without a manual refresh control', async () => {
		const snapshot = emptySnapshot();
		state.currentSnapshot = snapshot;
		let complete!: (value: unknown) => void;
		let calls = 0;
		state.api = {
			snapshot: () => {
				calls++;
				return new Promise((resolve) => {
					complete = resolve;
				});
			}
		};
		const first = refresh();
		const second = refresh();
		expect(calls).toBe(1);
		expect(state.snapshotPromise).toBeDefined();
		complete(snapshot);
		await Promise.all([first, second]);
		expect(state.snapshotPromise).toBeUndefined();
	});
	it('marks failed automatic checks unavailable on Overview, then recovers without clearing user errors', async () => {
		state.currentSnapshot = withServices(runtimeSnapshot(), [
			{ name: 'assistant', state: 'running', health: 'healthy' }
		]);
		render(state.currentSnapshot);
		renderServices(state.currentSnapshot);
		control('notice').className = 'notice error';
		control('notice-message').textContent = 'Unsaved setting needs attention';
		state.api = {
			snapshot: async () => {
				throw new Error('Connection unavailable');
			},
			providers: async () => ({ providers: [] })
		};
		await refreshVisibleStatus();
		expect(control('assistant-summary').textContent).toBe('Status unavailable');
		expect(control('notice-message').textContent).toBe('Unsaved setting needs attention');
		state.api.snapshot = async () =>
			withServices(runtimeSnapshot(), [{ name: 'assistant', state: 'running', health: 'healthy' }]);
		await refreshVisibleStatus();
		expect(control('assistant-summary').textContent).toBe('Running');
		expect(control('runtime-status-detail').hidden).toBe(true);
		expect(control('notice-message').textContent).toBe('Unsaved setting needs attention');
	});
	it('updates status without overwriting app drafts, configuration baseline, transient passwords or explicit hook review', async () => {
		const snapshot = runtimeSnapshot();
		render(snapshot);
		state.currentSnapshot = snapshot;
		state.currentConfig = snapshot.docker.config;
		state.dirtyForms.add('opencode-network-form');
		control('assistant-port').value = '3910';
		control('direct-password').value = 'transient-password';
		control('codex-recall-status').textContent = 'Managed · ready';
		state.api = {
			snapshot: async () => ({
				...snapshot,
				docker: {
					...snapshot.docker,
					config: { ...snapshot.docker.config, assistant: { timezone: 'other writer' } }
				},
				pendingChanges: known({ pending: true })
			})
		};
		await refreshVisibleStatus();
		expect(control('assistant-port').value).toBe('3910');
		expect(control('direct-password').value).toBe('transient-password');
		expect(control('codex-recall-status').textContent).toBe('Managed · ready');
		expect(state.currentConfig).toBe(snapshot.docker.config);
		expect(control('pending-restart').hidden).toBe(false);
	});
	it('retains loaded provider UI on same-instance status renders and resets it after a target change', () => {
		const snapshot = runtimeSnapshot();
		state.providersLoaded = true;
		control('provider-default-service').textContent = 'Saved provider';
		control('provider-default-model').textContent = 'saved/model';
		control('provider-saved-list').append(new Control());
		render({ ...snapshot, deployment: known({ warnings: ['Unrelated deployment update.'] }) });
		expect(control('provider-default-service').textContent).toBe('Saved provider');
		expect(control('provider-default-model').textContent).toBe('saved/model');
		expect(control('provider-saved-list').children).toHaveLength(1);
		render({
			...snapshot,
			identity: {
				...snapshot.identity,
				ref: { kind: 'local-docker', homeDir: '/other-instance' },
				name: 'other-instance',
				location: '/other-instance'
			},
			docker: {
				...snapshot.docker!,
				homeDir: '/other-instance',
				configPath: '/other-instance/state/stack.json'
			}
		});
		expect(state.providersLoaded).toBe(false);
		expect(control('provider-default-service').textContent).toBe('Not inspected');
		expect(control('provider-saved-list').children).toHaveLength(0);
	});
	it('discards an old background read if an operation or a newer snapshot has superseded it', async () => {
		for (const superseded of ['operation', 'snapshot']) {
			state.currentSnapshot = runtimeSnapshot();
			render(state.currentSnapshot);
			let finish!: (value: unknown) => void;
			state.api = {
				snapshot: () =>
					new Promise((resolve) => {
						finish = resolve;
					})
			};
			const checking = refreshVisibleStatus();
			if (superseded === 'operation') state.operationInFlight = true;
			else state.currentSnapshot = withPending(runtimeSnapshot(), true);
			control('assistant-summary').textContent = 'Newer result';
			finish(runtimeSnapshot());
			await checking;
			expect(control('assistant-summary').textContent).toBe('Newer result');
			state.operationInFlight = false;
		}
	});
	it('performs a full read after a pending status-only check when a lifecycle action requests one', async () => {
		const snapshot = emptySnapshot();
		state.currentSnapshot = snapshot;
		let finish!: (value: unknown) => void;
		let calls = 0;
		state.api = {
			snapshot: () => {
				calls++;
				return calls === 1
					? new Promise((resolve) => {
							finish = resolve;
						})
					: Promise.resolve(snapshot);
			}
		};
		const checking = refresh({ statusOnly: true });
		const lifecycleRead = refresh();
		finish(snapshot);
		await Promise.all([checking, lifecycleRead]);
		expect(calls).toBe(2);
		expect(state.snapshotPromise).toBeUndefined();
	});
	it('discovers providers after an externally started Assistant becomes healthy without needing Refresh', async () => {
		const snapshot = runtimeSnapshot();
		state.currentSnapshot = { ...snapshot, lifecycle: known('setup-incomplete') };
		render(state.currentSnapshot);
		let discoveries = 0;
		state.api = {
			snapshot: async () => ({
				...state.currentSnapshot,
				agent: {
					...state.currentSnapshot.agent,
					access: known({ endpoint: 'https://agent.example.com' })
				},
				services: known([{ name: 'assistant', state: 'running', health: 'healthy' }])
			}),
			providers: async () => {
				discoveries++;
				return { providers: [] };
			}
		};
		await refreshVisibleStatus();
		await state.providerLoadPromise;
		expect(discoveries).toBe(0);
		expect(state.providersLoaded).toBe(false);
	});
	it('polls every 15 seconds and on focus/visibility, but pauses for hidden windows, Welcome and busy operations', async () => {
		state.currentSnapshot = runtimeSnapshot();
		render(state.currentSnapshot);
		let calls = 0;
		state.api = {
			snapshot: async () => {
				calls++;
				return runtimeSnapshot();
			}
		};
		const events = new Map<string, () => void>();
		window.addEventListener = ((name, callback) => {
			events.set(name, callback);
		}) as typeof window.addEventListener;
		document.addEventListener = ((name, callback) => {
			events.set(name, callback);
		}) as typeof document.addEventListener;
		let poll!: () => void;
		window.setInterval = ((callback, interval) => {
			expect(interval).toBe(15_000);
			poll = callback;
			return 1;
		}) as typeof window.setInterval;
		bindSnapshotEvents();
		for (const trigger of [poll, events.get('focus'), events.get('visibilitychange')]) {
			trigger?.();
			await state.snapshotPromise;
		}
		expect(calls).toBe(3);
		for (const blocked of ['hidden', 'welcome', 'busy', 'remote']) {
			Object.assign(document, { hidden: blocked === 'hidden' });
			control('app-shell').hidden = blocked === 'welcome';
			state.operationInFlight = blocked === 'busy';
			control('remote-dialog').open = blocked === 'remote';
			await refreshVisibleStatus();
		}
		expect(calls).toBe(3);
	});
});

describe('Admin runtime recovery controls', () => {
	function fixture(running = true) {
		const settings = {
			enabled: false,
			destination: '',
			instanceId: 'my-agent',
			intervalSeconds: 60,
			maxUnsavedSeconds: 300,
			operationTimeoutSeconds: 120,
			authentication: 'connection-string',
			clientId: ''
		};
		const recovery = {
			settings,
			selection: {
				version: 1,
				paths: [],
				sqlite: [],
				excludePaths: [],
				externalMounts: [],
				recoverMounts: [],
				autoExcludeNetworkMounts: false
			},
			digest: 'reviewed-digest',
			credentialConfigured: false,
			policyPath: '/home/config/recovery/include.json'
		};
		state.currentSnapshot = normalizedSnapshot({
			config: { ...defaultStackConfig(), recovery: settings },
			services: running ? [{ name: 'assistant', state: 'running', health: 'healthy' }] : [],
			data: { recovery: known(recovery) }
		});
		renderRecovery(state.currentSnapshot);
		return state.currentSnapshot;
	}
	it('defaults off, hides advanced storage fields and refuses offline operations while writers run', () => {
		const snapshot = fixture();
		expect(control('runtime-recovery-akm-capture').checked).toBe(false);
		expect(control('runtime-recovery-akm-restore').checked).toBe(false);
		expect(control('runtime-recovery-settings').hidden).toBe(true);
		expect(control('runtime-recovery-status').children[0].textContent).toContain('off');
		snapshot.docker.config.recovery.enabled = true;
		snapshot.data.recovery.value.settings.enabled = true;
		renderRecovery(snapshot);
		expect(control('runtime-recovery-settings').hidden).toBe(false);
		expect(control('initialize-recovery').disabled).toBe(true);
		expect(control('restore-runtime-recovery').disabled).toBe(true);
		snapshot.services = known([]);
		updateRecoveryFields();
		expect(control('initialize-recovery').disabled).toBe(false);
	});
	it('uses exact recovery operation keys instead of a parent capability alias', () => {
		const snapshot = fixture(false);
		snapshot.docker.config.recovery.enabled = true;
		snapshot.data.recovery.value.settings.enabled = true;
		snapshot.operations = {
			...snapshot.operations,
			'data.recovery.initialize': unsupported('This instance cannot initialize recovery.'),
			'data.recovery.setCredential': unsupported('This instance uses an identity instead.')
		};
		renderRecovery(snapshot);
		expect(control('save-recovery-settings').disabled).toBe(false);
		expect(control('check-recovery-status').disabled).toBe(false);
		expect(control('inspect-recovery').disabled).toBe(false);
		expect(control('initialize-recovery').disabled).toBe(true);
		expect(control('restore-runtime-recovery').disabled).toBe(false);
		expect(control('save-recovery-credential').disabled).toBe(true);
		expect(html).toContain('data-instance-feature="data.recovery.save"');
	});
	it('recomputes offline controls after a completed lifecycle operation rather than restoring stale disabled flags', async () => {
		const snapshot = fixture();
		snapshot.docker.config.recovery.enabled = true;
		snapshot.data.recovery.value.settings.enabled = true;
		renderRecovery(snapshot);
		selector('button', control('initialize-recovery'), control('restore-runtime-recovery'));
		await operation('Stopping', async () => {
			snapshot.services = known([]);
			updateRecoveryFields();
			expect(control('initialize-recovery').disabled).toBe(true);
			return 'stopped';
		});
		expect(control('initialize-recovery').disabled).toBe(false);
		expect(control('restore-runtime-recovery').disabled).toBe(false);
		snapshot.services = known([{ name: 'assistant', state: 'paused', health: '' }]);
		updateRecoveryFields();
		expect(control('initialize-recovery').disabled).toBe(true);
	});
	it('supports a directory with spaces and arbitrary path/database lists without copying credentials into the payload', () => {
		fixture();
		control('runtime-recovery-enabled').checked = true;
		control('runtime-recovery-akm-capture').checked = true;
		control('runtime-recovery-akm-restore').checked = false;
		control('runtime-recovery-directory').value = '/private/my backups#1?test';
		control('runtime-recovery-paths').value = '/home/fhold/.my-client\n/work/additional';
		control('runtime-recovery-sqlite').value = '/home/fhold/.my-client/state.sqlite';
		control('runtime-recovery-connection-string').value = 'secret must not enter settings';
		const value = recoveryInput();
		expect(value.settings).toMatchObject({ akmIndexCapture: true, akmIndexRestore: false });
		expect(value.settings.destination).toBe('file:///private/my%20backups%231%3Ftest');
		expect(value.selection.paths).toEqual(['/home/fhold/.my-client', '/work/additional']);
		expect(value.selection.sqlite).toEqual(['/home/fhold/.my-client/state.sqlite']);
		expect(value.baselineDigest).toBe('reviewed-digest');
		expect(JSON.stringify(value)).not.toContain('secret must');
	});
	it('shows Blob credential presence without revealing it and guides deployment identity without host auth discovery', () => {
		const snapshot = fixture();
		snapshot.docker.config.recovery.enabled = true;
		snapshot.docker.config.recovery.destination = 'azblob://account123/private/my-agent';
		snapshot.data.recovery.value.settings.enabled = true;
		snapshot.data.recovery.value.settings.destination = 'azblob://account123/private/my-agent';
		snapshot.data.recovery.value.credentialConfigured = true;
		renderRecovery(snapshot);
		expect(control('runtime-recovery-directory-field').hidden).toBe(true);
		expect(control('runtime-recovery-blob-field').hidden).toBe(false);
		expect(control('runtime-recovery-credential-status').textContent).toContain(
			'value is not shown'
		);
		expect(control('runtime-recovery-credential-form').hidden).toBe(false);
		control('runtime-recovery-auth').value = 'managed-identity';
		updateRecoveryFields();
		expect(control('runtime-recovery-client-id-field').hidden).toBe(false);
		expect(control('runtime-recovery-credential-form').hidden).toBe(true);
	});
	it('requires native confirmation for init/restore; cancel performs no recovery operation', async () => {
		const snapshot = fixture(false);
		snapshot.docker.config.recovery.enabled = true;
		snapshot.data.recovery.value.settings.enabled = true;
		const calls: string[] = [];
		state.api = {
			confirmRestart: async (action: string) => {
				calls.push(action);
				return false;
			},
			recovery: async () => {
				throw new Error('must not run after cancellation');
			}
		};
		bindRecoveryEvents();
		await control('initialize-recovery').listeners.get('click')?.({});
		await control('restore-runtime-recovery').listeners.get('click')?.({});
		expect(calls).toEqual(['recovery-init', 'recovery-restore']);
	});
	it('uses a refreshed normalized snapshot after saving recovery settings or a credential', async () => {
		const snapshot = fixture(false);
		const saved = structuredClone(snapshot);
		saved.docker.config.recovery.enabled = true;
		saved.data.recovery.value.settings.enabled = true;
		saved.data.recovery.value.credentialConfigured = true;
		const actions: string[] = [];
		state.api = {
			recovery: async (input: { action?: string }) => {
				actions.push(input.action || 'save');
				return saved;
			}
		};
		bindRecoveryEvents();
		control('runtime-recovery-enabled').checked = true;
		await control('runtime-recovery-form').listeners.get('submit')?.({ preventDefault() {} });
		expect(state.currentSnapshot.data.recovery.value.settings.enabled).toBe(true);
		control('runtime-recovery-connection-string').value = 'private-fixture-value';
		await control('runtime-recovery-credential-form').listeners.get('submit')?.({
			preventDefault() {}
		});
		expect(actions).toEqual(['save', 'credential']);
		expect(control('runtime-recovery-connection-string').value).toBe('');
		expect(state.currentSnapshot.data.recovery.value.credentialConfigured).toBe(true);
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
	it('shows backup failures or overdue checkpoints without reporting a stopped agent or accepted checkpoint', () => {
		fixture();
		for (const status of [
			{ state: 'ready', durable: false, lastPublishedAt: null },
			{
				state: 'ready',
				durable: true,
				lastAttemptFailed: true,
				failure: 'recovery Blob transport failed'
			}
		]) {
			renderRecoveryStatus(status);
			expect(control('runtime-recovery-status').children[0].textContent).toBe(
				'Agent is running; backups need attention.'
			);
			expect(control('runtime-recovery-status').className).not.toContain('success');
		}
	});
});

describe('Admin renderer behavior', () => {
	it('keeps ambiguous Assistant fields disabled while allowing an explicit sidecar image change', async () => {
		const snapshot = normalizedSnapshot({ config: defaultStackConfig() });
		for (const name of ['inspect', 'prepare', 'apply', 'discard'])
			snapshot.operations[`host.deployment.${name}`] = supported();
		state.currentSnapshot = snapshot;
		const reason = 'Assistant container is ambiguous.';
		const settings = {
			containers: [{ name: 'sidecar', image: 'custom/sidecar:old' }],
			environment: {},
			unavailable: Object.fromEntries(
				['FH_TIMEZONE', 'FH_SCHEDULER_ENABLED', 'FH_CLAUDE_REMOTE', 'FH_CODEX_REMOTE'].map(
					(key) => [key, reason]
				)
			)
		};
		const calls: unknown[] = [];
		state.api = {
			deploymentSettings: async () => settings,
			prepareDeployment: async (patch) => {
				calls.push(parseDeploymentPatch(patch));
				return { ...settings, pending: patch };
			},
			snapshot: async () => snapshot
		};
		await loadDeploymentSettings();
		for (const field of ['timezone', 'schedule', 'claude', 'codex'])
			expect(control(`deployment-${field}`).disabled).toBe(true);
		expect(control('deployment-timezone-help').textContent).toBe(reason);
		control('deployment-timezone').value = 'UTC'; // An old DOM value is never submitted while disabled.
		control('deployment-container').value = 'sidecar';
		control('deployment-image').value = 'custom/sidecar:new';
		bindConfigurationEvents();
		await control('deployment-edit-form').listeners.get('submit')?.({ preventDefault() {} });
		expect(calls).toEqual([{ container: 'sidecar', image: 'custom/sidecar:new' }]);
	});
	for (const kind of ['local-docker', 'ssh-docker', 'azure-container-apps']) {
		it(`uses the same deployment form and native API keys for ${kind}`, async () => {
			const snapshot = normalizedSnapshot({ config: defaultStackConfig() });
			snapshot.identity.ref.kind = kind;
			snapshot.pendingChanges = known({ pending: true });
			for (const name of ['inspect', 'prepare', 'apply', 'discard'])
				snapshot.operations[`host.deployment.${name}`] = supported();
			state.currentSnapshot = snapshot;
			const settings = {
				containers: [{ name: 'assistant', image: 'fwdslsh/fhold-assistant:0.4.1001' }],
				environment: {
					FH_TIMEZONE: 'America/Chicago',
					FH_CLAUDE_REMOTE: '1',
					FH_CODEX_REMOTE: '1'
				},
				...(kind === 'azure-container-apps'
					? { availability: 'always' }
					: {
							unavailable: {
								availability: 'Use Start and Stop.',
								FH_SCHEDULER_ENABLED: 'Use custom Compose.'
							}
						})
			};
			const calls: unknown[] = [];
			state.api = {
				deploymentSettings: async () => settings,
				prepareDeployment: async (patch) => {
					calls.push(parseDeploymentPatch(patch));
					return { ...settings, pending: patch };
				},
				confirmRestart: async (action) => {
					calls.push(action);
					return false;
				},
				snapshot: async () => snapshot
			};
			await loadDeploymentSettings();
			expect(control('deployment-edit-form').hidden).toBe(false);
			expect(control('deployment-current').textContent).toContain('America/Chicago');
			expect(control('deployment-availability').disabled).toBe(kind !== 'azure-container-apps');
			expect(control('deployment-schedule').disabled).toBe(kind !== 'azure-container-apps');
			control('deployment-timezone').value = 'Asia/Tokyo';
			control('deployment-claude').value = '0';
			bindConfigurationEvents();
			await control('deployment-edit-form').listeners.get('submit')?.({ preventDefault() {} });
			expect(calls).toEqual([
				{ environment: { FH_TIMEZONE: 'Asia/Tokyo', FH_CLAUDE_REMOTE: '0' } },
				'apply'
			]);
			expect(control('apply-pending-restart').textContent).toBe('Apply changes');
		});
	}
	it('stores a narrow deployment draft and choosing Later never applies or starts the target', async () => {
		const snapshot = {
			...normalizedSnapshot({
				ref: { kind: 'azure-container-apps', connectionId: 'cloud', resourceId: '/resource/agent' },
				lifecycle: 'deployed',
				services: []
			}),
			pendingChanges: known({ pending: true }),
			operations: { 'host.deployment.prepare': supported(), 'host.deployment.apply': supported() }
		};
		state.currentSnapshot = snapshot;
		state.deploymentSettings = {
			containers: [{ name: 'assistant', image: 'image:pinned' }],
			environment: {}
		};
		const calls: unknown[] = [];
		state.api = {
			prepareDeployment: async (patch) => {
				calls.push(['prepare', patch]);
				return { ...state.deploymentSettings, pending: patch };
			},
			confirmRestart: async (action) => {
				calls.push(['confirm', action]);
				return false;
			},
			applyDeployment: async () => {
				throw new Error('Later must not apply');
			},
			action: async () => {
				throw new Error('Later must not start');
			},
			snapshot: async () => snapshot
		};
		control('deployment-availability').value = 'on-demand';
		bindConfigurationEvents();
		await control('deployment-edit-form').listeners.get('submit')?.({ preventDefault() {} });
		expect(calls).toEqual([
			['prepare', { availability: 'on-demand' }],
			['confirm', 'apply']
		]);
		expect(control('pending-restart').hidden).toBe(false);
		expect(control('apply-pending-restart').textContent).toBe('Apply changes');
	});
	it('does not turn an accepted update or lifecycle request into a completion message', async () => {
		const snapshot = normalizedSnapshot({ config: defaultStackConfig() });
		state.currentSnapshot = snapshot;
		state.api = {
			confirmRestart: async () => true,
			update: async () => ({
				snapshot,
				outcome: { state: 'unknown', step: 'stopping', reference: 'operation-1' }
			}),
			action: async () => ({
				snapshot,
				outcome: { state: 'submitted', step: 'start', reference: 'operation-2' }
			})
		};
		bindRuntimeEvents();
		await control('update-stack').listeners.get('click')?.({});
		expect(control('notice-message').textContent).toContain('unknown');
		expect(control('notice-message').textContent).toContain('operation-1');
		await requestStackAction('host.start');
		expect(control('notice-message').textContent).toContain('submitted');
		expect(control('notice-message').textContent).not.toContain('started');
	});
	it('keeps pending changes visible when restart is postponed, refreshed or navigation changes', async () => {
		state.currentSnapshot = {
			...normalizedSnapshot({
				config: defaultStackConfig(),
				services: [{ name: 'assistant', state: 'running', health: 'healthy' }]
			}),
			pendingChanges: known({ pending: true })
		};
		let applies = 0;
		state.api = {
			confirmRestart: async () => false,
			action: async () => {
				applies++;
			}
		};
		renderRestartStatus(state.currentSnapshot);
		await offerRestart();
		expect(applies).toBe(0);
		expect(control('pending-restart').hidden).toBe(false);
		expect(control('pending-restart-title').textContent).toBe('Changes pending');
		showView('system');
		expect(control('pending-restart').hidden).toBe(false);
		renderRestartStatus(structuredClone(state.currentSnapshot));
		expect(control('pending-restart').hidden).toBe(false);
	});

	it('applies only after confirmation, retains the alert on failure, and handles stopped instances', async () => {
		state.currentSnapshot = {
			...normalizedSnapshot({ config: defaultStackConfig(), services: [] }),
			pendingChanges: known({ pending: true })
		};
		const calls: unknown[] = [];
		state.api = {
			confirmRestart: async (action) => {
				calls.push(action);
				return true;
			},
			action: async (...args) => {
				calls.push(args);
				throw new Error('Startup failed');
			},
			snapshot: async () => {
				throw new Error('Docker unavailable');
			}
		};
		renderRestartStatus(state.currentSnapshot);
		expect(control('apply-pending-restart').textContent).toBe('Apply changes');
		await offerRestart();
		expect(calls).toEqual(['apply', ['start', true]]);
		expect(control('pending-restart').hidden).toBe(false);
		state.api.action = async (...args) => {
			calls.push(args);
			return { ok: true };
		};
		await requestStackAction('host.restart');
		expect(calls.at(-1)).toEqual(['restart', true]);
		renderRestartStatus({
			...normalizedSnapshot({ config: defaultStackConfig(), services: [] }),
			pendingChanges: known({ pending: false })
		});
		expect(control('pending-restart').hidden).toBe(true);
	});
	it('groups settings by task and removes the duplicate overview catalog', () => {
		expect(html).not.toContain('Things to try');
		expect(html).not.toContain('choice-grid');
		expect([...html.matchAll(/data-view="([^"]+)"/g)].map((match) => match[1])).toEqual([
			'overview',
			'provider',
			'knowledge',
			'connections',
			'system'
		]);
		expect(html).toContain('data-view="system"');
		expect(html).not.toContain('id="agent-preferences"');
		expect(html).not.toContain('id="view-access"');
		expect(html.indexOf('id="opencode-network-form"')).toBeGreaterThan(
			html.indexOf('id="view-connections"')
		);
	});

	it('captures and restores externally associated MCP configuration controls', () => {
		const form = control('mcp-connections-form');
		const gateway = control('gateway');
		form.elements = [gateway];
		gateway.form = form;
		gateway.type = 'checkbox';
		gateway.checked = true;
		state.dirtyForms.add('mcp-connections-form');
		const drafts = captureDirtyForms();
		expect(drafts['mcp-connections-form'].gateway).toEqual({ checked: true });
		gateway.checked = false;
		restoreDirtyForms(drafts);
		expect(gateway.checked).toBe(true);
	});
	it('labels Guardian as an MCP API and keeps diagnostic endpoints copy-only', () => {
		expect(html).not.toContain('Protected-access');
		expect(html).toContain('for="gateway-bind"');
		expect(html).toContain('not a website');
		expect(html).toContain('connection; external apps may not be listed');
		for (const id of ['mcp-url', 'guardian-health-url-detail']) {
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
		expect(css.replace(/\s+/g, '')).toContain(
			':where(a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"])):focus-visible'
		);
		expect(css).toContain('.field textarea {');
	});

	it('renders an authenticated browser action and copyable dialable Guardian endpoints', async () => {
		const link = control('assistant-url-detail');
		link.hidden = true;
		const copy = new Control();
		copy.dataset.copyField = 'mcp-url';
		selector('[data-copy-field]', copy);
		const copied: string[] = [];
		state.api = {
			copyText: async (value: string) => {
				copied.push(value);
			}
		};
		bindConnectionsEvents();
		expect(link.hidden).toBe(true);
		expect(link.listeners.has('click')).toBe(true);
		renderNetworkDetails(
			normalizedSnapshot({
				connections: {
					opencode: { url: 'http://192.0.2.10:3810' }
				}
			})
		);
		expect(link.textContent).toBe('http://192.0.2.10:3810');
		expect(link.getAttribute('href')).toBe(link.textContent);
		expect(link.hidden).toBe(false);
		expect(link.getAttribute('tabindex')).toBeNull();
		renderConnectionDetails(
			normalizedSnapshot({
				connections: {
					opencode: { url: 'http://192.0.2.10:3810' },
					claude: { url: 'http://[::1]:3830/mcp' },
					mcp: { url: 'http://[::1]:3830/mcp' }
				}
			})
		);
		expect(control('mcp-url').textContent).toBe('http://[::1]:3830/mcp');
		expect(control('guardian-health-url-detail').textContent).toBe('');
		expect(control('guardian-api-status').textContent).toContain('Enable MCP access');
		await copy.listeners.get('click')?.({});
		expect(copied).toEqual(['http://[::1]:3830/mcp']);
		renderNetworkDetails(
			normalizedSnapshot({
				connections: {
					opencode: { url: 'http://[::1]:3810' },
					mcp: { url: 'http://127.0.0.1:3830/mcp' }
				}
			})
		);
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
		const snapshot = normalizedSnapshot({
			connections: {
				opencode: { url: 'http://127.0.0.1:3810', username: 'user' },
				claude: {
					url: 'http://127.0.0.1:3830/mcp',
					note,
					extension: extension as string | undefined
				},
				mcp: { url: 'http://127.0.0.1:3830/mcp' }
			}
		});
		renderConnectionDetails(snapshot);
		expect(control('claude-extension-help').textContent).toBe(note);
		expect(control('claude-extension-download').getAttribute('href')).toBe(extension);
		expect(control('claude-extension-download').hidden).toBe(false);
		expect(html).toContain('data-copy-field="claude-extension-help"');
		renderConnectionDetails(
			normalizedSnapshot({
				connections: {
					opencode: snapshot.apps.connections.value.opencode,
					claude: { ...snapshot.apps.connections.value.claude, extension: undefined },
					mcp: snapshot.apps.connections.value.mcp
				}
			})
		);
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
		control('instance-welcome').hidden = false;
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
		renderProviders({
			providers: [
				{
					id: 'example',
					name: 'Example',
					authenticated: true,
					models: [{ id: 'text-model', name: 'Text model' }],
					authMethods: [{ index: 0, type: 'api', label: 'API key' }]
				}
			]
		});
		openProviderEditor('change', 'example');
		control('provider-model').value = 'text-model';
		const failed = await verifyProvider('Checking', async () => ({
			ok: false,
			error: 'Sign-in expired'
		}));
		expect(failed).toBe(false);
		expect(control('notice').hidden).toBe(true);
		expect(control('provider-status').getAttribute('role')).toBe('alert');
		expect(control('provider-status').getAttribute('aria-live')).toBe('assertive');
		expect(control('provider-status').children[1].textContent).toBe('Sign-in expired');
		expect(control('provider-badge').hidden).toBe(true);
		expect(control('use-provider-model').disabled).toBe(true);
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
		renderPhase('not-installed');
		expect(control('install-section').hidden).toBe(false);
		expect(control('app-shell').hidden).toBe(true);
		expect(control('skip-link').getAttribute('href')).toBe('#install-section');
		state.currentSnapshot = normalizedSnapshot({ lifecycle: 'setup-incomplete' });
		renderPhase('setup-incomplete');
		expect(control('install-section').hidden).toBe(true);
		expect(control('app-shell').hidden).toBe(false);
		expect(setup.hidden).toBe(false);
		expect(ready.hidden).toBe(true);
		expect(state.currentView).toBe('provider');
		showView('connections');
		expect(state.currentView).toBe('provider');
		state.currentSnapshot = normalizedSnapshot();
		renderPhase('ready');
		expect(setup.hidden).toBe(true);
		expect(ready.hidden).toBe(false);
		showView('connections', { focus: true });
		expect(state.currentView).toBe('connections');
		expect(control('view-title').focused).toBe(true);
	});

	it('opens the requested app disclosure in Connections without separate client tabs', () => {
		state.currentSnapshot = normalizedSnapshot();
		showConnectionApp('claude');
		expect(state.currentView).toBe('connections');
		expect(control('claude-connection').open).toBe(true);
		expect(control('opencode-connection').open).toBe(false);
		expect(html).not.toContain('data-client-panel');
		showConnectionApp('not-an-app');
		expect(state.currentView).toBe('connections');
	});

	it('preserves only dirty app form drafts, including unchecked bot enablement', () => {
		control('discord-connections-form').children = [control('discord-users'), control('discord')];
		control('discord-users').value = 'reviewed-user';
		control('discord').type = 'checkbox';
		control('discord').checked = false;
		state.dirtyForms.add('discord-connections-form');
		const drafts = captureDirtyForms();
		expect(drafts).toEqual({
			'discord-connections-form': {
				'discord-users': { value: 'reviewed-user' },
				discord: { checked: false }
			}
		});
		control('discord-users').value = '';
		control('discord').checked = true;
		restoreDirtyForms(drafts);
		expect(control('discord-users').value).toBe('reviewed-user');
		expect(control('discord').checked).toBe(false);
		restoreDirtyForms({ 'discord-connections-form': { 'assistant-port': { value: '9999' } } });
		expect(control('assistant-port').value).toBe('');
		setFormClean('discord-connections-form');
		expect(captureDirtyForms()).toEqual({});
	});

	it('copies a connection key only after an explicit request without revealing it in the renderer', async () => {
		let loads = 0;
		let copied = '';
		state.api = {
			credentialKey: async () => {
				loads++;
				return { key: 'private-test-key' };
			},
			copyText: async (value: string) => {
				copied = value;
			}
		};
		await copyAccessKey('');
		expect(loads).toBe(0);
		await copyAccessKey('family');
		expect(loads).toBe(1);
		expect(copied).toBe('private-test-key');
		expect(JSON.stringify(state)).not.toContain('private-test-key');
		expect(control('notice-message').textContent).not.toContain('private-test-key');
		for (const id of ['mcp-key', 'show-mcp-key', 'claude-key', 'show-claude-key']) {
			expect(html).not.toContain(`id="${id}"`);
		}
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

	it('omits memory/timezone controls without duplicate remote toggles or false connection readiness', () => {
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
		renderRemoteStatus(snapshot);
		expect(html).not.toContain('id="agent-timezone"');
		expect(html).not.toContain('id="automatic-memory"');
		expect(html).not.toContain('id="preferences-form"');
		expect(control('codex-remote-status').textContent).toContain('Unavailable for this instance');
		expect(control('claude-remote-status').textContent).toBe('Unavailable for this instance');
		expect(html).not.toContain('id="codex-remote"');
		expect(html).not.toContain('id="claude-remote"');
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
		await control('opencode-network-form').listeners.get('submit')?.({ preventDefault() {} });
		expect((submitted as { baseConfig: unknown }).baseConfig).toEqual(state.currentConfig);
		expect((submitted as { config: unknown }).config).toEqual({
			assistant: {
				bindAddress: '127.0.0.1',
				port: 4200,
				timezone: 'Europe/London',
				automaticMemory: false
			},
			gateway: { bindAddress: '127.0.0.1', port: 9180, enabled: true }
		});
	});
});

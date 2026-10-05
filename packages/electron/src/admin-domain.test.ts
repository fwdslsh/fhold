import { afterEach, describe, expect, it } from 'bun:test';
import { readdirSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultStackConfig, createBackup, writeStackConfig, MANAGED_FILES, SEEDED_FILES } from '@fhold/lib';
import { stageAdminAssets, DISTRIBUTION_ASSETS } from '../scripts/stage-assets.js';
import { retainAdminE2eHome } from '../scripts/admin-e2e-retention.mjs';

import {
	confirmedAdminAction,
	interruptionPrompt,
	adminPortalMappings,
	adminPortalTokens,
	backupFromAdmin,
	createAdminCredential,
	externalAdminUrl,
	restoreFromAdmin,
	installFromAdmin,
	isAdminPageUrl,
	mapAdminPortalUser,
	removeAdminCredential,
	rotateAdminCredential,
	saveAdminConfig
} from './admin-domain.js';

const roots: string[] = [];
const originalHome = process.env.FH_HOME;
const originalRepo = process.env.FH_REPO_ROOT;
const originalSkeleton = process.env.FH_SKELETON_DIR;
const originalProject = process.env.FH_PROJECT_NAME;

afterEach(() => {
	if (originalHome === undefined) delete process.env.FH_HOME;
	else process.env.FH_HOME = originalHome;
	if (originalRepo === undefined) delete process.env.FH_REPO_ROOT;
	else process.env.FH_REPO_ROOT = originalRepo;
	if (originalSkeleton === undefined) delete process.env.FH_SKELETON_DIR;
	else process.env.FH_SKELETON_DIR = originalSkeleton;
	if (originalProject === undefined) delete process.env.FH_PROJECT_NAME;
	else process.env.FH_PROJECT_NAME = originalProject;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function install(
	config: unknown = defaultStackConfig(), automaticPorts = true
): Promise<{ root: string; home: string }> {
	const root = mkdtempSync(join(tmpdir(), 'fhold-admin-domain-'));
	roots.push(root);
	const home = join(root, 'home');
	process.env.FH_HOME = home;
	process.env.FH_REPO_ROOT = join(import.meta.dir, '../../..');
	await installFromAdmin(config, undefined, automaticPorts);
	return { root, home };
}

describe('Admin domain', () => {
	it('requires explicit container confirmation and defaults native dialogs to postponing', () => {
		for (const action of ['start', 'restart', 'stop'] as const) {
			expect(() => confirmedAdminAction(action)).toThrow();
			expect(() => confirmedAdminAction({ action })).toThrow('Confirm');
			expect(() => confirmedAdminAction({ action, confirmed: false })).toThrow('Confirm');
			expect(confirmedAdminAction({ action, confirmed: true })).toBe(action);
		}
		expect(() => confirmedAdminAction({ action: ['start'], confirmed: true })).toThrow();
		expect(interruptionPrompt('restart').buttons).toEqual(['Restart later', 'Restart now']);
		expect(interruptionPrompt('recovery-init').buttons[0]).toBe('Cancel');
		expect(interruptionPrompt('recovery-init').detail).toContain('genuinely unused');
		expect(interruptionPrompt('recovery-restore').detail).toContain('containers remain stopped');
		expect(interruptionPrompt('remote-setup').detail).toContain('before and after native sign-in');
		expect(() => interruptionPrompt(['restart'])).toThrow();
	});
	it('installs explicitly selected homes with distinct stable Compose projects without changing FH_HOME', async () => {
		const { root, home } = await install();
		const other = join(root, 'other-home');
		const third = join(root, 'third-home');
		delete process.env.FH_PROJECT_NAME;
		await installFromAdmin(defaultStackConfig(other), other);
		await installFromAdmin(defaultStackConfig(third), third);
		expect(process.env.FH_HOME).toBe(home);
		const first = readFileSync(join(other, 'state', 'stack.env'), 'utf8');
		const second = readFileSync(join(third, 'state', 'stack.env'), 'utf8');
		expect(first.match(/FH_PROJECT_NAME=(.*)/)?.[1]).toMatch(/^fhold-[a-f0-9]{12}$/);
		expect(first.match(/FH_PROJECT_NAME=(.*)/)?.[1]).not.toBe(
			second.match(/FH_PROJECT_NAME=(.*)/)?.[1]
		);
		process.env.FH_PROJECT_NAME = 'launch-default-project';
		const fourth = join(root, 'fourth-home');
		await installFromAdmin(defaultStackConfig(fourth), fourth);
		expect(readFileSync(join(fourth, 'state', 'stack.env'), 'utf8')).not.toContain(
			'launch-default-project'
		);
	});
	it('authenticates the exact local Admin page with platform-aware file paths', () => {
		const windows = 'file:///C:/Users/Runner/fhold%20Admin/resources/app.asar/admin/index.html';
		expect(
			isAdminPageUrl(
				'file:///c:/Users/Runner/fhold%20Admin/resources/app.asar/admin/index.html',
				windows,
				true
			)
		).toBe(true);
		expect(
			isAdminPageUrl(
				'file:///C:/users/runner/fhold%20Admin/resources/app.asar/admin/index.html',
				windows,
				true
			)
		).toBe(true);
		const posix = 'file:///opt/fhold%20Admin/admin/index.html';
		expect(isAdminPageUrl('file:///opt/fhold%20Admin/admin/index.html', posix, false)).toBe(
			true
		);
		for (const value of [
			undefined,
			'invalid',
			'https://example.com/index.html',
			'file:///opt/fhold%20admin/admin/index.html',
			'file:///opt/fhold%20Admin/admin/evil.html',
			'file:///opt/fhold%20Admin/admin/index.html?query=1',
			'file:///opt/fhold%20Admin/admin/index.html#frame',
			'file://remote/opt/fhold%20Admin/admin/index.html',
			'file:///opt/fhold%20Admin/admin%2Findex.html'
		]) {
			expect(isAdminPageUrl(value, posix, false)).toBe(false);
		}
		for (const value of [
			'file:///d:/Users/Runner/fhold%20Admin/resources/app.asar/admin/index.html',
			'file:///c:/Users/Runner/fhold%20Admin/resources/app.asar/admin/other.html',
			'file://remote/share/index.html'
		]) {
			expect(isAdminPageUrl(value, windows, true)).toBe(false);
		}
	});

	it('packages exactly the shared managed and seeded Skeleton allowlists', () => {
		const builder = Bun.YAML.parse(
			readFileSync(join(import.meta.dir, '..', 'electron-builder.yml'), 'utf8')
		) as { extraResources: Array<{ from: string; to: string }> };
		const resource = builder.extraResources.find((entry) => entry.to === 'skeleton');
		if (!resource) throw new Error('Missing packaged Skeleton resources.');
		expect(resource.from).toBe('dist/skeleton');
  expect(DISTRIBUTION_ASSETS).toEqual([...MANAGED_FILES, ...SEEDED_FILES].sort());
  const staged = stageAdminAssets(join(import.meta.dir, '../../..'));
  function inventory(directory: string, prefix = ''): string[] {
   return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? inventory(join(directory, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]);
  }
  expect(inventory(staged).sort()).toEqual(DISTRIBUTION_ASSETS);
	});

	it('materializes a complete fresh home using only packaged Skeleton resources', async () => {
		const builder = Bun.YAML.parse(
			readFileSync(join(import.meta.dir, '..', 'electron-builder.yml'), 'utf8')
		) as { extraResources: Array<{ from: string; to: string }> };
		const resource = builder.extraResources.find((entry) => entry.to === 'skeleton');
		if (!resource) throw new Error('Missing packaged Skeleton resources.');
		expect(resource.from).toBe('dist/skeleton');
		const filter = DISTRIBUTION_ASSETS;
		const root = mkdtempSync(join(tmpdir(), 'fhold-admin-packaged-seed-'));
		roots.push(root);
		const packagedSkeleton = join(root, 'resources', 'skeleton');
		const source = join(import.meta.dir, '..', '..', 'skeleton');
		for (const path of filter) {
			const destination = join(packagedSkeleton, path);
			mkdirSync(dirname(destination), { recursive: true });
			copyFileSync(join(source, path), destination);
		}
		process.env.FH_SKELETON_DIR = packagedSkeleton;
		const { home } = await install();
		for (const path of [...MANAGED_FILES, ...SEEDED_FILES]) {
			expect(readFileSync(join(home, path))).toEqual(readFileSync(join(source, path)));
		}
	});

	it('retains explicit and provider-backed E2E homes without requiring KEEP flags', () => {
		for (const name of [
			'FH_ADMIN_E2E_HOME',
			'FH_ADMIN_E2E_PROVIDER',
			'FH_ADMIN_E2E_PROVIDER_KEY',
			'FH_ADMIN_E2E_PROVIDER_KEY_FILE'
		]) {
			expect(
				retainAdminE2eHome({ [name]: 'supplied-test-value', FH_ADMIN_E2E_KEEP_HOME: 'false' })
			).toBe(true);
		}
		expect(retainAdminE2eHome({ FH_ADMIN_E2E_KEEP_HOME: 'true' })).toBe(true);
		expect(retainAdminE2eHome({ FH_ADMIN_E2E_KEEP_RUNNING: 'true' })).toBe(true);
		expect(retainAdminE2eHome({})).toBe(false);
	});

	it('retains unexpectedly populated or malformed E2E provider auth', () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-admin-retention-'));
		roots.push(root);
		mkdirSync(join(root, 'knowledge', 'secrets'), { recursive: true });
		const auth = join(root, 'knowledge', 'secrets', 'auth.json');
		writeFileSync(auth, '{}');
		expect(retainAdminE2eHome({}, root)).toBe(false);
		writeFileSync(auth, JSON.stringify({ test: { type: 'api', key: 'synthetic-test-key' } }));
		expect(retainAdminE2eHome({}, root)).toBe(true);
		writeFileSync(auth, '{malformed');
		expect(retainAdminE2eHome({}, root)).toBe(true);
		expect(readFileSync(auth, 'utf8')).toBe('{malformed');
	});

	it('opens ordinary HTTP and HTTPS links without embedded credentials', () => {
		for (const address of [
			'http://127.0.0.1:3810',
			'http://192.0.2.10:3810',
			'http://[::1]:3810',
			'http://example.com',
			'https://example.com/sign-in?state=abc'
		]) {
			expect(externalAdminUrl(address)).toBe(new URL(address).href);
		}
		for (const value of [
			null,
			42,
			'file:///tmp/private',
			'javascript:alert(1)',
			'https://user:password@example.com',
			`https://example.com/${'a'.repeat(4096)}`
		]) {
			expect(() => externalAdminUrl(value)).toThrow();
		}
	});

	it('requires portal-specific initial tokens and keeps blank Slack values unchanged', () => {
		expect(() => adminPortalTokens({ portal: 'discord' }, {})).toThrow('Discord bot token');
		expect(() => adminPortalTokens({ portal: 'slack', botToken: 'bot' }, {})).toThrow('Both Slack');
		expect(adminPortalTokens({ portal: 'slack', botToken: 'bot', appToken: 'app' }, {})).toEqual({
			portal: 'slack',
			botToken: 'bot',
			appToken: 'app'
		});
		const configured = { slack_bot_token: true, slack_app_token: true };
		expect(
			adminPortalTokens({ portal: 'slack', botToken: '', appToken: 'new-app' }, configured)
		).toEqual({ portal: 'slack', appToken: 'new-app' });
		expect(() =>
			adminPortalTokens({ portal: 'slack', botToken: '', appToken: '' }, configured)
		).toThrow('at least one');
		expect(() =>
			adminPortalTokens({ portal: 'slack', botToken: 123, appToken: 'app' }, configured)
		).toThrow('Invalid portal token');
		expect(() => adminPortalTokens([], {})).toThrow();
	});

	it('validates and preserves first-install port choices', async () => {
		const config = defaultStackConfig();
		config.assistant.port = 43_810;
		config.gateway.port = 43_830;
		const { home } = await install(config, false);
		const saved = JSON.parse(readFileSync(join(home, 'state', 'stack.json'), 'utf8'));
		expect(saved.assistant.port).toBe(43_810);
		expect(saved.gateway.port).toBe(43_830);

		await expect(install({ version: 1 })).rejects.toThrow('product fhold');
	});

	it('installs the active skeleton and manages credentials and portal mappings', async () => {
		const { home } = await install();
		expect(JSON.parse(readFileSync(join(home, 'state', 'stack.json'), 'utf8')).version).toBe(1);
		const created = createAdminCredential(home, { username: 'family', policy: 'read' });
		const firstKey = readFileSync(created.keyFile, 'utf8');
		mapAdminPortalUser(home, {
			portal: 'discord',
			userId: '123456789012345678',
			username: 'family'
		});
		expect(adminPortalMappings(home).discord.users).toEqual({
			'123456789012345678': 'family'
		});
		rotateAdminCredential(home, 'family');
		expect(readFileSync(created.keyFile, 'utf8')).not.toBe(firstKey);
		expect(() => removeAdminCredential(home, 'family')).toThrow('assigned');
		mapAdminPortalUser(home, { portal: 'discord', userId: '123456789012345678' });
		removeAdminCredential(home, 'family');
	});

	it('creates a portable backup through the shared library', async () => {
		const { root, home } = await install();
		mkdirSync(join(home, 'knowledge', 'inbox'), { recursive: true });
		writeFileSync(join(home, 'knowledge', 'inbox', 'result.md'), 'durable result');
		const destination = join(root, 'backup');
		const manifest = await backupFromAdmin(home, { destination });
		expect(manifest.files.some((entry) => entry.path === 'knowledge/inbox/result.md')).toBe(true);
	});

	it('synchronizes portal bundles when Admin changes a default credential', async () => {
		const { home } = await install();
		createAdminCredential(home, { username: 'family', policy: 'read' });
		const config = JSON.parse(readFileSync(join(home, 'state', 'stack.json'), 'utf8'));
		const baseline = structuredClone(config);
		config.portals.discord.credential = 'family';
		saveAdminConfig(home, config, baseline);
		const bundle = JSON.parse(
			readFileSync(join(home, 'state', 'portal-credentials', 'discord', 'credentials.json'), 'utf8')
		);
		expect(bundle.default).toBe('family');
		expect(bundle.credentials.family).toBeString();
	});

	it('reconciles delegated portal bundles after applying an Admin restore', async () => {
		const { root, home } = await install();
		process.env.FH_HOME = join(root, 'unrelated-default');
		const source = join(root, 'old-home');
		mkdirSync(join(source, 'config', 'portal', 'discord'), { recursive: true });
		writeFileSync(
			join(source, 'config', 'portal', 'discord', 'credentials.json'),
			JSON.stringify({ version: 1, users: { '123456789012345678': 'owner' } })
		);
		writeStackConfig(source, defaultStackConfig(source));
		const archive = join(root, 'portable-backup');
		await createBackup({ sourceHome: source, destination: archive, includePortalMaps: true });
		const preview = restoreFromAdmin(home, { sourceHome: archive, includePortalMaps: true });
		restoreFromAdmin(home, {
			sourceHome: archive,
			apply: true,
			previewDigest: preview.digest,
			includePortalMaps: true
		});
		const bundle = JSON.parse(
			readFileSync(join(home, 'state', 'portal-credentials', 'discord', 'credentials.json'), 'utf8')
		);
		expect(bundle.users).toEqual({ '123456789012345678': 'owner' });
	});
});

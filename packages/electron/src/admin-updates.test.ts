import { afterEach, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppImageUpdater } from 'electron-updater';
import { AdminSettingsStore, parseAdminSettings } from './admin-settings.js';
import { AdminUpdates, type AdminAppSnapshot } from './admin-updates.js';

const fixtures: string[] = [];
afterEach(() => {
	for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});
function store() {
	const path = mkdtempSync(join(tmpdir(), 'fhold-admin-preferences-test-'));
	fixtures.push(path);
	return new AdminSettingsStore(path);
}
class Updater extends EventEmitter {
	autoDownload = false;
	autoInstallOnAppQuit = false;
	allowPrerelease = true;
	allowDowngrade = true;
	channel: string | null = null;
	checks = 0;
	downloads = 0;
	installs = 0;
	available = false;
	failure?: Error;
	installFailure?: Error;
	release?: () => void;
	async checkForUpdates() {
		this.checks++;
		if (this.failure) throw this.failure;
		if (this.release)
			await new Promise<void>((resolve) => {
				this.release = resolve;
			});
		if (!this.available) {
			this.emit('update-not-available');
			return null;
		}
		this.emit('update-available', { version: '0.3.261002-beta' });
		return { downloadPromise: this.autoDownload ? this.downloadUpdate() : undefined };
	}
	async downloadUpdate() {
		this.downloads++;
		this.emit('download-progress', { percent: 51 });
		this.emit('update-downloaded', { version: '0.3.261002-beta' });
		return [];
	}
	quitAndInstall() {
		this.installs++;
		if (this.installFailure) this.emit('error', this.installFailure);
	}
}
function setup(preferences = store(), unavailableReason?: string) {
	const native: Updater[] = [];
	const changes: AdminAppSnapshot[] = [];
	const updates = new AdminUpdates(preferences, {
		version: '0.3.261001-beta',
		unavailableReason,
		createUpdater: () => {
			const value = new Updater();
			native.push(value);
			return value as unknown as AppImageUpdater;
		},
		changed: (snapshot) => changes.push(snapshot)
	});
	return { updates, native, changes, preferences };
}

test('app preferences default to Stable and automatic even for a beta app, without creating files', () => {
	const { updates, native, preferences } = setup();
	expect(updates.snapshot().settings.updates).toEqual({ channel: 'stable', automatic: true });
	expect(native).toHaveLength(0);
	expect(() => readFileSync(preferences.path)).toThrow();
});
test('preferences round-trip locally and reject malformed channel/automatic choices', () => {
	const preferences = store();
	preferences.save({ updates: { channel: 'beta', automatic: false } });
	expect(new AdminSettingsStore(join(preferences.path, '..')).read().updates).toEqual({
		channel: 'beta',
		automatic: false
	});
	for (const value of [
		null,
		{},
		{ updates: { channel: 'rc', automatic: true } },
		{ updates: { channel: 'stable', automatic: 'yes' } }
	])
		expect(() => parseAdminSettings(value)).toThrow();
	writeFileSync(preferences.path, '{incomplete');
	const damaged = new AdminSettingsStore(join(preferences.path, '..'));
	expect(damaged.read().updates.channel).toBe('stable');
	expect(damaged.error).toContain('could not be loaded');
	expect(readFileSync(preferences.path, 'utf8')).toBe('{incomplete');
});
test('Stable always excludes prereleases and never permits a downgrade', async () => {
	const { updates, native } = setup();
	await updates.check();
	expect(native[0].channel).toBeNull();
	expect(native[0].allowPrerelease).toBe(false);
	expect(native[0].allowDowngrade).toBe(false);
	expect(updates.snapshot().update.phase).toBe('idle');
	expect(updates.snapshot().update.checkedAt).toBeDefined();
});
test('Alpha and Beta use public native channels; switching back uses a fresh Stable updater', async () => {
	const { updates, native } = setup();
	for (const channel of ['alpha', 'beta', 'stable'] as const) {
		updates.save({ updates: { channel, automatic: false } });
		await updates.check();
		const current = native[native.length - 1];
		expect(current.channel).toBe(channel === 'stable' ? null : channel);
		expect(current.allowPrerelease).toBe(channel !== 'stable');
		expect(current.allowDowngrade).toBe(false);
	}
	expect(native).toHaveLength(3);
	expect(native[0].autoInstallOnAppQuit).toBe(false);
	expect(native[1].autoInstallOnAppQuit).toBe(false);
});
test('automatic checks download and stage an update but never call quitAndInstall', async () => {
	const { updates, native, changes } = setup();
	await updates.check();
	native[0].available = true;
	await updates.check();
	expect(native[0].downloads).toBe(1);
	expect(native[0].installs).toBe(0);
	expect(native[0].autoInstallOnAppQuit).toBe(true);
	expect(updates.snapshot().update.phase).toBe('ready');
	expect(changes.some((item) => item.update.progress === 51)).toBe(true);
	await updates.check();
	expect(native[0].checks).toBe(2);
	updates.install();
	expect(native[0].installs).toBe(1);
});
test('manual mode does not check in the background or download until requested', async () => {
	const preferences = store();
	preferences.save({ updates: { channel: 'beta', automatic: false } });
	const { updates, native } = setup(preferences);
	await updates.backgroundCheck();
	expect(native).toHaveLength(0);
	await updates.check();
	native[0].available = true;
	await updates.check();
	expect(native[0].downloads).toBe(0);
	expect(updates.snapshot().update.phase).toBe('available');
	await updates.download();
	expect(updates.snapshot().update.phase).toBe('ready');
});
test('changing channel invalidates a staged prerelease and disables its install-on-quit handler', async () => {
	const { updates, native } = setup();
	updates.save({ updates: { channel: 'beta', automatic: false } });
	await updates.check();
	native[0].available = true;
	await updates.check();
	await updates.download();
	expect(updates.snapshot().update.phase).toBe('ready');
	updates.save({ updates: { channel: 'stable', automatic: false } });
	expect(native[0].autoInstallOnAppQuit).toBe(false);
	expect(updates.snapshot().update.availableVersion).toBeUndefined();
	expect(() => updates.install()).toThrow('Download');
	await updates.check();
	expect(native[1].allowPrerelease).toBe(false);
});
test('turning automatic downloads off updates the active native updater and does not strand manual checks', async () => {
	const { updates, native } = setup();
	await updates.check();
	updates.save({ updates: { channel: 'stable', automatic: false } });
	native[0].available = true;
	await updates.check();
	expect(native[0].autoDownload).toBe(false);
	expect(native[0].downloads).toBe(0);
	expect(updates.snapshot().update.phase).toBe('available');
	updates.save({ updates: { channel: 'stable', automatic: true } });
	await Promise.resolve();
	await updates.download();
	expect(native[0].downloads).toBe(1);
	expect(updates.snapshot().update.phase).toBe('ready');
});
test('checks share a single request; preferences cannot race an active download/check', async () => {
	const { updates, native } = setup();
	await updates.check();
	native[0].release = () => {};
	const first = updates.check();
	const second = updates.check();
	expect(first).toBe(second);
	expect(() => updates.save({ updates: { channel: 'beta', automatic: true } })).toThrow('Wait');
	await Promise.resolve();
	native[0].release?.();
	await first;
	expect(native[0].checks).toBe(2);
});
test('offline, missing feed and throttling stay actionable without breaking Admin', async () => {
	for (const [error, expected] of [
		['ENOTFOUND github.com', 'internet'],
		['ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', 'No stable'],
		['HTTP 429', 'temporarily limited']
	]) {
		const { updates, native } = setup();
		await updates.check();
		native[0].failure = Error(error);
		await updates.check();
		expect(updates.snapshot().update.error).toContain(expected);
		expect(updates.snapshot().update.phase).toBe('idle');
		native[0].failure = undefined;
		await updates.check();
		expect(updates.snapshot().update.error).toBeUndefined();
	}
});
test('install errors retain ready state for retry instead of claiming the app restarted', async () => {
	const { updates, native } = setup();
	await updates.check();
	native[0].available = true;
	await updates.check();
	native[0].installFailure = Error('EACCES');
	updates.install();
	expect(updates.snapshot().update.phase).toBe('ready');
	expect(updates.snapshot().update.error).toContain('write permissions');
});
test('development, extracted builds and smoke runs do not initialize the native updater', async () => {
	const { updates, native } = setup(store(), 'Run the AppImage.');
	await updates.backgroundCheck();
	await updates.check();
	await updates.download();
	expect(native).toHaveLength(0);
	expect(updates.snapshot().update.unavailableReason).toBe('Run the AppImage.');
});
test('background checks are throttled while Admin is open', async () => {
	const { updates, native } = setup();
	await updates.backgroundCheck();
	await updates.backgroundCheck();
	expect(native[0].checks).toBe(1);
});

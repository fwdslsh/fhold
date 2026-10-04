import { afterEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyHomeSeed } from './seed.js';
import { ensureHomeDirs } from './foundation.js';
import {
	classifyInstall,
	createFholdState,
	ensureRuntime,
	markInstalled
} from './state.js';
import { installHome } from './install.js';
import { readStackConfig } from './stack-config.js';

const roots: string[] = [];
const originalHome = process.env.FH_HOME;
const originalRepo = process.env.FH_REPO_ROOT;
const originalProjectName = process.env.FH_PROJECT_NAME;

afterEach(() => {
	if (originalHome === undefined) delete process.env.FH_HOME;
	else process.env.FH_HOME = originalHome;
	if (originalRepo === undefined) delete process.env.FH_REPO_ROOT;
	else process.env.FH_REPO_ROOT = originalRepo;
	if (originalProjectName === undefined) delete process.env.FH_PROJECT_NAME;
	else process.env.FH_PROJECT_NAME = originalProjectName;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('fhold clean install boundary', () => {
	it('refuses symlinked runtime directories instead of escaping FH_HOME', () => {
		if (process.platform === 'win32') return;
		const root = mkdtempSync(join(tmpdir(), 'fhold-symlink-'));
		roots.push(root);
		const home = join(root, 'home');
		const outside = join(root, 'outside');
		mkdirSync(home);
		mkdirSync(outside);
		symlinkSync(outside, join(home, 'state'));
		expect(() => ensureHomeDirs(home)).toThrow('Refusing non-directory or symlink in FH_HOME');
	});

	it('refuses nested seed symlinks instead of writing managed files outside FH_HOME', async () => {
		if (process.platform === 'win32') return;
		const root = mkdtempSync(join(tmpdir(), 'fhold-seed-symlink-'));
		roots.push(root);
		const home = join(root, 'home');
		const outside = join(root, 'outside');
		process.env.FH_REPO_ROOT = join(import.meta.dir, '../../../..');
		ensureHomeDirs(home);
		mkdirSync(outside);
		symlinkSync(outside, join(home, 'system', 'assistant', 'agents'));
		await expect(applyHomeSeed(home)).rejects.toThrow('linked seed path');
		expect(existsSync(join(outside, 'remote.md'))).toBe(false);
	});

	it('classifies a nonempty unmanaged home as incompatible without mutating its files', () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-migration-'));
		roots.push(root);
		const home = join(root, 'home');
		process.env.FH_HOME = home;
		process.env.FH_REPO_ROOT = join(import.meta.dir, '../../../..');
		mkdirSync(join(home, 'system', 'stack'), { recursive: true });
		mkdirSync(join(home, 'config', 'stack'), { recursive: true });
		mkdirSync(join(home, 'state'), { recursive: true });
		writeFileSync(join(home, 'system', 'stack', 'unmanaged.compose.yml'), 'unmanaged: true\n');
		writeFileSync(join(home, 'config', 'stack', 'custom.compose.yml'), 'user: sentinel\n');
		writeFileSync(
			join(home, 'state', 'stack.env'),
			'FH_UID=1000\nFH_GID=1000\nFH_SETUP_COMPLETE=true\nFH_ENABLED_ADDONS=gateway\n'
		);

		expect(classifyInstall(home)).toBe('incompatible_home');
		expect(readFileSync(join(home, 'system', 'stack', 'unmanaged.compose.yml'), 'utf8')).toBe(
			'unmanaged: true\n'
		);
		expect(readFileSync(join(home, 'config', 'stack', 'custom.compose.yml'), 'utf8')).toBe(
			'user: sentinel\n'
		);
		expect(existsSync(join(home, 'system', 'stack', 'stack.compose.yml'))).toBe(false);
		expect(readFileSync(join(home, 'state', 'stack.env'), 'utf8')).toContain('gateway');
	});

	it('materializes an empty home as a fresh setup without deleting operator data', async () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-fresh-'));
		roots.push(root);
		const home = join(root, 'home');
		process.env.FH_HOME = home;
		process.env.FH_REPO_ROOT = join(import.meta.dir, '../../../..');
		mkdirSync(home);
		writeFileSync(join(home, 'keep.txt'), 'operator data\n');
		expect(classifyInstall(home)).toBe('incompatible_home');

		rmSync(join(home, 'keep.txt'));
		expect(classifyInstall(home)).toBe('not_installed');
		await applyHomeSeed(home);
		const state = createFholdState();
		ensureRuntime(state);
		expect(classifyInstall(home)).toBe('setup_incomplete');
		markInstalled(home);
		expect(classifyInstall(home)).toBe('installed');
		expect(readStackConfig(home).ok).toBe(true);
	});

	it('persists an explicit Compose project name for later multi-instance operations', async () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-project-name-'));
		roots.push(root);
		const home = join(root, 'home');
		process.env.FH_HOME = home;
		process.env.FH_PROJECT_NAME = 'fhold-second';
		process.env.FH_REPO_ROOT = join(import.meta.dir, '../../../..');

		await installHome({ homeDir: home });
		const state = createFholdState();
		ensureRuntime(state);
		expect(readFileSync(join(home, 'state', 'stack.env'), 'utf8')).toContain(
			'FH_PROJECT_NAME=fhold-second'
		);

		process.env.FH_PROJECT_NAME = 'different-project';
		ensureRuntime(state);
		expect(readFileSync(join(home, 'state', 'stack.env'), 'utf8')).toContain(
			'FH_PROJECT_NAME=fhold-second'
		);
	});

	it('rejects an invalid Compose project name before starting Docker', async () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-invalid-project-'));
		roots.push(root);
		const home = join(root, 'home');
		process.env.FH_HOME = home;
		process.env.FH_PROJECT_NAME = 'Invalid Project';
		process.env.FH_REPO_ROOT = join(import.meta.dir, '../../../..');

		await expect(installHome({ homeDir: home })).rejects.toThrow('deployment');
		expect(existsSync(home)).toBe(false);
	});
});

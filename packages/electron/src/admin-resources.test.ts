import { afterEach, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureAdminResources } from './admin-resources.js';
import { configureSkeletonDirectory, installHome, updateHome } from '@fhold/lib';
import { skeletonRoot } from '../../lib/src/control-plane/seed.js';

const roots: string[] = [];
const original = { skeleton: process.env.FH_SKELETON_DIR, repo: process.env.FH_REPO_ROOT };
afterEach(() => {
	configureSkeletonDirectory();
	for (const [name, value] of [
		['FH_SKELETON_DIR', original.skeleton],
		['FH_REPO_ROOT', original.repo]
	] as const) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('packaged relaunch ignores old mount/repository overrides without exporting resource paths', async () => {
	const root = mkdtempSync(join(tmpdir(), 'fhold-admin-relaunch-'));
	roots.push(root);
	const previous = join(root, 'old-mount');
	const current = join(root, 'new-mount');
	const home = join(root, 'instance');
	const source = join(import.meta.dir, '../../skeleton');
	cpSync(source, join(current, 'skeleton'), { recursive: true });
	cpSync(source, join(previous, 'skeleton'), { recursive: true });
	const app = { isPackaged: true, getAppPath: () => '/unused/app.asar' };
	configureAdminResources(app, previous);
	await installHome({ homeDir: home });
	// Model the automatic updater's inherited environment and retired mount.
	process.env.FH_SKELETON_DIR = join(previous, 'skeleton');
	process.env.FH_REPO_ROOT = '/old-development-checkout';
	rmSync(join(previous, 'skeleton/system/codex'), { recursive: true });
	// An earlier instance does not yet have the new system policy files, either.
	rmSync(join(home, 'system/codex'), { recursive: true });
	writeFileSync(join(home, 'config/assistant/persona.md'), 'operator-owned sentinel');
	configureAdminResources(app, current);
	expect(skeletonRoot()).toBe(join(current, 'skeleton'));
	await updateHome({ homeDir: home, start: false });
	expect(readFileSync(join(home, 'system/codex/config.toml'))).toEqual(
		readFileSync(join(source, 'system/codex/config.toml'))
	);
	expect(readFileSync(join(home, 'config/assistant/persona.md'), 'utf8')).toBe(
		'operator-owned sentinel'
	);
	expect(process.env.FH_SKELETON_DIR).toBe(join(previous, 'skeleton'));
	// The same code is also correct when the old mount no longer exists.
	rmSync(previous, { recursive: true });
	configureAdminResources(app, current);
	expect(skeletonRoot()).toBe(join(current, 'skeleton'));
});

test('development keeps explicit asset overrides; clean startup does not leak new ones', () => {
	const app = { isPackaged: false, getAppPath: () => '/repo/packages/electron' };
	const environment = { FH_SKELETON_DIR: '/reviewed-assets', FH_REPO_ROOT: '/reviewed-repo' };
	configureAdminResources(app, '/unused', environment);
	expect(skeletonRoot()).toBe('/reviewed-assets');
	configureAdminResources(app, '/unused', { FH_REPO_ROOT: '/reviewed-repo' });
	expect(skeletonRoot()).toBe('/reviewed-repo/packages/skeleton');
	configureAdminResources(app, '/unused', {});
	expect(skeletonRoot()).toBe('/repo/packages/skeleton');
	const clean = {};
	configureAdminResources({ ...app, isPackaged: true }, '/new/resources', clean);
	expect(clean).toEqual({});
});

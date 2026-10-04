import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
	symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyHomeSeed } from '../packages/lib/src/control-plane/seed.js';

const repo = join(import.meta.dir, '..');
const cli = join(repo, 'packages/cli/src/main.ts');
const fixtures: string[] = [];
function fixture(): string {
	const path = mkdtempSync(join(tmpdir(), 'fhold-contract-'));
	fixtures.push(path);
	return path;
}
function run(home: string, ...args: string[]) {
	return spawnSync(process.execPath, [cli, ...args], {
		cwd: repo, encoding: 'utf8', timeout: 20_000,
		env: { ...process.env, FH_HOME: home, FH_REPO_ROOT: repo, FH_DOCKER_BIN: '/usr/bin/false' }
	});
}
function inventory(root: string): Record<string, string> {
	const result: Record<string, string> = {};
	function walk(path: string, prefix: string) {
		for (const name of readdirSync(path).sort()) {
			const full = join(path, name);
			const relative = prefix ? `${prefix}/${name}` : name;
			const info = lstatSync(full);
			result[relative] = `${info.mode}:${info.mtimeMs}:${info.isFile() ? createHash('sha256').update(readFileSync(full)).digest('hex') : info.isSymbolicLink() ? 'symlink' : 'directory'}`;
			if (info.isDirectory()) walk(full, relative);
		}
	}
	walk(root, '');
	return result;
}
function install(home: string): Record<string, unknown> {
	const result = run(home, 'install', '--no-start');
	expect(result.status, result.stderr || result.stdout).toBe(0);
	return JSON.parse(readFileSync(join(home, 'state/stack.json'), 'utf8'));
}
afterEach(() => {
	for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('fhold installation contract', () => {
	it('keeps product copy lowercase throughout tracked text', () => {
		const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8' });
		expect(tracked.status).toBe(0);
		for (const path of tracked.stdout.split('\0').filter(Boolean)) {
			const bytes = readFileSync(join(repo, path));
			const text = bytes.toString('utf8');
			if (!Buffer.from(text).equals(bytes) || text.includes('\0')) continue;
			expect(text, path).not.toMatch(/f[H]old|F[H]old|\bF[H]OLD\b/);
		}
	});
	it('CLI installs distinct per-home projects and an explicit product identity', () => {
		const one = fixture();
		const two = fixture();
		const a = install(one);
		const b = install(two);
		expect(a.product).toBe('fhold');
		expect(b.product).toBe('fhold');
		const first = a.deployment as { projectName: string };
		const second = b.deployment as { projectName: string };
		expect(first.projectName).toMatch(/^fhold-/);
		expect(second.projectName).toMatch(/^fhold-/);
		expect(first.projectName).not.toBe(second.projectName);
	});
	it('status and logs are read-only even through a canonical-home alias', () => {
		const home = fixture();
		install(home);
		const aliasRoot = fixture();
		const alias = join(aliasRoot, 'selected-instance');
		symlinkSync(home, alias, 'dir');
		const before = inventory(home);
		run(alias, 'status', '--json');
		expect(inventory(home)).toEqual(before);
		run(alias, 'logs');
		expect(inventory(home)).toEqual(before);
	});
	it('foreign and future homes are refused without writes', () => {
		for (const config of [{ product: 'another-product', version: 1 }, { product: 'fhold', version: 999 }]) {
			const home = fixture();
			mkdirSync(join(home, 'state'));
			writeFileSync(join(home, 'state/stack.json'), JSON.stringify(config));
			writeFileSync(join(home, 'authored.txt'), 'Keep this file unchanged.');
			const before = inventory(home);
			const result = run(home, 'install', '--no-start');
			expect(result.status).not.toBe(0);
			expect(inventory(home)).toEqual(before);
		}
	});
	it('an unknown schema is rejected before an update can replace managed files', () => {
		const home = fixture();
		const config = install(home);
		writeFileSync(join(home, 'state/stack.json'), JSON.stringify({ ...config, version: 999 }));
		writeFileSync(join(home, 'system/stack/stack.compose.yml'), '# preserved until preflight succeeds\n');
		const before = inventory(home);
		const result = run(home, 'update', '--no-start');
		expect(result.status).not.toBe(0);
		expect(inventory(home)).toEqual(before);
	});
	it('an incomplete asset inventory cannot leave an earlier managed write behind', async () => {
		const home = fixture();
		const assets = fixture();
		mkdirSync(join(assets, 'system/stack'), { recursive: true });
		writeFileSync(join(assets, 'system/stack/stack.compose.yml'), '# incomplete candidate\n');
		const before = inventory(home);
		const previous = process.env.FH_SKELETON_DIR;
		process.env.FH_SKELETON_DIR = assets;
		try {
			await expect(applyHomeSeed(home)).rejects.toThrow();
			expect(inventory(home)).toEqual(before);
		} finally {
			if (previous === undefined) delete process.env.FH_SKELETON_DIR;
			else process.env.FH_SKELETON_DIR = previous;
		}
	});
	it('CLI exposes restore instead of a historical import/addon contract', () => {
		const help = run(fixture(), '--help');
		expect(help.status).toBe(0);
		expect(help.stdout).toMatch(/\brestore\b/);
		expect(help.stdout).not.toMatch(/^\s+(import|addon)\b/m);
	});
});

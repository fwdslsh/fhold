import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('interrupted native asset seeding never publishes a partial cache file and preserves operator entries', () => {
	const root = mkdtempSync(join(tmpdir(), 'fhold-akm-assets-'));
	const assets = join(root, 'assets');
	const cache = join(root, 'cache');
	mkdirSync(join(assets, 'opencode/version'), { recursive: true });
	mkdirSync(cache);
	const binary = join(assets, 'opencode/version/opencode');
	const bytes = Buffer.alloc(8192, 65);
	writeFileSync(binary, bytes);
	chmodSync(binary, 0o755);
	const entrypoint = readFileSync(new URL('../containers/assistant/entrypoint.sh', import.meta.url), 'utf8');
	// Substitute only the image's physical source tree; execute its actual
	// seeding function and coreutils, including a real failed copy.
	const helper = entrypoint.slice(entrypoint.indexOf('prepare_akm_assets() {'), entrypoint.indexOf('\nprepare_native_defaults() {'))
		.replaceAll('/assistant-defaults/akm-cache', assets);
	const script = join(root, 'seed.sh');
	writeFileSync(script, `set -eu\n${helper}\nprepare_akm_assets\n`);
	const run = (limited = false) => Bun.spawnSync(['bash', '-c', limited ? 'ulimit -f 2; bash "$1"' : 'bash "$1"', 'fixture', script], {
		env: { ...process.env, AKM_CACHE_DIR: cache }, stdout: 'pipe', stderr: 'pipe'
	});
	expect(run(true).exitCode).not.toBe(0);
	const target = join(cache, 'opencode/version/opencode');
	expect(existsSync(target)).toBe(false);
	expect(run().exitCode).toBe(0);
	expect(readFileSync(target)).toEqual(bytes);

	writeFileSync(target, 'operator-owned bytes');
	expect(run().exitCode).toBe(0);
	expect(readFileSync(target, 'utf8')).toBe('operator-owned bytes');
	const linked = join(assets, 'operator-link');
	writeFileSync(linked, 'new image default');
	symlinkSync(binary, join(cache, 'operator-link'));
	expect(run().exitCode).toBe(0);
	expect(readlinkSync(join(cache, 'operator-link'))).toBe(binary);

	mkdirSync(join(assets, 'models'));
	writeFileSync(join(assets, 'models/model'), 'baked model');
	const outside = join(root, 'operator-models');
	mkdirSync(outside);
	symlinkSync(outside, join(cache, 'models'));
	expect(run().exitCode).not.toBe(0);
	expect(readlinkSync(join(cache, 'models'))).toBe(outside);
	expect(existsSync(join(outside, 'model'))).toBe(false);
});

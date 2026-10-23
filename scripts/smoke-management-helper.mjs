#!/usr/bin/env node
/** Native execution gate; run on both release runners, never call a live home. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch))
	throw new Error('Native Linux x64/arm64 runner is required.');
const executable = resolve(`packages/cli/embedded/fhold-linux-${process.arch}`);
const root = mkdtempSync(join(tmpdir(), 'fhold-native-helper-'));
function run(args, input) {
	const result = spawnSync(executable, args, {
		input,
		encoding: 'utf8',
		timeout: 60_000,
		env: { HOME: root, PATH: process.env.PATH, XDG_CONFIG_HOME: join(root, 'config') }
	});
	if (result.error || result.status !== 0)
		throw new Error(`Native management helper failed: ${result.error?.message || result.stderr}`);
	return result.stdout;
}
try {
	const version = JSON.parse(readFileSync('packages/cli/package.json', 'utf8')).version;
	if (run(['--version']).trim() !== version) throw new Error('Native helper release mismatch.');
	const hello = JSON.parse(
		run(['hosting', 'rpc'], JSON.stringify({ version: 1, action: 'hello' }))
	);
	if (!hello.ok || !hello.value.management.includes('snapshot'))
		throw new Error('Native helper protocol unavailable.');
	const home = join(root, 'instance');
	run(['--name', home, 'install', '--no-start']);
	for (const file of [
		'system/stack/stack.compose.yml',
		'system/codex/config.toml',
		'system/claude/managed-settings.json'
	]) {
		if (!readFileSync(join(home, file)).equals(readFileSync(join('packages/skeleton', file))))
			throw new Error(`Native helper embedded Skeleton mismatch: ${file}`);
	}
	console.log(`Native ${process.arch} helper protocol and exact embedded Skeleton passed.`);
} finally {
	rmSync(root, { recursive: true, force: true });
}

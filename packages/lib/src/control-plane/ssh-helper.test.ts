import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	configureSshHelperResources,
	createSshHelperResolver,
	resolveSshHelper
} from './ssh-helper.js';
import type { HostingProcess } from './process.js';

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
	const home = mkdtempSync(join(tmpdir(), 'fhold helper space '));
	homes.push(home);
	const calls: string[] = [];
	const run: HostingProcess = async (_binary, args, options) => {
		const command = args.at(-1);
		if (!command) throw Error('Fixture expected an SSH command.');
		calls.push(command);
		return new Promise((resolve, reject) => {
			const child = spawn('sh', ['-c', command], {
				env: { PATH: '/usr/bin:/bin', HOME: home, XDG_CACHE_HOME: join(home, 'cache with spaces') },
				stdio: 'pipe'
			});
			let stdout = '';
			child.stdout.on('data', (data) => {
				stdout += String(data);
			});
			let stderr = '';
			child.stderr.on('data', (data) => {
				stderr += String(data);
			});
			child.once('error', reject);
			child.once('close', (code) =>
				code === 0 ? resolve(stdout) : reject(Error(`fixture process failed: ${stderr}`))
			);
			if (options?.inputFile) child.stdin.end(readFileSync(options.inputFile));
			else child.stdin.end(options?.input);
		});
	};
	configureSshHelperResources(async () => Buffer.from('#!/bin/sh\nprintf fixture-version\\n\n'));
	return { home, calls, run };
}
const connection = { host: 'fixture' };
test('fresh, cache hit, corruption and concurrent preparation preserve operator CLI and use exact content', async () => {
	const { home, calls, run } = fixture();
	mkdirSync(join(home, '.local/bin'), { recursive: true });
	writeFileSync(join(home, '.local/bin/fhold'), 'stale operator CLI');
	const [first, second] = await Promise.all([
		resolveSshHelper(connection, run),
		resolveSshHelper(connection, run)
	]);
	expect(first).toBe(second);
	const cache = join(home, 'cache with spaces/fhold/management');
	const digest = readdirSync(cache)[0];
	if (!digest) throw Error('Expected a prepared helper cache entry.');
	const path = join(cache, digest, 'fhold');
	expect(existsSync(path)).toBe(true);
	expect(readFileSync(path, 'utf8')).toContain('fixture-version');
	const transfers = calls.filter((call) => call.includes('cat >')).length;
	await resolveSshHelper(connection, run);
	expect(calls.filter((call) => call.includes('cat >')).length).toBe(transfers);
	writeFileSync(path, 'corrupt');
	await resolveSshHelper(connection, run);
	expect(readFileSync(path, 'utf8')).toContain('fixture-version');
	expect(readdirSync(join(cache, digest))).toEqual(['fhold']);
	expect(readFileSync(join(home, '.local/bin/fhold'), 'utf8')).toBe('stale operator CLI');
});
test('platform selection ignores local architecture and refuses unsupported targets before transfer', async () => {
	const selected: string[] = [];
	configureSshHelperResources(async (arch) => {
		selected.push(arch);
		return Buffer.from(arch);
	});
	for (const platform of ['Linux aarch64', 'Linux x86_64']) {
		await resolveSshHelper(connection, async (_binary, args) =>
			args.at(-1) === 'uname -sm' ? platform : 'ready'
		);
	}
	expect(selected).toEqual(['arm64', 'x64']);
	await expect(resolveSshHelper(connection, async () => 'Darwin arm64')).rejects.toThrow(
		'Linux x64 and arm64'
	);
});
test('preparation failure does not run any instance command and reports the cache stage', async () => {
	fixture();
	let uploads = 0;
	await expect(
		resolveSshHelper(connection, async (_binary, args, options) => {
			if (args.at(-1) === 'uname -sm') return 'Linux x86_64';
			if (!options?.inputFile) return '';
			uploads++;
			throw Error('transport failed');
		})
	).rejects.toThrow('helper preparation failed');
	expect(uploads).toBe(1);
});
test('corrupt transfer and non-running helper never publish a cache executable', async () => {
	for (const corrupt of [true, false]) {
		const { home, run } = fixture();
		if (!corrupt) configureSshHelperResources(async () => Buffer.from('#!/bin/sh\nexit 1\n'));
		await expect(
			resolveSshHelper(connection, async (binary, args, options) => {
				if (corrupt && options?.inputFile) writeFileSync(options.inputFile, 'corrupt transfer');
				return run(binary, args, options);
			})
		).rejects.toThrow('helper preparation failed');
		const cache = join(home, 'cache with spaces/fhold/management');
		for (const digest of readdirSync(cache)) expect(readdirSync(join(cache, digest))).toEqual([]);
	}
});
test('adapter resolver shares preparation across methods but allows explicit retry after failure', async () => {
	fixture();
	let probes = 0;
	const helper = createSshHelperResolver(connection, async (_binary, args) => {
		if (args.at(-1) === 'uname -sm') {
			probes++;
			if (probes === 1) throw Error('SSH unavailable');
			return 'Linux x86_64';
		}
		return 'ready';
	});
	await expect(helper('rpc')).rejects.toThrow('SSH unavailable');
	const [rpc, session] = await Promise.all([helper('rpc'), helper('session')]);
	expect(rpc.replace(' rpc', '')).toBe(session.replace(' session', ''));
	await helper('command');
	expect(probes).toBe(2);
});

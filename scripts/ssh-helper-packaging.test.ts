import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

test('shipping CLI embeds exact current helpers for both Linux architectures, with no published-release dependency', () => {
	const repo = join(import.meta.dir, '..');
	const cli = join(repo, 'packages/cli');
	const build = spawnSync(process.execPath, ['run', '--cwd', cli, 'build'], { encoding: 'utf8' });
	expect(build.status, build.stderr).toBe(0);
	const bytes = readFileSync(join(cli, `embedded/fhold-linux-${process.arch}`));
	for (const [arch, machine] of [
		['x64', 62],
		['arm64', 183]
	] as const) {
		const raw = readFileSync(join(cli, `embedded/fhold-linux-${arch}`));
		expect(raw.subarray(0, 4)).toEqual(Buffer.from([127, 69, 76, 70]));
		expect(raw.readUInt16LE(18)).toBe(machine);
		expect(gunzipSync(readFileSync(join(cli, `embedded/fhold-linux-${arch}.gz`)))).toEqual(raw);
	}
	const work = mkdtempSync(join(tmpdir(), 'fhold packaging space '));
	try {
		const bin = join(work, 'bin');
		const remote = join(work, 'remote');
		mkdirSync(bin);
		mkdirSync(remote);
		// Only native SSH transport is substituted. It runs the actual shipped
		// remote command and helper against an empty private account, with no CLI.
		const ssh = join(bin, 'ssh');
		writeFileSync(
			ssh,
			'#!/bin/sh\nfor last do :; done\nHOME="$FH_FIXTURE_REMOTE" XDG_CACHE_HOME="$FH_FIXTURE_REMOTE/cache space" exec /bin/sh -c "$last"\n'
		);
		chmodSync(ssh, 0o700);
		const env = {
			HOME: work,
			XDG_CONFIG_HOME: join(work, 'config'),
			PATH: `${bin}:/usr/bin:/bin`,
			FH_FIXTURE_REMOTE: remote
		};
		const executable = join(cli, 'dist/fhold-cli');
		for (const argv of [
			['hosting', 'add', 'fixture', '--provider', 'ssh-docker', '--host', 'fixture'],
			['hosting', 'instances', '--connection', 'fixture'],
			['hosting', 'instances', '--connection', 'fixture']
		]) {
			const result = spawnSync(executable, argv, { env, encoding: 'utf8', timeout: 120_000 });
			expect(result.status, result.stderr || result.stdout).toBe(0);
		}
		const digest = createHash('sha256').update(bytes).digest('hex');
		const cache = join(remote, 'cache space/fhold/management');
		expect(readdirSync(cache)).toEqual([digest]);
		expect(readFileSync(join(cache, digest, 'fhold'))).toEqual(bytes);
		const config = readFileSync(join(repo, 'packages/electron/electron-builder.yml'), 'utf8');
		for (const arch of ['x64', 'arm64'])
			expect(config).toContain(`from: ../cli/embedded/fhold-linux-${arch}`);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}, 180_000);

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { serveManagementSession } from './session.js';
import { localInstanceManagement } from './instance.js';
import { localDockerManagementHost } from './local-host-port.js';
import { FH_RUNTIME_VERSION } from '../control-plane/release.js';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test('snapshot reports the managing CLI runtime cohort locally and over the SSH session envelope', async () => {
	const root = mkdtempSync(join(tmpdir(), 'fhold-session-version-'));
	roots.push(root);
	const home = join(root, 'not-installed');
	// This tests snapshot/transport metadata, not the runner's Docker daemon.
	const docker = join(root, 'docker');
	writeFileSync(docker, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o700 });
	const previousDocker = process.env.FH_DOCKER_BIN;
	process.env.FH_DOCKER_BIN = docker;
	const management = localInstanceManagement(home, { host: localDockerManagementHost });
	try {
		const snapshot = await management.call('snapshot');
		expect(snapshot.updateImageTag).toBe(FH_RUNTIME_VERSION);
		let output = '';
		await serveManagementSession(
			Readable.from([`${JSON.stringify({ id: 1, homeDir: home, method: 'snapshot' })}\n`]),
			new Writable({
				write(chunk, _encoding, done) {
					output += String(chunk);
					done();
				}
			})
		);
		expect(JSON.parse(output)).toMatchObject({
			id: 1,
			ok: true,
			value: { updateImageTag: FH_RUNTIME_VERSION }
		});
		expect(existsSync(home)).toBe(false);
	} finally {
		await management.close();
		if (previousDocker === undefined) delete process.env.FH_DOCKER_BIN;
		else process.env.FH_DOCKER_BIN = previousDocker;
	}
});
test('native session routes paths only through JSON and continues after a failed read', async () => {
	const root = mkdtempSync(join(tmpdir(), 'fhold-session-test-'));
	roots.push(root);
	const home = join(root, "owner's agent; not a shell");
	mkdirSync(home);
	const requests = [
		{ id: 1, homeDir: home, method: 'directory', value: 'relative' },
		{ id: 2, homeDir: home, method: 'directory', value: root }
	];
	let output = '';
	const sink = new Writable({
		write(chunk, _encoding, done) {
			output += String(chunk);
			done();
		}
	});
	await serveManagementSession(
		Readable.from(requests.map((value) => `${JSON.stringify(value)}\n`)),
		sink
	);
	const results = output
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));
	expect(results[0]).toMatchObject({ id: 1, ok: false });
	expect(results[1]).toMatchObject({
		id: 2,
		ok: true,
		value: { path: root, directories: [{ path: home }] }
	});
});
test('transfer workspaces belong to their session and are removed on disconnect, not user directories', async () => {
	const root = mkdtempSync(join(tmpdir(), 'fhold-session-test-'));
	roots.push(root);
	const api = localInstanceManagement(join(root, 'home'), { host: localDockerManagementHost });
	const owned = await api.call('transferCreate');
	expect(existsSync(owned)).toBe(true);
	await expect(api.call('transferRelease', root)).rejects.toThrow('Unknown');
	await api.close();
	expect(existsSync(owned)).toBe(false);
	expect(existsSync(root)).toBe(true);
});
test('one live session accepts repeated requests without creating any management listener', async () => {
	const root = mkdtempSync(join(tmpdir(), 'fhold-session-test-'));
	roots.push(root);
	const input = new PassThrough();
	let output = '';
	const sink = new Writable({
		write(chunk, _encoding, done) {
			output += String(chunk);
			done();
		}
	});
	const session = serveManagementSession(input, sink);
	input.write(
		`${JSON.stringify({ id: 1, homeDir: join(root, 'home'), method: 'directory', value: root })}\n`
	);
	input.end(
		`${JSON.stringify({ id: 2, homeDir: join(root, 'home'), method: 'directory', value: root })}\n`
	);
	await session;
	expect(
		output
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line).id)
	).toEqual([1, 2]);
});

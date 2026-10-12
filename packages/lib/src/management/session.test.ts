import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { serveManagementSession } from './session.js';
import { localInstanceManagement } from './instance.js';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
	const api = localInstanceManagement(join(root, 'home'));
	const owned = await api.call<string>('transferCreate');
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

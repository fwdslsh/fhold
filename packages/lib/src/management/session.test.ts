import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { serveManagementSession } from './session.js';
import { localInstanceManagement } from './instance.js';
import { localDockerManagementHost } from '../control-plane/local-instance-host.js';
import { FH_RUNTIME_VERSION } from '../control-plane/release.js';
import { installHome } from '../control-plane/install.js';
import { defaultStackConfig, readStackConfig } from '../control-plane/stack-config.js';
import { parseManagementArgs } from './wire-input.js';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test.each(['my_agent', 'agent-', 'a'.repeat(64)])(
	'fresh managed installs reject non-hostname project names before writing or starting: %s',
	async (name) => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-session-install-name-'));
		roots.push(root);
		const home = join(root, 'home');
		const calls = join(root, 'docker-calls');
		const docker = join(root, 'docker');
		writeFileSync(
			docker,
			`#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
			{ mode: 0o700 }
		);
		const previousDocker = process.env.FH_DOCKER_BIN;
		process.env.FH_DOCKER_BIN = docker;
		const management = localInstanceManagement(home, { host: localDockerManagementHost(home) });
		try {
			const config = defaultStackConfig(home);
			config.deployment.projectName = name;
			// Exercise the same parsed install entry point as the SSH session and Admin.
			const args = parseManagementArgs('install', config, [false]);
			await expect(management.call('install', ...args)).rejects.toThrow('Instance name must be');
			expect(existsSync(home)).toBe(false);
			expect(existsSync(calls)).toBe(false);
		} finally {
			await management.close();
			if (previousDocker === undefined) delete process.env.FH_DOCKER_BIN;
			else process.env.FH_DOCKER_BIN = previousDocker;
		}
	}
);
test('fresh installs validate ambient names and allow an explicit valid name to override config', async () => {
	const root = mkdtempSync(join(tmpdir(), 'fhold-session-install-name-sources-'));
	roots.push(root);
	const home = join(root, 'home');
	const previousName = process.env.FH_PROJECT_NAME;
	process.env.FH_PROJECT_NAME = 'invalid_name';
	try {
		await expect(installHome({ homeDir: home, automaticPorts: false })).rejects.toThrow(
			'Instance name must be'
		);
		expect(existsSync(home)).toBe(false);
		const config = defaultStackConfig(home);
		config.deployment.projectName = 'invalid_name';
		const name = 'a'.repeat(63);
		await installHome({ homeDir: home, config, name, automaticPorts: false });
		const saved = readStackConfig(home);
		expect(saved.ok && saved.config.deployment.projectName).toBe(name);
	} finally {
		if (previousName === undefined) delete process.env.FH_PROJECT_NAME;
		else process.env.FH_PROJECT_NAME = previousName;
	}
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
	const management = localInstanceManagement(home, { host: localDockerManagementHost(home) });
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
	const api = localInstanceManagement(join(root, 'home'), {
		host: localDockerManagementHost(join(root, 'home'))
	});
	const owned = await api.call('transferCreate');
	expect(existsSync(owned)).toBe(true);
	await expect(api.call('transferRelease', root)).rejects.toThrow('Unknown');
	await api.close();
	expect(existsSync(owned)).toBe(false);
	expect(existsSync(root)).toBe(true);
});
test('the local legacy backup route carries only parsed confirmation into a full export', async () => {
	const root = mkdtempSync(join(tmpdir(), 'fhold-session-confirmation-'));
	roots.push(root);
	const home = join(root, 'home');
	await installHome({ homeDir: home, automaticPorts: false });
	const docker = join(root, 'docker');
	writeFileSync(docker, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o700 });
	const previousDocker = process.env.FH_DOCKER_BIN;
	process.env.FH_DOCKER_BIN = docker;
	const management = localInstanceManagement(home, { host: localDockerManagementHost(home) });
	try {
		await expect(
			management.call('backup', {
				destination: join(root, 'without-confirmation'),
				full: true
			})
		).rejects.toThrow('Full-instance export requires --confirm-stopped');
		await expect(
			management.call('backup', {
				destination: join(root, 'with-confirmation'),
				full: true,
				confirmed: true
			})
		).resolves.toMatchObject({ version: 1 });
	} finally {
		await management.close();
		if (previousDocker === undefined) delete process.env.FH_DOCKER_BIN;
		else process.env.FH_DOCKER_BIN = previousDocker;
	}
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

test('malformed native input is rejected at wire ingress before a use case can inspect the home', async () => {
	const root = mkdtempSync(join(tmpdir(), 'fhold-session-ingress-'));
	roots.push(root);
	const home = join(root, 'untouched');
	let output = '';
	await serveManagementSession(
		Readable.from([
			`${JSON.stringify({ id: 1, homeDir: home, method: 'providerKey', value: { provider: 'example', key: 123 } })}\n`,
			`${JSON.stringify({ id: 2, homeDir: home, method: 'credential', value: { action: 'policy', username: 'owner', policy: 'typo', previousPolicy: 'chat' } })}\n`
		]),
		new Writable({
			write(chunk, _encoding, done) {
				output += String(chunk);
				done();
			}
		})
	);
	const results = output
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));
	expect(results[0]).toMatchObject({
		id: 1,
		ok: false,
		error: expect.stringContaining('Provider key')
	});
	expect(results[1]).toMatchObject({
		id: 2,
		ok: false,
		error: expect.stringContaining('Policy')
	});
	expect(existsSync(home)).toBe(false);
});

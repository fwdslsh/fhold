import { afterEach, describe, expect, it } from 'bun:test';
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	acquireStackLock,
	buildComposeOptions,
	composeConfigJson,
	createFholdState,
	createBackup,
	defaultStackConfig,
	writeStackConfig,
	releaseStackLock
} from '@fhold/lib';

import { main } from '../main.js';
import { diagnoseStack } from './doctor.js';
import { bootstrapInstall } from './install.js';
import { readStatus } from './lifecycle.js';
import { updateStack } from './update.js';

const roots: string[] = [];
const originalHome = process.env.FH_HOME;
const originalRepo = process.env.FH_REPO_ROOT;
const originalDocker = process.env.FH_DOCKER_BIN;

afterEach(() => {
	if (originalHome === undefined) delete process.env.FH_HOME;
	else process.env.FH_HOME = originalHome;
	if (originalRepo === undefined) delete process.env.FH_REPO_ROOT;
	else process.env.FH_REPO_ROOT = originalRepo;
	if (originalDocker === undefined) delete process.env.FH_DOCKER_BIN;
	else process.env.FH_DOCKER_BIN = originalDocker;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function install(root: string): Promise<string> {
	const home = join(root, 'home');
	process.env.FH_HOME = home;
	process.env.FH_REPO_ROOT = join(import.meta.dir, '../../../..');
	await bootstrapInstall({ start: false });
	return home;
}

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), 'fhold-operations-command-'));
	roots.push(root);
	return root;
}

describe('operational command wiring', () => {
	it('enables Guardian and updates managed files without a running Docker daemon', async () => {
		const root = fixture();
		const home = await install(root);
		await main(['guardian', 'enable', '--no-apply']);
		await updateStack({ start: false });
		const config = JSON.parse(readFileSync(join(home, 'state', 'stack.json'), 'utf8')) as {
			gateway: { enabled: boolean };
		};
		expect(config.gateway.enabled).toBe(true);
		expect(existsSync(join(home, 'system', 'assistant', 'agents', 'remote-full.md'))).toBe(true);
	});

	it('previews and applies own-backup restore through the CLI while leaving the source unchanged', async () => {
		const root = fixture();
		const source = join(root, 'old-home');
		mkdirSync(join(source, 'knowledge', 'notes'), { recursive: true });
		writeFileSync(join(source, 'knowledge', 'notes', 'portable.md'), 'portable');
		writeStackConfig(source, defaultStackConfig(source));
		const archive = join(root, 'portable-backup');
		await createBackup({ sourceHome: source, destination: archive });
		const home = await install(root);
		const before = readFileSync(join(source, 'knowledge', 'notes', 'portable.md'));
		await main(['restore', '--from', archive, '--dry-run', '--json']);
		await main(['restore', '--from', archive, '--apply', '--json']);
		expect(readFileSync(join(home, 'knowledge', 'notes', 'portable.md'), 'utf8')).toBe('portable');
		expect(readFileSync(join(source, 'knowledge', 'notes', 'portable.md'))).toEqual(before);
	});

	it('rejects invalid installation input without materializing a home', async () => {
		const root = fixture();
		process.env.FH_HOME = join(root, 'home');
		const configFile = join(root, 'invalid.json');
		writeFileSync(configFile, '{');
		await expect(bootstrapInstall({ start: false, configFile })).rejects.toThrow(
			'Invalid stack config JSON'
		);
		expect(existsSync(process.env.FH_HOME)).toBe(false);
		writeFileSync(configFile, JSON.stringify({ version: 999 }));
		await expect(bootstrapInstall({ start: false, configFile })).rejects.toThrow();
		expect(existsSync(process.env.FH_HOME)).toBe(false);
	});

	it('refuses concurrent updates before touching managed assets', async () => {
		const root = fixture();
		const home = await install(root);
		const managed = join(home, 'system', 'assistant', 'AGENTS.md');
		writeFileSync(managed, 'unchanged while lifecycle operation is active');
		const lock = acquireStackLock(join(home, 'data'));
		expect(lock).not.toBeNull();
		try {
			await expect(updateStack({ start: false })).rejects.toThrow('lifecycle_in_progress');
			expect(readFileSync(managed, 'utf8')).toBe('unchanged while lifecycle operation is active');
		} finally {
			releaseStackLock(lock);
		}
	});

	it('recreates local images without implicit pulls and preserves user files', async () => {
		const root = fixture();
		const home = await install(root);
		const resolved = await composeConfigJson(buildComposeOptions(createFholdState()));
		if (!resolved.ok) throw new Error(resolved.stderr);
		const fakeDocker = join(root, 'docker');
		const callsPath = join(root, 'docker-calls.jsonl');
		writeFileSync(
			fakeDocker,
			`#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');
if (args.includes('config') && args.includes('--format')) console.log(${JSON.stringify(JSON.stringify(resolved.config))});
if (args.includes('ps') && args.includes('-q')) console.log('test-container-id');
if (args[0] === 'image' && args[1] === 'inspect') console.log('sha256:${'a'.repeat(64)}');
if (args[0] === 'inspect') console.log(${JSON.stringify(JSON.stringify({ Id: 'test-container-id', Image: `sha256:${'a'.repeat(64)}`, Config: { Image: `fhold/assistant:${JSON.parse(readFileSync(join(home, 'state', 'stack.json'), 'utf8')).deployment.images.assistant}`, Labels: { 'com.docker.compose.project': JSON.parse(readFileSync(join(home, 'state', 'stack.json'), 'utf8')).deployment.projectName, 'com.docker.compose.service': 'assistant' } } }))});
`
		);
		chmodSync(fakeDocker, 0o755);
		process.env.FH_DOCKER_BIN = fakeDocker;
		const knowledgeFile = join(home, 'knowledge', 'release-test.md');
		const configFile = join(home, 'config', 'assistant', 'persona.md');
		const credentialFile = join(home, 'state', 'credentials', 'owner', 'key');
		writeFileSync(knowledgeFile, 'user knowledge survives');
		writeFileSync(configFile, 'user persona survives');
		const credential = readFileSync(credentialFile);
		await expect(main(['update', '--pull'])).rejects.toThrow('Build the reviewed images locally');
		await main(['update']);
		await main(['update', '--no-pull']);
		const calls = readFileSync(callsPath, 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as string[]);
		const updates = calls.filter((args) => args.includes('up'));
		expect(updates).toHaveLength(2);
		expect(updates[0]?.slice(-7)).toEqual([
			'up',
			'-d',
			'--pull',
			'never',
			'--force-recreate',
			'--remove-orphans',
			'--wait'
		]);
		expect(updates[1]).toContain('never');
		expect(calls.filter((args) => args.includes('pull') && !args.includes('up'))).toHaveLength(0);
		expect(readFileSync(knowledgeFile, 'utf8')).toBe('user knowledge survives');
		expect(readFileSync(configFile, 'utf8')).toBe('user persona survives');
		expect(readFileSync(credentialFile)).toEqual(credential);
		// Make preflight select a different immutable ID than the recreated
		// container actually reports. A successful `up` alone is not completion.
		writeFileSync(fakeDocker, readFileSync(fakeDocker, 'utf8').replace(`sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`));
		await expect(updateStack({ start: true, pull: false })).rejects.toThrow('preflight-selected image identities');
		const receipts = readdirSync(join(home, 'state/update-receipts')).map((directory) => JSON.parse(readFileSync(join(home, 'state/update-receipts', directory, 'receipt.json'), 'utf8')));
		const failed = receipts.find((receipt) => receipt.phase === 'failed');
		expect(failed.failedPhase).toBe('verifying-images');
		expect(failed.runningContainersUpgraded).toBe(false);
		expect(failed.nativeDataRollbackAvailable).toBe(false);
		expect(failed.selectedImages[0].imageId).toBe(`sha256:${'b'.repeat(64)}`);
		expect(failed.runningImages[0].imageId).toBe(`sha256:${'a'.repeat(64)}`);
		expect(readFileSync(credentialFile)).toEqual(credential);
		// This test resolves the real Compose configuration before using fake Docker.
		// Its subprocess budget is 30s; the default 5s test budget can cut it off on
		// a cold/contended runner before the assertions are reached.
	}, 30_000);

	it('reports Docker failures and reads status through an argument-safe fake Docker binary', async () => {
		const root = fixture();
		await install(root);
		process.env.FH_DOCKER_BIN = join(root, 'missing-docker');
		const diagnosis = await diagnoseStack();
		expect(diagnosis.checks.find((check) => check.name === 'docker')?.ok).toBe(false);

		const fakeDocker = join(root, 'docker');
		writeFileSync(
			fakeDocker,
			'#!/bin/sh\ncase " $* " in *" ps --format json "*) exit 0;; esac\nexit 1\n'
		);
		chmodSync(fakeDocker, 0o755);
		process.env.FH_DOCKER_BIN = fakeDocker;
		const status = await readStatus();
		expect(status.services).toEqual([]);
	});
});

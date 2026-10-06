import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	exportInstance,
	INSTANCE_BACKUP_NOTICE,
	planInstanceRestore,
	restoreInstance
} from './instance-backup.js';
import { installHome } from './install.js';
import { acquireStackLock, releaseStackLock } from './lock.js';
import { readEnvFile, writeFileAtomic } from './foundation.js';
import { classifyInstall, markInstalled } from './state.js';
import { readStackConfig } from './stack-config.js';
import { restartStatus } from './runtime-revision.js';

const roots: string[] = [];
const previousDocker = process.env.FH_DOCKER_BIN;
afterEach(() => {
	if (previousDocker === undefined) delete process.env.FH_DOCKER_BIN;
	else process.env.FH_DOCKER_BIN = previousDocker;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'fhold-instance-backup-test-'));
	roots.push(root);
	const home = join(root, 'source');
	const destination = join(root, 'export');
	const restored = join(root, 'restored');
	await installHome({ homeDir: home, name: 'snapshot-agent', automaticPorts: false });
	markInstalled(home);
	const control = join(root, 'docker-state.json');
	writeFileSync(control, '{}');
	const docker = join(root, 'docker');
	writeFileAtomic(
		docker,
		`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);const file=${JSON.stringify(control)};const control=JSON.parse(fs.readFileSync(file,'utf8'));if(control.failed)process.exit(1);if(args[0]==='inspect') console.log(JSON.stringify({'com.docker.compose.project.working_dir': control.owner || ${JSON.stringify(join(home, 'system/stack'))}}));else if(args[args.length-1]==='{{.ID}}'&&control.state)console.log('fixture');else if(args[args.length-1]==='{{.State}}'){if(control.failAfter){control.calls=(control.calls||0)+1;fs.writeFileSync(file,JSON.stringify(control));if(control.calls>=control.failAfter)control.state='running';}if(control.state)console.log(control.state);}\n`,
		0o700
	);
	process.env.FH_DOCKER_BIN = docker;
	return { root, home, destination, restored, control };
}

describe('stopped full-instance import/export', () => {
	it('accepts semantically identical manifest formatting without depending on JSON key order', async () => {
		const { home, destination, restored } = await fixture();
		const manifest = await exportInstance({
			sourceHome: home,
			destination,
			confirmedStopped: true
		});
		manifest.files = manifest.files.map(
			(entry) => Object.fromEntries(Object.entries(entry).reverse()) as typeof entry
		);
		writeFileSync(join(destination, 'fhold-backup.json'), JSON.stringify(manifest));
		await expect(
			planInstanceRestore({ sourceHome: destination, destinationHome: restored })
		).resolves.toMatchObject({ scope: 'instance' });
	});
	it('includes every instance tree, credentials, dependency links, SQLite/WAL sessions and ordinary file metadata', async () => {
		const { home, destination, restored } = await fixture();
		mkdirSync(join(home, 'workspace/project/node_modules/pkg'), { recursive: true });
		mkdirSync(join(home, 'workspace/project/node_modules/.bin'));
		writeFileAtomic(
			join(home, 'workspace/project/node_modules/pkg/run'),
			'#!/bin/sh\nexit 0\n',
			0o751
		);
		symlinkSync('../pkg/run', join(home, 'workspace/project/node_modules/.bin/run'));
		symlinkSync(join(home, 'workspace/project'), join(home, 'workspace/absolute-project'));
		writeFileSync(join(home, 'custom-root-file'), 'all roots, not a selection');
		const native = join(home, 'data/assistant/.local/share/opencode/opencode.db');
		const db = new Database(native);
		db.run('PRAGMA journal_mode=WAL');
		db.run('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT)');
		db.run("INSERT INTO session VALUES ('durable-session', 'Preserve my conversation')");
		// Keep WAL committed but uncheckpointed. Docker is stopped; the test does
		// not write again until the snapshot finishes. WAL must travel with the DB.
		try {
			const originalKey = readFileSync(join(home, 'state/secrets/fhold_opencode_password'));
			const config = readFileSync(join(home, 'state/stack.json'));
			const manifest = await exportInstance({
				sourceHome: home,
				destination,
				confirmedStopped: true
			});
			expect(manifest.scope).toBe('instance');
			expect(manifest.files.some((entry) => entry.path.endsWith('opencode.db-wal'))).toBe(true);
			expect(manifest.files.some((entry) => entry.path === 'custom-root-file')).toBe(true);
			expect(manifest.files.some((entry) => entry.path === 'data/.lifecycle.lock')).toBe(false);
			expect(JSON.stringify(manifest)).not.toContain(originalKey.toString().trim());
			expect(lstatSync(destination).mode & 0o777).toBe(0o700);
			const plan = await planInstanceRestore({
				sourceHome: destination,
				destinationHome: restored
			});
			expect(existsSync(restored)).toBe(false); // Preview does not seed or lock.
			await restoreInstance(
				{ sourceHome: destination, destinationHome: restored, confirmedStopped: true },
				plan.digest
			);
			expect(classifyInstall(restored)).toBe('installed');
			expect(readFileSync(join(restored, 'state/stack.json'))).toEqual(config);
			expect(readFileSync(join(restored, 'state/secrets/fhold_opencode_password'))).toEqual(
				originalKey
			);
			expect(readEnvFile(join(restored, 'state/stack.env')).FH_HOME).toBe(restored);
			expect(readEnvFile(join(restored, 'state/stack.env')).FH_RECOVERY_DIRECTORY).toBe(
				join(restored, 'state/recovery-storage')
			);
			expect(
				JSON.parse(readFileSync(join(restored, 'state/installation.json'), 'utf8')).homeDir
			).toBe(restored);
			expect(restartStatus(restored).required).toBe(true);
			expect(readlinkSync(join(restored, 'workspace/project/node_modules/.bin/run'))).toBe(
				'../pkg/run'
			);
			expect(readlinkSync(join(restored, 'workspace/absolute-project'))).toBe('project');
			expect(lstatSync(join(restored, 'workspace/project/node_modules/pkg/run')).mode & 0o777).toBe(
				0o751
			);
			const recovered = new Database(
				join(restored, 'data/assistant/.local/share/opencode/opencode.db'),
				{ readonly: true }
			);
			try {
				expect(recovered.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
				expect(recovered.query('SELECT * FROM session').all()).toEqual([
					{ id: 'durable-session', title: 'Preserve my conversation' }
				]);
			} finally {
				recovered.close();
			}
			expect(readStackConfig(home)).toEqual(readStackConfig(restored));
		} finally {
			db.close();
		}
	});

	it('requires informed stopped confirmation and refuses every active or uncertain writer state before copying', async () => {
		const { home, destination, control } = await fixture();
		expect(INSTANCE_BACKUP_NOTICE).toContain('active task settings');
		expect(INSTANCE_BACKUP_NOTICE).toContain('unencrypted');
		expect(INSTANCE_BACKUP_NOTICE).toContain('Never run the original and restored copies together');
		await expect(exportInstance({ sourceHome: home, destination })).rejects.toThrow(
			'confirm-stopped'
		);
		for (const state of ['running', 'paused', 'restarting', 'created', 'removing', 'unknown']) {
			writeFileSync(control, JSON.stringify({ state }));
			await expect(
				exportInstance({ sourceHome: home, destination, confirmedStopped: true })
			).rejects.toThrow('all containers stopped');
			expect(existsSync(destination)).toBe(false);
		}
		writeFileSync(control, JSON.stringify({ failed: true }));
		await expect(
			exportInstance({ sourceHome: home, destination, confirmedStopped: true })
		).rejects.toThrow();
		expect(existsSync(destination)).toBe(false);
	});

	it('refuses import without confirmation, to any nonempty home, or while the named source project still belongs elsewhere', async () => {
		const { home, destination, restored, control } = await fixture();
		await exportInstance({ sourceHome: home, destination, confirmedStopped: true });
		await expect(
			restoreInstance({ sourceHome: destination, destinationHome: restored })
		).rejects.toThrow('confirm-stopped');
		writeFileSync(control, JSON.stringify({ state: 'exited' }));
		await expect(
			planInstanceRestore({ sourceHome: destination, destinationHome: restored })
		).rejects.toThrow('another folder');
		writeFileSync(control, '{}');
		mkdirSync(restored);
		writeFileSync(join(restored, 'keep'), 'user data');
		await expect(
			planInstanceRestore({ sourceHome: destination, destinationHome: restored })
		).rejects.toThrow('empty');
		expect(readFileSync(join(restored, 'keep'), 'utf8')).toBe('user data');
	});

	it('refuses checksum changes, extra files, unsafe paths and symlink parents without mutating the target', async () => {
		const { home, destination, restored } = await fixture();
		writeFileSync(join(home, 'workspace/file'), 'before');
		await exportInstance({ sourceHome: home, destination, confirmedStopped: true });
		const path = join(destination, 'fhold-backup.json');
		const original = readFileSync(path);
		writeFileSync(join(destination, 'instance/workspace/file'), 'after');
		await expect(
			planInstanceRestore({ sourceHome: destination, destinationHome: restored })
		).rejects.toThrow('mismatch');
		writeFileSync(join(destination, 'instance/workspace/file'), 'before');
		writeFileSync(join(destination, 'instance/unrecorded'), 'extra');
		await expect(
			planInstanceRestore({ sourceHome: destination, destinationHome: restored })
		).rejects.toThrow('mismatch');
		rmSync(join(destination, 'instance/unrecorded'));
		for (const entry of [
			{
				path: '../outside',
				type: 'file',
				mode: 0o600,
				mtimeMs: 0,
				bytes: 0,
				sha256: 'a'.repeat(64)
			},
			{ path: 'escaped', type: 'symlink', mode: 0o777, mtimeMs: 0, target: '/tmp' },
			{
				path: 'escaped/child',
				type: 'file',
				mode: 0o600,
				mtimeMs: 0,
				bytes: 0,
				sha256: 'a'.repeat(64)
			}
		]) {
			const manifest = JSON.parse(original.toString());
			manifest.files.push(entry);
			writeFileSync(path, JSON.stringify(manifest));
			await expect(
				planInstanceRestore({ sourceHome: destination, destinationHome: restored })
			).rejects.toThrow();
		}
		expect(existsSync(restored)).toBe(false);
	});

	it('preserves external links but reports uncaptured targets and refuses linked runtime roots', async () => {
		const { home, destination, restored, root } = await fixture();
		const outside = join(root, 'external-data');
		mkdirSync(outside);
		writeFileSync(join(outside, 'private'), 'not included');
		symlinkSync(outside, join(home, 'workspace/external'));
		const manifest = await exportInstance({
			sourceHome: home,
			destination,
			confirmedStopped: true
		});
		expect(manifest.warnings.some((warning) => warning.includes('workspace/external'))).toBe(true);
		expect(manifest.files.some((entry) => entry.path.endsWith('private'))).toBe(false);
		await restoreInstance({
			sourceHome: destination,
			destinationHome: restored,
			confirmedStopped: true
		});
		expect(readlinkSync(join(restored, 'workspace/external'))).toBe(outside);
		rmSync(join(home, 'data/assistant'), { recursive: true });
		symlinkSync(outside, join(home, 'data/assistant'));
		await expect(
			exportInstance({
				sourceHome: home,
				destination: join(root, 'other-export'),
				confirmedStopped: true
			})
		).rejects.toThrow('unsafe');
	});

	it('omits only declared coordination and keeps plugin state and caches', async () => {
		const { home, destination } = await fixture();
		mkdirSync(join(home, 'data/assistant/.codex/tmp/arg0'), { recursive: true });
		mkdirSync(join(home, 'data/assistant/.codex/plugins/cache'), { recursive: true });
		symlinkSync('/opt/image-baked-tool', join(home, 'data/assistant/.codex/tmp/arg0/wrapper'));
		writeFileSync(join(home, 'data/assistant/.codex/plugins/cache/plugin'), 'installed plugin');
		const manifest = await exportInstance({
			sourceHome: home,
			destination,
			confirmedStopped: true
		});
		expect(manifest.omittedPaths).toContain('data/assistant/.codex/tmp');
		expect(manifest.files.some((entry) => entry.path.endsWith('plugins/cache/plugin'))).toBe(true);
		expect(existsSync(join(destination, 'instance/data/assistant/.codex/tmp'))).toBe(false);
	});

	it('binds import to its reviewed digest, refuses aliases/overlapping paths and respects lifecycle locks', async () => {
		const { home, destination, restored, root } = await fixture();
		const lock = acquireStackLock(join(home, 'data'));
		try {
			await expect(
				exportInstance({ sourceHome: home, destination, confirmedStopped: true })
			).rejects.toThrow('lifecycle_in_progress');
		} finally {
			releaseStackLock(lock);
		}
		await expect(
			exportInstance({
				sourceHome: home,
				destination: join(home, 'nested'),
				confirmedStopped: true
			})
		).rejects.toThrow('non-overlapping');
		symlinkSync(root, join(root, 'alias'));
		await expect(
			exportInstance({
				sourceHome: home,
				destination: join(root, 'alias/export'),
				confirmedStopped: true
			})
		).rejects.toThrow('symlink');
		await exportInstance({ sourceHome: home, destination, confirmedStopped: true });
		await expect(
			restoreInstance(
				{ sourceHome: destination, destinationHome: restored, confirmedStopped: true },
				'a'.repeat(64)
			)
		).rejects.toThrow('after preview');
		expect(existsSync(restored)).toBe(false);
	});

	it('blocks startup after a partial import failure while keeping source/archive untouched', async () => {
		const { home, destination, restored, control } = await fixture();
		await exportInstance({ sourceHome: home, destination, confirmedStopped: true });
		const original = readFileSync(join(destination, 'instance/state/stack.json'));
		// Simulate another operator starting a writer during import. The final
		// daemon check must fail closed even after all files have copied.
		writeFileSync(control, JSON.stringify({ failAfter: 3 }));
		await expect(
			restoreInstance({
				sourceHome: destination,
				destinationHome: restored,
				confirmedStopped: true
			})
		).rejects.toThrow('all containers stopped');
		expect(classifyInstall(restored)).toBe('incompatible_home');
		expect(
			JSON.parse(readFileSync(join(restored, 'data/.instance-restore.json'), 'utf8')).phase
		).toBe('incomplete');
		expect(existsSync(join(restored, 'data/.lifecycle.lock'))).toBe(false);
		expect(existsSync(join(home, 'state/stack.json'))).toBe(true);
		expect(readFileSync(join(destination, 'instance/state/stack.json'))).toEqual(original);
	});
});

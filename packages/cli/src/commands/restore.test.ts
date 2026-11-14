import { afterAll, afterEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	acquireStackLock,
	createBackup,
	defaultStackConfig,
	writeStackConfig,
	releaseStackLock
} from '@fhold/lib';

import { main } from '../main.js';
import { bootstrapInstall } from './install.js';

const log = spyOn(console, 'log').mockImplementation(() => {});
const warn = spyOn(console, 'warn').mockImplementation(() => {});

afterAll(() => {
	log.mockRestore();
	warn.mockRestore();
});

afterEach(() => {
	log.mockClear();
	warn.mockClear();
});

function output(): string {
	return [...log.mock.calls, ...warn.mock.calls].map((args) => args.join(' ')).join('\n');
}
function lastJson() {
	return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
}

describe('restore command safety', () => {
	it('exports and restores a whole stopped instance through ordinary --name CLI selection', async () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-full-cli-test-'));
		const originalHome = process.env.FH_HOME;
		const originalDocker = process.env.FH_DOCKER_BIN;
		const originalRepo = process.env.FH_REPO_ROOT;
		try {
			const home = join(root, 'source');
			const restored = join(root, 'restored');
			const archive = join(root, 'export');
			process.env.FH_HOME = home;
			process.env.FH_REPO_ROOT = join(import.meta.dir, '../../../..');
			process.env.FH_DOCKER_BIN = join(root, 'docker');
			writeFileSync(process.env.FH_DOCKER_BIN, `#!${process.execPath}\n`, { mode: 0o700 });
			await bootstrapInstall({ start: false });
			writeFileSync(join(home, 'data/assistant/native-history'), 'native conversation and accounts');
			await expect(main(['backup', '--to', archive, '--full'])).rejects.toThrow('confirm-stopped');
			await main(['--name', home, 'backup', '--to', archive, '--full', '--confirm-stopped']);
			expect(lastJson().scope).toBe('instance');
			await main(['--name', restored, 'restore', '--from', archive, '--full', '--dry-run']);
			expect(existsSync(restored)).toBe(false);
			await expect(main(['--name', restored, 'restore', '--from', archive, '--full', '--apply'])).rejects.toThrow('confirm-stopped');
			await main(['--name', restored, 'restore', '--from', archive, '--full', '--apply', '--confirm-stopped']);
			expect(readFileSync(join(restored, 'data/assistant/native-history'), 'utf8')).toBe('native conversation and accounts');
		} finally {
			if (originalHome === undefined) delete process.env.FH_HOME; else process.env.FH_HOME = originalHome;
			if (originalDocker === undefined) delete process.env.FH_DOCKER_BIN; else process.env.FH_DOCKER_BIN = originalDocker;
			if (originalRepo === undefined) delete process.env.FH_REPO_ROOT; else process.env.FH_REPO_ROOT = originalRepo;
			rmSync(root, { recursive: true, force: true });
		}
	});
	it('keeps previews read-only and failed apply atomic for destination conflicts without exposing secrets', async () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-import-cli-test-'));
		const originalHome = process.env.FH_HOME;
		const originalRepo = process.env.FH_REPO_ROOT;
		try {
			const source = join(root, 'source');
			const home = join(root, 'fresh');
			process.env.FH_HOME = home;
			process.env.FH_REPO_ROOT = join(import.meta.dir, '../../../..');
			await bootstrapInstall({ start: false });
			mkdirSync(join(source, 'knowledge', 'secrets'), { recursive: true });
			writeFileSync(join(source, 'knowledge', 'first.md'), 'source knowledge');
			writeFileSync(join(source, 'knowledge', 'conflict.md'), 'source conflict');
			const secret = JSON.stringify({
				example: { type: 'api', key: 'private-provider-test-value' }
			});
			writeFileSync(join(source, 'knowledge', 'secrets', 'auth.json'), secret);
			writeStackConfig(source, defaultStackConfig(source));
			const archive = join(root, 'portable-backup');
			await createBackup({ sourceHome: source, destination: archive, includeProviderAuth: true });
			writeFileSync(join(home, 'knowledge', 'conflict.md'), 'operator destination');
			log.mockClear();
			await main(['restore', '--from', archive, '--dry-run']);
			expect(existsSync(join(home, 'knowledge', 'first.md'))).toBe(false);
			expect(lastJson().entries).toContainEqual(
				expect.objectContaining({ relativeSource: 'knowledge/conflict.md', action: 'conflict' })
			);
			await expect(main(['restore', '--from', archive, '--apply'])).rejects.toThrow(
				'destination conflict'
			);
			expect(existsSync(join(home, 'knowledge', 'first.md'))).toBe(false);
			expect(readFileSync(join(home, 'knowledge', 'conflict.md'), 'utf8')).toBe(
				'operator destination'
			);
			expect(readFileSync(join(source, 'knowledge', 'first.md'), 'utf8')).toBe('source knowledge');
			expect(readFileSync(join(source, 'knowledge', 'secrets', 'auth.json'), 'utf8')).toBe(secret);
			expect(output()).not.toContain('private-provider-test-value');
			const lock = acquireStackLock(join(home, 'data'));
			expect(lock).not.toBeNull();
			releaseStackLock(lock);
		} finally {
			if (originalHome === undefined) delete process.env.FH_HOME;
			else process.env.FH_HOME = originalHome;
			if (originalRepo === undefined) delete process.env.FH_REPO_ROOT;
			else process.env.FH_REPO_ROOT = originalRepo;
			rmSync(root, { recursive: true, force: true });
		}
	});
});

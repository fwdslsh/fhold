import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { exportHistory, validateHistoryDirectories } from './history.js';

describe('native history directory boundaries', () => {
	it('accepts exact reviewed workspace contexts only', () => {
		expect(
			validateHistoryDirectories({ '/old/home': '/work', '/old/project': '/work/project' })
		).toEqual({ '/old/home': '/work', '/old/project': '/work/project' });
		for (const target of [
			'/host-stash',
			'/work/../private',
			'/work/./project',
			'/work//project',
			'/work\\escape',
			'/work/project\n'
		])
			expect(() => validateHistoryDirectories({ '/old': target })).toThrow();
		expect(() => validateHistoryDirectories([])).toThrow();
		expect(() => validateHistoryDirectories({ relative: '/work' })).toThrow();
	});

	it('rejects linked SQLite rollback journals before invoking Docker', async () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-history-journal-test-'));
		const source = join(root, 'old');
		const runtime = join(source, 'data/assistant/.local/share/opencode');
		mkdirSync(runtime, { recursive: true });
		writeFileSync(join(runtime, 'opencode.db'), 'fixture');
		writeFileSync(join(root, 'external'), 'must remain untouched');
		symlinkSync(join(root, 'external'), join(runtime, 'opencode.db-journal'));
		await expect(
			exportHistory({
				sourceHome: source,
				image: 'not-installed',
				destination: join(root, 'archive')
			})
		).rejects.toThrow('unsafe component: opencode.db-journal');
		expect(readFileSync(join(root, 'external'), 'utf8')).toBe('must remain untouched');
	});
});

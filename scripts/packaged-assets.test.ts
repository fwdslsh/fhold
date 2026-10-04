import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { MANAGED_FILES, SEEDED_FILES } from '../packages/lib/src/index.js';

test('built CLI and Admin distributions contain exactly the shared allowlist and bytes', () => {
	const repository = join(import.meta.dir, '..');
	const run = (script: string) => execFileSync(process.execPath, ['run', script], { cwd: repository });
	run('packages/cli/scripts/pack-embedded-assets.ts');
	run('packages/electron/scripts/stage-assets.ts');
	const expected = [...MANAGED_FILES, ...SEEDED_FILES].sort();
	const archive = join(repository, 'packages/cli/embedded/skeleton.tar.gz');
	const cli = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n').sort();
	const staged = join(repository, 'packages/electron/dist/skeleton');
	const walk = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
		const child = join(path, entry.name);
		return entry.isDirectory() ? walk(child) : [relative(staged, child).replaceAll('\\', '/')];
	});
	expect(cli).toEqual(expected);
	expect(walk(staged).sort()).toEqual(expected);
	for (const file of expected) {
		const source = readFileSync(join(repository, 'packages/skeleton', file));
		expect(readFileSync(join(staged, file))).toEqual(source);
		expect(execFileSync('tar', ['-xOzf', archive, file])).toEqual(source);
	}
});

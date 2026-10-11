/** Conservative input classification shared by PR CI and tooling publication. */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function changeScope(files, readBefore, readAfter) {
	for (const path of files) {
		if (path === 'bun.lock') {
			try {
				const normalize = (text) => {
					const lock = Bun.JSONC.parse(text);
					for (const workspace of ['packages/lib', 'packages/cli', 'packages/electron'])
						if (lock.workspaces?.[workspace]) delete lock.workspaces[workspace].version;
					return JSON.stringify(lock);
				};
				if (normalize(readBefore(path)) === normalize(readAfter(path))) continue;
			} catch { /* A dependency change or unreadable lock needs runtime qualification. */ }
			return 'full';
		}
		if (path === 'package.json') {
			const settings = (text) => {
				const json = JSON.parse(text);
				return JSON.stringify([json.dependencies, json.devDependencies, json.overrides, json.trustedDependencies, json.workspaces, json.packageManager]);
			};
			try { if (settings(readBefore(path)) === settings(readAfter(path))) continue; } catch {}
			return 'full';
		}
		if (path === 'packages/lib/src/control-plane/seed-manifest.ts') return 'full';
		if (/^(?:packages\/(?:lib|cli|electron)\/|docs\/|website\/)/.test(path)) continue;
		if (/^(?:README|CHANGELOG|AGENTS|LICENSE)(?:\.md)?$/.test(path)) continue;
		if (['.github/workflows/ci.yml', '.github/workflows/gates.yml', '.github/workflows/release.yml', '.github/release-manifest.json', 'scripts/ci-scope.mjs', 'scripts/tooling-release.test.ts', 'scripts/bump-release.mjs', 'scripts/bump-release.test.ts', 'scripts/validate-release-assets.mjs', 'scripts/release-aggregates-hygiene.test.ts', 'scripts/smoke-admin-artifact.mjs', '.github/workflows/deploy-docs.yml'].includes(path)) continue;
		return 'full';
	}
	return 'tools';
}

export function gitScope(base, head = 'HEAD') {
	const git = (args) => execFileSync('git', args, { encoding: 'utf8' });
	const files = git(['diff', '--name-only', '-z', '--no-renames', base, head, '--']).split('\0').filter(Boolean);
	return changeScope(files, (path) => git(['show', `${base}:${path}`]), (path) => git(['show', `${head}:${path}`]));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const scope = !process.env.BASE_SHA || /^0+$/.test(process.env.BASE_SHA) ? 'full' : gitScope(process.env.BASE_SHA, process.env.HEAD_SHA || 'HEAD');
	console.log(scope);
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `scope=${scope}\n`);
}

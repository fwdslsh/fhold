// TEMPORARY until https://github.com/fwdslsh/unify/issues/118 is released.
// This only stages the npm template and local overrides. Remove it and its
// prepare:template callers once Unify can consume templates during builds.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const config = Bun.YAML.parse(await Bun.file(join(project, 'unify.yaml')).text());
const cache = join(project, '.cache');
mkdirSync(cache, { recursive: true });
const staging = mkdtempSync(join(cache, 'template-'));
try {
	const result = spawnSync(
		process.execPath,
		[fileURLToPath(import.meta.resolve('@fwdslsh/unify')), 'init', config.template.source],
		{ cwd: staging, stdio: 'inherit' }
	);
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`Template fetch failed (${result.status})`);
	cpSync(join(project, 'site'), join(staging, 'site'), { recursive: true });
	// init's config belongs to the fetched template. Only our website config
	// may control the build, even when Unify discovers a config in the source.
	rmSync(join(staging, 'site', 'unify.yaml'), { force: true });
	rmSync(join(cache, 'template'), { recursive: true, force: true });
	renameSync(staging, join(cache, 'template'));
} finally {
	rmSync(staging, { recursive: true, force: true });
}

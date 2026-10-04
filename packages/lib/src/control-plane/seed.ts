import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureHomeDirs, writeFileAtomic } from './foundation.js';
import { MANAGED_FILES, SEEDED_FILES } from './seed-manifest.js';
export { MANAGED_FILES, SEEDED_FILES } from './seed-manifest.js';

export function skeletonRoot(): string {
	if (process.env.FH_SKELETON_DIR) return process.env.FH_SKELETON_DIR;
	if (process.env.FH_REPO_ROOT) {
		return join(process.env.FH_REPO_ROOT, 'packages', 'skeleton');
	}
	const candidate = join(
		dirname(fileURLToPath(import.meta.url)),
		'..',
		'..',
		'..',
		'..',
		'packages',
		'skeleton'
	);
	if (existsSync(join(candidate, 'system', 'stack', 'stack.compose.yml'))) return candidate;
	throw new Error(
		'fhold skeleton assets were not found. Set FH_SKELETON_DIR or FH_REPO_ROOT.'
	);
}

/** Read-only, whole-manifest validation before the first installation write. */
export function preflightHomeSeed(homeDir: string): void {
	const source = skeletonRoot();
	for (const path of [...MANAGED_FILES, ...SEEDED_FILES]) {
		let sourcePath = source;
		for (const segment of path.split('/')) {
			sourcePath = join(sourcePath, segment);
			const stat = lstatSync(sourcePath, { throwIfNoEntry: false });
			if (!stat || stat.isSymbolicLink() || (sourcePath === join(source, path) ? !stat.isFile() : !stat.isDirectory())) throw new Error(`Required skeleton asset is missing or invalid: ${path}`);
		}
		if (!lstatSync(join(source, path), { throwIfNoEntry: false })?.isFile()) {
			throw new Error(`Required skeleton asset is missing or invalid: ${path}`);
		}
		let current = homeDir;
		for (const segment of path.split('/')) {
			current = join(current, segment);
			const stat = lstatSync(current, { throwIfNoEntry: false });
			if (stat && (stat.isSymbolicLink() || (current === join(homeDir, path) ? !stat.isFile() : !stat.isDirectory()))) {
				throw new Error(`Refusing non-file or linked seed path: ${current}`);
			}
		}
	}
}

export function readSeedFile(path: string): Buffer {
	if (![...MANAGED_FILES, ...SEEDED_FILES].includes(path as typeof MANAGED_FILES[number])) {
		throw new Error('Path is not a current fhold seed asset');
	}
	return readFileSync(join(skeletonRoot(), path));
}

function copy(
	sourceRoot: string,
	homeDir: string,
	relativePath: string,
	overwrite: boolean
): boolean {
	const source = join(sourceRoot, relativePath);
	const destination = join(homeDir, relativePath);
	const sourceStat = lstatSync(source, { throwIfNoEntry: false });
	if (!sourceStat?.isFile()) {
		throw new Error(`Required skeleton asset is missing or invalid: ${relativePath}`);
	}
	const parentPath = dirname(destination);
	const parentRelative = relative(homeDir, parentPath);
	if (
		parentRelative === '..' ||
		parentRelative.startsWith(`..${sep}`) ||
		isAbsolute(parentRelative)
	) {
		throw new Error(`Skeleton destination escapes FH_HOME: ${destination}`);
	}
	let current = homeDir;
	for (const segment of parentRelative.split(sep).filter(Boolean)) {
		current = join(current, segment);
		let stat = lstatSync(current, { throwIfNoEntry: false });
		if (!stat) {
			mkdirSync(current, { mode: 0o700 });
			stat = lstatSync(current);
		}
		if (!stat.isDirectory()) {
			throw new Error(`Refusing non-directory or symlink seed path: ${current}`);
		}
	}
	const destinationStat = lstatSync(destination, { throwIfNoEntry: false });
	if (destinationStat) {
		if (!destinationStat.isFile()) {
			throw new Error(`Refusing to replace non-file seed path: ${destination}`);
		}
		if (!overwrite) return false;
	}
	writeFileAtomic(destination, readFileSync(source), sourceStat.mode & 0o777);
	return true;
}

/**
 * Materialize only the release surface. Managed files are replaced as
 * whole files; user-owned seed files are never overwritten. No stale path is
 * removed automatically, which keeps upgrades from deleting operator data.
 */
export async function applyHomeSeed(homeDir: string): Promise<{ updated: string[] }> {
	preflightHomeSeed(homeDir);
	ensureHomeDirs(homeDir);
	const source = skeletonRoot();
	const updated: string[] = [];
	for (const path of MANAGED_FILES) {
		if (copy(source, homeDir, path, true)) updated.push(path);
	}
	for (const path of SEEDED_FILES) {
		if (copy(source, homeDir, path, false)) updated.push(path);
	}
	return { updated };
}

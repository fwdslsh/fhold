import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { MANAGED_FILES, SEEDED_FILES } from '../../lib/src/index.js';

export const DISTRIBUTION_ASSETS = [...MANAGED_FILES, ...SEEDED_FILES].sort();

export function stageAdminAssets(repository: string): string {
	const source = join(repository, 'packages/skeleton');
	const destination = join(repository, 'packages/electron/dist/skeleton');
	for (const file of DISTRIBUTION_ASSETS) {
		if (!lstatSync(join(source, file), { throwIfNoEntry: false })?.isFile())
			throw new Error(`Missing or invalid packaged asset: ${file}`);
	}
	// No wholesale directory copy or cleanup: refuse unexpected stale output.
	function inventory(directory: string): string[] {
		if (!existsSync(directory)) return [];
		return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return inventory(path);
			if (!entry.isFile()) throw new Error(`Invalid staged asset: ${path}`);
			return [relative(destination, path).replaceAll('\\', '/')];
		});
	}
	for (const file of inventory(destination)) {
		if (!DISTRIBUTION_ASSETS.includes(file as (typeof DISTRIBUTION_ASSETS)[number]))
			throw new Error(`Unexpected staged asset: ${file}; use a fresh build directory`);
	}
	for (const file of DISTRIBUTION_ASSETS) {
		mkdirSync(dirname(join(destination, file)), { recursive: true });
		copyFileSync(join(source, file), join(destination, file));
	}
	return destination;
}

if (import.meta.main) console.log(`Staged Admin assets at ${stageAdminAssets(join(import.meta.dir, '../../..'))}`);

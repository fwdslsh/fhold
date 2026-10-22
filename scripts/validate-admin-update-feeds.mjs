/** Validate electron-builder's generated per-architecture AppImage feeds. Run with Bun. */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_UPDATE_FEEDS, expectedAdminAssets } from './validate-release-assets.mjs';

export function validateAdminUpdateFeeds(directory, version) {
	const assets = expectedAdminAssets(version);
	for (const [index, name] of ADMIN_UPDATE_FEEDS.entries()) {
		const feed = Bun.YAML.parse(readFileSync(join(directory, name), 'utf8'));
		const asset = assets[index];
		const file = feed?.files?.[0];
		if (feed?.version !== version || feed?.files?.length !== 1 || file?.url !== asset)
			throw Error(`${name} does not identify the ${version} ${asset} artifact.`);
		const path = join(directory, asset);
		const sha512 = createHash('sha512').update(readFileSync(path)).digest('base64');
		if (
			file.sha512 !== sha512 ||
			file.size !== statSync(path).size ||
			feed.path !== asset ||
			feed.sha512 !== sha512
		)
			throw Error(`${name} does not match its published AppImage bytes.`);
	}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (!process.env.VERSION) throw Error('VERSION is required');
	validateAdminUpdateFeeds(resolve(process.env.RELEASE_ASSETS_DIR ?? 'dist'), process.env.VERSION);
	console.log('Verified both native Admin update feeds against the AppImage checksums.');
}

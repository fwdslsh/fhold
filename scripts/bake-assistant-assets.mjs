#!/usr/bin/env bun
// Build-time only. The host's authoritative allowlist also selects image assets.
import { copyFileSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MANAGED_FILES, SEEDED_FILES } from '../packages/lib/src/control-plane/seed-manifest.ts';

const locations = [
	['system/assistant/', '/etc/opencode/'],
	['config/assistant/', '/home/opencode/.config/opencode/'],
	['config/akm/', '/etc/akm/'],
	['knowledge/', '/stash/']
];

export function assistantAssets() {
	return [...MANAGED_FILES, ...SEEDED_FILES].flatMap((source) => {
		const location = locations.find(([prefix]) => source.startsWith(prefix));
		return location ? [{ source, target: location[1] + source.slice(location[0].length) }] : [];
	});
}

export function bakeAssistantAssets(skeleton, output) {
	const assets = assistantAssets();
	// Validate everything before publishing the image build's selection.
	for (const { source } of assets) {
		let current = resolve(skeleton);
		for (const component of source.split('/')) {
			current = join(current, component);
			const stat = lstatSync(current);
			if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
				throw new Error(`Invalid Assistant image asset: ${source}`);
		}
		if (!lstatSync(current).isFile()) throw new Error(`Missing Assistant image asset: ${source}`);
	}
	mkdirSync(output, { recursive: true });
	for (const { source } of assets) {
		const target = join(output, source);
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(join(skeleton, source), target);
	}
	writeFileSync(join(output, 'manifest.tsv'), assets.map(({ source, target }) => `${source}\t${target}\n`).join(''));
	return assets;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	if (process.argv.length !== 4) throw new Error('Usage: bake-assistant-assets.mjs <skeleton> <output>');
	bakeAssistantAssets(resolve(process.argv[2]), resolve(process.argv[3]));
}

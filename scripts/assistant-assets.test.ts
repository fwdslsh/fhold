import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANAGED_FILES, SEEDED_FILES } from '../packages/lib/src/control-plane/seed-manifest.js';
import { assistantAssets, bakeAssistantAssets } from './bake-assistant-assets.mjs';

test('standalone Assistant uses the same allowlisted bytes without host or ingress assets', () => {
	const skeleton = join(import.meta.dir, '../packages/skeleton');
	const output = mkdtempSync(join(tmpdir(), 'fhold-assistant-assets-'));
	const assets = bakeAssistantAssets(skeleton, output);
	const prefixes = [
		'system/assistant/',
		'config/assistant/',
		'config/akm/',
		'config/codex/',
		'config/claude/',
		'config/opencode/',
		'knowledge/'
	];
	const source = [...MANAGED_FILES, ...SEEDED_FILES].filter((name) =>
		prefixes.some((prefix) => name.startsWith(prefix))
	);
	expect(assets.map((asset: { source: string }) => asset.source)).toEqual(source);
	expect(assistantAssets()).toEqual(assets);
	for (const asset of assets) {
		expect(readFileSync(join(output, asset.source))).toEqual(
			readFileSync(join(skeleton, asset.source))
		);
		expect(asset.target).toMatch(
			/^\/(etc\/(opencode|akm|codex|claude-code)|home\/fhold\/\.config\/opencode|stash)\//
		);
	}
	expect(readFileSync(join(output, 'manifest.tsv'), 'utf8')).toBe(
		assets
			.map((asset: { source: string; target: string }) => `${asset.source}\t${asset.target}\n`)
			.join('')
	);
});

import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMIN_UPDATE_FEEDS, expectedAdminAssets } from './validate-release-assets.mjs';
import { validateAdminUpdateFeeds } from './validate-admin-update-feeds.mjs';

const fixtures: string[] = [];
afterEach(() => {
	for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture(version = '0.3.261002-beta') {
	const directory = mkdtempSync(join(tmpdir(), 'fhold-admin-feeds-'));
	fixtures.push(directory);
	for (const [index, asset] of expectedAdminAssets(version).entries()) {
		const bytes = Buffer.from(`synthetic-${asset}`);
		writeFileSync(join(directory, asset), bytes);
		const sha512 = createHash('sha512').update(bytes).digest('base64');
		writeFileSync(
			join(directory, ADMIN_UPDATE_FEEDS[index]),
			Bun.YAML.stringify({
				version,
				files: [{ url: asset, sha512, size: bytes.length }],
				path: asset,
				sha512
			})
		);
	}
	return { directory, version };
}
test('both native architecture feeds identify the exact checksummed AppImage bytes', () => {
	const { directory, version } = fixture();
	expect(() => validateAdminUpdateFeeds(directory, version)).not.toThrow();
});

test('0.4 month-counter versions retain their exact names in both update feeds', () => {
	for (const value of ['0.4.1001-beta', '0.4.1002', '0.4.1101', '0.5.101']) {
		const { directory, version } = fixture(value);
		expect(() => validateAdminUpdateFeeds(directory, version)).not.toThrow();
	}
});
test('a stale feed, swapped architecture or corrupt image cannot be published', () => {
	for (const mutation of ['version', 'architecture', 'hash', 'size', 'legacy-path', 'extra-file']) {
		const { directory, version } = fixture();
		const path = join(directory, ADMIN_UPDATE_FEEDS[0]);
		const feed = Bun.YAML.parse(readFileSync(path, 'utf8'));
		if (mutation === 'version') feed.version = '0.3.261001-beta';
		if (mutation === 'architecture') feed.files[0].url = expectedAdminAssets(version)[1];
		if (mutation === 'hash') feed.files[0].sha512 = 'invalid';
		if (mutation === 'size') feed.files[0].size++;
		if (mutation === 'legacy-path') feed.path = 'unexpected.AppImage';
		if (mutation === 'extra-file') feed.files.push(feed.files[0]);
		writeFileSync(path, Bun.YAML.stringify(feed));
		expect(() => validateAdminUpdateFeeds(directory, version)).toThrow();
	}
});
test('release publishing includes and verifies feeds but PR previews never publish or auto-update', () => {
	const workflow = Bun.YAML.parse(
		readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
	);
	const gates = Bun.YAML.parse(
		readFileSync(new URL('../.github/workflows/gates.yml', import.meta.url), 'utf8')
	);
	expect(
		gates.jobs.admin.steps.some((step: { run?: string }) => step.run?.includes('latest-linux*.yml'))
	).toBe(true);
	expect(
		workflow.jobs.release.steps.filter((step: { run?: string }) =>
			step.run?.includes('validate-admin-update-feeds.mjs')
		)
	).toHaveLength(2);
	const preview = Bun.YAML.parse(
		readFileSync(new URL('../.github/workflows/pr-admin.yml', import.meta.url), 'utf8')
	);
	expect(
		preview.jobs.appimage.steps.find(
			(step: { name?: string }) => step.name === "Build the PR's Admin"
		).run
	).toContain('fholdPreview=true');
	const manifest = JSON.parse(
		readFileSync(new URL('../packages/electron/package.json', import.meta.url), 'utf8')
	);
	expect(manifest.scripts['build:linux']).toContain('--publish never');
	expect(manifest.scripts['build:linux-x64']).toContain('--publish never');
});

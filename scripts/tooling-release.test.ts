import { expect, test } from 'bun:test';
import { changeScope } from './ci-scope.mjs';
import {
	requiredReleaseAssets,
	writeReleaseAssetManifest,
	validateReleaseAssets
} from './validate-release-assets.mjs';
import {
	FH_RUNTIME_VERSION,
	FH_BRIDGE_VERSION
} from '../packages/lib/src/control-plane/release.js';
import { defaultStackConfig } from '../packages/lib/src/control-plane/stack-config.js';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

test('tooling changes do not require container qualification', () => {
	expect(
		changeScope(
			[
				'packages/lib/src/hosting/ssh-docker.ts',
				'packages/electron/admin/hosting.js',
				'packages/cli/src/commands/hosting.ts'
			],
			() => '',
			() => ''
		)
	).toBe('tools');
	for (const path of [
		'containers/assistant/entrypoint.sh',
		'packages/portal/src/server.ts',
		'packages/skeleton/config/opencode/opencode.json',
		'packages/lib/src/control-plane/seed-manifest.ts',
		'unknown-input'
	])
		expect(
			changeScope(
				[path],
				() => '',
				() => ''
			)
		).toBe('full');
});
test('tooling declarations can reuse locked packages; changed resolutions still require runtime qualification', () => {
	const lock = { workspaces: { 'packages/lib': { version: 'old' } }, packages: { dep: '1' } };
	const next = structuredClone(lock);
	next.workspaces['packages/lib'].version = 'new';
	expect(
		changeScope(
			['bun.lock'],
			() => JSON.stringify(lock),
			() => JSON.stringify(next)
		)
	).toBe('tools');
	const declaration = {
		...next,
		workspaces: {
			'packages/lib': { ...next.workspaces['packages/lib'], dependencies: { tar: '^7.5.22' } }
		}
	};
	expect(
		changeScope(
			['bun.lock'],
			() => JSON.stringify(lock),
			() => JSON.stringify(declaration)
		)
	).toBe('tools');
	next.packages.dep = '2';
	expect(
		changeScope(
			['bun.lock'],
			() => JSON.stringify(lock),
			() => JSON.stringify(next)
		)
	).toBe('full');
});
test('root build scripts can change without runtime qualification, but install hooks cannot', () => {
	const before = { version: 'old', scripts: { check: 'old check' } };
	const after = {
		version: 'new',
		scripts: { check: 'new check', postinstall: undefined as string | undefined }
	};
	expect(
		changeScope(
			['package.json'],
			() => JSON.stringify(before),
			() => JSON.stringify(after)
		)
	).toBe('tools');
	after.scripts.postinstall = 'new install hook';
	expect(
		changeScope(
			['package.json'],
			() => JSON.stringify(before),
			() => JSON.stringify(after)
		)
	).toBe('full');
});
test('tooling assets omit the bridge and fresh installs use the published runtime cohort', () => {
	expect(requiredReleaseAssets('0.2.2610121-beta.9', 'fhold Admin', 'tools')).toHaveLength(5);
	expect(
		requiredReleaseAssets('0.2.2610121-beta.9', 'fhold Admin', 'tools').some((name) =>
			name.endsWith('.mcpb')
		)
	).toBe(false);
	expect(defaultStackConfig().deployment.images).toEqual({
		assistant: FH_RUNTIME_VERSION,
		guardian: FH_RUNTIME_VERSION,
		portal: FH_RUNTIME_VERSION
	});
	expect(FH_BRIDGE_VERSION).toBe(
		JSON.parse(
			readFileSync(new URL('../packages/claude-desktop/package.json', import.meta.url), 'utf8')
		).version
	);
});
test('tooling workflow skips image gates and publication without skipping artifact checks', () => {
	const gates = Bun.YAML.parse(
		readFileSync(new URL('../.github/workflows/gates.yml', import.meta.url), 'utf8')
	) as { jobs: Record<string, { if?: string }> };
	const release = Bun.YAML.parse(
		readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
	) as {
		jobs: Record<
			string,
			{ if?: string; steps?: Array<{ name?: string; env?: Record<string, string> }> }
		>;
	};
	expect(gates.jobs.images?.if).toBe("inputs.scope != 'tools'");
	expect(release.jobs.images?.if).toBe("needs.validate.outputs.scope == 'full'");
	expect(release.jobs['claude-extension']?.if).toBe("needs.validate.outputs.scope == 'full'");
	expect(
		release.jobs.release?.steps?.find(
			(step) => step.name === 'Write manifest and validate the complete release'
		)?.env?.SCOPE
	).toBe('${{ needs.validate.outputs.scope }}');
});
test('tooling-only checksums and manifest validate without a new extension', () => {
	const dir = mkdtempSync(join(tmpdir(), 'fhold-release-preview-'));
	try {
		const version = '0.2.2610121-beta.9';
		const names = requiredReleaseAssets(version, 'fhold Admin', 'tools').filter(
			(name) => name !== 'checksums-sha256.txt'
		);
		for (const name of names) writeFileSync(join(dir, name), name);
		writeFileSync(
			join(dir, 'checksums-sha256.txt'),
			names.map((name) => `${createHash('sha256').update(name).digest('hex')}  ${name}\n`).join('')
		);
		writeReleaseAssetManifest(dir, version, 'fhold Admin', 'tools');
		expect(validateReleaseAssets(dir, version, 'fhold Admin', 'tools')).toEqual([]);
		expect(validateReleaseAssets(dir, version, 'fhold Admin', 'full').length).toBeGreaterThan(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

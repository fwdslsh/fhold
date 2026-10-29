import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	FH_BRIDGE_VERSION,
	FH_RUNTIME_VERSION
} from '../packages/lib/src/control-plane/release.js';
import { defaultStackConfig } from '../packages/lib/src/control-plane/stack-config.js';
import { changeScope, validationPlan } from './ci-scope.mjs';
import {
	requiredReleaseAssets,
	validateReleaseAssets,
	writeReleaseAssetManifest
} from './validate-release-assets.mjs';

test('tooling changes do not require container qualification', () => {
	expect(
		changeScope(
			[
				'packages/lib/src/hosting/ssh-docker.ts',
				'packages/electron/admin/hosting.js',
				'packages/cli/src/commands/hosting.ts',
				'.github/workflows/pr-admin.yml',
				'.github/workflows/admin-desktop-native.yml',
				'scripts/validate-admin-update-feeds.mjs',
				'scripts/admin-update-feeds.test.ts',
				'scripts/management-architecture.test.ts',
				'scripts/README.md'
			],
			() => '',
			() => ''
		)
	).toBe('tools');
	for (const path of [
		'containers/assistant/entrypoint.sh',
		'packages/portal/src/server.ts',
		'packages/skeleton/system/assistant/opencode.json',
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
	const lock = {
		lockfileVersion: 1,
		configVersion: 1,
		workspaces: {
			'': { name: 'root', dependencies: { dep: '1', tar: '^7.5.22' } },
			'packages/lib': { name: '@fhold/lib', version: 'old', dependencies: { dep: '1' } }
		},
		packages: { dep: ['dep@1', '', {}, 'dep-hash'], tar: ['tar@7.5.22', '', {}, 'tar-hash'] }
	};
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
			...next.workspaces,
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
	next.packages.dep = ['dep@2', '', {}, 'dep-hash-2'];
	// Repository policy can skip lock-only product CI, but publication must still
	// detect that runtime consumers changed and refuse a tooling-only release.
	expect(
		validationPlan(
			['bun.lock'],
			() => JSON.stringify(lock),
			() => JSON.stringify(next)
		).scope
	).toBe('none');
	expect(
		changeScope(
			['bun.lock'],
			() => JSON.stringify(lock),
			() => JSON.stringify(next)
		)
	).toBe('full');
});
test('Admin-only lock additions and rehoisting do not change runtime consumers', () => {
	const before = {
		lockfileVersion: 1,
		configVersion: 1,
		workspaces: {
			'': { name: 'root' },
			'packages/electron': { name: '@fhold/electron', dependencies: { builder: '1' } },
			'packages/guardian': { name: '@fhold/guardian', dependencies: { '@scope/client': '1' } }
		},
		packages: {
			builder: ['builder@1', '', { dependencies: { yaml: '1' } }, 'builder-hash'],
			'@scope/client': ['@scope/client@1', '', { dependencies: { yaml: '2' } }, 'client-hash'],
			yaml: ['yaml@2', '', {}, 'yaml-2-hash'],
			'builder/yaml': ['yaml@1', '', {}, 'yaml-1-hash']
		} as Record<string, unknown>
	};
	const after = structuredClone(before);
	after.workspaces['packages/electron'].dependencies = { builder: '1', updater: '1' } as {
		builder: string;
	};
	after.packages.updater = ['updater@1', '', { dependencies: { yaml: '1' } }, 'updater-hash'];
	after.packages.yaml = before.packages['builder/yaml'];
	after.packages['@scope/client/yaml'] = before.packages.yaml;
	delete after.packages['builder/yaml'];
	const scope = (value = after) =>
		changeScope(
			['bun.lock'],
			() => JSON.stringify(before),
			() => JSON.stringify(value)
		);
	expect(scope()).toBe('tools');
	const runtimeUpgrade = structuredClone(after);
	runtimeUpgrade.packages['@scope/client/yaml'] = ['yaml@3', '', {}, 'yaml-3-hash'];
	expect(scope(runtimeUpgrade)).toBe('full');
	const wrongHoist = structuredClone(after);
	delete wrongHoist.packages['@scope/client/yaml'];
	expect(scope(wrongHoist)).toBe('full');
	const tampered = structuredClone(after);
	tampered.packages['@scope/client/yaml'] = ['yaml@2', '', {}, 'different-integrity'];
	expect(scope(tampered)).toBe('full');
	const orphan = structuredClone(after);
	orphan.packages.unexplained = ['unexplained@1', '', {}, 'orphan-hash'];
	expect(scope(orphan)).toBe('full');
	const unknown = { ...after, configVersion: 2 };
	expect(
		changeScope(
			['bun.lock'],
			() => JSON.stringify(before),
			() => JSON.stringify(unknown)
		)
	).toBe('full');
});
test('lock comparison follows workspace, peer, optional and cyclic dependency edges', () => {
	const before = {
		lockfileVersion: 1,
		configVersion: 1,
		workspaces: {
			'': { name: 'root' },
			'packages/electron': { name: '@fhold/electron', dependencies: {} },
			'packages/lib': { name: '@fhold/lib', dependencies: { shared: '1' } },
			'packages/guardian': {
				name: '@fhold/guardian',
				dependencies: { '@fhold/lib': 'workspace:*' }
			}
		},
		packages: {
			'@fhold/lib': ['@fhold/lib@workspace:packages/lib'],
			shared: [
				'shared@1',
				'',
				{ peerDependencies: { peer: '1' }, optionalDependencies: { platform: '1' } },
				'shared-hash'
			],
			peer: ['peer@1', '', { dependencies: { shared: '1' } }, 'peer-hash'],
			platform: ['platform@1', '', { os: 'linux', cpu: 'arm64' }, 'platform-hash']
		} as Record<string, unknown>
	};
	const after = structuredClone(before);
	after.workspaces['packages/electron'].dependencies = { updater: '1' };
	after.packages.updater = ['updater@1', '', {}, 'updater-hash'];
	const scope = (value = after) =>
		changeScope(
			['bun.lock'],
			() => JSON.stringify(before),
			() => JSON.stringify(value)
		);
	expect(scope()).toBe('tools');
	for (const name of ['shared', 'peer', 'platform']) {
		const changed = structuredClone(after);
		changed.packages[name] = [`${name}@2`, '', {}, 'new-hash'];
		expect(scope(changed)).toBe('full');
	}
	const missing = structuredClone(after);
	delete missing.packages.platform;
	expect(scope(missing)).toBe('full');
	const workspaceChanged = structuredClone(after);
	workspaceChanged.workspaces['packages/lib'].dependencies.shared = '2';
	expect(scope(workspaceChanged)).toBe('full');
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
	expect(requiredReleaseAssets('0.2.2610121-beta.9', 'fhold Admin', 'tools')).toHaveLength(7);
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
	) as { jobs: Record<string, { if?: string; steps?: Array<{ name?: string; run?: string }> }> };
	const release = Bun.YAML.parse(
		readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
	) as {
		jobs: Record<
			string,
			{ if?: string; steps?: Array<{ name?: string; env?: Record<string, string> }> }
		>;
	};
	expect(gates.jobs.images?.if).toBe("inputs.scope != 'tools'");
	expect(
		gates.jobs.quality?.steps?.find((step) => step.name === 'Check and test tooling')?.run
	).toContain('scripts/management-architecture.test.ts');
	const qualified =
		"always() && needs.validate.result == 'success' && (needs.gates.result == 'success' || (needs.gates.result == 'skipped' && needs.validate.outputs.qualified == 'true'))";
	expect(release.jobs.images?.if).toBe(`${qualified} && needs.validate.outputs.scope == 'full'`);
	expect(release.jobs['claude-extension']?.if).toBe(
		`${qualified} && needs.validate.outputs.scope == 'full'`
	);
	expect(release.jobs.cli?.if).toBe(qualified);
	expect(release.jobs.admin?.if).toBe(qualified);
	expect(release.jobs.gates?.if).toBe("needs.validate.outputs.qualified != 'true'");
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

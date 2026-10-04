import { afterEach, expect, test } from 'bun:test';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installHome } from './install.js';
import { updateHome } from './update.js';
import { MANAGED_FILES, SEEDED_FILES, skeletonRoot } from './seed.js';
import { readStackConfig, writeStackConfig } from './stack-config.js';
import { FH_RELEASE_VERSION } from './release.js';

const roots: string[] = [];
const originalSkeleton = process.env.FH_SKELETON_DIR;
afterEach(() => {
	if (originalSkeleton === undefined) delete process.env.FH_SKELETON_DIR;
	else process.env.FH_SKELETON_DIR = originalSkeleton;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'fhold-update-test-'));
	roots.push(root);
	const home = join(root, 'home');
	await installHome({ homeDir: home });
	return { root, home };
}

test('upgrades seed missing native policies, preserve operator edits and never rewrite account settings', async () => {
	const { home } = await fixture();
	const policies = {
		'config/opencode/opencode.json': '{"permission":{"bash":"ask"}}\n',
		'config/codex/config.toml': 'approval_policy = "never"\n',
		'config/codex/requirements.toml': 'allowed_approval_policies = ["never"]\n',
		'config/claude/managed-settings.json': '{"permissions":{"defaultMode":"plan"}}\n'
	};
	// Model an earlier installation without the newly introduced policy files.
	for (const path of Object.keys(policies)) rmSync(join(home, path));
	const userConfig = join(home, 'data/assistant/home/.codex/config.toml');
	mkdirSync(dirname(userConfig), { recursive: true });
	writeFileSync(userConfig, '# Existing account preferences and unrelated hook approvals\n');
	await updateHome({ homeDir: home, start: false });
	for (const [path, value] of Object.entries(policies)) {
		expect(readFileSync(join(home, path))).toEqual(readFileSync(join(skeletonRoot(), path)));
		writeFileSync(join(home, path), value);
	}
	await updateHome({ homeDir: home, start: false });
	for (const [path, value] of Object.entries(policies))
		expect(readFileSync(join(home, path), 'utf8')).toBe(value);
	expect(readFileSync(userConfig, 'utf8')).toBe(
		'# Existing account preferences and unrelated hook approvals\n'
	);
});

test('unknown schema leaves managed and user files unchanged before any checkpoint', async () => {
	const { home } = await fixture();
	const managed = join(home, 'system/assistant/AGENTS.md');
	writeFileSync(managed, 'prior release sentinel');
	const path = join(home, 'state/stack.json');
	const config = JSON.parse(readFileSync(path, 'utf8'));
	config.version = 999;
	writeFileSync(path, JSON.stringify(config));
	await expect(updateHome({ homeDir: home, start: false })).rejects.toThrow('incompatible');
	expect(readFileSync(managed, 'utf8')).toBe('prior release sentinel');
	expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(999);
	expect(existsSync(join(home, 'state/update-receipts'))).toBe(false);
});

test('a late missing candidate asset leaves every existing managed asset untouched', async () => {
	const { home, root } = await fixture();
	const managed = join(home, MANAGED_FILES[0]);
	writeFileSync(managed, 'prior compose sentinel');
	const candidate = join(root, 'incomplete-skeleton');
	const source = skeletonRoot();
	for (const file of [...MANAGED_FILES, ...SEEDED_FILES].slice(0, -1)) {
		mkdirSync(dirname(join(candidate, file)), { recursive: true });
		copyFileSync(join(source, file), join(candidate, file));
	}
	process.env.FH_SKELETON_DIR = candidate;
	await expect(updateHome({ homeDir: home, start: false })).rejects.toThrow(
		'Required skeleton asset'
	);
	expect(readFileSync(managed, 'utf8')).toBe('prior compose sentinel');
	expect(existsSync(join(home, 'state/update-receipts'))).toBe(false);
});

test('update advances managed release tags while preserving explicit pins, project, namespace, authority and scheduling intent', async () => {
	const { home } = await fixture();
	const read = readStackConfig(home);
	if (!read.ok) throw new Error(read.error);
	const config = read.config;
	const prior = '0.1.2610011200-alpha.1';
	config.deployment = {
		projectName: 'reviewed-instance',
		imageNamespace: 'local-review',
		images: { assistant: prior, guardian: prior, portal: 'reviewed-portal-pin' }
	};
	config.assistant.timezone = 'America/Chicago';
	config.assistant.automaticMemory = false;
	writeStackConfig(home, config);
	writeFileSync(
		join(home, 'state/installation.json'),
		JSON.stringify({
			product: 'fhold',
			homeDir: home,
			release: prior,
			managedImages: { assistant: prior, guardian: prior, portal: prior }
		})
	);
	writeFileSync(join(home, 'knowledge/tasks/reviewed.yaml'), 'enabled: true\n');
	const key = readFileSync(join(home, 'state/credentials/owner/key'));
	const result = await updateHome({ homeDir: home, start: false });
	const after = readStackConfig(home);
	if (!after.ok) throw new Error(after.error);
	expect(after.config.deployment).toEqual({
		projectName: 'reviewed-instance',
		imageNamespace: 'local-review',
		images: {
			assistant: FH_RELEASE_VERSION,
			guardian: FH_RELEASE_VERSION,
			portal: 'reviewed-portal-pin'
		}
	});
	expect(after.config.assistant.timezone).toBe('America/Chicago');
	expect(after.config.assistant.automaticMemory).toBe(false);
	expect(after.config.assistant.port).toBe(config.assistant.port);
	expect(after.config.gateway.port).toBe(config.gateway.port);
	expect(readFileSync(join(home, 'state/credentials/owner/key'))).toEqual(key);
	expect(readFileSync(join(home, 'knowledge/tasks/reviewed.yaml'), 'utf8')).toBe('enabled: true\n');
	const receipt = JSON.parse(readFileSync(result.receipt, 'utf8'));
	expect(receipt.phase).toBe('files-refreshed-not-activated');
	expect(receipt.runningContainersUpgraded).toBe(false);
	expect(receipt.scope).toBe('control-plane-only');
	expect(receipt.runningImages).toBeUndefined();
	expect(readdirSync(join(dirname(result.receipt), 'before/system/assistant'))).toContain(
		'AGENTS.md'
	);
});

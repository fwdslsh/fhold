import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assistantImage, ASSISTANT_EDITIONS } from './assistant-editions.js';
import { installHome } from './install.js';
import { readStackConfig, stackConfigEnv } from './stack-config.js';
import { saveStackIntent } from './operations.js';
import { restartStatus, recordAppliedRuntime, runtimeRevision } from './runtime-revision.js';

const homes: string[] = [];

test('an unsafe retirement destination fails before edition intent or discovery changes', async () => {
	const home = mkdtempSync(join(tmpdir(), 'fhold-edition-unsafe-')); homes.push(home);
	await installHome({ homeDir: home, automaticPorts: false });
	const original = config(home), slim = structuredClone(original);
	slim.assistant.edition = 'slim';
	const outside = mkdtempSync(join(tmpdir(), 'fhold-edition-outside-')); homes.push(outside);
	symlinkSync(outside, join(home, 'state/retired-managed'), 'dir');
	expect(() => saveStackIntent(home, slim, original)).toThrow();
	expect(config(home).assistant.edition).toBeUndefined();
	expect(existsSync(join(home, 'system/assistant/skills/codex-remote-setup/SKILL.md'))).toBe(true);
});

afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function config(home: string) {
	const result = readStackConfig(home);
	if (!result.ok) throw new Error(result.error);
	return result.config;
}
test('four editions select exact images and skills without changing native remote preferences', async () => {
	for (const edition of ASSISTANT_EDITIONS) {
		const home = mkdtempSync(join(tmpdir(), 'fhold-edition-')); homes.push(home);
		await installHome({ homeDir: home, automaticPorts: false, edition });
		const saved = config(home);
		expect(saved.assistant.edition).toBe(edition);
		expect(stackConfigEnv(saved).FH_ASSISTANT_IMAGE).toBe(assistantImage(edition));
		expect(saved.assistant.claudeRemote).toBe(true);
		expect(saved.assistant.codexRemote).toBe(true);
		for (const [harness, skill] of [['claude', 'claude-code-login'], ['codex', 'codex-remote-setup']]) {
			expect(existsSync(join(home, 'system/assistant/skills', skill!, 'SKILL.md'))).toBe(edition === 'aio' || edition === harness);
		}
		expect(existsSync(join(home, 'system/codex/config.toml'))).toBe(true);
	}
});
test('edition transitions reconcile skills and restart intent while preserving native accounts, off choices and unrelated policies', async () => {
	const home = mkdtempSync(join(tmpdir(), 'fhold-edition-switch-')); homes.push(home);
	await installHome({ homeDir: home, automaticPorts: false });
	const original = config(home); original.assistant.codexRemote = false;
	saveStackIntent(home, original, config(home));
	for (const name of ['.claude', '.codex']) {
		mkdirSync(join(home, 'data/assistant', name), { recursive: true });
		writeFileSync(join(home, 'data/assistant', name, 'account-fixture'), 'private operator fixture');
	}
	const policy = join(home, 'system/codex/config.toml');
	writeFileSync(policy, '# explicit operator policy\n');
	recordAppliedRuntime(home, runtimeRevision(home));
	const slim = structuredClone(original); slim.assistant.edition = 'slim';
	saveStackIntent(home, slim, original);
	expect(restartStatus(home).required).toBe(true);
	expect(config(home).assistant.codexRemote).toBe(false);
	for (const skill of ['claude-code-login', 'codex-remote-setup']) expect(existsSync(join(home, 'system/assistant/skills', skill, 'SKILL.md'))).toBe(false);
	saveStackIntent(home, original, config(home));
	for (const skill of ['claude-code-login', 'codex-remote-setup']) expect(existsSync(join(home, 'system/assistant/skills', skill, 'SKILL.md'))).toBe(true);
	for (const name of ['.claude', '.codex']) expect(readFileSync(join(home, 'data/assistant', name, 'account-fixture'), 'utf8')).toBe('private operator fixture');
	expect(readFileSync(policy, 'utf8')).toBe('# explicit operator policy\n');
	const skill = join(home, 'system/assistant/skills/codex-remote-setup/SKILL.md');
	writeFileSync(skill, 'operator-owned instructions');
	saveStackIntent(home, slim, original);
	expect(readFileSync(skill, 'utf8')).toBe('operator-owned instructions');
});

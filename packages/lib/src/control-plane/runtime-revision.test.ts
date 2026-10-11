import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHome } from './install.js';
import { createFholdState, markInstalled } from './state.js';
import { readStackConfig } from './stack-config.js';
import {
	createCredential,
	rotateCredential,
	savePortalTokens,
	saveStackIntent
} from './operations.js';
import { recordAppliedRuntime, restartStatus, runtimeRevision, upgradedScheduledEngineContents } from './runtime-revision.js';
import { activateComposeCommand, deactivateComposeCommand } from './activation.js';
import { buildComposeOptions } from './compose.js';
import { composeConfigJson } from './docker.js';
import { writeFileAtomic } from './foundation.js';

const roots: string[] = [];
const originalDocker = process.env.FH_DOCKER_BIN;
afterEach(() => {
	if (originalDocker === undefined) delete process.env.FH_DOCKER_BIN;
	else process.env.FH_DOCKER_BIN = originalDocker;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'fhold-runtime-revision-'));
	roots.push(root);
	const home = join(root, 'home');
	await installHome({ homeDir: home, automaticPorts: false });
	return { root, home };
}
function config(home: string) {
	const result = readStackConfig(home);
	if (!result.ok) throw new Error(result.error);
	return result.config;
}

test('status is read-only; a first saved change remains pending across repeated reads and homes', async () => {
	const { home } = await fixture();
	const other = await fixture();
	expect(restartStatus(home)).toEqual({ required: false });
	expect(existsSync(join(home, 'state/applied-runtime.json'))).toBe(false);
	const baseline = config(home);
	const changed = structuredClone(baseline);
	changed.assistant.timezone = 'Europe/London';
	saveStackIntent(home, changed, baseline);
	for (let i = 0; i < 3; i++) expect(restartStatus(home)).toEqual({ required: true });
	expect(restartStatus(other.home)).toEqual({ required: false });
	expect(statSync(join(home, 'state/applied-runtime.json')).mode & 0o777).toBe(0o600);
	saveStackIntent(home, baseline, changed);
	expect(restartStatus(home)).toEqual({ required: false });
});

test('native policy files and enabled portal tokens require apply, but live auth and agent content do not', async () => {
	const { home } = await fixture();
	recordAppliedRuntime(home, runtimeRevision(home));
	const original = config(home);
	saveStackIntent(home, original, original);
	markInstalled(home);
	createCredential(home, { username: 'reader', policy: 'read' });
	rotateCredential(home, 'reader');
	writeFileSync(
		join(home, 'knowledge/secrets/auth.json'),
		'{"test":{"type":"api","key":"not-real"}}'
	);
	writeFileSync(join(home, 'workspace/note.txt'), 'ongoing work');
	savePortalTokens(home, { portal: 'discord', botToken: 'disabled-test-token' });
	expect(restartStatus(home)).toEqual({ required: false });
	writeFileSync(join(home, 'config/codex/config.toml'), 'approval_policy = "on-request"\n');
	expect(restartStatus(home)).toEqual({ required: true });
	recordAppliedRuntime(home, runtimeRevision(home));
	const baseline = config(home);
	const enabled = structuredClone(baseline);
	enabled.gateway.enabled = true;
	enabled.portals.discord.enabled = true;
	enabled.portals.discord.access.users = ['123456789012345678'];
	saveStackIntent(home, enabled, baseline);
	recordAppliedRuntime(home, runtimeRevision(home));
	savePortalTokens(home, { portal: 'discord', botToken: 'replacement-test-token' });
	expect(restartStatus(home)).toEqual({ required: true });
	expect(readFileSync(join(home, 'state/applied-runtime.json'), 'utf8')).not.toContain(
		'test-token'
	);
});

test('native preferences accept ordinary atomic saves without restart; changing the selected filename needs activation', async () => {
	const { home } = await fixture();
	const path = join(home, 'config/assistant/opencode.json');
	recordAppliedRuntime(home, runtimeRevision(home));
	// OpenCode watches the settings directory; both editing styles are supported.
	writeFileSync(path, '{"model":"native/model","provider":{"native":{"models":{"model":{}}}}}\n');
	expect(restartStatus(home)).toEqual({ required: false });
	const contents = readFileSync(path, 'utf8');
	writeFileAtomic(path, contents);
	expect(restartStatus(home)).toEqual({ required: false });
	recordAppliedRuntime(home, runtimeRevision(home));
	writeFileSync(join(home, 'config/assistant/opencode.jsonc'), '// preferred native file\n{}\n');
	expect(restartStatus(home)).toEqual({ required: true });
});

test('a failed apply or stop does not clear pending settings; successful recreation does', async () => {
	const { root, home } = await fixture();
	const state = createFholdState(home);
	const baseline = config(home);
	const changed = structuredClone(baseline);
	changed.assistant.automaticMemory = !baseline.assistant.automaticMemory;
	saveStackIntent(home, changed, baseline);
	const resolved = await composeConfigJson(buildComposeOptions(state));
	if (!resolved.ok) throw new Error(resolved.stderr);
	const binary = join(root, 'docker');
	const mode = join(root, 'mode');
	const calls = join(root, 'up-args');
	writeFileSync(mode, 'fail');
	writeFileSync(
		binary,
		`#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'image') console.log('1');
else if (args[0] === 'compose' && args.includes('config')) console.log(${JSON.stringify(JSON.stringify(resolved.config))});
else if (args[0] === 'compose' && args.includes('up')) {
 writeFileSync(${JSON.stringify(calls)}, JSON.stringify(args));
 const mode = readFileSync(${JSON.stringify(mode)}, 'utf8');
 if (mode === 'fail') process.exit(1);
 const akmPath = ${JSON.stringify(join(home, 'config/akm/config.json'))};
 const akm = JSON.parse(readFileSync(akmPath, 'utf8'));
 if (mode === 'akm-edit') akm.engines.scheduled.timeoutMs += 1;
 if (mode !== 'old') { akm.engines.scheduled.args[1] = '--server'; writeFileSync(akmPath, JSON.stringify(akm, null, 2) + '\\n'); }
 if (mode === 'edit') writeFileSync(${JSON.stringify(join(home, 'config/codex/config.toml'))}, 'approval_policy = "on-request"\\n');
}
`,
		{ mode: 0o700 }
	);
	process.env.FH_DOCKER_BIN = binary;
	await expect(activateComposeCommand(state, ['up', '-d', '--wait'])).rejects.toThrow();
	expect(restartStatus(home).required).toBe(true);
	await deactivateComposeCommand(state);
	expect(restartStatus(home).required).toBe(true);
	writeFileSync(mode, 'pass');
	const akmPath = join(home, 'config/akm/config.json');
	const oldAkm = JSON.parse(readFileSync(akmPath, 'utf8'));
	oldAkm.engines.scheduled.args[1] = '--attach';
	oldAkm.scheduler.enabled = ['operator-task'];
	writeFileSync(akmPath, JSON.stringify(oldAkm));
	// A newer control plane must not rewrite a still-pinned v1 engine.
	writeFileSync(mode, 'old');
	await activateComposeCommand(state, ['up', '-d', '--wait']);
	expect(JSON.parse(readFileSync(calls, 'utf8'))).toContain('--force-recreate');
	expect(JSON.parse(readFileSync(akmPath, 'utf8'))).toEqual(oldAkm);
	expect(restartStatus(home)).toEqual({ required: false });
	writeFileSync(mode, 'pass');
	await activateComposeCommand(state, ['up', '-d', '--wait']);
	oldAkm.engines.scheduled.args[1] = '--server';
	expect(JSON.parse(readFileSync(akmPath, 'utf8'))).toEqual(oldAkm);
	expect(JSON.parse(readFileSync(calls, 'utf8'))).toContain('--wait');
	expect(restartStatus(home)).toEqual({ required: false });
	// An unsuccessful restart of unchanged settings still needs a successful retry.
	writeFileSync(mode, 'fail');
	await expect(
		activateComposeCommand(state, ['up', '-d', '--force-recreate', '--wait'])
	).rejects.toThrow();
	expect(restartStatus(home).required).toBe(true);
	writeFileSync(mode, 'pass');
	oldAkm.engines.scheduled.args[1] = '--attach';
	writeFileSync(akmPath, JSON.stringify(oldAkm));
	const revision = await activateComposeCommand(state, ['up', '-d', '--force-recreate', '--wait'], {
		deferAppliedReceipt: true
	});
	expect(restartStatus(home).required).toBe(true);
	recordAppliedRuntime(home, revision);
	expect(restartStatus(home)).toEqual({ required: false });
	oldAkm.engines.scheduled.args[1] = '--attach';
	writeFileSync(akmPath, JSON.stringify(oldAkm));
	writeFileSync(mode, 'akm-edit');
	await activateComposeCommand(state, ['up', '-d', '--force-recreate', '--wait']);
	expect(restartStatus(home).required).toBe(true);
	writeFileSync(mode, 'edit');
	oldAkm.engines.scheduled.args[1] = '--attach';
	writeFileSync(akmPath, JSON.stringify(oldAkm));
	await activateComposeCommand(state, ['up', '-d', '--force-recreate', '--wait']);
	expect(restartStatus(home).required).toBe(true);
});

test('fingerprints preserve old native pins, custom engines and malformed optional settings without writes', async () => {
	const { home } = await fixture();
	const path = join(home, 'config/akm/config.json');
	const custom = JSON.parse(readFileSync(path, 'utf8'));
	const baseline = runtimeRevision(home);
	custom.engines.scheduled.args[1] = '--attach';
	const previous = JSON.stringify(custom);
	writeFileSync(path, previous);
	expect(runtimeRevision(home)).not.toBe(baseline);
	const expected = structuredClone(custom);
	expected.engines.scheduled.args[1] = '--server';
	expect(upgradedScheduledEngineContents(home)).toEqual(Buffer.from(`${JSON.stringify(expected, null, 2)}\n`));
	expect(readFileSync(path, 'utf8')).toBe(previous);
	custom.engines.scheduled.args = ['run', '--attach', 'http://custom:4096', '--agent', 'scheduled'];
	const original = JSON.stringify(custom);
	writeFileSync(path, original);
	expect(runtimeRevision(home)).not.toBe(baseline);
	expect(upgradedScheduledEngineContents(home)).toBeUndefined();
	expect(readFileSync(path, 'utf8')).toBe(original);
	writeFileSync(path, '{invalid optional scheduler config');
	expect(() => runtimeRevision(home)).not.toThrow();
	expect(upgradedScheduledEngineContents(home)).toBeUndefined();
	expect(readFileSync(path, 'utf8')).toBe('{invalid optional scheduler config');
});

test('existing raw server receipts remain applied without normalization or inspection writes', async () => {
	const { home } = await fixture();
	const path = join(home, 'config/akm/config.json');
	const original = readFileSync(path);
	recordAppliedRuntime(home, runtimeRevision(home));
	expect(upgradedScheduledEngineContents(home)).toBeUndefined();
	expect(restartStatus(home)).toEqual({ required: false });
	expect(readFileSync(path)).toEqual(original);
});

test('invalid restart evidence is not silently treated as applied', async () => {
	const { home } = await fixture();
	writeFileSync(join(home, 'state/applied-runtime.json'), '{bad');
	expect(restartStatus(home).required).toBe(true);
	expect(restartStatus(home).error).toContain('could not be verified');
	// Invalid derived evidence must not prevent live credential revocation/rotation.
	createCredential(home, { username: 'reader', policy: 'read' });
	expect(restartStatus(home).required).toBe(true);
});

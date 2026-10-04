import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateComposeCommand } from './activation.js';
import { buildComposeOptions } from './compose.js';
import { composeConfigJson } from './docker.js';
import { createFholdState } from './foundation.js';
import { installHome } from './install.js';
import { defaultStackConfig, readStackConfig, writeStackConfig } from './stack-config.js';
import { updateHome } from './update.js';

const roots: string[] = [];
const originalDocker = process.env.FH_DOCKER_BIN;
afterEach(() => {
	if (originalDocker === undefined) delete process.env.FH_DOCKER_BIN; else process.env.FH_DOCKER_BIN = originalDocker;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(namespace = 'fhold', managedPolicy = true, imagePresent = true) {
	const root = mkdtempSync(join(tmpdir(), 'fhold-image-provenance-')); roots.push(root);
	const home = join(root, 'home'); await installHome({ homeDir: home });
	const read = readStackConfig(home); if (!read.ok) throw new Error(read.error);
	read.config.deployment.imageNamespace = namespace; writeStackConfig(home, read.config);
	const state = createFholdState(home);
	const resolved = await composeConfigJson(buildComposeOptions(state)); if (!resolved.ok) throw new Error(resolved.stderr);
	const callsPath = join(root, 'calls.jsonl');
	const docker = join(root, 'docker');
	const imageReference = `${namespace}/fhold-assistant:${read.config.deployment.images.assistant}`;
	const imageId = `sha256:${'a'.repeat(64)}`;
	writeFileSync(docker, `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');
if (args.includes('pull') && !args.includes('up')) writeFileSync(${JSON.stringify(join(root, 'pulled'))}, 'pulled');
if (args.includes('config') && args.includes('--format')) console.log(${JSON.stringify(JSON.stringify(resolved.config))});
if (args.includes('ps') && args.includes('-q')) console.log('fixture-container');
if (args[0] === 'image' && args[1] === 'inspect') {
  if (!${imagePresent} && !existsSync(${JSON.stringify(join(root, 'pulled'))})) process.exit(1);
  console.log(args.some(arg => arg.includes('managed-harness-policy')) ? ${JSON.stringify(managedPolicy ? '1' : '<no value>')} : ${JSON.stringify(imageId)});
}
if (args[0] === 'inspect') console.log(${JSON.stringify(JSON.stringify({ Id: 'fixture-container', Image: imageId, Config: { Image: imageReference, Labels: { 'com.docker.compose.project': read.config.deployment.projectName, 'com.docker.compose.service': 'assistant' } } }))});
`);
	chmodSync(docker, 0o700); process.env.FH_DOCKER_BIN = docker;
	const calls = () => existsSync(callsPath) ? readFileSync(callsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]) : [];
	return { home, state, calls };
}

test('an older pinned image cannot activate managed-only policy or change a running stack during update', async () => {
	const { home, state, calls } = await fixture('fhold', false);
	const managed = join(home, 'system/assistant/AGENTS.md');
	writeFileSync(managed, 'prior release sentinel');
	const config = readFileSync(join(home, 'state/stack.json'));
	await expect(updateHome({ homeDir: home, start: true })).rejects.toThrow('does not support managed harness policy');
	expect(readFileSync(managed, 'utf8')).toBe('prior release sentinel');
	expect(readFileSync(join(home, 'state/stack.json'))).toEqual(config);
	expect(existsSync(join(home, 'state/update-receipts'))).toBe(false);
	await expect(activateComposeCommand(state, ['up', '-d'])).rejects.toThrow('does not support managed harness policy');
	expect(calls().some(args => args.includes('up') || args.includes('pull'))).toBe(false);
});

test('fresh registry activation pulls a missing image before policy inspection', async () => {
	const { state, calls } = await fixture('registry.example.test/fhold', true, false);
	await activateComposeCommand(state, ['up', '-d']);
	const pull = calls().findIndex(args => args.includes('pull'));
	const up = calls().findIndex(args => args.includes('up'));
	expect(pull).toBeGreaterThanOrEqual(0);
	expect(up).toBeGreaterThan(pull);
	expect(calls()[pull]?.slice(-2)).toEqual(['pull', 'assistant']);
});

test.each(['fhold', 'registry.example.test/fhold'])('a missing %s image with no-pull never triggers an implicit registry fetch', async (namespace) => {
		const { state, calls } = await fixture(namespace, true, false);
		await expect(activateComposeCommand(state, ['up', '-d', '--pull', 'never'])).rejects.toThrow('Pull or build');
		expect(calls().some(args => args.includes('pull') || args.includes('up'))).toBe(false);
});

test('an omitted pull never contacts a registry for the exact local fhold namespace', async () => {
	const { home, calls } = await fixture();
	await updateHome({ homeDir: home, start: true });
	expect(calls().some((args) => args.includes('pull') && !args.includes('up'))).toBe(false);
	const up = calls().find((args) => args.includes('up')); expect(up).toContain('--pull');
	expect(up?.[up.indexOf('--pull') + 1]).toBe('never');
});

test('an explicit local pull fails before Docker calls or managed file/checkpoint changes', async () => {
	const { home, calls } = await fixture();
	const managed = join(home, 'system/assistant/AGENTS.md'); writeFileSync(managed, 'reviewed local sentinel');
	const config = readFileSync(join(home, 'state/stack.json'));
	await expect(updateHome({ homeDir: home, start: true, pull: true })).rejects.toThrow('Build the reviewed images locally');
	expect(calls()).toEqual([]);
	expect(readFileSync(managed, 'utf8')).toBe('reviewed local sentinel');
	expect(readFileSync(join(home, 'state/stack.json'))).toEqual(config);
	expect(existsSync(join(home, 'state/update-receipts'))).toBe(false);
});

test('local activation preserves supplied build flags/arrays and forbids every conflicting pull flag', async () => {
	const { state, calls } = await fixture();
	const supplied = ['up', '-d', '--build'];
	await activateComposeCommand(state, supplied);
	expect(supplied).toEqual(['up', '-d', '--build']);
	const up = calls().find((args) => args.includes('up')); expect(up).toContain('--build');
	expect(up?.slice(-2)).toEqual(['--pull', 'never']);
	const before = calls().length;
	for (const flags of [['--pull', 'always'], ['--pull=missing'], ['--pull', 'never', '--pull=always']]) {
		await expect(activateComposeCommand(state, ['up', ...flags])).rejects.toThrow('activation requires --pull never');
	}
	expect(calls()).toHaveLength(before);
});

test('explicit registry namespaces retain default, explicit-pull and no-pull update behavior', async () => {
	const { home, state, calls } = await fixture('registry.example.test/reviewed-fhold');
	await updateHome({ homeDir: home, start: true });
	await updateHome({ homeDir: home, start: true, pull: true });
	await updateHome({ homeDir: home, start: true, pull: false });
	expect(calls().filter((args) => args.includes('pull') && !args.includes('up'))).toHaveLength(2);
	const before = calls().length;
	await activateComposeCommand(state, ['up', '-d', '--pull', 'missing']);
	expect(calls().slice(before).find((args) => args.includes('up'))?.slice(-2)).toEqual(['--pull', 'missing']);
});

test('fresh installs select the public images and updates pull the pinned release by default', async () => {
	const namespace = defaultStackConfig('/tmp/fhold-public-default').deployment.imageNamespace;
	expect(namespace).toBe('fwdslsh');
	const { home, state, calls } = await fixture(namespace);
	const resolved = await composeConfigJson(buildComposeOptions(state));
	if (!resolved.ok) throw new Error(resolved.stderr);
	const config = readStackConfig(home);
	if (!config.ok) throw new Error(config.error);
	expect(resolved.config.services.assistant.image).toBe(`fwdslsh/fhold-assistant:${config.config.deployment.images.assistant}`);
	await updateHome({ homeDir: home, start: true });
	expect(calls().filter((args) => args.includes('pull') && !args.includes('up'))).toHaveLength(1);
});

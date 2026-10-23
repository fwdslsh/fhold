import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remoteBrowserUrls, remoteTool, beginRemoteEnable } from './remote.js';
import { createFholdState } from './foundation.js';
import { changeCodexRecall } from './codex-recall.js';
import { defaultStackConfig, readStackConfig, writeStackConfig } from './stack-config.js';

const roots: string[] = [];
const originalDocker = process.env.FH_DOCKER_BIN;
afterEach(() => {
	if (originalDocker === undefined) delete process.env.FH_DOCKER_BIN;
	else process.env.FH_DOCKER_BIN = originalDocker;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function installedHome(): string {
	const root = mkdtempSync(join(tmpdir(), 'fhold-remote-'));
	roots.push(root);
	mkdirSync(join(root, 'system/stack'), { recursive: true });
	mkdirSync(join(root, 'state'), { recursive: true });
	writeFileSync(join(root, 'system/stack/stack.compose.yml'), 'services: {}\n');
	writeFileSync(join(root, 'state/stack.env'), 'FH_SETUP_COMPLETE=true\n');
	const config = defaultStackConfig();
	config.assistant.codexRemote = true;
	config.assistant.codexSandbox = 'read-only';
	writeStackConfig(root, config);
	return root;
}

describe('native remote setup boundaries', () => {
	it('opens only complete vendor sign-in and pairing URLs, not arbitrary native output', () => {
		expect(remoteBrowserUrls('https://claude.com/cai/oauth/authorize?state=private\n')).toEqual([
			'https://claude.com/cai/oauth/authorize?state=private'
		]);
		expect(remoteBrowserUrls('Go https://auth.openai.com/codex/device\n')).toEqual([
			'https://auth.openai.com/codex/device'
		]);
		expect(
			remoteBrowserUrls('Go https://claude.ai/oauth/authorize?state=private&code=token\n')
		).toEqual(['https://claude.ai/oauth/authorize?state=private&code=token']);
		expect(remoteBrowserUrls('https://claude.ai/code/session-test\n')).toEqual([
			'https://claude.ai/code/session-test'
		]);
		for (const url of [
			'https://attacker.test/oauth/authorize',
			'https://claude.ai.attacker.test/code/foo',
			'https://user@claude.ai/code/foo',
			'https://claude.ai:8443/code/foo',
			'http://claude.ai/code/foo',
			'file:///tmp/foo',
			'https://claude.ai/settings'
		]) {
			expect(remoteBrowserUrls(`${url}\n`)).toEqual([]);
		}
		expect(remoteBrowserUrls('https://auth.openai.com/codex/device?state=incomplete')).toEqual([]);
		expect(remoteBrowserUrls('https://auth.openai.com/codex/device')).toEqual([]);
	});
	it('rejects untrusted enable and invalid tools before touching an installation', async () => {
		await expect(
			changeCodexRecall(createFholdState(), 'approve', 'a'.repeat(64), false)
		).rejects.toThrow('explicitly confirm');
		await expect(changeCodexRecall(createFholdState(), 'approve', 'invalid', true)).rejects.toThrow(
			'explicitly confirm'
		);
		expect(() => remoteTool('claude; echo pwn')).toThrow();
		await expect(
			beginRemoteEnable(createFholdState(), 'claude', { trusted: false })
		).rejects.toThrow('Confirm trusted');
		await expect(
			beginRemoteEnable(createFholdState(), 'codex', {
				trusted: false,
				sandbox: 'danger-full-access'
			})
		).rejects.toThrow('Confirm trusted');
		await expect(
			beginRemoteEnable(createFholdState(), 'codex', {
				trusted: true,
				sandbox: 'yolo' as never
			})
		).rejects.toThrow('container isolation');
	});

	it('cancelling a native setup only closes its temporary process and preserves prior worker intent', async () => {
		const root = installedHome();
		const docker = join(root, 'synthetic-docker');
		writeFileSync(
			docker,
			'#!/bin/sh\ncase " $* " in *" ps "*) printf \'{"Service":"assistant","State":"running","ID":"original-assistant"}\\n\'; exit 0;; esac\nprintf \'{"stage":"sign-in"}\\n\'\nread ignored\nexit 1\n'
		);
		chmodSync(docker, 0o700);
		process.env.FH_DOCKER_BIN = docker;
		const session = await beginRemoteEnable(createFholdState(root), 'codex', {
			trusted: true,
			sandbox: 'danger-full-access'
		});
		expect(session.snapshot()).toMatchObject({ enabled: true, running: true });
		session.cancel();
		const result = await session.done;
		expect(result).toMatchObject({ running: false, enabled: true, stage: 'failed' });
		const config = readStackConfig(root);
		expect(config.ok && config.config.assistant).toMatchObject({
			codexRemote: true,
			codexSandbox: 'read-only'
		});
		expect(readFileSync(join(root, 'state/stack.json'), 'utf8')).not.toContain(
			'danger-full-access'
		);
	});

	it('does not apply startup intent to a replacement container after sign-in completed elsewhere', async () => {
		const root = installedHome();
		const before = readFileSync(join(root, 'state/stack.json'), 'utf8');
		const docker = join(root, 'synthetic-docker');
		const replaced = join(root, 'replaced');
		const calls = join(root, 'docker-calls');
		writeFileSync(
			docker,
			`#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
case " $* " in
  *" ps "*)
    id=original-assistant
    if test -f '${replaced}'; then id=replacement-assistant; fi
    printf '{"Service":"assistant","State":"running","ID":"%s"}\\n' "$id"
    exit 0;;
esac
touch '${replaced}'
printf '{"ready":true}\\n'
`
		);
		chmodSync(docker, 0o700);
		process.env.FH_DOCKER_BIN = docker;
		const session = await beginRemoteEnable(createFholdState(root), 'codex', {
			trusted: true,
			sandbox: 'danger-full-access'
		});
		const result = await session.done;
		expect(result.error).toContain('replaced during native sign-in');
		expect(readFileSync(join(root, 'state/stack.json'), 'utf8')).toBe(before);
		const commands = readFileSync(calls, 'utf8');
		expect(commands).toContain(
			'exec --interactive --workdir /work original-assistant fhold-remote-setup'
		);
		expect(commands).not.toContain(' up ');
	});
});

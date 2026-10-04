import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(import.meta.dir, '../packages/skeleton/system/assistant/skills/codex-remote-setup/scripts/setup.sh');
// Test the shipped scripts against the existing native prompt bridge.
const recipes = [
	`bash ${JSON.stringify(script)} start`,
	`bash ${JSON.stringify(script)} progress SESSION_DIR`,
	`bash ${JSON.stringify(script)} verify SESSION_DIR`,
	'fhold-codex-recall.mjs review',
	'fhold-codex-recall.mjs approve REVIEWED_DIGEST',
	`bash ${JSON.stringify(script)} pair`,
	`bash ${JSON.stringify(script)} clean SESSION_DIR`
];
const attempts: Array<{ dir: string; env: NodeJS.ProcessEnv }> = [];

async function shell(source: string, env: NodeJS.ProcessEnv, dir?: string) {
	const child = Bun.spawn(['bash', '-c', source.replaceAll('SESSION_DIR', dir ?? 'SESSION_DIR')], {
		env,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text()
	]);
	return { code, stdout, stderr };
}

async function until(check: () => boolean) {
	const deadline = Date.now() + 7000;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error('Codex setup fixture did not reach its expected state');
		await Bun.sleep(20);
	}
}

function fixture(mode = 'waiting', sandbox?: string) {
	const root = mkdtempSync(join(tmpdir(), 'fhold-codex-skill-test-'));
	const helper = join(import.meta.dir, '../containers/assistant/fhold-remote-setup.mjs');
	writeFileSync(
		join(root, 'fhold-remote-setup'),
		`#!${process.execPath} --no-env-file --config=/dev/null
import {guidedSetup} from ${JSON.stringify(helper)};
try { await guidedSetup(process.argv[2], process.argv[3], {workdir:process.env.HOME}); }
catch (error) { console.log(JSON.stringify({error:error.message})); process.exitCode=1; }
`,
		{ mode: 0o700 }
	);
	writeFileSync(
		join(root, 'codex'),
		`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const file = name => path.join(process.env.HOME, name);
const args = process.argv.slice(2);
fs.appendFileSync(file('commands'), JSON.stringify(args)+'\\n');
if (process.env.OPENAI_API_KEY || process.env.FH_RECOVERY_URL) process.exit(67);
if (args.includes('sandbox')) process.exit(process.env.CODEX_TEST_MODE==='sandbox-failure' ? 1 : 0);
if (args.join(' ')==='login status') {
 if (process.env.CODEX_TEST_MODE==='api-key') {console.log('Logged in with an API key: fixture-secret'); process.exit(0);}
 if (fs.existsSync(file('native-account'))) {console.log('Logged in using ChatGPT'); process.exit(0);}
 console.log('Not logged in'); process.exit(1);
}
if (args.join(' ')==='login --device-auth') {
 if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(68);
 fs.writeFileSync(file('login-started'),'1');
 if (process.env.CODEX_TEST_MODE==='api-key') process.exit(0);
 console.log('Open https://auth.openai.com/codex/device and enter fixture-device-code');
 process.on('SIGTERM',()=>{fs.writeFileSync(file('native-stopped'),'1'); process.exit(143);});
 setInterval(()=>{
  if (fs.existsSync(file('browser-approved'))) { fs.writeFileSync(file('native-account'),'account preserved'); process.exit(0); }
 },20);
 return;
}
process.exit(69);
`,
		{ mode: 0o700 }
	);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: root,
		PATH: `${root}:${process.env.PATH}`,
		CODEX_TEST_MODE: mode,
		OPENAI_API_KEY: 'fixture-secret',
		FH_RECOVERY_URL: 'file:///private-fixture'
	};
	delete env.FH_CODEX_SANDBOX;
	if (sandbox !== undefined) env.FH_CODEX_SANDBOX = sandbox;
	return { root, env };
}

async function start(options: { mode?: string; sandbox?: string; lifetime?: string } = {}) {
	const value = fixture(options.mode, options.sandbox);
	const result = await shell(`${recipes[0]} ${options.lifetime === '1s' ? '1' : '900'}`, value.env);
	if (result.code !== 0) throw new Error(`Skill setup failed: ${JSON.stringify(result)}`);
	const dir = result.stdout.trim();
	expect(dir).toMatch(/^\/tmp\/fhold-codex-setup\.[A-Za-z0-9]+$/);
	attempts.push({ dir, env: value.env });
	await until(() => existsSync(join(dir, 'pid')) && existsSync(join(dir, 'output.log')));
	return { ...value, dir };
}

afterEach(async () => {
	for (const { dir, env } of attempts.splice(0)) {
		if (!existsSync(dir)) continue;
		await shell(recipes[6], env, dir);
		await until(() => !existsSync(dir) || existsSync(join(dir, 'exit')));
		if (existsSync(dir)) expect((await shell(recipes[6], env, dir)).code).toBe(0);
	}
});

describe('image-baked Codex remote setup skill', () => {
	it('keeps the existing native PTY setup alive across calls and waits for browser device approval', async () => {
		expect(recipes).toHaveLength(7);
		const { dir, env, root } = await start();
		await until(() => existsSync(join(root, 'login-started')));
		await until(() => readFileSync(join(dir, 'output.log'), 'utf8').includes('fixture-device-code'));
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		for (const name of ['pid', 'input', 'output.log'])
			expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, 'input')).isFIFO()).toBe(true);
		const progress = await shell(recipes[1], env, dir);
		expect(progress.stdout).toContain('https://auth.openai.com/codex/device');
		expect(progress.stdout).toContain('fixture-device-code');
		expect((await shell(recipes[2], env, dir)).code).not.toBe(0);
		writeFileSync(join(root, 'browser-approved'), '1');
		await until(() => existsSync(join(dir, 'exit')));
		// Verification must use the native environment, not an ambient API key.
		const nativeEnv = { ...env };
		delete nativeEnv.OPENAI_API_KEY;
		delete nativeEnv.FH_RECOVERY_URL;
		expect((await shell(recipes[2], nativeEnv, dir)).code).toBe(0);
		const commands = readFileSync(join(root, 'commands'), 'utf8');
		expect(commands).toContain('sandbox_mode=\\"workspace-write\\"');
		expect(commands.match(/--device-auth/g)).toHaveLength(1);
		expect(commands).not.toMatch(/remote-control|app-server|logout|bypass/);
		expect((await shell(recipes[6], env, dir)).code).toBe(0);
		expect(readFileSync(join(root, 'native-account'), 'utf8')).toBe('account preserved');
	});

	it('reuses existing ChatGPT sign-in and preserves explicit container isolation', async () => {
		const value = fixture('waiting', 'danger-full-access');
		writeFileSync(join(value.root, 'native-account'), 'previous account bytes');
		const result = await shell(recipes[0], value.env);
		const dir = result.stdout.trim();
		attempts.push({ dir, env: value.env });
		await until(() => existsSync(join(dir, 'exit')));
		expect(readFileSync(join(dir, 'exit'), 'utf8').trim()).toBe('0');
		const commands = readFileSync(join(value.root, 'commands'), 'utf8');
		expect(commands).not.toMatch(/--device-auth|sandbox/);
		expect(readFileSync(join(value.root, 'native-account'), 'utf8')).toBe('previous account bytes');
		expect((await shell(recipes[1], value.env, dir)).stdout).toContain('startup and pairing still need verification');
	});

	it('refuses a failed sandbox before login, without switching isolation modes', async () => {
		const { dir, env, root } = await start({ mode: 'sandbox-failure' });
		await until(() => existsSync(join(dir, 'exit')));
		expect(readFileSync(join(dir, 'exit'), 'utf8').trim()).toBe('1');
		expect(existsSync(join(root, 'login-started'))).toBe(false);
		const progress = await shell(recipes[1], env, dir);
		expect(progress.stderr).toContain('sandbox check failed');
		expect((await shell(recipes[2], env, dir)).code).not.toBe(0);
	});

	it('rejects unsupported sandbox input before creating an attempt', async () => {
		const { env } = fixture('waiting', 'yolo');
		const result = await shell(recipes[0], env);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('Invalid configured Codex sandbox');
	});

	it('rejects API-key-only accounts without exposing account output as device instructions', async () => {
		const { dir, env } = await start({ mode: 'api-key', sandbox: 'danger-full-access' });
		await until(() => existsSync(join(dir, 'exit')));
		const progress = await shell(recipes[1], env, dir);
		expect(progress.stdout).not.toContain('fixture-secret');
		expect(progress.stderr).toContain('requires ChatGPT account sign-in');
		expect((await shell(recipes[2], env, dir)).code).not.toBe(0);
	});

	it('verification refuses API-key status even if a stale scratch exit says success', async () => {
		const { dir, env } = await start({ mode: 'api-key', sandbox: 'danger-full-access' });
		await until(() => existsSync(join(dir, 'exit')));
		writeFileSync(join(dir, 'exit'), '0');
		const statusEnv = { ...env };
		delete statusEnv.FH_RECOVERY_URL;
		const result = await shell(recipes[2], statusEnv, dir);
		expect(result.code).not.toBe(0);
		expect(result.stdout).not.toContain('fixture-secret');
	});

	it('expires abandoned device login and cancels only its own attempt', async () => {
		const first = await start({ lifetime: '1s' });
		await until(() => existsSync(join(first.root, 'login-started')));
		const second = await start();
		await until(() => existsSync(join(second.root, 'login-started')));
		await until(() => existsSync(join(first.dir, 'exit')));
		expect(readFileSync(join(first.dir, 'exit'), 'utf8').trim()).toBe('124');
		expect(existsSync(join(first.root, 'native-stopped'))).toBe(true);
		await shell(recipes[6], second.env, second.dir);
		await until(() => existsSync(join(second.root, 'native-stopped')));
		expect(existsSync(join(second.root, 'native-account'))).toBe(false);
		expect((await shell(recipes[2], first.env, first.dir)).code).not.toBe(0);
	}, 15000);
});

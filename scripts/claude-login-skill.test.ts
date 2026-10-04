import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(import.meta.dir, '../packages/skeleton/system/assistant/skills/claude-code-login/scripts/login.sh');
// Invoke the shipped scripts; prose/code-block layout is not the implementation.
const recipes = [
	`bash ${JSON.stringify(script)} start`,
	`bash ${JSON.stringify(script)} link SESSION_DIR`,
	`bash ${JSON.stringify(script)} submit SESSION_DIR <<'CALLBACK'\nPASTE_FULL_CODE#STATE\nCALLBACK`,
	`bash ${JSON.stringify(script)} verify SESSION_DIR`,
	`bash ${JSON.stringify(script)} clean SESSION_DIR`
];
const attempts: Array<{ dir: string; env: NodeJS.ProcessEnv }> = [];

async function shell(source: string, env: NodeJS.ProcessEnv, dir?: string, callback?: string) {
	const child = Bun.spawn(
		[
			'bash',
			'-c',
			source
				.replaceAll('SESSION_DIR', dir ?? 'SESSION_DIR')
				.replace('PASTE_FULL_CODE#STATE', callback ?? 'PASTE_FULL_CODE#STATE')
		],
		{
			env,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe'
		}
	);
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text()
	]);
	return { code, stdout, stderr };
}

async function until(check: () => boolean) {
	const deadline = Date.now() + 5000;
	while (!check()) {
		if (Date.now() >= deadline)
			throw new Error('Native login fixture did not reach its expected state');
		await Bun.sleep(20);
	}
}

async function start(mode = 'success', lifetime = '15m') {
	const root = mkdtempSync(join(tmpdir(), 'fhold-login-skill-test-'));
	writeFileSync(
		join(root, 'claude'),
		`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.HOME;
const file = name => path.join(root, name);
if (process.argv.slice(2).join(' ') === 'auth status') {
 const loggedIn = fs.existsSync(file('native-auth.json'));
 process.stdout.write(JSON.stringify({loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none', email:'private@example.test', token:'do-not-print'}) + '\\n',
  () => process.exit(loggedIn ? 0 : 1));
 return;
}
if (process.argv.slice(2).join(' ') !== 'auth login --claudeai') process.exit(65);
const state = require('node:crypto').randomBytes(16).toString('hex');
fs.writeFileSync(file('expected-callback'), 'fixture-code#' + state);
console.log('https://claude.ai/oauth/authorize?code_challenge=' + state);
const reader = require('node:readline').createInterface({input:process.stdin});
reader.once('line', line => {
 fs.writeFileSync(file('input-count'), '1');
 if (process.env.LOGIN_TEST_MODE === 'success' && line === 'fixture-code#' + state) {
  fs.writeFileSync(file('native-auth.json'), '{}');
  console.log('Signed in'); process.exit(0);
 }
 console.log('Invalid code'); process.exit(1);
});
reader.on('close', () => { fs.writeFileSync(file('unexpected-eof'), '1'); process.exit(66); });
process.on('SIGTERM', () => { fs.writeFileSync(file('native-stopped'), '1'); process.exit(143); });
`,
		{ mode: 0o700 }
	);
	chmodSync(join(root, 'claude'), 0o700);
	const env = {
		...process.env,
		HOME: root,
		PATH: `${root}:${process.env.PATH}`,
		LOGIN_TEST_MODE: mode
	};
	const result = await shell(`${recipes[0]} ${lifetime === '15m' ? '900' : '1'}`, env);
	expect(result.code).toBe(0);
	const dir = result.stdout.trim();
	expect(dir).toMatch(/^\/tmp\/fhold-claude-login\.[A-Za-z0-9]+$/);
	attempts.push({ dir, env });
	await until(
		() =>
			existsSync(join(root, 'expected-callback')) &&
			readFileSync(join(dir, 'output.log'), 'utf8').includes('https://claude.ai/oauth/authorize')
	);
	return { dir, env, root, callback: readFileSync(join(root, 'expected-callback'), 'utf8') };
}

afterEach(async () => {
	for (const { dir, env } of attempts.splice(0)) {
		if (!existsSync(dir)) continue;
		await shell(recipes[4], env, dir);
		await until(() => !existsSync(dir) || existsSync(join(dir, 'exit')));
		if (existsSync(dir)) expect((await shell(recipes[4], env, dir)).code).toBe(0);
	}
});

describe('image-baked Claude Code login skill recipes', () => {
	it('keeps one private native process reachable across separate completed tool calls', async () => {
		expect(recipes).toHaveLength(5);
		const { dir, env, root, callback } = await start();
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		for (const file of ['input', 'output.log', 'pid'])
			expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, 'input')).isFIFO()).toBe(true);
		const link = await shell(recipes[1], env, dir);
		expect(link.code).toBe(0);
		expect(link.stdout).toContain('https://claude.ai/oauth/authorize?code_challenge=');
		expect((await shell(recipes[3], env, dir)).stdout).toContain('still waiting');
		expect(existsSync(join(root, 'unexpected-eof'))).toBe(false);
		const submitted = await shell(recipes[2], env, dir, callback);
		expect(submitted).toEqual({ code: 0, stdout: '', stderr: '' });
		await until(() => existsSync(join(dir, 'exit')));
		const verified = await shell(recipes[3], env, dir);
		expect(verified.code).toBe(0);
		if (!verified.stdout)
			throw new Error(`Empty native fixture status: ${JSON.stringify(verified)}; fixture ${root}`);
		expect(JSON.parse(verified.stdout)).toEqual({ loggedIn: true, authMethod: 'claude.ai' });
		expect(readFileSync(join(root, 'input-count'), 'utf8')).toBe('1');
		expect(readFileSync(join(dir, 'output.log'), 'utf8')).not.toContain(callback);
		expect((await shell(recipes[2], env, dir, callback)).code).not.toBe(0);
		expect((await shell(recipes[4], env, dir)).code).toBe(0);
		expect(existsSync(dir)).toBe(false);
		expect(existsSync(join(root, 'native-auth.json'))).toBe(true);
		const reused = await shell(recipes[0], env);
		expect(reused.code).toBe(0);
		expect(JSON.parse(reused.stdout)).toEqual({ signedIn: true, note: 'Existing Claude subscription sign-in preserved.' });
		expect(reused.stdout).not.toContain('private@example.test');
		expect(reused.stdout).not.toContain('do-not-print');
	});

	it('rejects a bare code without sending a probe or burning the native attempt', async () => {
		const { dir, env, root, callback } = await start();
		const refused = await shell(recipes[2], env, dir, callback.split('#')[0]);
		expect(refused.code).not.toBe(0);
		expect(refused.stderr).toContain('full code#state');
		expect(existsSync(join(root, 'input-count'))).toBe(false);
		expect(existsSync(join(dir, 'submitted'))).toBe(false);
		expect((await shell(recipes[2], env, dir, callback)).code).toBe(0);
		await until(() => existsSync(join(dir, 'exit')));
		expect((await shell(recipes[3], env, dir)).code).toBe(0);
	});

	it('does not report success after a failed exchange or reuse another process callback', async () => {
		const first = await start();
		const second = await start();
		expect(first.dir).not.toBe(second.dir);
		expect((await shell(recipes[2], second.env, second.dir, first.callback)).code).toBe(0);
		await until(() => existsSync(join(second.dir, 'exit')));
		expect((await shell(recipes[3], second.env, second.dir)).code).not.toBe(0);
		expect(existsSync(join(second.root, 'native-auth.json'))).toBe(false);
		expect((await shell(recipes[2], second.env, second.dir, second.callback)).code).not.toBe(0);
		expect((await shell(recipes[2], first.env, first.dir, first.callback)).code).toBe(0);
		await until(() => existsSync(join(first.dir, 'exit')));
		expect((await shell(recipes[3], first.env, first.dir)).code).toBe(0);
	});

	it('expires an abandoned login and cleans it without touching native credentials', async () => {
		const { dir, env, root, callback } = await start('waiting', '1s');
		await until(() => existsSync(join(dir, 'exit')));
		expect(readFileSync(join(dir, 'exit'), 'utf8').trim()).toBe('124');
		expect(existsSync(join(root, 'native-stopped'))).toBe(true);
		expect((await shell(recipes[2], env, dir, callback)).code).not.toBe(0);
		expect((await shell(recipes[3], env, dir)).code).not.toBe(0);
		writeFileSync(join(root, 'native-auth.json'), 'existing account preserved');
		expect((await shell(recipes[4], env, dir)).code).toBe(0);
		expect(readFileSync(join(root, 'native-auth.json'), 'utf8')).toBe('existing account preserved');
	});

	it('cancels only its own attempt, leaving another login usable', async () => {
		const first = await start();
		const second = await start();
		await shell(recipes[4], first.env, first.dir);
		await until(() => existsSync(join(first.root, 'native-stopped')));
		await until(() => !existsSync(first.dir) || existsSync(join(first.dir, 'exit')));
		if (existsSync(first.dir)) expect((await shell(recipes[4], first.env, first.dir)).code).toBe(0);
		expect((await shell(recipes[2], second.env, second.dir, second.callback)).code).toBe(0);
		await until(() => existsSync(join(second.dir, 'exit')));
		expect((await shell(recipes[3], second.env, second.dir)).code).toBe(0);
	});
});

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
	chmodSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	beginRemoteEnable,
	disableRemote,
	buildComposeOptions,
	composeConfigJson,
	createFholdState,
	readStackConfig,
	writeStackConfig,
	ensureRuntime,
	acquireStackLock,
	releaseStackLock
} from '@fhold/lib';
import { remoteExecArguments, describeRecall } from './remote.js';
import { bootstrapInstall } from './install.js';
import { main } from '../main.js';

const original = {
	home: process.env.FH_HOME,
	repo: process.env.FH_REPO_ROOT,
	docker: process.env.FH_DOCKER_BIN
};
afterEach(() => {
	for (const [key, value] of [
		['FH_HOME', original.home],
		['FH_REPO_ROOT', original.repo],
		['FH_DOCKER_BIN', original.docker]
	]) {
		if (value === undefined) delete process.env[key as string];
		else process.env[key as string] = value;
	}
});

async function guidedFixture(failure = false) {
	const root = mkdtempSync(join(tmpdir(), 'fhold-guided-remote-fixture-'));
	process.env.FH_HOME = join(root, 'home');
	process.env.FH_REPO_ROOT = join(import.meta.dir, '../../../..');
	await bootstrapInstall({ start: false });
	const state = createFholdState();
	// Keep the non-target worker off in this isolated native enable fixture.
	const initial = readStackConfig(state.homeDir);
	if (!initial.ok) throw new Error(initial.error);
	initial.config.assistant.codexRemote = false;
	initial.config.assistant.claudeRemote = false;
	writeStackConfig(state.homeDir, initial.config);
	ensureRuntime(state);
	const resolved = await composeConfigJson(buildComposeOptions(state));
	if (!resolved.ok) throw new Error(resolved.stderr);
	const docker = join(root, 'docker');
	writeFileSync(
		docker,
		`#!${process.execPath}
const args=process.argv.slice(2);
if(args.includes('config')) {
 const config=${JSON.stringify(resolved.config)};
 Object.assign(config.services.assistant.environment,{FH_CODEX_REMOTE:process.env.FH_CODEX_REMOTE,FH_CLAUDE_REMOTE:process.env.FH_CLAUDE_REMOTE,FH_CODEX_SANDBOX:process.env.FH_CODEX_SANDBOX});
 console.log(JSON.stringify(config));
} else if(args.includes('pair')) {
 console.log(JSON.stringify({pairingCode:'private-fixture-code'}));
} else if(args.includes('logs')) {
 console.log('https://claude.ai/code/background-fixture');
} else if(args.includes('exec')) {
 ${
		failure
			? 'console.log(JSON.stringify({error:"Fixture sandbox denied"})); process.exit(1);'
			: `
 console.log(JSON.stringify({stage:'sign-in',output:'Private fixture prompt\\n'}));
 setInterval(()=>{},1000);
 const reader=require('node:readline').createInterface({input:process.stdin});
 reader.on('line', line=>{const value=JSON.parse(line); if(value.cancel)process.exit(1); if(value.input==='human-approved'){console.log(JSON.stringify({ready:true}));setTimeout(()=>process.exit(0),30);}});
 `
 }
}

`
	);
	chmodSync(docker, 0o700);
	process.env.FH_DOCKER_BIN = docker;
	return state;
}

describe('native remote commands', () => {
	it('explains native recall commands and data access without requiring a Codex slash command', () => {
		const text = describeRecall({
			status: 'approval-needed',
			digest: 'a'.repeat(64),
			hooks: [
				{
					key: 'akm',
					hash: 'sha256:abc',
					event: 'sessionStart',
					command: 'sh /actual/akm-hook.sh session-start',
					sourcePath: '/actual/plugin.json',
					enabled: true,
					trust: 'untrusted'
				}
			]
		});
		expect(text).toContain('sh /actual/akm-hook.sh session-start');
		expect(text).toContain('search/embedding endpoints');
		expect(text).toContain('does not grant tool permissions');
		expect(text).not.toContain('/hooks');
	});
	for (const [tool, sandbox] of [
		['codex', 'read-only'],
		['codex', 'danger-full-access'],
		['claude', 'workspace-write']
	] as const)
		it(`enables ${tool} startup with ${sandbox} after native setup and preserves credentials`, async () => {
			const state = await guidedFixture();
			const keyFile = join(state.homeDir, 'state/credentials/owner/key');
			const key = readFileSync(keyFile);
			const session = await beginRemoteEnable(state, tool, {
				trusted: true,
				sandbox
			});
			expect(acquireStackLock(state.dataDir)).toBeNull();
			expect(() => session.input('bad\ninput')).toThrow();
			const promptDeadline = Date.now() + 2000;
			while (session.snapshot().stage !== 'sign-in') {
				if (Date.now() >= promptDeadline) throw new Error('Fixture prompt did not start.');
				await Bun.sleep(5);
			}
			session.input('human-approved');
			const result = await session.done;
			expect(result).toMatchObject({ enabled: true, running: false, stage: 'enabled' });
			expect(result.output).toContain(
				tool === 'codex' ? 'private-fixture-code' : 'https://claude.ai/code/background-fixture'
			);
			const config = readStackConfig(state.homeDir);
			expect(config.ok && config.config.assistant).toMatchObject({
				codexRemote: tool === 'codex',
				claudeRemote: tool === 'claude',
				codexSandbox: sandbox
			});
			expect(readFileSync(keyFile)).toEqual(key);
			const lock = acquireStackLock(state.dataDir);
			expect(lock).not.toBeNull();
			releaseStackLock(lock);
			const runtimeEnv = readFileSync(join(state.homeDir, 'state/stack.env'), 'utf8');
			expect(runtimeEnv).toContain(`FH_${tool.toUpperCase()}_REMOTE=1`);
			await disableRemote(state, tool);
			const disabled = readStackConfig(state.homeDir);
			expect(disabled.ok && disabled.config.assistant).toMatchObject({
				codexRemote: false,
				claudeRemote: false,
				codexSandbox: sandbox
			});
			expect(readFileSync(keyFile)).toEqual(key);
		});
	it('keeps startup off after native failure or cancellation', async () => {
		let state = await guidedFixture(true);
		let session = await beginRemoteEnable(state, 'claude', { trusted: true });
		expect(await session.done).toMatchObject({
			enabled: false,
			running: false,
			error: 'Fixture sandbox denied'
		});
		delete process.env.FH_DOCKER_BIN;
		state = await guidedFixture();
		session = await beginRemoteEnable(state, 'claude', { trusted: true });
		session.cancel();
		expect(await session.done).toMatchObject({ enabled: false, running: false });
		const config = readStackConfig(state.homeDir);
		expect(config.ok && config.config.assistant.claudeRemote).toBe(false);
	});
	it('rolls startup back off if cancelled after native setup, during background pairing', async () => {
		const state = await guidedFixture();
		const session = await beginRemoteEnable(state, 'claude', {
			trusted: true,
			update(progress) {
				if (progress.stage === 'pairing') session.cancel();
			}
		});
		const deadline = Date.now() + 2000;
		while (session.snapshot().stage !== 'sign-in') {
			if (Date.now() >= deadline) throw new Error('Fixture prompt did not start.');
			await Bun.sleep(5);
		}
		session.input('human-approved');
		expect(await session.done).toMatchObject({ enabled: false, running: false, stage: 'failed' });
		const config = readStackConfig(state.homeDir);
		expect(config.ok && config.config.assistant.claudeRemote).toBe(false);
		const lock = acquireStackLock(state.dataDir);
		expect(lock).not.toBeNull();
		releaseStackLock(lock);
	});
	it('delegates sign-in, pairing, and status to native commands without shell strings', () => {
		expect(remoteExecArguments('setup', 'codex')).toEqual(['codex', 'login', '--device-auth']);
		expect(remoteExecArguments('setup', 'claude')).toEqual(['claude']);
		expect(remoteExecArguments('pair', 'codex')).toEqual([
			'codex',
			'remote-control',
			'pair',
			'--json'
		]);
		expect(remoteExecArguments('pair', 'claude')).toEqual(['fhold-remote', 'claude', 'logs']);
		expect(remoteExecArguments('logs', 'codex')).toEqual(['fhold-remote', 'codex', 'logs']);
		expect(remoteExecArguments('status', 'claude')).toEqual(['fhold-remote', 'claude', 'status']);
		for (const tool of [
			'codex; touch /tmp/pwn',
			'claude --dangerously-skip-permissions',
			'../claude'
		])
			expect(() => remoteExecArguments('setup', tool)).toThrow('Choose codex or claude');
		expect(() => remoteExecArguments('arbitrary', 'codex')).toThrow();
	});
});

function homeProof(home: string): string {
	return JSON.stringify(
		readdirSync(home, { recursive: true, withFileTypes: true })
			.map((entry) => {
				const path = join(entry.parentPath, entry.name);
				const stat = lstatSync(path);
				return [
					path,
					stat.mode,
					stat.mtimeMs,
					stat.isFile() ? readFileSync(path).toString('base64') : null
				];
			})
			.sort((left, right) => String(left[0]).localeCompare(String(right[0])))
	);
}

for (const tool of ['codex', 'claude'] as const) {
	for (const action of ['status', 'logs'] as const) {
		for (const running of [false, true]) {
			it(`remote ${action} ${tool} is read-only with Assistant ${running ? 'running' : 'stopped'}`, async () => {
				const root = mkdtempSync(join(tmpdir(), 'fhold-readonly-remote-'));
				process.env.FH_HOME = join(root, 'home');
				process.env.FH_REPO_ROOT = join(import.meta.dir, '../../../..');
				await bootstrapInstall({ start: false });
				const state = createFholdState();
				const config = readStackConfig(state.homeDir);
				if (!config.ok) throw new Error(config.error);
				config.config.assistant[tool === 'codex' ? 'codexRemote' : 'claudeRemote'] = true;
				writeStackConfig(state.homeDir, config.config);
				const calls = join(root, 'docker-calls.jsonl');
				const docker = join(root, 'docker');
				writeFileSync(
					docker,
					`#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'ps') console.log('fixture-container');
else if (args[0] === 'inspect') console.log(${JSON.stringify(JSON.stringify({ 'com.docker.compose.project.working_dir': state.stackDir }))});
else if (args.includes('ps')) console.log(JSON.stringify({Service:'assistant',State:${JSON.stringify(running ? 'running' : 'exited')}}));
else if (args.includes('exec') && args.includes('fhold-remote')) console.log('native-read-only-fixture');
else { console.error('unexpected mutation or native inventory'); process.exit(9); }
`
				);
				chmodSync(docker, 0o700);
				process.env.FH_DOCKER_BIN = docker;
				const before = homeProof(state.homeDir);
				const output = spyOn(console, 'log').mockImplementation(() => {});
				try {
					await main(['remote', action, tool]);
					if (!running)
						expect(
							output.mock.calls.some(([line]) =>
								String(line).includes('Assistant is stopped. Run fhold start explicitly')
							)
						).toBe(true);
				} finally {
					output.mockRestore();
				}
				const invoked = readFileSync(calls, 'utf8')
					.trim()
					.split('\n')
					.map((line) => JSON.parse(line) as string[]);
				expect(invoked).toHaveLength(running ? 4 : 1);
				expect(invoked[0]).toContain('ps');
				if (running) {
					expect(invoked[1]).toEqual([
						'ps',
						'-a',
						'--filter',
						`label=com.docker.compose.project=${config.config.deployment.projectName}`,
						'--format',
						'{{.ID}}'
					]);
					expect(invoked[2]).toEqual([
						'inspect',
						'--format',
						'{{json .Config.Labels}}',
						'fixture-container'
					]);
					expect(invoked[3]?.slice(-3)).toEqual(['fhold-remote', tool, action]);
				}
				expect(
					invoked.some(
						(args) =>
							args.includes('up') ||
							args.includes('config') ||
							args.includes('info') ||
							args.includes('fhold-codex-recall')
					)
				).toBe(false);
				expect(homeProof(state.homeDir)).toBe(before);
			});
		}
	}
}

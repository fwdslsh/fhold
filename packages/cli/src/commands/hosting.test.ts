import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const cli = resolve(import.meta.dir, '..', 'main.ts');
function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'fhold-hosting-cli-'));
	roots.push(root);
	return {
		root,
		env: {
			...process.env,
			XDG_CONFIG_HOME: join(root, 'config'),
			FH_HOME: join(root, 'must-not-touch')
		}
	};
}
async function run(args: string[], env: NodeJS.ProcessEnv, cwd: string, input?: string) {
	const child = Bun.spawn([process.execPath, 'run', cli, ...args], {
		cwd,
		env,
		stdin: input ? new Blob([input]) : 'ignore',
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited
	]);
	return { stdout, stderr, code };
}

test('hosting metadata commands are independent of FH_HOME, Docker, sign-in and setup', async () => {
	const { root, env } = fixture();
	const added = await run(
		[
			'hosting',
			'add',
			'lab',
			'--provider',
			'ssh-docker',
			'--host',
			'lab',
			'--roots',
			'["/opt/stacks"]'
		],
		env,
		root
	);
	expect(added.code).toBe(0);
	const listed = await run(['hosting', 'list'], env, root);
	expect(JSON.parse(listed.stdout).map((item: { id: string }) => item.id)).toEqual([
		'local',
		'lab'
	]);
	expect(existsSync(env.FH_HOME)).toBe(false);
	const rejected = await run(
		['--connection', 'lab', '-n', '/opt/stacks/agent', 'backup', '--to', '/bad'],
		env,
		root
	);
	expect(rejected.code).not.toBe(0);
	expect(rejected.stderr).toMatch(/SSH|resolve|Connection|connect|hostname/i);
	expect(existsSync(env.FH_HOME)).toBe(false);
	expect(existsSync('/bad')).toBe(false);
});

test('CLI edits, confirms retarget/removal, and leaves instance state untouched', async () => {
	const { root, env } = fixture();
	expect(
		(await run(['hosting', 'add', 'lab', '--provider', 'ssh-docker', '--host', 'krang'], env, root))
			.code
	).toBe(0);
	expect(
		(
			await run(
				['hosting', 'edit', 'lab', '--label', 'Krang', '--roots', '["/opt/stacks"]'],
				env,
				root
			)
		).code
	).toBe(0);
	expect((await run(['hosting', 'edit', 'lab', '--host', 'other'], env, root)).stderr).toContain(
		'--confirm'
	);
	expect(
		(await run(['hosting', 'edit', 'lab', '--host', 'other', '--confirm'], env, root)).code
	).toBe(0);
	expect((await run(['hosting', 'remove', 'lab'], env, root)).stderr).toContain('--confirm');
	expect((await run(['hosting', 'remove', 'lab', '--confirm'], env, root)).code).toBe(0);
	expect(
		JSON.parse((await run(['hosting', 'list'], env, root)).stdout).map(
			(item: { id: string }) => item.id
		)
	).toEqual(['local']);
	expect(existsSync(env.FH_HOME)).toBe(false);
});

test('native SSH subprocess receives a fixed command, discovers and inspects the selected remote target', async () => {
	const { root, env } = fixture();
	const bin = join(root, 'bin');
	mkdirSync(bin);
	const capture = join(root, 'ssh-input.json');
	writeFileSync(
		join(bin, 'ssh'),
		`#!${process.execPath}
import { writeFileSync } from 'node:fs';
const input = await Bun.stdin.text(); const request = JSON.parse(input);
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), request }));
const item = { ref: { kind:'local-docker',connectionId:'local',homeDir:'/opt/stacks/agent' },name:'agent',location:'/opt/stacks/agent',services:[],warnings:[] };
const value = request.action==='hello' ? {actions:['list','inspect','logs','start','stop','restart']} : request.action==='list' ? [item] : item;
if(request.action==='hello') process.exitCode=0;
console.log(JSON.stringify({version:1,ok:true,value}));
`,
		{ mode: 0o700 }
	);
	await run(['hosting', 'add', 'lab', '--provider', 'ssh-docker', '--host', 'lab'], env, root);
	const result = await run(
		['--connection', 'lab', '-n', 'agent', 'status'],
		{ ...env, PATH: `${bin}:${process.env.PATH}` },
		root
	);
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout).ref).toEqual({
		kind: 'ssh-docker',
		connectionId: 'lab',
		remoteHome: '/opt/stacks/agent'
	});
	const input = JSON.parse(readFileSync(capture, 'utf8'));
	expect(input.args.at(-1)).toBe('PATH="$HOME/.local/bin:$PATH" exec fhold hosting rpc');
	expect(input.args).not.toContain('/opt/stacks/agent');
	expect(input.request).toMatchObject({ action: 'hello', version: 1 });
	expect(existsSync(env.FH_HOME)).toBe(false);
});

test('the CLI machine endpoint returns one envelope and never runs an unconfirmed change', async () => {
	const { root, env } = fixture();
	const hello = await run(['hosting', 'rpc'], env, root, '{"version":1,"action":"hello"}');
	expect(JSON.parse(hello.stdout)).toMatchObject({ version: 1, ok: true });
	const stop = await run(
		['hosting', 'rpc'],
		env,
		root,
		JSON.stringify({ version: 1, action: 'stop', homeDir: env.FH_HOME })
	);
	expect(JSON.parse(stop.stdout)).toMatchObject({
		version: 1,
		ok: false,
		error: expect.stringContaining('Confirm')
	});
	expect(existsSync(env.FH_HOME)).toBe(false);
});

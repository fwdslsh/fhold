#!/usr/bin/env node
// Native AKM/sudo boundary through the real opt-in Compose overlay. All state,
// grants and credentials are synthetic, in disposable project-scoped volumes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const image = process.argv[2];
assert.ok(image, 'Usage: node scripts/smoke-credential-custody.mjs IMAGE');
const root = mkdtempSync(join(tmpdir(), 'fhold-custody-'));
const project = `fhold-custody-${process.pid}`;
const base = join(root, 'compose.json');
const overlay = resolve('docs/examples/credential-custody.compose.yml');
const privateHome = '/var/lib/fhold-credentials';
const token = 'synthetic-custody-canary';
const auth = 'synthetic-custody-http';
let enabled = false;
writeFileSync(base, JSON.stringify({ services: { assistant: {
	image, hostname: project, network_mode: 'none', cap_drop: ['ALL'],
	security_opt: ['no-new-privileges:true'],
	environment: { OPENCODE_SERVER_PASSWORD: auth, FH_CODEX_REMOTE: '0', FH_CLAUDE_REMOTE: '0' },
	volumes: ['assistant-home:/home/fhold']
} }, volumes: { 'assistant-home': {} } }));
function result(args, input) {
	return spawnSync('docker', args, { input, encoding: 'utf8', timeout: 100_000 });
}
function docker(args, input) {
	const r = result(args, input);
	assert.equal(r.status, 0, r.stderr || r.stdout);
	return r.stdout;
}
function compose(args, input, withOverlay = enabled) {
	return docker(['compose', '-p', project, '-f', base, ...(withOverlay ? ['-f', overlay] : []), ...args], input);
}
function execResult(args, input, uid = '1000:1000', cwd = '/work') {
	const id = compose(['ps', '-q', 'assistant']).trim();
	return result(['exec', '-i', '--user', uid, '--workdir', cwd, id, ...args], input);
}
function exec(args, input, uid, cwd) {
	const r = execResult(args, input, uid, cwd);
	assert.equal(r.status, 0, r.stderr || r.stdout);
	return r.stdout;
}
function credential(args, input) {
	return exec(['env', '-i', `HOME=${privateHome}`, 'PATH=/usr/local/bin:/usr/bin:/bin', ...args], input, '1101:1101', privateHome);
}
const approved = ['sudo', '-n', '-H', '-u', 'fhold-credentials', '/usr/local/bin/akm', 'run', 'tasks/probe'];
function denied(args) { assert.notEqual(execResult(args).status, 0, 'Unexpectedly allowed: ' + args.join(' ')); }
function checkResult(output) {
	assert.match(output, /credential-used/);
	assert.match(output, /\[REDACTED\]/);
	assert.ok(!output.includes(token), 'Secret reached caller');
}
async function start() {
	compose(['up', '-d', '--force-recreate', '--pull', 'never', '--wait', '--wait-timeout', '90']);
}
try {
	await start();
	assert.match(exec(['sh', '-c', 'sed -n "/^NoNewPrivs:/p" /proc/self/status']), /1/);
	denied(approved);
	console.log('Default deployment preserves no-new-privileges; no credential task grants.');
	enabled = true;
	const config = JSON.parse(compose(['config', '--format', 'json']));
	assert.deepEqual(config.services.assistant.security_opt, ['no-new-privileges:false']);
	assert.deepEqual(config.services.assistant.cap_drop, ['ALL']);
	assert.deepEqual(config.services.assistant.cap_add.sort(), ['SETGID', 'SETUID']);
	await start();
	assert.equal(exec(['stat', '-c', '%u:%g:%a', privateHome]).trim(), '1101:1101:700');
	denied(approved); // Enabling the overlay alone authorizes no operation.
	credential(['akm', 'setup', '--yes', '--no-probe', '--embedding', 'off', '--dir', `${privateHome}/akm`]);
	credential(['akm', 'secret', 'set', 'secrets/probe'], token);
	credential(['sh', '-eu', '-c', 'mkdir -p "$HOME/akm/scripts" "$HOME/akm/tasks"']);
	credential(['sh', '-eu', '-c', 'cat > "$HOME/akm/scripts/probe.sh"; chmod 700 "$HOME/akm/scripts/probe.sh"'],
		'#!/bin/sh\nset -eu\ntest -n "$TOKEN"\nprintf "credential-used %s\\n" "$TOKEN"\n');
	credential(['sh', '-eu', '-c', 'cat > "$HOME/akm/tasks/probe.yml"'],
		'version: 5-beta.1\nsteps:\n  - name: probe\n    run: scripts/probe.sh\n    secret: [secrets/probe:TOKEN]\n');
	exec(['sh', '-eu', '-c', 'umask 077; cat > /etc/sudoers.d/fhold-credentials; chmod 0440 /etc/sudoers.d/fhold-credentials; /usr/sbin/visudo -cf /etc/sudoers'],
		`Defaults:fhold env_reset\nfhold ALL=(fhold-credentials) CWD=${privateHome} NOPASSWD: NOSETENV: /usr/local/bin/akm run tasks/probe\n`, '0');
	checkResult(exec(approved));
	for (const args of [
		['cat', `${privateHome}/akm/secrets/probe`],
		['sh', '-c', `printf tamper >> ${privateHome}/akm/scripts/probe.sh`],
		['sh', '-c', 'printf tamper >> /etc/sudoers.d/fhold-credentials'],
		['sh', '-c', 'test -w "$(readlink -f /usr/local/bin/akm)"'],
		['sudo', '-n', '-H', '-u', 'fhold-credentials', '/usr/local/bin/akm', 'secret', 'list'],
		[...approved, '--cwd', '/work'], [...approved, '--secret', 'secrets/probe:OTHER'],
		['sudo', '-n', 'sh'], ['sudo', '-n', '-E', ...approved.slice(2)]
	]) denied(args);
	checkResult(exec(['env', 'AKM_CONFIG_FILE=/tmp/attacker.json', 'AKM_BUNDLE_DIR=/tmp/attacker', 'BUN_OPTIONS=--preload=/tmp/attacker.ts', ...approved]));
	exec(['sh', '-eu', '-c', 'mkdir -p /work/caller; printf \'preload = ["./attack.ts"]\\n\' > /work/caller/bunfig.toml; printf \'throw new Error("CALLER_PRELOAD");\' > /work/caller/attack.ts']);
	checkResult(exec(approved, undefined, '1000:1000', '/work/caller'));
	denied(['sudo', '-n', '-D', '/work/caller', ...approved.slice(2)]);
	console.log('Native AKM task succeeds; direct read, tampering, arbitrary sudo, flags, environment and cwd attacks denied.');
	exec(['node', '--input-type=module', '-e', `
import assert from 'node:assert/strict';
const headers={authorization:'Basic '+Buffer.from('opencode:${auth}').toString('base64'),'content-type':'application/json'};
const base='http://127.0.0.1:4096/api';
const {data:s}=await(await fetch(base+'/session',{method:'POST',headers,body:JSON.stringify({location:{directory:'/work'}})})).json();
try {
 const r=await fetch(base+'/session/'+s.id+'/shell',{method:'POST',headers,body:JSON.stringify({command:${JSON.stringify(approved.join(' '))}})});
 assert.ok(r.ok);
 const text=JSON.stringify(await(await fetch(base+'/session/'+s.id+'/message',{headers})).json());
 assert.ok(text.includes('credential-used')&&text.includes('[REDACTED]'));
 assert.ok(!text.includes(${JSON.stringify(token)}));
} finally { await fetch(base+'/session/'+s.id,{method:'DELETE',headers}); }
`]);
	const cron = exec(['crontab', '-l']);
	try {
		exec(['crontab', '-'], `${cron}\n* * * * * * * ${approved.join(' ')} > /tmp/credential-result 2>/tmp/credential-error && touch /tmp/credential-done\n`);
		const deadline = Date.now() + 15_000;
		while (execResult(['test', '-f', '/tmp/credential-done']).status !== 0) {
			assert.ok(Date.now() < deadline, execResult(['cat', '/tmp/credential-error']).stdout);
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		checkResult(exec(['cat', '/tmp/credential-result']));
	} finally { exec(['crontab', '-'], cron); }
	console.log('Real OpenCode shell and Supercronic task received redacted results.');
	await start();
	checkResult(exec(approved));
	denied(['cat', `${privateHome}/akm/secrets/probe`]);
	enabled = false;
	await start();
	denied(approved);
	enabled = true;
	await start();
	checkResult(exec(approved));
	assert.ok(readFileSync(overlay, 'utf8').includes('credential-home'));
	console.log('Private home/policy persist across replacement, disabling and re-enabling; no automatic credential migration.');
} finally {
	// Only this script's unique Compose project and synthetic volumes are removed.
	compose(['down', '-v', '--remove-orphans'], undefined, true);
	rmSync(root, { recursive: true, force: true });
}

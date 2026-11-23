#!/usr/bin/env node
// Native Secret Service lifecycle, using only disposable homes and synthetic
// credentials. No image repair, desktop bus, cloud account or model is involved.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const image = process.argv[2];
assert.ok(image, 'Usage: node scripts/smoke-keyring.mjs IMAGE');
const name = `fhold-keyring-smoke-${process.pid}`;
const volume = `${name}-home`;
const root = mkdtempSync(join(tmpdir(), 'fhold-keyring-'));
const password = join(root, 'password');
const wrong = join(root, 'wrong');
writeFileSync(password, 'synthetic-keyring-unlock', { mode: 0o444 });
writeFileSync(wrong, 'synthetic-wrong-unlock', { mode: 0o444 });
function result(args, input) {
	return spawnSync('docker', args, { input, encoding: 'utf8', timeout: 100_000 });
}
function docker(args, input) {
	const value = result(args, input);
	assert.equal(value.status, 0, value.stderr || value.stdout);
	return value.stdout;
}
function exec(args, input) { return docker(['exec', '-i', name, ...args], input); }
async function start(secret = password, extra = []) {
	docker(['run', '-d', '--name', name, '--network', 'none', '--cap-drop=ALL',
		'--security-opt', 'no-new-privileges:true',
		'-e', 'OPENCODE_SERVER_PASSWORD=synthetic-keyring-core',
		'-e', 'FH_CODEX_REMOTE=0', '-e', 'FH_CLAUDE_REMOTE=0',
		'--mount', `type=volume,src=${volume},dst=/home/fhold`,
		...(secret ? ['--mount', `type=bind,src=${secret},dst=/run/secrets/keyring-password,readonly`,
			'-e', 'FH_KEYRING_PASSWORD_FILE=/run/secrets/keyring-password'] : []),
		...extra, image]);
	await ready();
}
async function ready() {
	const deadline = Date.now() + 90_000;
	while (result(['exec', name, 'fhold-healthcheck']).status !== 0) {
		assert.ok(Date.now() < deadline, docker(['logs', name]));
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}
function stop() { docker(['stop', '-t', '30', name]); docker(['rm', name]); }
function lookup() { return exec(['secret-tool', 'lookup', 'fhold-smoke', 'persistent']).trim(); }
try {
	docker(['volume', 'create', volume]);
	await start();
	assert.match(exec(['fhold-keyring', 'status']), /unlocked \(persistent collection\)/);
	exec(['secret-tool', 'store', '--label=fhold-keyring-smoke', 'fhold-smoke', 'persistent'], 'synthetic-persistent-value');
	assert.equal(lookup(), 'synthetic-persistent-value');
	const originalCron = exec(['crontab', '-l']);
	try {
		exec(['crontab', '-'], `${originalCron}\n* * * * * * * test "$(secret-tool lookup fhold-smoke persistent)" = synthetic-persistent-value && touch /tmp/fhold-keyring-scheduler\n`);
		const deadline = Date.now() + 15_000;
		while (result(['exec', name, 'test', '-f', '/tmp/fhold-keyring-scheduler']).status !== 0) {
			assert.ok(Date.now() < deadline, 'The real scheduled job must access the unlocked keyring');
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	} finally { exec(['crontab', '-'], originalCron); }
	exec(['node', '--input-type=module', '-e', `
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
assert.notEqual(process.getuid(),0);
assert.ok(!readFileSync(process.env.HOME+'/.local/share/keyrings/login.keyring').includes(Buffer.from('synthetic-persistent-value')));
const scheduler=readFileSync('/tmp/fhold-runtime/scheduler.pid','utf8').trim();
assert.ok(readFileSync('/proc/'+scheduler+'/environ','utf8').split(String.fromCharCode(0)).includes('DBUS_SESSION_BUS_ADDRESS='+process.env.DBUS_SESSION_BUS_ADDRESS));
const headers={authorization:'Basic '+Buffer.from('opencode:synthetic-keyring-core').toString('base64'),'content-type':'application/json'};
const {data:session}=await (await fetch('http://127.0.0.1:4096/api/session',{method:'POST',headers,body:JSON.stringify({location:{directory:'/work'}})})).json();
try {
const response=await fetch('http://127.0.0.1:4096/api/session/'+session.id+'/shell',{method:'POST',headers,body:JSON.stringify({command:'test "$(secret-tool lookup fhold-smoke persistent)" = synthetic-persistent-value && printf keyring-tool-usable'})});
assert.ok(response.ok);
const messages=await (await fetch('http://127.0.0.1:4096/api/session/'+session.id+'/message',{headers})).json();
assert.ok(messages.data.some(m=>m.type==='shell'&&JSON.stringify(m.output).includes('keyring-tool-usable')));
} finally { await fetch('http://127.0.0.1:4096/api/session/'+session.id,{method:'DELETE',headers}); }
`]);
	docker(['restart', name]);
	await ready();
	assert.equal(lookup(), 'synthetic-persistent-value', 'Encrypted keyring must unlock after restart');
	stop();
	await start(wrong);
	assert.notEqual(result(['exec', name, 'fhold-keyring', 'status']).status, 0, 'Wrong password must not report usable');
	assert.match(exec(['fhold-healthcheck']), /keyring/i, 'Locked keyring must be reported without failing core health');
	stop();
	await start(null);
	assert.notEqual(result(['exec', name, 'fhold-keyring', 'status']).status, 0, 'Missing password must preserve the locked default');
	stop();
	await start();
	assert.equal(lookup(), 'synthetic-persistent-value', 'Failed unlocks must preserve credentials');
	exec(['secret-tool', 'clear', 'fhold-smoke', 'persistent']);
	stop();
	docker(['volume', 'rm', volume]);
	docker(['volume', 'create', volume]);
	await start(password, ['--user', '21432:21432']);
	assert.match(exec(['fhold-keyring', 'status']), /unlocked/);
	exec(['secret-tool', 'store', '--label=fhold-uid-smoke', 'fhold-smoke', 'uid'], 'synthetic-uid-value');
	assert.equal(exec(['secret-tool', 'lookup', 'fhold-smoke', 'uid']).trim(), 'synthetic-uid-value');
	stop();
	docker(['volume', 'rm', volume]);
	docker(['volume', 'create', volume]);
	await start(null);
	assert.match(exec(['fhold-keyring', 'status']), /session only/);
	exec(['secret-tool', 'store', '--label=fhold-session-smoke', 'fhold-smoke', 'session'], 'synthetic-session-value');
	docker(['restart', name]);
	await ready();
	assert.equal(result(['exec', name, 'secret-tool', 'lookup', 'fhold-smoke', 'session']).status, 1, 'Memory-only entries must disappear on restart');
	stop();
	console.log('Native keyring: encrypted persistence, OpenCode tool and scheduled job access, restart, wrong/missing password preservation, arbitrary UID and memory-only restart passed.');
} finally {
	result(['rm', '-f', name]);
	result(['volume', 'rm', volume]);
	rmSync(root, { recursive: true, force: true });
}

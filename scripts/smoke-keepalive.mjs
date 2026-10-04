#!/usr/bin/env node
// Offline, disposable image test: a real native shell task and the real cron
// drive HTTP requests. This does not qualify any hosting provider's autoscaler.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const image = process.argv[2];
assert.ok(image, 'Usage: node scripts/smoke-keepalive.mjs IMAGE');
const name = `fhold-keepalive-smoke-${randomUUID().slice(0, 8)}`;
const password = 'synthetic-keepalive-smoke-only';

function command(args, timeout = 300000) {
	return new Promise((resolve, reject) => {
		const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
		const chunks = [];
		const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
		child.stdout.on('data', (chunk) => chunks.push(chunk));
		child.stderr.on('data', (chunk) => chunks.push(chunk));
		child.once('error', reject);
		child.once('exit', (code) => {
			clearTimeout(timer);
			const output = Buffer.concat(chunks).toString();
			if (code === 0) resolve(output);
			else
				reject(
					Error(
						`Keep-alive image smoke failed: ${output.slice(-4000).replaceAll(password, '[fixture-password]')}`
					)
				);
		});
	});
}

const probe = `
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { activityStatus } from '/fhold-plugins/fhold/scripts/activity.mjs';
const authorization = 'Basic ' + Buffer.from('user:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
let count = 0;
const sink = createServer((request, response) => {
  assert.equal(request.url, '/tick');
  assert.equal(request.method, 'GET');
  assert.equal(request.headers.authorization, authorization);
  count++;
  response.writeHead(200); response.end();
});
await new Promise(resolve => sink.listen(4100, '127.0.0.1', resolve));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, seconds = 90) {
  const deadline = Date.now() + seconds * 1000;
  while (!await check()) {
    if (Date.now() >= deadline) throw Error('Image smoke deadline exceeded');
    await pause(200);
  }
}
async function api(path, body) {
  const response = await fetch('http://127.0.0.1:4096' + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(body?.command ? 90000 : 3000)
  });
  assert.ok(response.ok, 'Native API request failed: ' + response.status);
  return response.json();
}
try {
  await until(async () => { try { await api('/global/health'); return true; } catch { return false; } });
  await api('/config?directory=%2Fwork');
  try { await until(() => activityStatus('/tmp/fhold-runtime', []) === 'idle', 15); }
  catch { throw Error('Initial activity was ' + activityStatus('/tmp/fhold-runtime', []) + ': ' + readdirSync('/tmp/fhold-runtime/activity').join(',')); }
  for (const username of ['', 'opencode']) {
    const response = await fetch('http://127.0.0.1:4096/global/health', {headers:{authorization:'Basic ' + Buffer.from(username + ':' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64')}});
    assert.equal(response.status, 401, 'Only the configured username should authenticate');
  }
  const quiet = count;
  await pause(22000);
  assert.equal(count, quiet, 'Idle native sessions must not send keep-alive');
  const session = await api('/session?directory=%2Fwork', {title:'Disposable keep-alive qualification'});
  const task = api('/session/' + session.id + '/shell?directory=%2Fwork', {agent:'build', command:'sleep 45; printf fhold-keepalive-complete'});
  await until(() => activityStatus('/tmp/fhold-runtime', []) === 'busy', 10);
  console.log('Native OpenCode work was observed; waiting for real scheduler ticks.');
  await task;
  assert.ok(count >= quiet + 2, 'The scheduler must keep sending during long native work');
  await until(() => activityStatus('/tmp/fhold-runtime', []) === 'idle', 10);
  const completed = count;
  await pause(22000);
  assert.equal(count, completed, 'Keep-alive must stop after native work finishes');
  const status = JSON.parse(readFileSync('/tmp/fhold-runtime/keepalive-status.json', 'utf8'));
  assert.equal(status.activity, 'idle');
  assert.equal(status.sent, false);
  const cron = readFileSync('/tmp/fhold-crontabs/fhold', 'utf8');
  assert.ok(cron.includes('fhold-keepalive tick'));
  assert.ok(!cron.includes('# akm:task'), 'User scheduling remains disabled');
  console.log(JSON.stringify({nativeActivity:true, conditionalHttp:true, userSchedulesDisabled:true, activeRequests:completed-quiet, idleRequests:0}));
} finally { sink.closeAllConnections(); await new Promise(resolve => sink.close(resolve)); }
`;

try {
	await command([
		'run',
		'-d',
		'--name',
		name,
		'--network',
		'none',
		'--init',
		'--cap-drop=ALL',
		'--security-opt',
		'no-new-privileges:true',
		'-e',
		`OPENCODE_SERVER_PASSWORD=${password}`,
		'-e',
		'FH_CODEX_REMOTE=0',
		'-e',
		'FH_CLAUDE_REMOTE=0',
		'-e',
		'FH_SCHEDULER_ENABLED=0',
		'-e',
		'FH_KEEPALIVE_URL=http://127.0.0.1:4100/tick',
		'-e',
		'FH_KEEPALIVE_AUTH=opencode',
		'-e',
		'FH_AUTOMATIC_MEMORY=0',
		'-e',
		`OPENCODE_CONFIG_CONTENT=${JSON.stringify({ model: 'openai/gpt-5-nano', provider: { openai: { options: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'offline-fixture' } } } })}`,
		image
	]);
	console.log((await command(['exec', name, 'node', '--input-type=module', '-e', probe])).trim());
} finally {
	await command(['rm', '-f', name]).catch(() => {});
}

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
import { OpenCode } from '/opt/fhold/tools/node_modules/@opencode/client/dist/promise/index.js';
const authorization = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
const events = new AbortController();
let eventStream;
let streamReady = false;
let streamFailure;
let unloaded = 0;
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
  const response = await fetch('http://127.0.0.1:4096' + '/api' + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(body?.command ? 90000 : 3000)
  });
  assert.ok(response.ok, 'Native API request failed: ' + response.status);
  return response.status === 204 ? undefined : (await response.json()).data;
}
try {
  await until(async () => { try { await api('/info'); return true; } catch { return false; } });
  const client = OpenCode.make({ baseUrl: 'http://127.0.0.1:4096', headers: { authorization } });
  eventStream = (async () => {
    try {
      for await (const event of client.event.subscribe({ signal: events.signal, onActivity: () => { streamReady = true; } })) {
        if (event.type === 'location.shutdown' && event.location?.directory === '/work') unloaded++;
      }
    } catch (error) { if (!events.signal.aborted) streamFailure = error; }
  })();
  await until(() => streamReady, 10);
  await api('/config?location[directory]=/work');
  await until(() => ['claude', 'codex'].every(tool => {
    try { return JSON.parse(readFileSync('/tmp/fhold-runtime/remote/' + tool + '.json', 'utf8')).state === 'sign-in-needed'; }
    catch { return false; }
  }), 30);
  try { await until(() => activityStatus('/tmp/fhold-runtime') === 'idle', 15); }
  catch { throw Error('Initial activity was ' + activityStatus('/tmp/fhold-runtime') + ': ' + readdirSync('/tmp/fhold-runtime/activity').join(',')); }
  for (const username of ['', 'user']) {
    const response = await fetch('http://127.0.0.1:4096/api/info', {headers:{authorization:'Basic ' + Buffer.from(username + ':' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64')}});
    assert.equal(response.status, 401, 'Only the configured username should authenticate');
  }
  const quiet = count;
  await pause(22000);
  assert.equal(count, quiet, 'Idle native sessions must not send keep-alive');
  // Shorten only the documented native idle TTL for this regression. Observe
  // actual native cleanup before starting work; never write activity markers.
  await until(() => unloaded > 0, 130);
  assert.equal(streamFailure, undefined);
  assert.equal(activityStatus('/tmp/fhold-runtime'), 'idle', 'Normal native workspace unload must preserve idle');
  const afterUnload = count;
  await pause(62000);
  assert.equal(count, afterUnload, 'Unloaded idle workspace must remain quiet for three intervals');
  const session = await api('/session', {title:'Disposable keep-alive qualification', location:{directory:'/work'}});
  await api('/session/' + session.id + '/synthetic', {resume:false, text:'Append-only history fixture; do not execute.'});
  await pause(500);
  assert.equal(activityStatus('/tmp/fhold-runtime'), 'idle', 'Append-only history is not active work');
  const task = api('/session/' + session.id + '/shell', {command:'sleep 45; printf fhold-keepalive-complete'});
  await until(() => activityStatus('/tmp/fhold-runtime') === 'busy', 10);
  console.log('Native OpenCode work was observed; waiting for real scheduler ticks.');
  await task;
  assert.ok(count >= quiet + 2, 'The scheduler must keep sending during long native work');
  await until(() => activityStatus('/tmp/fhold-runtime') === 'idle', 10);
  const completed = count;
  await pause(22000);
  assert.equal(count, completed, 'Keep-alive must stop after native work finishes');
  const status = JSON.parse(readFileSync('/tmp/fhold-runtime/keepalive-status.json', 'utf8'));
  assert.equal(status.activity, 'idle');
  assert.equal(status.sent, false);
  const cron = readFileSync('/tmp/fhold-crontabs/fhold', 'utf8');
  assert.ok(cron.includes('fhold-keepalive tick'));
  assert.ok(!cron.includes('# akm:task'), 'User scheduling remains disabled');
  console.log(JSON.stringify({nativeActivity:true, conditionalHttp:true, unsignedRemotesIdle:true, userSchedulesDisabled:true, activeRequests:completed-quiet, idleRequests:0, nativeUnloads:unloaded, afterUnloadQuietIntervals:3, workAfterUnload:true}));
} finally {
  events.abort(); await eventStream;
  sink.closeAllConnections(); await new Promise(resolve => sink.close(resolve));
}
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
		'FH_SCHEDULER_ENABLED=0',
		'-e',
		'FH_KEEPALIVE_URL=http://127.0.0.1:4100/tick',
		'-e',
		'FH_KEEPALIVE_AUTH=opencode',
		'-e',
		'FH_AUTOMATIC_MEMORY=0',
		'-e',
		`OPENCODE_CONFIG_CONTENT=${JSON.stringify({ experimental: { location_idle_timeout: '1 second' }, model: 'openai/gpt-5-nano', provider: { openai: { options: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'offline-fixture' } } } })}`,
		image
	]);
	console.log((await command(['exec', name, 'node', '--input-type=module', '-e', probe])).trim());
} finally {
	await command(['rm', '-f', name]).catch(() => {});
}

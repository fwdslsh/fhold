#!/usr/bin/env node
// Disposable shipped-image test. No vendor account, paid model, cloud API,
// runtime patch or native configuration repair is involved.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const image = process.argv[2];
assert.ok(image, 'Usage: node scripts/smoke-workload-environment.mjs IMAGE');
const name = `fhold-workload-env-${process.pid}`;
function docker(args, input) {
	const result = spawnSync('docker', args, { input, encoding: 'utf8', timeout: 120_000 });
	assert.equal(result.status, 0, result.stderr || 'Workload environment image test failed');
	return result.stdout;
}
const probe = `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const authorization = 'Basic ' + Buffer.from('opencode:synthetic-workload-test-only').toString('base64');
async function api(path, body) {
  const response = await fetch('http://127.0.0.1:4096/api' + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000)
  });
  assert.ok(response.ok, 'Native API status: ' + response.status);
  return response.status === 204 ? undefined : (await response.json()).data;
}
const deadline = Date.now() + 90000;
while (true) {
  try { await api('/info'); break; }
  catch (error) { if (Date.now() >= deadline) throw error; }
  await new Promise(resolve => setTimeout(resolve, 200));
}
function environment(tool) {
  const pid = readFileSync('/tmp/fhold-runtime/' + tool + '.pid', 'utf8').trim();
  return Object.fromEntries(readFileSync('/proc/' + pid + '/environ', 'utf8')
    .split('\0').filter(Boolean).map(pair => {
      const offset = pair.indexOf('='); return [pair.slice(0, offset), pair.slice(offset + 1)];
    }));
}
const native = environment('assistant');
assert.equal(native.PLUGIN_ENDPOINT, 'https://synthetic.invalid/workload');
assert.equal(native.PLUGIN_HEADER, 'synthetic header with spaces');
for (const tool of ['assistant', 'scheduler', 'claude', 'codex']) {
  const env = environment(tool);
  for (const source of ['WORKLOAD_ENDPOINT', 'IDENTITY_HEADER', 'FH_OPENCODE_ENV_MAP'])
    assert.equal(env[source], undefined, tool + ': source/map must be omitted');
  if (tool !== 'assistant') {
    assert.equal(env.PLUGIN_ENDPOINT, undefined, tool + ': no endpoint alias');
    assert.equal(env.PLUGIN_HEADER, undefined, tool + ': no header alias');
  }
}
const session = await api('/session', { title: 'Disposable workload environment test', location: { directory: '/work' } });
await api('/session/' + session.id + '/shell', {
  command: 'test "$PLUGIN_ENDPOINT" = "https://synthetic.invalid/workload" && test "$PLUGIN_HEADER" = "synthetic header with spaces" && test -z "\${IDENTITY_HEADER+x}" && test -z "\${WORKLOAD_ENDPOINT+x}" && printf workload-aliases-consumed'
});
const messages = await api('/session/' + session.id + '/message');
assert.ok(messages.some(message => message.type === 'shell' && JSON.stringify(message.output).includes('workload-aliases-consumed')), 'Native tool output must prove it inherited and consumed aliases');
console.log('Shipped image: OpenCode/tool aliases ready; scheduler/remotes clean; no source forwarding.');
`;
try {
	docker([
		'run',
		'-d',
		'--name',
		name,
		'--network',
		'none',
		'--cap-drop=ALL',
		'--security-opt',
		'no-new-privileges:true',
		'-e',
		'OPENCODE_SERVER_PASSWORD=synthetic-workload-test-only',
		'-e',
		'FH_OPENCODE_ENV_MAP=WORKLOAD_ENDPOINT=PLUGIN_ENDPOINT,IDENTITY_HEADER=PLUGIN_HEADER',
		'-e',
		'WORKLOAD_ENDPOINT=https://synthetic.invalid/workload',
		'-e',
		'IDENTITY_HEADER=synthetic header with spaces',
		image
	]);
	process.stdout.write(docker(['exec', '-i', name, 'node', '--input-type=module'], probe));
} finally {
	spawnSync('docker', ['stop', '-t', '30', name], { stdio: 'ignore', timeout: 45_000 });
	spawnSync('docker', ['rm', name], { stdio: 'ignore', timeout: 10_000 });
}

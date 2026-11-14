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
for (const tool of ['assistant', 'scheduler', 'claude', 'codex'])
  assert.equal(environment(tool).IDENTITY_HEADER, undefined, tool + ': identity selector must be omitted');
const session = await api('/session', { title: 'Disposable workload environment test', location: { directory: '/work' } });
await api('/session/' + session.id + '/shell', {
  command: 'test -z "\${IDENTITY_HEADER+x}" && printf workload-identity-omitted'
});
const messages = await api('/session/' + session.id + '/message');
assert.ok(messages.some(message => message.type === 'shell' && JSON.stringify(message.output).includes('workload-identity-omitted')), 'Native tool output must prove the identity selector was omitted');
console.log('Shipped image: OpenCode, tools, scheduler and remotes receive no workload identity selectors.');
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
		'IDENTITY_HEADER=synthetic header with spaces',
		image
	]);
	process.stdout.write(docker(['exec', '-i', name, 'node', '--input-type=module'], probe));
} finally {
	spawnSync('docker', ['stop', '-t', '30', name], { stdio: 'ignore', timeout: 45_000 });
	spawnSync('docker', ['rm', name], { stdio: 'ignore', timeout: 10_000 });
}

#!/usr/bin/env bun
// Actual image-baked Codex, native hooks and supervisor observer; offline provider.
// No vendor account, remote pairing, activity injection or sandbox relaxation.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withCodexControl, withCodexRecall, reviewRecall, changeRecall } from '/usr/local/bin/fhold-codex-recall.mjs';
import { monitorCodexActivity, remoteEnvironment } from '/usr/local/bin/fhold-remote.mjs';

const root = mkdtempSync('/tmp/fhold-codex-activity-');
const home = join(root, 'codex');
const workdir = join(root, 'work');
const runtime = join(root, 'runtime');
for (const path of [home, workdir, join(runtime, 'activity')]) mkdirSync(path, { recursive: true });
cpSync('/native-defaults/codex/plugins', join(home, 'plugins'), { recursive: true });
let mode = 'complete';
let requests = 0;
const held = new Set();
const completed = () => {
	const item = { id: 'msg_fixture', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'completed', annotations: [] }] };
	return [
		{ type: 'response.created', response: { id: 'resp_fixture', object: 'response', status: 'in_progress', output: [] } },
		{ type: 'response.output_item.done', output_index: 0, item },
		{ type: 'response.completed', response: { id: 'resp_fixture', object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
	].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
};
const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch() {
	requests++;
	if (mode === 'fail') return new Response('controlled provider failure', { status: 400 });
	if (mode === 'hold') return new Response(new ReadableStream({ start(controller) { held.add(controller); } }), { headers: { 'content-type': 'text/event-stream' } });
	return new Response(completed(), { headers: { 'content-type': 'text/event-stream' } });
} });
writeFileSync(join(home, 'config.toml'),
	'model="offline"\nmodel_provider="offline"\napproval_policy="on-request"\nsandbox_mode="workspace-write"\n' +
	readFileSync('/native-defaults/codex/config.toml', 'utf8') +
	`\n[model_providers.offline]\nname="offline"\nbase_url="http://127.0.0.1:${provider.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n`);
const env = remoteEnvironment({ ...process.env, HOME: root, CODEX_HOME: home, FH_RUNTIME_DIR: runtime, AKM_AUTO_MEMORY: '0', AKM_AUTO_LEARNING: '0' });
const options = { env, workdir };
const ready = () => existsSync(join(runtime, 'activity/codex.ready'));
const busy = () => readdirSync(join(runtime, 'activity')).filter(name => name.startsWith('codex-')).length;
async function until(check, label, timeout = 35_000) {
	const start = performance.now();
	while (!await check()) {
		assert.ok(performance.now() - start < timeout, `${label} timed out`);
		await Bun.sleep(50);
	}
	return performance.now() - start;
}
const results = [];
const record = result => { results.push(result); console.log(JSON.stringify(result)); };
let server;
let observer;
let abort;
try {
	// Explicit consent in a disposable profile, using the ordinary native review API.
	// The production observer never approves or changes hooks.
	const review = await withCodexRecall(rpc => reviewRecall(rpc, 'fhold@fhold-plugins'), options);
	assert.equal(review.status, 'approval-needed');
	server = Bun.spawn(['codex', 'app-server', '--listen', 'unix://'], { env, cwd: workdir, stdout: 'ignore', stderr: 'ignore' });
	abort = new AbortController();
	observer = monitorCodexActivity({ env, root: runtime, signal: abort.signal, alive: () => server.exitCode === null && !abort.signal.aborted });
	await until(() => existsSync(join(home, 'app-server-control/app-server-control.sock')), 'native socket');
	await Bun.sleep(500);
	assert.equal(ready(), false, 'Unapproved hooks must not establish coverage');
	await withCodexControl(async rpc => {
		const current = await reviewRecall(rpc, 'fhold@fhold-plugins');
		await changeRecall(rpc, 'approve', current.digest, 'fhold@fhold-plugins');
	}, { env });
	record({ case: 'unused native server after explicit late consent', readyMs: await until(ready, 'unused coverage'), busy: busy() });
	assert.equal(busy(), 0);
	for (let interval = 0; interval < 3; interval++) {
		await Bun.sleep(20_000);
		assert.equal(ready(), true);
		assert.equal(busy(), 0);
	}
	record({ case: 'unused native coverage retained', quietIntervals: 3, intervalMs: 20_000 });
	await withCodexControl(async rpc => {
		const threadId = (await rpc('thread/start', { cwd: workdir, sandbox: 'workspace-write', approvalPolicy: 'on-request' })).thread.id;
		const start = async scenario => {
			mode = scenario;
			const before = requests;
			const turn = (await rpc('turn/start', { threadId, input: [{ type: 'text', text: 'Disposable native lifecycle regression.' }] })).turn;
			await until(() => requests > before, 'native provider request');
			return turn.id;
		};
		const terminal = async status => until(async () => {
			const turns = await rpc('thread/turns/list', { threadId, limit: 1, itemsView: 'notLoaded' });
			return turns.data[0]?.status === status;
		}, `native ${status} turn`);
		await start('complete'); await terminal('completed');
		record({ case: 'completed turn', clearMs: await until(() => busy() === 0, 'completed idle') });
		await start('fail'); await terminal('failed');
		record({ case: 'failed turn', clearMs: await until(() => busy() === 0, 'failed idle') });
		// A fresh active turn must survive repeated inspections of the previous failure.
		const turnId = await start('hold');
		const quietStart = performance.now();
		while (performance.now() - quietStart < 45_000) {
			assert.ok(busy() > 0, 'Quiet active turn was cleared by an older failure');
			await Bun.sleep(250);
		}
		await rpc('turn/interrupt', { threadId, turnId }); await terminal('interrupted');
		record({ case: 'quiet active then interrupted', protectedMs: performance.now() - quietStart, clearMs: await until(() => busy() === 0, 'interrupted idle') });
		await start('fail'); await terminal('failed');
		record({ case: 'repeated failed turn', clearMs: await until(() => busy() === 0, 'repeated failed idle') });
		// Native revocation is a genuine observation failure, with the server still running.
		const current = await reviewRecall(rpc, 'fhold@fhold-plugins');
		await changeRecall(rpc, 'disable', current.digest, 'fhold@fhold-plugins');
		record({ case: 'native hooks disabled', unknownMs: await until(() => !ready(), 'lost native coverage'), serverRunning: server.exitCode === null });
	}, { env, timeoutMs: 180_000 });
	assert.equal(server.exitCode, null);
	console.log(JSON.stringify({ nativeBinary: Bun.spawnSync(['codex', '--version']).stdout.toString().trim(), provider: 'offline controlled fixture', sandbox: 'workspace-write', accountQualification: false, results }));
} finally {
	abort?.abort();
	await observer;
	server?.kill();
	if (server) await server.exited;
	for (const controller of held) { try { controller.close(); } catch { /* interrupted connection */ } }
	provider.stop(true);
}

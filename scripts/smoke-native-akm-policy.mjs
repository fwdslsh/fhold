#!/usr/bin/env bun
// Execute inside a disposable candidate image. Only synthetic accounts, native
// APIs and a loopback model are used; product files and PATH are not repaired.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenCode } from '/opt/fhold/tools/node_modules/@opencode/client/dist/promise/index.js';

const root = mkdtempSync(join(tmpdir(), 'fhold-native-akm-policy-'));
const requests = [];
const marker = 'FH_PRIVATE_RECALL_7e31';
const prompt = 'Investigate the token budget and lean release verification for our design';
const extractReply = JSON.stringify({ candidates: [{
	type: 'knowledge', name: 'native-recovery-observation',
	description: 'Native recovery checks preserve the independently verified bundle ownership.',
	when_to_use: '', body: 'The synthetic native integration verified bundle ownership before publication and preserved the original operator configuration without a compatibility converter.',
	confidence: 0.99, evidence: 'The operator explicitly described the verified bundle ownership finding.'
}], rationale_if_empty: '' });
const model = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
	if (new URL(request.url).pathname.endsWith('/models')) return Response.json({ data: [{ id: 'model' }] });
	const body = await request.json();
	requests.push(body);
	const supplied = body.messages.map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
	const extraction = supplied.includes('extracting durable engineering insights');
	const author = supplied.match(/Author a new akm stash asset of type "([^"]+)" named "([^"]+)"/);
	const content = extraction ? extractReply : author ? JSON.stringify({
		ref: `${author[1] === 'memory' ? 'memories' : 'instructions'}/${author[2]}`,
		content: '---\ndescription: Native prompt learning preserves the synthetic desk plant observation.\n---\n# Synthetic desk plant\nThe operator explicitly stated that the synthetic desk plant is named Marigold. This reviewable proposal preserves that observation without accepting it automatically.\n', confidence: 0.99
	}) : 'FH_NATIVE_COMPLETE. We fixed the synthetic root cause because the native catalog must remain available to child agents.';
	const chunk = (delta, finish_reason) => ({ id: 'synthetic', object: 'chat.completion.chunk', created: 1780000000,
		model: 'model', choices: [{ index: 0, delta, finish_reason }] });
	if (body.stream) return new Response(`data: ${JSON.stringify(chunk({ role: 'assistant', content }, null))}\n\ndata: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
	return Response.json({ id: 'synthetic', object: 'chat.completion', model: 'model',
		choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
} });
const env = { ...process.env, HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'),
	XDG_DATA_HOME: join(root, 'home/.local/share'), XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'),
	AKM_BUNDLE_DIR: join(root, 'bundle'), AKM_CONFIG_DIR: join(root, 'akm'),
	AKM_STATE_DIR: join(root, 'akm-state'), AKM_DATA_DIR: join(root, 'akm-data'), AKM_CACHE_DIR: join(root, 'akm-cache'),
	FH_RUNTIME_DIR: join(root, 'runtime'), AKM_AUTO_MEMORY: '0', AKM_AUTO_LEARNING: '0', AKM_CURATE_MIN_SCORE: '0',
	OPENCODE_SERVER_PASSWORD: 'synthetic-native-policy', OPENCODE_CONFIG_DIR: join(root, 'system'),
	OPENCODE_CONFIG: join(root, 'config/opencode/opencode.json') };
for (const path of ['home', 'config/opencode', 'data', 'state', 'cache', 'bundle/knowledge', 'akm', 'runtime', 'project/.opencode/skills/project-native'])
	mkdirSync(join(root, path), { recursive: true });
cpSync('/etc/opencode', env.OPENCODE_CONFIG_DIR, { recursive: true });
writeFileSync(join(root, 'bundle/knowledge/lean-release-verification.md'), `---\ndescription: Lean release verification and token budget design knowledge ${marker}.\n---\n# Lean verification\n${marker}\n`);
writeFileSync(join(root, 'project/.opencode/skills/project-native/SKILL.md'), '---\nname: project-native\ndescription: Synthetic project skill discovery probe.\n---\nNative project skill.\n');
writeFileSync(join(root, 'project/opencode.json'), JSON.stringify({ agents: {
	'project-native': { mode: 'primary', description: 'Native project configuration probe' }
} }));
const config = JSON.parse(readFileSync('/assistant-defaults/config/akm/config.json', 'utf8'));
config.bundles.stash.path = env.AKM_BUNDLE_DIR;
writeFileSync(join(env.AKM_CONFIG_DIR, 'config.json'), JSON.stringify(config));
writeFileSync(env.OPENCODE_CONFIG, JSON.stringify({ model: 'fixture/model', default_agent: 'analyst',
	providers: { fixture: { package: '@opencode/ai/providers/openai-compatible', settings: {
		baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: 'synthetic' },
		models: { model: { capabilities: { tools: true, input: ['text'], output: ['text'] } } } } },
	agents: { analyst: { mode: 'primary', description: 'Custom primary native analyst' },
		specialist: { mode: 'subagent', description: 'Custom native subagent' } },
	permissions: [{ action: '*', resource: '*', effect: 'allow' }] }));
const cwd = join(root, 'project');
async function run(args, overrides = {}) {
	const child = Bun.spawn(args, { cwd, env: { ...env, ...overrides }, stdout: 'pipe', stderr: 'pipe' });
	const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	assert.equal(code, 0, `${args.join(' ')}: ${err}\n${out}`);
	return out;
}
await run(['akm', 'index']);
assert.match(await run(['akm', 'curate', prompt, '-q']), /lean-release-verification/);
const logFile = Bun.file(join(root, 'server.log'));
let server = Bun.spawn(['opencode', 'serve', '--hostname', '127.0.0.1', '--port', '4097'], {
	cwd, env, stdout: logFile, stderr: logFile
});
const client = OpenCode.make({ baseUrl: 'http://127.0.0.1:4097', headers: {
	authorization: `Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}` } });
const location = { directory: cwd };
async function until(probe, label) {
	const end = Date.now() + 30_000;
	while (Date.now() < end) { try { if (await probe()) return; } catch {} await Bun.sleep(100); }
	throw Error(`${label}\n${await logFile.text()}`);
}
async function turn(session, text = prompt) {
	const start = requests.length;
	await client.session.prompt({ sessionID: session.id, text });
	await until(() => requests.length > start, 'Native model request');
	await until(async () => !(await client.session.active())[session.id], 'Native completion');
	return requests.slice(start).find((request) => JSON.stringify(request.messages).includes(text));
}
try {
	await until(async () => (await client.agent.list({ location })).data.some((agent) => agent.id === 'analyst'), 'Native plugin/agent activation');
	await until(async () => (await client.agent.list({ location })).data.some((agent) => agent.id === 'project-native'), 'Native project configuration discovery');
	await until(async () => (await client.skill.list({ location })).data.some((skill) => skill.name === 'project-native'), 'Native project skill discovery');
	const sessions = [];
	for (const agent of ['build', 'plan', 'analyst', undefined, 'specialist']) {
		const session = await client.session.create({ location, title: 'Native AKM policy fixture', ...(agent ? { agent } : {}) });
		sessions.push(session);
		const request = await turn(session);
		assert.ok(JSON.stringify(request.messages).includes(marker), `Native ${agent ?? 'custom default'} lacks automatic AKM context`);
		assert.ok(JSON.stringify(request.messages).includes('token budget'), 'Benign recall prompt was lost');
		const offered = request.tools?.map((tool) => tool.function.name) ?? [];
		for (const tool of ['akm_search', 'akm_show', 'akm_curate', 'akm_remember', 'akm_feedback'])
			assert.ok(offered.includes(tool), `${agent ?? 'default'} lacks ${tool}`);
	}
	const mixed = sessions[2];
	await client.session.switchAgent({ sessionID: mixed.id, agent: 'build' });
	assert.ok(JSON.stringify((await turn(mixed)).messages).includes(marker), 'Mixed native agent history lost recall');
	for (const agent of ['remote', 'remote-read', 'remote-full']) {
		const full = agent === 'remote-full';
		const remote = await client.session.create({ location, agent, title: 'Synthetic Guardian scope' });
		await client.session.update({ sessionID: remote.id, metadata: { fholdGuardian: { principal: 'fixture' }, fholdGuardianKnowledge: full } });
		const request = await turn(remote);
		assert.equal(JSON.stringify(request.messages).includes(marker), full, 'Guardian automatic context exceeded credential scope');
		if (full) {
			await client.session.update({ sessionID: remote.id, metadata: { fholdGuardian: { principal: 'fixture' }, fholdGuardianKnowledge: false } });
			// Historical full-authority conversation text cannot be revoked; inspect
			// only newly generated system context after the credential downgrade.
			const downgraded = await turn(remote);
			assert.equal(JSON.stringify(downgraded.messages.filter((m) => m.role === 'system')).includes(marker), false);
		}
	}
	// Ordinary native child dispatch must inherit nonstandard AKM locations,
	// without a fhold launcher, config alias or environment repair.
	const dispatched = await run(['akm', 'agent', '--prompt', prompt, '-q']);
	assert.match(dispatched, /FH_NATIVE_COMPLETE/);
	assert.ok(JSON.stringify(requests.at(-1).messages).includes(marker), 'Native child lost AKM catalog locations');
	// The shipped native harness owns bounded model work and reuses native auth.
	await turn(sessions[0], `Investigation evidence: the independently verified native bundle ownership remained intact after the recovery fix. ${'We inspected native configuration, reproduced the failure, verified ownership and preserved the operator settings. '.repeat(30)}`);
	assert.doesNotMatch(await run(['akm', 'proposal', 'list', '-q']), /native-recovery-observation/, 'Explicit off must prevent automatic extraction');
	const extraction = await run(['akm', 'proposal', 'extract', '--type', 'opencode', '--session-id', sessions[0].id, '--force', '--timeout-ms', '30000', '-q']);
	assert.match(extraction, /opencode/);
	writeFileSync(join(root, 'extraction.json'), extraction);
	assert.ok(requests.some((body) => JSON.stringify(body.messages).includes('extracting durable engineering insights')), 'Native extraction did not reach configured model');
	assert.match(await run(['akm', 'proposal', 'list', '-q']), /native-recovery-observation/);
	assert.ok(requests.filter((body) => JSON.stringify(body.messages).includes('extracting durable engineering insights')).length <= 2, 'Native utility inference recursed');
	const before = readFileSync(join(env.AKM_CONFIG_DIR, 'config.json'), 'utf8');
	const broken = Bun.spawn(['akm', 'proposal', 'extract', '--type', 'opencode', '--session-id', sessions[0].id, '--force', '--harness', 'missing-native-harness', '-q'], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
	const [brokenOut, brokenError, brokenCode] = await Promise.all([new Response(broken.stdout).text(), new Response(broken.stderr).text(), broken.exited]);
	assert.notEqual(brokenCode, 0);
	assert.match(brokenOut + brokenError, /harness|config/i);
	assert.ok(await turn(sessions[1], 'Optional learning failed; complete this native prompt normally.'), 'Missing engine blocked the primary agent');
	writeFileSync(join(env.AKM_CONFIG_DIR, 'config.json'), before);
	// Native enabled defaults must also drive the real plugin lifecycle. Restart
	// only this synthetic server so its process environment changes normally.
	server.kill(); await server.exited;
	env.AKM_AUTO_MEMORY = '1'; env.AKM_AUTO_LEARNING = '1';
	server = Bun.spawn(['opencode', 'serve', '--hostname', '127.0.0.1', '--port', '4097'], { cwd, env, stdout: logFile, stderr: logFile });
	await until(async () => (await client.agent.list({ location })).data.some((agent) => agent.id === 'analyst'), 'Native enabled plugin activation');
	const learned = await client.session.create({ location, agent: 'analyst', title: 'Native automatic learning' });
	const extractionCount = requests.filter((request) => JSON.stringify(request.messages).includes('extracting durable engineering insights')).length;
	await turn(learned, `Remember that my synthetic desk plant is named Marigold. ${'We fixed the native integration root cause, verified bundle ownership, preserved operator settings and checked the recovery result independently. '.repeat(30)}`);
	const eventFile = join(env.XDG_STATE_HOME, 'akm-opencode/events.jsonl');
	await until(() => existsSync(eventFile) && readFileSync(eventFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).some((event) => event.event === 'learning_proposal' && event.sessionId === learned.id && event.outcome?.status === 'ok'), 'Native prompt learning proposal');
	await until(() => requests.filter((request) => JSON.stringify(request.messages).includes('extracting durable engineering insights')).length > extractionCount, 'Native automatic session extraction');
	await Bun.sleep(500);
	assert.ok(requests.filter((request) => JSON.stringify(request.messages).includes('extracting durable engineering insights')).length <= extractionCount + 3, 'Native automatic utility work recursed');
	console.log('Native custom/default/subagent/mixed recall, five offered tools, token-budget text, Guardian context scope and native extraction proposals passed.');
	console.log(`Synthetic evidence: ${root}`);
} finally {
	server.kill(); await server.exited; model.stop(true);
}

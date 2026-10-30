import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnoseNativeRuntime } from './native-diagnostics.js';
import { withAssistantEndpoint } from './opencode.js';

const roots: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const originalDocker = process.env.FH_DOCKER_BIN;
afterEach(() => {
	if (originalDocker === undefined) delete process.env.FH_DOCKER_BIN;
	else process.env.FH_DOCKER_BIN = originalDocker;
	for (const server of servers.splice(0)) server.stop(true);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'fhold-native-doctor-'));
	roots.push(root);
	mkdirSync(join(root, 'state/secrets'), { recursive: true });
	mkdirSync(join(root, 'knowledge/secrets'), { recursive: true });
	writeFileSync(join(root, 'state/secrets/fhold_opencode_password'), 'synthetic-password');
	const state = {
		running: true, unreachable: false, credential: true, generate: 'FH_READY',
		info: { schemaVersion: 1, version: '0.10.261019', connectionsAndHarnesses: [
			{ type: 'harness', name: 'opencode', installed: true },
			{ type: 'process', process: 'agents', kind: 'harness', target: 'opencode' }
		], semanticSearch: { status: 'disabled' } } as Record<string, unknown>,
		migration: { schemaVersion: 1, status: 'current' } as Record<string, unknown>,
		tasks: { backend: 'cron', bindings: [], warnings: [], improveAutonomy: { enabled: false } } as Record<string, unknown>
	};
	const statePath = join(root, 'fixture.json');
	const log = join(root, 'calls.jsonl');
	const binary = join(root, 'docker');
	writeFileSync(binary, `#!${process.execPath}
import { readFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf8'));
let value;
if (args.includes('ps')) value = [{Service:'assistant',State:state.running ? 'running' : 'exited',ID:'fixture'}];
else if (args.includes('info')) value = state.info;
else if (args.includes('migrate')) { value = state.migration; if(value.status==='blocked') process.exitCode=1; }
else if (args.includes('task')) value = state.tasks;
else throw Error('Unexpected Docker command');
console.log(typeof value === 'string' ? value : JSON.stringify(value));
`, { mode: 0o700 });
	process.env.FH_DOCKER_BIN = binary;
	const http: string[] = [];
	const model = { id: 'model', providerID: 'fixture', capabilities: { tools: true, input: ['text'], output: ['text'] } };
	const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
		const path = new URL(request.url).pathname;
		http.push(`${request.method} ${path}`);
		if (state.unreachable) return new Response('synthetic-secret-not-for-report', { status: 503 });
		const data = (value: unknown) => Response.json({ data: value });
		if (path === '/api/info') return Response.json({ version: '2.2.1' });
		if (path === '/api/provider') return data([{ id: 'fixture', name: 'Fixture' }]);
		if (path === '/api/integration') return data([{ id: 'fixture', connections: [{ type: state.credential ? 'credential' : 'config' }] }]);
		if (path === '/api/model') return data([model]);
		if (path === '/api/model/default') return data(model);
		if (path === '/api/experimental/generate') return data({ text: state.generate });
		return new Response('Unexpected request', { status: 500 });
	} });
	servers.push(server);
	return { root, state, http, async diagnose(readiness = false) {
		writeFileSync(statePath, JSON.stringify(state));
		return withAssistantEndpoint(root, server.url.toString(), () => diagnoseNativeRuntime(root, {
			projectDirectory: root, files: [], envFiles: [], profiles: []
		}, { readiness }));
	}, commands: () => readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]) };
}

test.each([undefined, '{}', '{"not-a-provider":"not-a-credential"}', '{broken'])('native providers ignore legacy auth input %s and never generate by default', async (legacy) => {
	const f = fixture();
	if (legacy !== undefined) writeFileSync(join(f.root, 'knowledge/secrets/auth.json'), legacy);
	const checks = await f.diagnose();
	expect(checks.find((check) => check.name === 'OpenCode providers')?.status).toBe('pass');
	expect(checks.find((check) => check.name === 'AKM proposal persistence')?.status).toBe('not-checked');
	expect(f.http.every((call) => call.startsWith('GET '))).toBe(true);
	expect(f.commands().filter((args) => args.includes('exec')).map((args) => args.slice(args.indexOf('akm') + 1))).toEqual(expect.arrayContaining([
		['info', '--format', 'json', '--quiet'], ['migrate', 'status', '--format', 'json', '--quiet'], ['task', 'doctor', '--format', 'json', '--quiet']
	]));
	expect(f.commands()).toHaveLength(4);
});

test('no-key native endpoint is connected without credential requirements', async () => {
	const f = fixture(); f.state.credential = false;
	const provider = (await f.diagnose()).find((check) => check.name === 'OpenCode providers');
	expect(provider?.status).toBe('pass');
	expect(provider?.detail).toContain('0 with native credentials');
});

test('stale legacy credentials do not pass unavailable native state', async () => {
	const f = fixture(); f.state.unreachable = true;
	writeFileSync(join(f.root, 'knowledge/secrets/auth.json'), '{"saved":"synthetic-secret"}');
	const checks = await f.diagnose();
	expect(checks.find((check) => check.name === 'OpenCode providers')?.status).toBe('not-checked');
	expect(JSON.stringify(checks)).not.toContain('synthetic-secret');
});

test('stopped Assistant skips all native inspection and refuses explicit readiness', async () => {
	const f = fixture(); f.state.running = false;
	const checks = await f.diagnose(true);
	expect(checks.every((check) => check.status === 'not-checked')).toBe(true);
	expect(checks.at(-1)?.ok).toBe(false);
	expect(f.commands()).toHaveLength(1);
	expect(f.http).toHaveLength(0);
});

test.each(['FH_READY', 'not ready'])('model requests run only for explicit readiness: %s', async (reply) => {
	const f = fixture(); f.state.generate = reply;
	expect((await f.diagnose(true)).find((check) => check.name === 'live provider readiness')?.ok).toBe(reply === 'FH_READY');
	expect(f.http.filter((call) => call.startsWith('POST '))).toEqual(['POST /api/experimental/generate']);
});

test('malformed configuration, missing harness and migration blockers degrade independently, then recover', async () => {
	const f = fixture();
	f.state.info.configError = 'Invalid JSON containing synthetic-secret';
	f.state.migration.status = 'blocked';
	let checks = await f.diagnose();
	expect(checks.find((check) => check.name === 'AKM configuration')?.status).toBe('warn');
	expect(checks.find((check) => check.name === 'AKM harnesses')?.status).toBe('not-checked');
	expect(checks.find((check) => check.name === 'AKM migrations')?.status).toBe('warn');
	expect(JSON.stringify(checks)).not.toContain('synthetic-secret');
	delete f.state.info.configError;
	f.state.info.connectionsAndHarnesses = [{ type: 'harness', installed: false }];
	f.state.tasks.warnings = ['synthetic-secret'];
	checks = await f.diagnose();
	expect(checks.find((check) => check.name === 'AKM harnesses')?.status).toBe('warn');
	expect(checks.find((check) => check.name === 'AKM tasks')?.status).toBe('warn');
	f.state.info.connectionsAndHarnesses = [{ type: 'harness', installed: true }];
	f.state.migration.status = 'current'; f.state.tasks.warnings = [];
	checks = await f.diagnose();
	expect(checks.filter((check) => check.status === 'warn')).toEqual([]);
	expect(checks.find((check) => check.name === 'AKM semantic search')?.status).toBe('off');
	expect(checks.find((check) => check.name === 'AKM improve autonomy')?.status).toBe('off');
});

test('external-only catalog does not imply a writable proposal queue', async () => {
	const f = fixture();
	f.state.info.sourceProviders = [{ type: 'local', path: '/readonly', name: 'external' }];
	const checks = await f.diagnose();
	expect(checks.find((check) => check.name === 'AKM proposal persistence')?.status).toBe('not-checked');
	expect(f.http.every((call) => call.startsWith('GET '))).toBe(true);
});

test('unrecognized or truncated native reports are never accepted as success', async () => {
	const f = fixture(); f.state.info = {}; f.state.tasks = {}; f.state.migration = {};
	expect((await f.diagnose()).filter((check) => check.name.startsWith('AKM ')).every((check) => check.status === 'not-checked')).toBe(true);
});

import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnoseNativeRuntime } from './native-diagnostics.js';
import { defaultStackConfig, writeStackConfig } from './stack-config.js';

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
		health: healthReport() as unknown, healthExit: 0,
		migration: { schemaVersion: 1, status: 'current' } as Record<string, unknown>
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
else if (args.includes('doctor')) { value = state.health; process.exitCode=state.healthExit; process.stderr.write('synthetic-secret-native-stderr'); }
else if (args.includes('akm-migrate')) { value = state.migration; if(value.status==='blocked') process.exitCode=1; }
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
	const config = defaultStackConfig();
	config.assistant.port = server.port as number;
	writeStackConfig(root, config);
	return { root, state, http, async diagnose(readiness = false) {
		writeFileSync(statePath, JSON.stringify(state));
		return diagnoseNativeRuntime(root, {
			projectDirectory: root, files: [], envFiles: [], profiles: []
		}, { readiness });
	}, commands: () => readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]) };
}

function healthReport(status = 'pass', hardChecks = [{ name: 'state-db-integrity', status: 'pass' }], advisories = [{ name: 'proposal-queue', status: 'unknown' }]): Record<string, unknown> {
	return { schemaVersion: 3, status, hardChecks, advisories, scheduler: { bindings: [{ argv: ['/private/akm'], taskIds: ['news'], status: ['ok'] }], warnings: [] } };
}

test.each([undefined, '{}', '{"not-a-provider":"not-a-credential"}', '{broken'])('native providers ignore legacy auth input %s and never generate by default', async (legacy) => {
	const f = fixture();
	if (legacy !== undefined) writeFileSync(join(f.root, 'knowledge/secrets/auth.json'), legacy);
	const checks = await f.diagnose();
	expect(checks.find((check) => check.name === 'OpenCode providers')?.status).toBe('pass');
	expect(checks.find((check) => check.name === 'AKM proposal-queue')?.status).toBe('not-checked');
	expect(f.http.every((call) => call.startsWith('GET '))).toBe(true);
	expect(f.commands().find((args) => args.includes('akm-migrate'))?.slice(-2)).toEqual(['akm-migrate', 'status']);
	expect(f.commands().some((args) => args.includes('task'))).toBe(false);
	expect(checks.find((check) => check.name === 'AKM tasks')?.status).toBe('pass');
	const health = f.commands().find((args) => args.includes('doctor')) ?? [];
	expect(health.slice(health.indexOf('--project-directory'), health.indexOf('--project-directory') + 2)).toEqual(['--project-directory', f.root]);
	expect(health.slice(health.indexOf('exec'))).toEqual(['exec', '-T', 'assistant', 'timeout', '--kill-after=2s', '10s',
		'akm', 'doctor', '--read-only', '--no-probe', '--format', 'json', '--quiet']);
	expect(JSON.stringify(checks)).not.toContain('synthetic-secret');
	expect(f.commands()).toHaveLength(3);
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

test('unavailable native health and migration blockers degrade independently, then recover', async () => {
	const f = fixture();
	f.state.healthExit = 78;
	f.state.migration.status = 'blocked';
	let checks = await f.diagnose();
	expect(checks.find((check) => check.name === 'AKM health')?.status).toBe('not-checked');
	expect(checks.find((check) => check.name === 'AKM migrations')?.status).toBe('warn');
	expect(JSON.stringify(checks)).not.toContain('synthetic-secret');
	f.state.healthExit = 4;
	f.state.health = healthReport('warn', [{ name: 'connections-and-harnesses', status: 'warn' }]);
	checks = await f.diagnose();
	expect(checks.find((check) => check.name === 'AKM connections-and-harnesses')?.status).toBe('warn');
	expect(checks.find((check) => check.name === 'AKM tasks')?.status).toBe('pass');
	f.state.healthExit = 0;
	f.state.health = healthReport();
	f.state.migration.status = 'current';
	checks = await f.diagnose();
	expect(checks.filter((check) => check.status === 'warn')).toEqual([]);
	expect(checks.find((check) => check.name === 'AKM tasks')?.status).toBe('pass');
});

test.each([
	[{ bindings: [{ argv: ['/private/akm'], taskIds: ['news'], status: ['missing-path'] }], warnings: [] }, 'warn'],
	[{ bindings: [], warnings: ['synthetic-secret'] }, 'warn'],
	[{ bindings: [], warnings: [] }, 'pass'],
	[undefined, 'not-checked'],
	[{ bindings: 'synthetic-secret' }, 'not-checked']
])('task bindings come from the same read-only native report without private evidence: %j', async (scheduler, status) => {
	const f = fixture(); f.state.health = { ...healthReport(), scheduler };
	const checks = await f.diagnose();
	expect(checks.find((check) => check.name === 'AKM tasks')).toMatchObject({ status, advisory: true });
	expect(JSON.stringify(checks)).not.toContain('synthetic-secret');
	expect(JSON.stringify(checks)).not.toContain('/private');
	expect(f.commands()).toHaveLength(3);
});

test('native plugin mismatch and unknown proposal outcomes retain native statuses without private evidence', async () => {
	const f = fixture();
	f.state.health = { ...healthReport('warn', [{ name: 'state-db-integrity', status: 'pass' }], [
		{ name: 'plugin-version', status: 'warn' }, { name: 'codex-plugin-version', status: 'warn' }, { name: 'proposal-queue', status: 'unknown' }
	]), evidence: { credentials: 'synthetic-secret', path: '/private' }, message: 'synthetic-secret' };
	const checks = await f.diagnose();
	expect(checks.find((check) => check.name === 'AKM plugin-version')?.status).toBe('warn');
	expect(checks.find((check) => check.name === 'AKM codex-plugin-version')?.status).toBe('warn');
	expect(checks.find((check) => check.name === 'AKM proposal-queue')?.status).toBe('not-checked');
	expect(JSON.stringify(checks)).not.toContain('synthetic-secret');
	expect(JSON.stringify(checks)).not.toContain('/private');
	expect(f.http.every((call) => call.startsWith('GET '))).toBe(true);
});

test.each(['state-db-readable', 'state-db-integrity'])('native unavailable/corrupt state stays failed and advisory: %s', async (name) => {
	const f = fixture(); f.state.health = healthReport('fail', [{ name, status: 'fail' }], []);
	f.state.healthExit = 1;
	const checks = await f.diagnose();
	expect(checks.find((check) => check.name === `AKM ${name}`)).toMatchObject({ status: 'fail', ok: false, advisory: true });
	expect(checks.find((check) => check.name === 'AKM health')).toMatchObject({ status: 'fail', ok: false, advisory: true });
	expect(checks.every((check) => check.ok || check.advisory)).toBe(true);
	expect(f.commands().every((args) => !args.some((arg) => ['start', 'restart', 'up', 'apply'].includes(arg)))).toBe(true);
});

test.each([1, 4, 124, 137])('native command errors never become healthy reports: exit %s', async (code) => {
	const f = fixture(); f.state.healthExit = code;
	f.state.health = { ok: false, code: 'CONFIG_INVALID', error: 'synthetic-secret' };
	const checks = await f.diagnose();
	expect(checks.find((check) => check.name === 'AKM health')?.status).toBe('not-checked');
	expect(JSON.stringify(checks)).not.toContain('synthetic-secret');
});

test.each([{}, '{truncated', healthReport('pass', []), healthReport('pass', [{ name: 'unexpected/private-path', status: 'pass' }]), healthReport('pass', [{ name: 'state-db-integrity', status: 'unrecognized' }])])('unrecognized or truncated native reports never pass: %j', async (report) => {
	const f = fixture(); f.state.health = report; f.state.migration = {};
	expect((await f.diagnose()).filter((check) => check.name.startsWith('AKM ')).every((check) => check.status === 'not-checked')).toBe(true);
});

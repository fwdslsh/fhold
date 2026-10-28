import { afterEach, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	activity,
	activityStatus,
	coverage,
	initialize,
	keepaliveConfig,
	nativeEvent,
	tick
} from '../plugins/fhold/scripts/activity.mjs';
import openCodePlugin, { observeOpenCode } from '../plugins/fhold/opencode.js';

const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'fhold-activity-'));
	roots.push(root);
	initialize(
		{
			FH_KEEPALIVE_URL: 'https://instance.example/api/info',
			FH_CODEX_REMOTE: '0',
			FH_CLAUDE_REMOTE: '0'
		},
		root
	);
	coverage('opencode', true, root);
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const event = (root: string, name: string, extra = {}, tool = 'codex', session = 'session-a') =>
	nativeEvent(tool, { session_id: session, turn_id: 'turn-a', hook_event_name: name, ...extra }, root);

test('a quiet, observed runtime sends no request; a turn has no time-based expiry', async () => {
	const root = fixture();
	let requests = 0;
	const fetch = async () => {
		requests++;
		return new Response(null);
	};
	expect((await tick({ root, fetch })).activity).toBe('idle');
	expect(requests).toBe(0);
	event(root, 'UserPromptSubmit');
	const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
	for (const name of readdirSync(join(root, 'activity')))
		utimesSync(join(root, 'activity', name), yesterday, yesterday);
	for (let i = 0; i < 3; i++) expect((await tick({ root, fetch })).activity).toBe('busy');
	expect(requests).toBe(3);
	event(root, 'Stop');
	expect((await tick({ root, fetch })).activity).toBe('idle');
	expect(requests).toBe(3);
});

test('overlapping sessions, tools, subagents and interrupted turns retain independent activity', () => {
	const root = fixture();
	event(root, 'UserPromptSubmit');
	event(root, 'PreToolUse', { tool_use_id: 'shell-1' });
	event(root, 'PreToolUse', { tool_use_id: 'shell-2' });
	event(root, 'SubagentStart', { agent_id: 'agent-1' });
	event(root, 'UserPromptSubmit', {}, 'codex', 'session-b');
	event(root, 'Interrupt');
	event(root, 'PostToolUse', { tool_use_id: 'shell-1' });
	event(root, 'SubagentStop', { agent_id: 'agent-1' });
	expect(activityStatus(root, [])).toBe('busy');
	event(root, 'PostToolUse', { tool_use_id: 'shell-2' });
	expect(activityStatus(root, [])).toBe('busy');
	event(root, 'Stop', {}, 'codex', 'session-b');
	expect(activityStatus(root, [])).toBe('idle');
});

test('compaction and resume do not erase active work; duplicate notifications are idempotent', () => {
	const root = fixture();
	event(root, 'UserPromptSubmit');
	event(root, 'UserPromptSubmit');
	event(root, 'SessionStart', { source: 'compact' });
	event(root, 'SessionStart', { source: 'resume' });
	expect(activityStatus(root, [])).toBe('busy');
	event(root, 'Stop');
	event(root, 'Stop');
	expect(activityStatus(root, [])).toBe('idle');
});

test('Codex late completion cannot clear a newer turn and missing turn identity is refused', () => {
	const root = fixture();
	event(root, 'UserPromptSubmit', { turn_id: 'earlier' });
	event(root, 'UserPromptSubmit', { turn_id: 'newer' });
	event(root, 'Stop', { turn_id: 'earlier' });
	expect(activityStatus(root, [])).toBe('busy');
	for (const turn_id of [undefined, null, '', 7])
		expect(() => event(root, 'Stop', { turn_id })).toThrow('turn identity');
	expect(activityStatus(root, [])).toBe('busy');
	event(root, 'Stop', { turn_id: 'newer' });
	expect(activityStatus(root, [])).toBe('idle');
});

test('Claude background work, session wakeups and missing status keep the runtime awake', () => {
	const root = fixture();
	for (const extra of [
		{},
		{ background_tasks: [{ id: 'background' }], session_crons: [] },
		{ background_tasks: [], session_crons: [{ id: 'wakeup' }] }
	]) {
		event(root, 'UserPromptSubmit', {}, 'claude');
		event(root, 'Stop', extra, 'claude');
		expect(activityStatus(root, [])).toBe('busy');
	}
	event(root, 'Stop', { background_tasks: [], session_crons: [] }, 'claude');
	expect(activityStatus(root, [])).toBe('idle');
});

test('native session end only removes that session; no prompt, tool argument or path is retained', () => {
	const root = fixture();
	event(
		root,
		'PreToolUse',
		{ tool_use_id: 'a', tool_input: { password: 'never-store-this' } },
		'codex',
		'../../private/session'
	);
	event(root, 'UserPromptSubmit', { prompt: 'never-store-this' }, 'claude', 'other-session');
	event(root, 'SessionEnd', {}, 'codex', '../../private/session');
	expect(activityStatus(root, [])).toBe('busy');
	for (const file of readdirSync(join(root, 'activity'))) {
		expect(file).not.toContain('private');
		expect(file).not.toContain('other-session');
		expect(readFileSync(join(root, 'activity', file), 'utf8')).toBe('');
	}
});

test('unknown startup, unobserved native workers and consent waits fail awake', async () => {
	const root = fixture();
	mkdirSync(join(root, 'remote'));
	initialize({ FH_KEEPALIVE_URL: 'https://instance.example/', FH_CLAUDE_REMOTE: '0' }, root);
	let requests = 0;
	const fetch = async () => {
		requests++;
		return new Response(null);
	};
	expect((await tick({ root, fetch })).activity).toBe('unknown');
	coverage('opencode', true, root);
	writeFileSync(join(root, 'remote/codex.json'), JSON.stringify({ state: 'process-running' }));
	expect((await tick({ root, fetch })).activity).toBe('unknown');
	event(root, 'SessionStart');
	expect((await tick({ root, fetch })).activity).toBe('idle');
	writeFileSync(join(root, 'remote/codex.json'), JSON.stringify({ state: 'approval-needed' }));
	expect((await tick({ root, fetch })).activity).toBe('unknown');
	writeFileSync(join(root, 'remote/codex.json'), JSON.stringify({ state: 'waiting-to-retry' }));
	expect((await tick({ root, fetch })).activity).toBe('idle');
	expect(requests).toBe(3);
});

test('unsigned-in remotes are inactive, but observed work and unknown activated coverage stay awake', async () => {
	const root = fixture();
	mkdirSync(join(root, 'remote'));
	initialize({ FH_KEEPALIVE_URL: 'https://instance.example/' }, root);
	coverage('opencode', true, root);
	for (const tool of ['claude', 'codex'])
		writeFileSync(
			join(root, 'remote', `${tool}.json`),
			JSON.stringify({ state: 'sign-in-needed' })
		);
	let requests = 0;
	const fetch = async () => {
		requests++;
		return new Response(null);
	};
	expect((await tick({ root, fetch })).activity).toBe('idle');
	expect(requests).toBe(0);
	// Genuine native work takes precedence even if a supervisor is waiting.
	event(root, 'UserPromptSubmit');
	expect((await tick({ root, fetch })).activity).toBe('busy');
	event(root, 'Stop');
	writeFileSync(join(root, 'remote/codex.json'), JSON.stringify({ state: 'process-running' }));
	expect((await tick({ root, fetch })).activity).toBe('unknown');
	event(root, 'SessionStart');
	expect((await tick({ root, fetch })).activity).toBe('idle');
	writeFileSync(join(root, 'remote/claude.json'), JSON.stringify({ state: 'approval-needed' }));
	expect((await tick({ root, fetch })).activity).toBe('unknown');
	expect(requests).toBe(3);
});

test('a hook-reporting error remains unknown until a new boot', () => {
	const root = fixture();
	writeFileSync(join(root, 'activity/unknown'), '');
	expect(activityStatus(root, [])).toBe('unknown');
	initialize({}, root);
	coverage('opencode', true, root);
	expect(activityStatus(root, [])).toBe('idle');
});

test('a new boot clears old keep-alive failures; status reports failures without credentials', async () => {
	const root = fixture();
	event(root, 'UserPromptSubmit');
	await tick({ root, fetch: async () => new Response(null, { status: 503 }) });
	event(root, 'Stop');
	const script = join(import.meta.dir, '../plugins/fhold/scripts/activity.mjs');
	const child = Bun.spawn(['node', script, 'status'], {
		env: { ...process.env, FH_RUNTIME_DIR: root },
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const status = JSON.parse(await new Response(child.stdout).text());
	expect(await child.exited).toBe(1);
	expect(status.degraded).toBe(true);
	expect(status.activity).toBe('idle');
	expect(status).not.toHaveProperty('url');
	expect(status).not.toHaveProperty('authorization');
	initialize({}, root);
	expect(() => readFileSync(join(root, 'keepalive-status.json'))).toThrow();
});

async function withOpenCode(run: (observe: typeof observeOpenCode, root: string) => void | Promise<void>) {
	const root = fixture();
	const previous = process.env.FH_RUNTIME_DIR;
	process.env.FH_RUNTIME_DIR = root;
	try {
		await run(observeOpenCode, root);
	} finally {
		if (previous === undefined) delete process.env.FH_RUNTIME_DIR;
		else process.env.FH_RUNTIME_DIR = previous;
	}
}

test('normal native OpenCode plugin unload preserves idle and does not retire active work', async () => {
	await withOpenCode(async (observe, root) => {
		const setup = () =>
			openCodePlugin.setup({
				location: { directory: '/work' },
				event: {
					async *subscribe({ signal }: { signal: AbortSignal }) {
						await new Promise<void>((resolve) =>
							signal.addEventListener('abort', () => resolve(), { once: true })
						);
					}
				}
			});
		const cleanup = setup();
		cleanup();
		await Bun.sleep(0);
		expect(activityStatus(root, [])).toBe('idle');
		const nextCleanup = setup();
		observe({ type: 'session.execution.started', data: { sessionID: 'active' } });
		nextCleanup();
		await Bun.sleep(0);
		expect(activityStatus(root, [])).toBe('busy');
	});
});

for (const failure of ['end', 'throw']) {
	test(`an unexpected OpenCode event stream ${failure} remains conservative after cleanup`, async () => {
		await withOpenCode(async (_observe, root) => {
			const cleanup = openCodePlugin.setup({
				location: { directory: '/work' },
				event: {
					async *subscribe() {
						yield { type: 'session.message.created', data: { sessionID: 'idle' } };
						if (failure === 'throw') throw Error('fixture observation failure');
					}
				}
			});
			await Bun.sleep(0);
			expect(activityStatus(root, [])).toBe('unknown');
			cleanup();
			expect(activityStatus(root, [])).toBe('unknown');
		});
	});
}

test('an OpenCode observation failure does not reject a native event', async () => {
	await withOpenCode((observe, root) => {
		observe({ type: 'session.shell.started', data: { sessionID: 'a' } });
		expect(activityStatus(root, [])).toBe('unknown');
		observe({ type: 'session.idle', data: { sessionID: 'still-works' } });
		expect(activityStatus(root, [])).toBe('unknown');
	});
});

test('OpenCode append-only messages do not invent active work', async () => {
	await withOpenCode((observe, root) => {
		observe({
			type: 'session.message.created',
			data: { sessionID: 'append-only', message: { type: 'user' } }
		});
		expect(activityStatus(root, [])).toBe('idle');
	});
});

test('OpenCode tools, shells and terminal events preserve overlapping work', async () => {
	await withOpenCode((observe, root) => {
		const tool = (id: string, type: string, sessionID = 'a') =>
			observe({ type, data: { id, sessionID } });
		tool('one', 'session.tool.called');
		tool('two', 'session.tool.called');
		expect(activityStatus(root, [])).toBe('busy');
		tool('one', 'session.tool.failed');
		expect(activityStatus(root, [])).toBe('busy');
		tool('two', 'session.tool.success');
		expect(activityStatus(root, [])).toBe('idle');
		observe({ type: 'session.execution.started', data: { sessionID: 'a' } });
		observe({ type: 'session.shell.started', data: { sessionID: 'b', shell: { id: 'shell' } } });
		observe({ type: 'session.execution.interrupted', data: { sessionID: 'a' } });
		expect(activityStatus(root, [])).toBe('busy');
		observe({ type: 'session.shell.ended', data: { sessionID: 'b', shell: { id: 'shell' } } });
		expect(activityStatus(root, [])).toBe('idle');
		for (const type of [
			'session.execution.succeeded',
			'session.execution.failed',
			'session.idle',
			'session.deleted'
		]) {
			observe({ type: 'session.execution.started', data: { sessionID: 'a' } });
			observe({ type, data: { sessionID: 'a' } });
			expect(activityStatus(root, [])).toBe('idle');
		}
	});
});

test('Claude batch completion releases denied and cancelled tools without ending the turn', () => {
	const root = fixture();
	event(root, 'PreToolUse', { tool_use_id: 'denied' }, 'claude');
	event(root, 'PreToolUse', { tool_use_id: 'cancelled' }, 'claude');
	event(
		root,
		'PostToolBatch',
		{ tool_calls: [{ tool_use_id: 'denied' }, { tool_use_id: 'cancelled' }] },
		'claude'
	);
	expect(activityStatus(root, [])).toBe('busy');
	event(root, 'Stop', { background_tasks: [], session_crons: [] }, 'claude');
	expect(activityStatus(root, [])).toBe('idle');
});

test('Claude subagent completion refreshes the parent background-work inventory', () => {
	const root = fixture();
	event(root, 'SubagentStart', { agent_id: 'child' }, 'claude');
	event(root, 'Stop', { background_tasks: [{ id: 'child' }], session_crons: [] }, 'claude');
	expect(activityStatus(root, [])).toBe('busy');
	event(
		root,
		'SubagentStop',
		{ agent_id: 'child', background_tasks: [], session_crons: [] },
		'claude'
	);
	expect(activityStatus(root, [])).toBe('idle');
});

test('boot observations are reset without touching native user state', () => {
	const root = fixture();
	writeFileSync(join(root, 'user-state'), 'preserve');
	activity('opencode', 'a', 'turn', true, root);
	initialize({}, root);
	expect(readdirSync(join(root, 'activity'))).toEqual([]);
	expect(readFileSync(join(root, 'user-state'), 'utf8')).toBe('preserve');
});

test('keep-alive is opt-in and never implicitly forwards the native password', () => {
	expect(keepaliveConfig({ OPENCODE_SERVER_PASSWORD: 'secret' })).toEqual({ enabled: false });
	expect(
		keepaliveConfig({
			FH_KEEPALIVE_URL: 'https://other.example/',
			OPENCODE_SERVER_PASSWORD: 'secret'
		}).authorization
	).toBeUndefined();
	expect(
		keepaliveConfig({
			FH_KEEPALIVE_URL: 'https://instance.example/api/info',
			FH_KEEPALIVE_AUTH: 'opencode',
			OPENCODE_SERVER_PASSWORD: 'synthetic'
		}).authorization
	).toBe(`Basic ${Buffer.from('opencode:synthetic').toString('base64')}`);
	for (const url of [
		'ftp://host/',
		'https://user:secret@host/',
		'https://host/#fragment',
		'/relative'
	])
		expect(() => keepaliveConfig({ FH_KEEPALIVE_URL: url })).toThrow();
});

test('arbitrary endpoints accept a private authorization file; diagnostics never retain it', async () => {
	const root = fixture();
	const file = join(root, 'authorization');
	writeFileSync(file, 'Bearer synthetic-credential\n', { mode: 0o600 });
	initialize(
		{
			FH_KEEPALIVE_URL: 'https://example.invalid/?private=synthetic',
			FH_KEEPALIVE_AUTHORIZATION_FILE: file
		},
		root
	);
	let observed: RequestInit | undefined;
	const result = await tick({
		root,
		fetch: async (_url: string, init: RequestInit) => {
			observed = init;
			return new Response(null);
		}
	});
	expect(observed?.headers).toEqual({ Authorization: 'Bearer synthetic-credential' });
	expect(observed?.redirect).toBe('error');
	expect(observed?.signal).toBeInstanceOf(AbortSignal);
	expect(result.sent).toBe(true);
	expect(readFileSync(join(root, 'keepalive-status.json'), 'utf8')).not.toContain('synthetic');
	writeFileSync(file, 'Bearer a\nInjected: value');
	expect(() =>
		keepaliveConfig({
			FH_KEEPALIVE_URL: 'https://example.invalid/',
			FH_KEEPALIVE_AUTHORIZATION_FILE: file
		})
	).toThrow();
});

test('failed HTTP responses and network errors are redacted and retried on the next tick', async () => {
	const root = fixture();
	event(root, 'UserPromptSubmit');
	expect(
		(
			await tick({
				root,
				fetch: async () => new Response('private upstream error', { status: 503 })
			})
		).sent
	).toBe(false);
	expect(
		(
			await tick({
				root,
				fetch: async () => {
					throw Error('private network error');
				}
			})
		).sent
	).toBe(false);
	expect((await tick({ root, fetch: async () => new Response(null) })).sent).toBe(true);
	expect(readFileSync(join(root, 'keepalive-status.json'), 'utf8')).not.toContain('private');
});

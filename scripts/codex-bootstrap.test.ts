import { afterEach, expect, test, spyOn, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootstrapCodexActivity, inspectCodexActivity, retireFailedCodexTurns } from '../containers/assistant/fhold-remote.mjs';
import * as recall from '../containers/assistant/fhold-codex-recall.mjs';
import { activityStatus, coverage, nativeEvent } from '../plugins/fhold/scripts/activity.mjs';

afterEach(() => mock.restore());

test('native approved hooks plus an empty complete session inventory prove initial coverage', async () => {
	const review = spyOn(recall, 'reviewRecall').mockResolvedValue({ status: 'ready', managed: true });
	const methods: string[] = [];
	let loaded: unknown = { data: [], nextCursor: null };
	let alive = true;
	const inspect = async (check: (rpc: (method: string) => Promise<unknown>) => Promise<boolean>) => check(async (method) => { methods.push(method); return loaded; });
	expect(await bootstrapCodexActivity({ inspect, alive: () => alive })).toBe(true);
	expect(methods).toEqual(['thread/loaded/list']);
	for (loaded of [
		{ data: ['existing-thread'] },
		...['more', '', false, 0, {}].map((nextCursor) => ({ data: [], nextCursor })),
		{}, { data: null }, { data: [] }
	])
		expect(await bootstrapCodexActivity({ inspect, alive: () => alive })).toBe(false);
	loaded = { data: [], nextCursor: null }; alive = false;
	expect(await bootstrapCodexActivity({ inspect, alive: () => alive })).toBe(false);
	alive = true;
	for (const hooks of [{ status: 'approval-needed' }, { status: 'installed' }]) {
		review.mockResolvedValue(hooks);
		expect(await bootstrapCodexActivity({ inspect, alive: () => alive })).toBe(false);
	}
	// Inspection does not fabricate SessionStart, write account state or create a thread.
	expect(methods.every((method) => method === 'thread/loaded/list')).toBe(true);
});

test('native control RPC is bounded, initializes normally and never starts another server', async () => {
	const root = mkdtempSync(join(tmpdir(), 'fhold-codex-control-'));
	mkdirSync(join(root, 'app-server-control'));
	const methods: string[] = [];
	const server = Bun.serve({
		unix: join(root, 'app-server-control/app-server-control.sock'),
		fetch(request, server) { if (!server.upgrade(request)) return new Response(null, { status: 400 }); },
		websocket: { message(socket, message) {
			const input = JSON.parse(String(message)); methods.push(input.method);
			if (input.id && input.method !== 'hold') socket.send(JSON.stringify({ id: input.id, result: input.method === 'initialize' ? {} : { data: [] } }));
		} }
	});
	try {
		const result = await recall.withCodexControl((rpc) => rpc('thread/loaded/list', {}), { env: { CODEX_HOME: root }, timeoutMs: 1000 });
		expect(result).toEqual({ data: [] });
		expect(methods).toEqual(['initialize', 'initialized', 'thread/loaded/list']);
		await expect(recall.withCodexControl((rpc) => rpc('hold', {}), { env: { CODEX_HOME: root }, timeoutMs: 100 })).rejects.toThrow('coverage');
		const abort = new AbortController(); abort.abort();
		await expect(recall.withCodexControl(async () => {}, { env: { CODEX_HOME: root }, signal: abort.signal })).rejects.toThrow('coverage');
	} finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test('worker replacement during native inventory cannot establish coverage', async () => {
	spyOn(recall, 'reviewRecall').mockResolvedValue({ status: 'ready', managed: true });
	let sameWorker = true;
	const inspect = async (check: (rpc: () => Promise<unknown>) => Promise<boolean>) => check(async () => {
		// Model an exit/restart while the asynchronous native inventory is in flight.
		await Bun.sleep(1);
		sameWorker = false;
		return { data: [], nextCursor: null };
	});
	expect(await bootstrapCodexActivity({ inspect, alive: () => sameWorker })).toBe(false);
	await expect(bootstrapCodexActivity({
		alive: () => true,
		inspect: async (check: (rpc: () => Promise<unknown>) => Promise<boolean>) => check(async () => {
			throw Error('Native inventory unavailable');
		})
	})).rejects.toThrow('Native inventory unavailable');
});

test('native failed-turn metadata retires only that turn, preserving a newer turn and independent tools', async () => {
	spyOn(recall, 'reviewRecall').mockResolvedValue({ status: 'ready' });
	const root = mkdtempSync(join(tmpdir(), 'fhold-codex-failed-'));
	const event = (name: string, turn = 'failed', extra = {}) => nativeEvent('codex', {
		session_id: 'thread-a', turn_id: turn, hook_event_name: name, ...extra
	}, root);
	const requests: unknown[] = [];
	const inspect = async (check: (rpc: (method: string, params: unknown) => Promise<unknown>) => Promise<unknown>) => check(async (method, params) => {
		requests.push({ method, params });
		if (method === 'thread/read') return { thread: { id: 'thread-a', status: { type: 'active', activeFlags: [] } } };
		return method === 'thread/loaded/list' ? { data: ['thread-a'], nextCursor: null } : {
			data: [{ id: 'newer', status: 'inProgress' }, { id: 'failed', status: 'failed' }], nextCursor: null
		};
	});
	try {
		coverage('opencode', true, root);
		event('UserPromptSubmit');
		expect(activityStatus(root, [])).toBe('busy');
		const result = await inspectCodexActivity({ inspect, alive: () => true, failedTurns: true });
		expect(result).toEqual({ known: true, empty: false, idle: false, failed: [{ threadId: 'thread-a', turnId: 'failed' }] });
		expect(requests).toEqual([
			{ method: 'thread/loaded/list', params: {} },
			{ method: 'thread/read', params: { threadId: 'thread-a', includeTurns: false } },
			{ method: 'thread/turns/list', params: { threadId: 'thread-a', limit: 100, itemsView: 'notLoaded' } }
		]);
		// A native failure is terminal even though Codex never emitted Stop.
		retireFailedCodexTurns(result.failed, root);
		expect(activityStatus(root, [])).toBe('idle');
		event('UserPromptSubmit');
		event('PreToolUse', 'failed', { tool_use_id: 'independent-tool' });
		event('UserPromptSubmit', 'newer');
		retireFailedCodexTurns(result.failed, root);
		expect(activityStatus(root, [])).toBe('busy');
		event('Stop', 'newer');
		expect(activityStatus(root, [])).toBe('busy');
		event('PostToolUse', 'failed', { tool_use_id: 'independent-tool' });
		expect(activityStatus(root, [])).toBe('idle');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed-turn inspection refuses malformed observations and a replaced worker', async () => {
	const review = spyOn(recall, 'reviewRecall').mockResolvedValue({ status: 'ready' });
	let turns: unknown = { data: [{ id: 'a', status: 'failed' }] };
	let alive = true;
	const inspect = async (check: (rpc: (method: string) => Promise<unknown>) => Promise<unknown>) => check(async method =>
		method === 'thread/loaded/list' ? { data: ['thread-a'], nextCursor: null } :
			method === 'thread/read' ? { thread: { id: 'thread-a', status: { type: 'idle' } } } : turns);
	for (turns of [{}, { data: null }, { data: [{ id: 'a', status: 'unknown' }] }, { data: [{ status: 'failed' }] }])
		expect(await inspectCodexActivity({ inspect, alive: () => alive, failedTurns: true })).toEqual({ known: false });
	turns = { data: [{ id: 'a', status: 'failed' }] }; alive = false;
		expect(await inspectCodexActivity({ inspect, alive: () => alive, failedTurns: true })).toEqual({ known: false });
	alive = true; review.mockResolvedValue({ status: 'approval-needed' });
		expect(await inspectCodexActivity({ inspect, alive: () => alive, failedTurns: true })).toEqual({ known: false });
});

test('native idle status restores observation coverage for loaded conversations without a new turn', async () => {
	const review = spyOn(recall, 'reviewRecall').mockResolvedValue({ status: 'ready' });
	let thread: unknown = { id: 'thread-a', status: { type: 'idle' }, turns: [] };
	const requests: unknown[] = [];
	const inspect = async (check: (rpc: (method: string, params: unknown) => Promise<unknown>) => Promise<unknown>) => check(async (method, params) => {
		requests.push({ method, params });
		if (method === 'thread/loaded/list') return { data: ['thread-a'], nextCursor: null };
		if (method === 'thread/read') return { thread };
		return { data: [{ id: 'complete', status: 'completed' }], nextCursor: null };
	});
	expect(await inspectCodexActivity({ inspect, alive: () => true, failedTurns: true })).toMatchObject({ known: true, empty: false, idle: true });
	expect(requests).toContainEqual({ method: 'thread/read', params: { threadId: 'thread-a', includeTurns: false } });
	for (const activeFlags of [[], ['waitingOnApproval'], ['waitingOnUserInput']]) {
		thread = { id: 'thread-a', status: { type: 'active', activeFlags }, turns: [] };
		expect(await inspectCodexActivity({ inspect, alive: () => true, failedTurns: true })).toMatchObject({ known: true, idle: false });
	}
	for (thread of [undefined, {}, { id: 'other', status: { type: 'idle' } },
		{ id: 'thread-a', status: { type: 'notLoaded' } }, { id: 'thread-a', status: { type: 'systemError' } },
		{ id: 'thread-a', status: { type: 'active' } }])
		expect(await inspectCodexActivity({ inspect, alive: () => true, failedTurns: true })).toEqual({ known: false });
	thread = { id: 'thread-a', status: { type: 'idle' }, turns: [] };
	review.mockResolvedValue({ status: 'installed' });
	expect(await inspectCodexActivity({ inspect, alive: () => true, failedTurns: true })).toEqual({ known: false });
});

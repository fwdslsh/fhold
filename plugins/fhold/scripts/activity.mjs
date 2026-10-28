#!/usr/bin/env node
// Native hooks report metadata only. No prompts, tool arguments or transcripts.
import { createHash, randomUUID } from 'node:crypto';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const harnesses = ['opencode', 'claude', 'codex'];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const runtime = () => process.env.FH_RUNTIME_DIR || '/tmp/fhold-runtime';

function directory(root) {
	if (!root.startsWith('/') || resolve(root) !== root || root === '/')
		throw Error('Invalid runtime directory');
	for (let part = root; part !== '/'; part = dirname(part)) {
		if (existsSync(part) && lstatSync(part).isSymbolicLink())
			throw Error('Invalid runtime directory');
	}
	const path = join(root, 'activity');
	mkdirSync(path, { recursive: true, mode: 0o700 });
	if (lstatSync(path).isSymbolicLink()) throw Error('Invalid activity directory');
	return path;
}

function marker(tool, session, token, root) {
	if (
		!harnesses.includes(tool) ||
		typeof session !== 'string' ||
		!session ||
		session.length > 1024 ||
		typeof token !== 'string' ||
		token.length > 2048
	)
		throw Error('Invalid activity metadata');
	return join(directory(root), `${tool}-${hash(session)}-${hash(token)}`);
}

function remove(file) {
	try {
		unlinkSync(file);
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
}

export function observe(tool, session, token, active, root = runtime()) {
	const file = marker(tool, session, token, root);
	if (active) writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
	else remove(file);
}

// Idempotent creates let independent tools/subagents maintain separate markers
// without a read/modify/write race on one shared session counter.
export function activity(tool, session, token, active, root = runtime()) {
	try {
		observe(tool, session, token, active, root);
	} catch (error) {
		if (error.code !== 'EEXIST') throw error;
	}
}

export function endSession(tool, session, root = runtime()) {
	// Validate before deriving a prefix, including events without an active turn.
	marker(tool, session, 'turn', root);
	const path = directory(root);
	const prefix = `${tool}-${hash(session)}-`;
	for (const file of readdirSync(path)) if (file.startsWith(prefix)) remove(join(path, file));
}

export function coverage(tool, ready, root = runtime()) {
	if (!harnesses.includes(tool)) throw Error('Invalid harness');
	const file = join(directory(root), `${tool}.ready`);
	if (ready) writeFileSync(file, '', { mode: 0o600 });
	else remove(file);
}

export function report(callback, root = runtime()) {
	try {
		callback();
	} catch {
		// An observation failure must keep the monitor awake without preventing
		// the native agent from accepting a prompt or running its tool.
		try {
			writeFileSync(join(directory(root), 'unknown'), '', { mode: 0o600 });
		} catch {
			/* Unreadable runtime state also evaluates to unknown. */
		}
		console.error('fhold: activity observation failed');
	}
}

export function nativeEvent(tool, input, root = runtime()) {
	if (!['claude', 'codex'].includes(tool)) throw Error('Invalid native harness');
	const session = input.session_id;
	const mark = (token, busy) => activity(tool, session, token, busy, root);
	const turn = (busy) => {
		if (tool === 'codex' && (typeof input.turn_id !== 'string' || !input.turn_id || input.turn_id.length > 1024))
			throw Error('Invalid native turn identity');
		mark(tool === 'codex' ? `turn:${input.turn_id}` : 'turn', busy);
	};
	const background = () => {
		if (tool !== 'claude') return;
		// Missing task metadata cannot prove that background work finished.
		mark('background', !Array.isArray(input.background_tasks) || input.background_tasks.length > 0);
		mark('native-schedules', !Array.isArray(input.session_crons) || input.session_crons.length > 0);
	};
	switch (input.hook_event_name) {
		case 'SessionStart':
			// Compaction/resume can happen during a turn. Never clear activity here.
			marker(tool, session, 'turn', root);
			coverage(tool, true, root);
			break;
		case 'UserPromptSubmit':
			turn(true);
			break;
		case 'PreToolUse':
			turn(true);
			// Codex PostToolUse reports successful calls only: cancellation,
			// permission rejection and tool errors have no balancing hook.
			// The native turn protects foreground calls and pending input;
			// separately started subagents retain their own observations.
			if (tool === 'codex') break;
			mark(`tool:${input.tool_use_id || 'unknown'}`, true);
			break;
		case 'PostToolUse':
		case 'PostToolUseFailure':
			if (input.tool_use_id) mark(`tool:${input.tool_use_id}`, false);
			break;
		case 'PostToolBatch':
			if (tool !== 'claude' || !Array.isArray(input.tool_calls)) throw Error('Invalid tool batch');
			// Permission denials and cancellations do not emit PostToolUseFailure.
			// Native batch completion covers those outcomes without reading results.
			for (const call of input.tool_calls)
				if (call.tool_use_id) mark(`tool:${call.tool_use_id}`, false);
			break;
		case 'SubagentStart':
			// Codex dispatches this in the child's own session and turn. Child
			// turns can continue after the parent, or finish without a Stop hook.
			if (tool === 'codex') { turn(true); break; }
			mark(`agent:${input.agent_id || 'unknown'}`, true);
			break;
		case 'SubagentStop':
			if (tool === 'codex') { turn(false); break; }
			if (input.agent_id) mark(`agent:${input.agent_id}`, false);
			background();
			break;
		case 'Stop':
			background();
			turn(false);
			break;
		case 'StopFailure':
		case 'Interrupt':
			// Claude tools and native subagents need their own completion signals.
			turn(false);
			break;
		case 'SessionEnd':
			endSession(tool, session, root);
			break;
		default:
			throw Error('Unsupported activity event');
	}
}

export function activityStatus(root = runtime(), remotes = ['claude', 'codex']) {
	try {
		const files = readdirSync(directory(root));
		if (files.length > 10000 || files.includes('unknown')) return 'unknown';
		if (files.some((name) => /^(opencode|claude|codex)-[a-f0-9]{64}-[a-f0-9]{64}$/.test(name)))
			return 'busy';
		if (!files.includes('opencode.ready')) return 'unknown';
		for (const tool of remotes) {
			const state = JSON.parse(readFileSync(join(root, 'remote', `${tool}.json`), 'utf8')).state;
			if (['stopped', 'waiting-to-retry', 'sign-in-needed'].includes(state)) continue;
			if (state !== 'process-running' || !files.includes(`${tool}.ready`)) return 'unknown';
		}
		return 'idle';
	} catch {
		return 'unknown';
	}
}

export function keepaliveConfig(env) {
	if (!env.FH_KEEPALIVE_URL) return { enabled: false };
	let url;
	try {
		url = new URL(env.FH_KEEPALIVE_URL);
	} catch {
		throw Error('FH_KEEPALIVE_URL must be an absolute HTTP(S) URL');
	}
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
		throw Error('FH_KEEPALIVE_URL must be HTTP(S), without inline credentials or a fragment');
	const mode = env.FH_KEEPALIVE_AUTH || 'none';
	if (
		!['none', 'opencode'].includes(mode) ||
		(mode === 'opencode' && env.FH_KEEPALIVE_AUTHORIZATION_FILE)
	)
		throw Error('Choose FH_KEEPALIVE_AUTH=none|opencode or an authorization file');
	const password =
		env.OPENCODE_SERVER_PASSWORD ||
		(env.OPENCODE_SERVER_PASSWORD_FILE &&
			readFileSync(env.OPENCODE_SERVER_PASSWORD_FILE, 'utf8').replace(/[\r\n]/g, ''));
	const opencodeAuthorization = password
		? `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
		: undefined;
	const opencodePort = Number(env.OPENCODE_PORT || 4096);
	if (!Number.isInteger(opencodePort) || opencodePort < 1 || opencodePort > 65535)
		throw Error('Invalid native OpenCode port');
	let authorization;
	if (env.FH_KEEPALIVE_AUTHORIZATION_FILE) {
		authorization = readFileSync(env.FH_KEEPALIVE_AUTHORIZATION_FILE, 'utf8').trim();
		if (!authorization || /[\r\n]/.test(authorization) || authorization.length > 8192)
			throw Error('Invalid keep-alive authorization file');
	} else if (mode === 'opencode') {
		if (!password) throw Error('OpenCode keep-alive authentication requires its native password');
		authorization = opencodeAuthorization;
	}
	return {
		enabled: true,
		url: url.href,
		authorization,
		opencodeAuthorization,
		opencodePort,
		remotes: ['claude', 'codex'].filter((tool) => env[`FH_${tool.toUpperCase()}_REMOTE`] !== '0')
	};
}

// A normal idle unload preserves coverage, but its plugin can be disabled
// before the next load. Confirm every currently loaded location still has its
// observer before suppressing a heartbeat. The global list does not load a
// location; inventories are read only for locations already in that list.
export async function observedActivity(root, config, fetch = globalThis.fetch) {
	const state = activityStatus(root, config.remotes);
	if (state !== 'idle') return state;
	try {
		if (!config.opencodeAuthorization) return 'unknown';
		const signal = AbortSignal.timeout(5000);
		const read = async (path) => {
			const response = await fetch(`http://127.0.0.1:${config.opencodePort}/api${path}`, {
				method: 'GET', redirect: 'error', signal,
				headers: { Authorization: config.opencodeAuthorization }
			});
			if (!response.ok) {
				await response.body?.cancel();
				throw Error('Native inventory unavailable');
			}
			return response.json();
		};
		const locations = async () => {
			const result = await read('/debug/location');
			if (!Array.isArray(result) || result.length > 100 ||
				result.some((ref) => typeof ref?.directory !== 'string' || !ref.directory.startsWith('/')))
				throw Error('Invalid native locations');
			const directories = result.map((ref) => ref.directory).sort();
			// Native public refs omit workspaceID. Ambiguous directory identities
			// cannot prove coverage of every internal workspace context.
			if (new Set(directories).size !== directories.length) throw Error('Ambiguous native locations');
			return directories;
		};
		const before = await locations();
		for (const directory of before) {
			const inventory = await read(`/plugin?${new URLSearchParams({ 'location[directory]': directory })}`);
			if (!Array.isArray(inventory?.data) || !inventory.data.some((plugin) =>
				plugin?.id === 'fhold.activity' && plugin.state?.status === 'active')) return 'unknown';
		}
		if (JSON.stringify(before) !== JSON.stringify(await locations())) return 'unknown';
		// Native events or an observation failure may have arrived during I/O.
		return activityStatus(root, config.remotes);
	} catch {
		return 'unknown';
	}
}

function publish(file, value) {
	const temporary = `${file}.${randomUUID()}.tmp`;
	writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
	renameSync(temporary, file);
}

export function initialize(env = process.env, root = runtime()) {
	const config = keepaliveConfig(env);
	const path = directory(root);
	// Ephemeral observations belong to this boot, never to recovered home state.
	for (const file of readdirSync(path)) {
		if (/^(?:unknown|(?:opencode|claude|codex)(?:\.ready|-[a-f0-9]{64}-[a-f0-9]{64}))$/.test(file))
			remove(join(path, file));
	}
	publish(join(root, 'keepalive.json'), config);
	remove(join(root, 'keepalive-status.json'));
	return { enabled: config.enabled };
}

export async function tick({ root = runtime(), fetch = globalThis.fetch, nativeFetch = fetch } = {}) {
	const config = JSON.parse(readFileSync(join(root, 'keepalive.json'), 'utf8'));
	if (!config.enabled) return { enabled: false };
	const state = await observedActivity(root, config, nativeFetch);
	const result = {
		enabled: true,
		activity: state,
		sent: false,
		checkedAt: new Date().toISOString()
	};
	if (state !== 'idle') {
		try {
			const response = await fetch(config.url, {
				method: 'GET',
				redirect: 'error',
				signal: AbortSignal.timeout(5000),
				headers: config.authorization ? { Authorization: config.authorization } : {}
			});
			await response.body?.cancel();
			result.sent = response.ok;
		} catch {
			/* Never include URLs, headers or upstream response bodies in diagnostics. */
		}
	}
	publish(join(root, 'keepalive-status.json'), result);
	return result;
}

function invokedDirectly() {
	// Compiled native hosts can have a virtual argv entrypoint. Importing this
	// module as a plugin must not try to open that host's executable path.
	try {
		return (
			Boolean(process.argv[1]) &&
			import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
		);
	} catch {
		return false;
	}
}

if (invokedDirectly()) {
	const [command, tool] = process.argv.slice(2);
	try {
		if (command === 'hook') {
			let input = '';
			for await (const chunk of process.stdin) {
				input += chunk;
				if (input.length > 1048576) throw Error('Activity event too large');
			}
			nativeEvent(tool, JSON.parse(input));
			console.log('{}');
		} else if (command === 'init') console.log(JSON.stringify(initialize()));
		else if (command === 'tick') {
			const result = await tick();
			if (result.enabled && result.activity !== 'idle' && !result.sent)
				console.error('fhold: keep-alive request failed');
		} else if (command === 'status') {
			const config = JSON.parse(readFileSync(join(runtime(), 'keepalive.json'), 'utf8'));
			const file = join(runtime(), 'keepalive-status.json');
			const last = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
			const degraded =
				config.enabled &&
				((last.activity !== 'idle' && last.sent === false) ||
					(last.checkedAt && Date.now() - Date.parse(last.checkedAt) > 60_000));
			console.log(
				JSON.stringify({
					...last,
					enabled: config.enabled,
					activity: config.enabled ? await observedActivity(runtime(), config) : 'disabled',
					degraded: Boolean(degraded)
				})
			);
			if (degraded) process.exitCode = 1;
		} else throw Error('Use init, tick, status or hook');
	} catch {
		if (command === 'hook') {
			report(() => {
				throw Error('Invalid activity event');
			});
			console.log('{}');
		}
		console.error(
			'fhold: activity reporting failed; check keep-alive configuration and native hook approval'
		);
		if (command !== 'hook') process.exitCode = 1;
	}
}

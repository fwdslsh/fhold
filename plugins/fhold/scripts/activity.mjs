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
	switch (input.hook_event_name) {
		case 'SessionStart':
			// Compaction/resume can happen during a turn. Never clear activity here.
			marker(tool, session, 'turn', root);
			coverage(tool, true, root);
			break;
		case 'UserPromptSubmit':
			mark('turn', true);
			break;
		case 'PreToolUse':
			mark('turn', true);
			mark(`tool:${input.tool_use_id || 'unknown'}`, true);
			break;
		case 'PostToolUse':
		case 'PostToolUseFailure':
			if (input.tool_use_id) mark(`tool:${input.tool_use_id}`, false);
			break;
		case 'SubagentStart':
			mark(`agent:${input.agent_id || 'unknown'}`, true);
			break;
		case 'SubagentStop':
			if (input.agent_id) mark(`agent:${input.agent_id}`, false);
			break;
		case 'Stop':
			if (tool === 'claude') {
				// Missing task metadata cannot prove that background work finished.
				mark(
					'background',
					!Array.isArray(input.background_tasks) || input.background_tasks.length > 0
				);
				mark(
					'native-schedules',
					!Array.isArray(input.session_crons) || input.session_crons.length > 0
				);
			}
			mark('turn', false);
			break;
		case 'StopFailure':
		case 'Interrupt':
			// Tools/subagents still need their own completion signals.
			mark('turn', false);
			break;
		case 'SessionEnd': {
			const prefix = `${tool}-${hash(session)}-`;
			for (const file of readdirSync(directory(root)))
				if (file.startsWith(prefix)) remove(join(directory(root), file));
			break;
		}
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
			if (['stopped', 'waiting-to-retry'].includes(state)) continue;
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
	let authorization;
	if (env.FH_KEEPALIVE_AUTHORIZATION_FILE) {
		authorization = readFileSync(env.FH_KEEPALIVE_AUTHORIZATION_FILE, 'utf8').trim();
		if (!authorization || /[\r\n]/.test(authorization) || authorization.length > 8192)
			throw Error('Invalid keep-alive authorization file');
	} else if (mode === 'opencode') {
		const password =
			env.OPENCODE_SERVER_PASSWORD ||
			(env.OPENCODE_SERVER_PASSWORD_FILE &&
				readFileSync(env.OPENCODE_SERVER_PASSWORD_FILE, 'utf8').replace(/[\r\n]/g, ''));
		if (!password) throw Error('OpenCode keep-alive authentication requires its native password');
		authorization = `Basic ${Buffer.from(`${env.OPENCODE_SERVER_USERNAME || 'user'}:${password}`).toString('base64')}`;
	}
	return {
		enabled: true,
		url: url.href,
		authorization,
		remotes: ['claude', 'codex'].filter((tool) => env[`FH_${tool.toUpperCase()}_REMOTE`] !== '0')
	};
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
	return { enabled: config.enabled };
}

export async function tick({ root = runtime(), fetch = globalThis.fetch } = {}) {
	const config = JSON.parse(readFileSync(join(root, 'keepalive.json'), 'utf8'));
	if (!config.enabled) return { enabled: false };
	const state = activityStatus(root, config.remotes);
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
			console.log(
				JSON.stringify({
					enabled: config.enabled,
					activity: config.enabled ? activityStatus(runtime(), config.remotes) : 'disabled'
				})
			);
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

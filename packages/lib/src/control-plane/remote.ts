import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { activateComposeCommand } from './activation.js';
import { buildComposeCliArgs, buildComposeOptions } from './compose.js';
import { composeProcessEnvironment, composePs, parseComposePsRows, runDocker } from './docker.js';
import type { FholdState } from './foundation.js';
import { acquireStackLock, releaseStackLock } from './lock.js';
import {
	isCodexSandbox,
	readStackConfig,
	writeStackConfig,
	type StackConfig
} from './stack-config.js';
import { ensureRuntime, requireInstall } from './state.js';
import { rememberRuntimeBeforeChange } from './runtime-revision.js';

export type RemoteTool = 'claude' | 'codex';
export type CodexSandbox = StackConfig['assistant']['codexSandbox'];
export type RemoteProgress = {
	tool: RemoteTool;
	stage: string;
	output: string;
	running: boolean;
	enabled: boolean;
	error?: string;
};
export type RemoteEnableSession = {
	snapshot(): RemoteProgress;
	input(value: string): void;
	cancel(): void;
	done: Promise<RemoteProgress>;
};

export function remoteTool(value: unknown): RemoteTool {
	if (value !== 'claude' && value !== 'codex') throw new Error('Choose codex or claude.');
	return value;
}

/** Only native vendor sign-in and pairing pages may be opened automatically. */
export function remoteBrowserUrls(text: string): string[] {
	const result = new Set<string>();
	for (const match of text.matchAll(/https:\/\/[^\s<>"']+(?=\s)/g)) {
		try {
			if ([...match[0]].some((char) => char.charCodeAt(0) < 32)) continue;
			const url = new URL(match[0]);
			if (url.username || url.password || url.port) continue;
			if (
				(url.hostname === 'auth.openai.com' && url.pathname === '/codex/device') ||
				(url.hostname === 'claude.com' && url.pathname === '/cai/oauth/authorize') ||
				(['claude.ai', 'console.anthropic.com', 'platform.claude.com'].includes(url.hostname) &&
					url.pathname === '/oauth/authorize') ||
				(['claude.ai', 'claude.com'].includes(url.hostname) && url.pathname.startsWith('/code/'))
			)
				result.add(url.href);
		} catch {
			/* incomplete native output */
		}
	}
	return [...result];
}

/** Private native pairing output, never written to a host log or new credential store. */
export async function remoteConnection(state: FholdState, value: unknown): Promise<string> {
	const tool = remoteTool(value);
	requireInstall(state.homeDir);
	const config = readStackConfig(state.homeDir);
	if (!config.ok) throw new Error(config.error);
	if (!config.config.assistant[tool === 'codex' ? 'codexRemote' : 'claudeRemote'])
		throw new Error(`Enable ${tool} remote access first.`);
	const result = await runDocker(
		[
			'compose',
			...buildComposeCliArgs(state),
			'exec',
			'-T',
			'assistant',
			...(tool === 'codex'
				? ['codex', 'remote-control', 'pair', '--json']
				: ['fhold-remote', 'claude', 'logs'])
		],
		{ env: composeProcessEnvironment(buildComposeOptions(state).envFiles), timeoutMs: 10_000 }
	);
	if (!result.ok)
		throw new Error(
			'Native pairing is not ready. Check private remote logs and account/client availability.'
		);
	const output = result.stdout.slice(-65_536);
	if (
		tool === 'claude' &&
		!remoteBrowserUrls(output).some((url) => new URL(url).pathname.startsWith('/code/'))
	)
		throw new Error(
			'Claude has not produced a background connection link. Check private remote logs.'
		);
	return output;
}

export async function disableRemote(state: FholdState, value: unknown): Promise<void> {
	const tool = remoteTool(value);
	requireInstall(state.homeDir);
	const lock = acquireStackLock(state.dataDir);
	if (!lock) throw new Error('Another stack operation is running.');
	try {
		const parsed = readStackConfig(state.homeDir);
		if (!parsed.ok) throw new Error(parsed.error);
		rememberRuntimeBeforeChange(state.homeDir);
		parsed.config.assistant[tool === 'codex' ? 'codexRemote' : 'claudeRemote'] = false;
		writeStackConfig(state.homeDir, parsed.config);
		ensureRuntime(state);
		await activateComposeCommand(state, ['up', '-d', '--wait'], { lock });
	} finally {
		releaseStackLock(lock);
	}
}

/** Bind a native login to the actual running writer, not a movable service name. */
async function runningAssistantId(state: FholdState): Promise<string> {
	const result = await composePs(buildComposeOptions(state));
	const assistants = result.ok
		? parseComposePsRows(result.stdout).filter(
				(row) => row.service === 'assistant' && row.state === 'running' && row.id
			)
		: [];
	if (assistants.length !== 1)
		throw new Error(
			'Start one Assistant before native sign-in. Its running container could not be selected.'
		);
	return assistants[0]!.id;
}

/**
 * Start only the temporary native sign-in process. Deployment intent is changed
 * once, after native setup succeeds; closing/cancelling this session never
 * recreates containers or changes worker enablement/isolation.
 */
export async function beginRemoteEnable(
	state: FholdState,
	value: unknown,
	options: {
		sandbox?: CodexSandbox;
		trusted: boolean;
		update?: (progress: RemoteProgress) => void;
		signal?: AbortSignal;
	}
): Promise<RemoteEnableSession> {
	options.signal?.throwIfAborted();
	const tool = remoteTool(value);
	if (options.trusted !== true)
		throw new Error('Confirm trusted native workspace access; it bypasses Guardian policies.');
	if (options.sandbox !== undefined && !isCodexSandbox(options.sandbox))
		throw new Error(
			'Choose workspace-write, read-only, or explicit danger-full-access container isolation.'
		);
	requireInstall(state.homeDir);
	const field = tool === 'codex' ? 'codexRemote' : 'claudeRemote';
	const parsed = readStackConfig(state.homeDir);
	if (!parsed.ok) throw new Error(parsed.error);
	const sandbox = options.sandbox ?? parsed.config.assistant.codexSandbox;
	const runtimeId = await runningAssistantId(state);
	options.signal?.throwIfAborted();
	const progress: RemoteProgress = {
		tool,
		stage: 'starting',
		output: '',
		running: true,
		enabled: parsed.config.assistant[field]
	};
	const publish = () => options.update?.({ ...progress });
	// Native setup is intentionally against the currently selected runtime.
	// Do not stage a disable/apply: a cancelled or switched client must leave
	// existing worker intent and isolation untouched.
	publish();
	const compose = buildComposeOptions(state);
	const child = spawn(
		process.env.FH_DOCKER_BIN?.trim() || 'docker',
		['exec', '--interactive', '--workdir', '/work', runtimeId, 'fhold-remote-setup', tool, sandbox],
		{ env: composeProcessEnvironment(compose.envFiles), stdio: ['pipe', 'pipe', 'pipe'] }
	);
	let ready = false;
	let cancelled = false;
	let protocolError = false;
	let buffer = '';
	const decoder = new StringDecoder('utf8');
	const cancel = () => {
		cancelled = true;
		if (!child.stdin.destroyed) child.stdin.end(`${JSON.stringify({ cancel: true })}\n`);
	};
	options.signal?.addEventListener('abort', cancel, { once: true });
	if (options.signal?.aborted) cancel();
	child.stdin.on('error', () => {
		/* native process exited */
	});
	const deadline = setTimeout(cancel, 900_000);
	child.stdout.on('data', (chunk: Buffer) => {
		buffer += decoder.write(chunk);
		if (buffer.length > 262_144) {
			protocolError = true;
			cancel();
			return;
		}
		while (buffer.includes('\n')) {
			const end = buffer.indexOf('\n');
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			try {
				const event: unknown = JSON.parse(line);
				if (!event || typeof event !== 'object') throw new Error('Invalid native setup output');
				const item = event as Record<string, unknown>;
				if (typeof item.stage === 'string') progress.stage = item.stage;
				if (typeof item.output === 'string')
					progress.output =
						item.replace === true
							? item.output.slice(-65_536)
							: `${progress.output}${item.output}`.slice(-65_536);
				if (typeof item.error === 'string') progress.error = item.error;
				if (item.ready === true) ready = true;
				publish();
			} catch {
				protocolError = true;
				cancel();
			}
		}
	});
	child.stderr.on('data', (chunk: Buffer) => {
		progress.output = `${progress.output}${chunk.toString('utf8')}`.slice(-65_536);
		publish();
	});
	const done = new Promise<number>((resolve) => {
		child.once('error', () => resolve(127));
		child.once('close', (code) => resolve(code ?? 1));
	}).then(async (code) => {
		buffer += decoder.end();
		if (buffer.trim()) protocolError = true;
		try {
			if (code !== 0 || !ready || cancelled || protocolError || progress.error)
				throw new Error(
					progress.error ??
						(cancelled
							? 'Setup cancelled. Existing remote startup settings were not changed.'
							: 'Native setup failed. Update to an image with guided remote setup and review the output.')
				);
			progress.stage = 'enabling';
			publish();
			if (cancelled)
				throw new Error('Setup cancelled. Existing remote startup settings were not changed.');
			// Applying startup intent is an explicit successful workflow step,
			// not a cleanup side effect. Recheck and lock immediately before it.
			const lock = acquireStackLock(state.dataDir);
			if (!lock) throw new Error('Another stack operation is running.');
			try {
				if (cancelled)
					throw new Error('Setup cancelled. Existing remote startup settings were not changed.');
				if ((await runningAssistantId(state)) !== runtimeId)
					throw new Error(
						'The Assistant was replaced during native sign-in. Reopen setup for its current container; startup settings were not changed.'
					);
				if (cancelled)
					throw new Error('Setup cancelled. Existing remote startup settings were not changed.');
				const current = readStackConfig(state.homeDir);
				if (!current.ok) throw new Error(current.error);
				rememberRuntimeBeforeChange(state.homeDir);
				current.config.assistant[field] = true;
				if (tool === 'codex') current.config.assistant.codexSandbox = sandbox;
				writeStackConfig(state.homeDir, current.config);
				progress.enabled = true;
				ensureRuntime(state);
				await activateComposeCommand(state, ['up', '-d', '--wait'], { lock });
			} finally {
				releaseStackLock(lock);
			}
			progress.stage = 'pairing';
			publish();
			const pairingDeadline = Date.now() + 20_000;
			while (true) {
				if (cancelled) throw new Error('Setup cancelled after startup settings were applied.');
				try {
					const output = await remoteConnection(state, tool);
					progress.output = `${progress.output}\nBackground connection:\n${output}`.slice(-65_536);
					publish();
					break;
				} catch (error) {
					if (Date.now() >= pairingDeadline) throw error;
					await new Promise((resolve) => setTimeout(resolve, 500));
				}
			}
			if (cancelled) throw new Error('Setup cancelled after startup settings were applied.');
			progress.enabled = true;
			progress.stage = 'enabled';
		} catch (error) {
			progress.error = error instanceof Error ? error.message : String(error);
			progress.stage = 'failed';
		} finally {
			clearTimeout(deadline);
			options.signal?.removeEventListener('abort', cancel);
			progress.running = false;
			publish();
		}
		return { ...progress };
	});
	return {
		snapshot: () => ({ ...progress }),
		input(input) {
			if (
				!progress.running ||
				!['sign-in', 'trust-and-consent'].includes(progress.stage) ||
				typeof input !== 'string' ||
				input.length > 2048 ||
				[...input].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
			)
				throw new Error('Enter one native prompt answer, at most 2048 characters.');
			child.stdin.write(`${JSON.stringify({ input })}\n`);
		},
		cancel,
		done
	};
}

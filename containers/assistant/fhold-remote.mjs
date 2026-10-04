#!/usr/bin/env -S bun --no-env-file
// Optional vendor-native agents. Their failures never stop OpenCode or cron.
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

export const remoteDirectory = join(process.env.FH_RUNTIME_DIR || '/tmp/fhold-runtime', 'remote');
export function remoteCommand(tool, sandbox = process.env.FH_CODEX_SANDBOX ?? 'workspace-write') {
	if (!['workspace-write', 'read-only', 'danger-full-access'].includes(sandbox))
		throw new Error('Invalid Codex sandbox');
	if (tool === 'codex')
		return [
			'codex',
			'app-server',
			'--remote-control',
			'--listen',
			'unix://',
			'-c',
			`sandbox_mode="${sandbox}"`
		];
	if (tool === 'claude')
		return [
			'claude',
			'remote-control',
			'--spawn',
			'same-dir',
			'--capacity',
			'1',
			'--no-chrome'
		];
	throw new Error('Remote agent must be codex or claude.');
}

export function remoteEnvironment(source) {
	const env = { ...source };
	// Native sessions use their own account sign-in, never the Assistant API password.
	for (const key of Object.keys(env)) {
		if (/^(OPENCODE_|GUARDIAN_|PORTAL_|DISCORD_|SLACK_|FH_|AZURE_|IDENTITY_|MSI_|IMDS_)/.test(key))
			delete env[key];
	}
	// Remote sessions require native account sign-in, not ambient provider keys.
	for (const key of [
		'OPENAI_API_KEY',
		'ANTHROPIC_API_KEY',
		'CODEX_API_KEY',
		'CLAUDE_CODE_OAUTH_TOKEN'
	])
		delete env[key];
	// Suppress vendor self-updates: runtime software is release-pinned and image-baked.
	env.DISABLE_AUTOUPDATER = '1';
	// Non-secret location for shared, per-boot native activity observations.
	if (source.FH_RUNTIME_DIR) env.FH_RUNTIME_DIR = source.FH_RUNTIME_DIR;
	return env;
}

export function claudePrompt(text) {
	const trust = text.lastIndexOf('Trust ');
	const consent = text.lastIndexOf('Enable Remote Control?');
	const link = Math.max(text.lastIndexOf('https://claude.ai/code/'), text.lastIndexOf('https://claude.com/code/'));
	if (consent > link) return { kind: 'remote-control-consent', position: consent };
	if (trust > link && /Trust [^\r\n]+\? \[y\/N\]/.test(text.slice(trust)))
		return { kind: 'workspace-trust', position: trust };
}

export async function superviseRemote(
	tool,
	{ directory = remoteDirectory, retryMs = 300_000, env = process.env, workdir = '/work' } = {}
) {
	const [binary, ...args] = remoteCommand(tool, env.FH_CODEX_SANDBOX ?? 'workspace-write');
	process.umask(0o077);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	const statusFile = join(directory, `${tool}.json`);
	const logFile = join(directory, `${tool}.log`);
	const answerFile = join(directory, `${tool}.answer`);
	let child;
	let answeredPrompt;
	let lastStatus;
	let restartRequested = false;
	let stopping = false;
	let wake;
	let timer;
	let childDeadline;
	let groupForced = false;
	let log = Buffer.alloc(0);
	const status = (state, details = {}) => {
		lastStatus = { tool, state, supervisorPid: process.pid, ...details };
		writeFileSync(`${statusFile}.tmp`, JSON.stringify(lastStatus), {
			mode: 0o600
		});
		chmodSync(`${statusFile}.tmp`, 0o600);
		renameSync(`${statusFile}.tmp`, statusFile);
	};
	const record = (chunk) => {
		// Pairing links can be sensitive. Keep bounded output in a private file,
		// never in Docker logs or the scheduler's durable history.
		log = Buffer.concat([log, Buffer.from(chunk)]).subarray(-65_536);
		writeFileSync(logFile, log, { mode: 0o600 });
		chmodSync(logFile, 0o600);
		if (tool === 'claude' && child?.pid) {
			const prompt = claudePrompt(stripVTControlCharacters(log.toString('utf8')));
			if (prompt && JSON.stringify(prompt) !== answeredPrompt)
				status('approval-needed', { pid: child.pid, approval: prompt.kind });
			else status('process-running', { pid: child.pid });
		}
	};
	const restart = () => {
		restartRequested = true;
		clearTimeout(timer);
		wake?.();
		if (child?.pid) {
			const pid = child.pid;
			try { process.kill(-pid, 'SIGTERM'); } catch { /* already stopped */ }
			timer = setTimeout(() => {
				try { process.kill(-pid, 'SIGKILL'); } catch { /* already stopped */ }
			}, 3_000);
		}
	};
	const answer = () => {
		try {
			const request = JSON.parse(readFileSync(answerFile, 'utf8'));
			const value = request.answer;
			unlinkSync(answerFile);
			const prompt = claudePrompt(stripVTControlCharacters(log.toString('utf8')));
			if (tool !== 'claude' || !child?.terminal || !prompt || lastStatus?.state !== 'approval-needed' || request.pid !== child.pid || request.approval !== prompt.kind || !['y', 'n'].includes(value)) return;
			answeredPrompt = JSON.stringify(prompt);
			// Relay only the operator's explicit answer to the existing native PTY.
			// No trust/config writes and no second Claude server.
			child.terminal.write(`${value}\r`);
			status('process-running', { pid: child.pid });
		} catch { /* no pending answer or worker already exited */ }
	};
	const stop = () => {
		stopping = true;
		clearTimeout(timer);
		wake?.();
		if (child?.pid) {
			const pid = child.pid;
			try {
				process.kill(-child.pid, 'SIGTERM');
			} catch {
				/* already stopped */
			}
			// A wedged vendor process must not delay Assistant shutdown indefinitely.
			timer = setTimeout(() => {
				groupForced = true;
				try {
					process.kill(-pid, 'SIGKILL');
				} catch {
					/* already stopped */
				}
			}, 3_000);
		}
	};
	process.on('SIGTERM', stop);
	process.on('SIGINT', stop);
	process.on('SIGUSR1', restart);
	process.on('SIGUSR2', answer);
	try {
		while (!stopping) {
			try { unlinkSync(join(dirname(directory), 'activity', `${tool}.ready`)); }
			catch (error) { if (error.code !== 'ENOENT') throw error; }
			child = undefined;
			answeredPrompt = undefined;
			groupForced = false;
			log = Buffer.alloc(0);
			record('');
			const code = tool === 'claude' ? await (async () => {
				child = Bun.spawn([binary, ...args], {
					cwd: workdir,
					env: { ...remoteEnvironment(env), TERM: 'dumb' },
					terminal: { cols: 4096, rows: 32, data(_terminal, data) { record(stripVTControlCharacters(Buffer.from(data).toString('utf8'))); } }
				});
				status('process-running', { pid: child.pid });
				const result = await child.exited;
				child.terminal.close();
				return result;
			})() : await new Promise((resolve) => {
				child = spawn(binary, args, {
					cwd: workdir,
					env: remoteEnvironment(env),
					detached: true,
					stdio: ['ignore', 'pipe', 'pipe']
				});
				child.stdout.on('data', record);
				child.stderr.on('data', record);
				child.on('spawn', () => status('process-running', { pid: child.pid }));
				child.on('error', () => resolve(127));
				child.on('exit', () => {
					const pid = child.pid;
					try {
						process.kill(-pid, 'SIGTERM');
					} catch {
						return;
					}
					// Descendants may keep stdout open after their leader exits;
					// waiting for close alone would hang instead of retrying.
					childDeadline = setTimeout(() => {
						groupForced = true;
						try {
							process.kill(-pid, 'SIGKILL');
						} catch {
							/* reaped */
						}
					}, 3_000);
				});
				child.on('close', (exitCode) => resolve(exitCode ?? 1));
			});
			// The leader can exit before its session children. Do not cancel the
			// shutdown deadline or start another attempt while descendants survive.
			if (child?.pid) {
				let groupExists = false;
				try {
					process.kill(-child.pid, 0);
					groupExists = true;
				} catch {
					/* reaped */
				}
				if (groupExists) {
					if (!groupForced) await new Promise((resolve) => setTimeout(resolve, 3_000));
					try {
						process.kill(-child.pid, 'SIGKILL');
					} catch {
						/* reaped */
					}
				}
			}
			clearTimeout(childDeadline);
			clearTimeout(timer);
			child = undefined;
			if (restartRequested && !stopping) {
				restartRequested = false;
				continue;
			}
			if (!stopping) {
				status('waiting-to-retry', {
					exitCode: code,
					retryAt: new Date(Date.now() + retryMs).toISOString()
				});
				await new Promise((resolve) => {
					wake = resolve;
					timer = setTimeout(resolve, retryMs);
				});
			}
		}
	} finally {
		clearTimeout(timer);
		clearTimeout(childDeadline);
		process.off('SIGTERM', stop);
		process.off('SIGINT', stop);
		process.off('SIGUSR1', restart);
		process.off('SIGUSR2', answer);
		status('stopped');
	}
}

if (import.meta.main) {
	const [tool, action] = process.argv.slice(2);
	remoteCommand(tool);
	if (action === 'status' || action === 'logs') {
		try {
			process.stdout.write(
				`${readFileSync(join(remoteDirectory, `${tool}.${action === 'status' ? 'json' : 'log'}`), 'utf8')}\n`
			);
		} catch {
			console.log(
				action === 'status'
					? JSON.stringify({ tool, state: 'not-started' })
					: 'No remote output. Enable startup and check status first.'
			);
		}
	} else if (action === 'answer' || action === 'restart') {
		const current = JSON.parse(readFileSync(join(remoteDirectory, `${tool}.json`), 'utf8'));
		if (!Number.isInteger(current.supervisorPid) || current.state === 'stopped') throw new Error('The managed worker is not running. Use host CLI/Admin or the external hosting app to enable it.');
		if (action === 'answer') {
			if (tool !== 'claude' || current.state !== 'approval-needed') throw new Error('Claude is not waiting for native trust or Remote Control consent.');
			const value = (await Bun.stdin.text()).trim();
			if (!['y', 'n'].includes(value)) throw new Error('Provide the operator-approved y or n on stdin.');
			writeFileSync(join(remoteDirectory, `${tool}.answer`), JSON.stringify({ answer: value, pid: current.pid, approval: current.approval }), { mode: 0o600, flag: 'wx' });
		}
		process.kill(current.supervisorPid, action === 'answer' ? 'SIGUSR2' : 'SIGUSR1');
	} else if (action === undefined) {
		await superviseRemote(tool);
	} else throw new Error('Use status, logs, answer or restart, or omit the action to run remote control.');
}

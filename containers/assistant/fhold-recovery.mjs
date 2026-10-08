#!/usr/bin/env -S bun --no-env-file
// Image-only same-instance recovery. Host deployment and lifecycle stay external.
import * as fs from 'node:fs/promises';
import { constants, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createEngine, DEFAULT_LIMITS, sanitizeRecoveryError } from './recovery/engine.mjs';
import { canonicalPath, readSelection } from './recovery/catalog.mjs';
import { assertNoLinks, readRegular } from './recovery/directory-store.mjs';
import { createRecoveryStore } from './recovery/storage.mjs';

export function integerSetting(env, name, fallback, min, max) {
	const text = env[name] ?? String(fallback);
	if (!/^\d+$/.test(text)) throw new Error(`Invalid ${name}`);
	const value = Number(text);
	if (!Number.isSafeInteger(value) || value < min || value > max)
		throw new Error(`Invalid ${name}`);
	return value;
}

export function recoveryConfig(env = process.env) {
	if (!env.FH_RECOVERY_URL) throw new Error('FH_RECOVERY_URL is required');
	const url = new URL(env.FH_RECOVERY_URL);
	if (url.search || url.hash || url.username || url.password)
		throw new Error('Recovery URLs cannot contain credentials or query strings');
	if (!['file:', 'azblob:'].includes(url.protocol))
		throw new Error('Unsupported recovery transport');
	if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(env.FH_INSTANCE_ID ?? ''))
		throw new Error('FH_INSTANCE_ID is required and must be a stable slug');
	const runtimeDir = env.FH_RUNTIME_DIR || '/tmp/fhold-runtime';
	const privateDir =
		env.FH_RECOVERY_STATE_DIR || join(env.HOME || '/home/fhold', '.fhold-recovery');
	for (const value of [runtimeDir, privateDir]) {
		if (!isAbsolute(value) || resolve(value) !== value || value === '/')
			throw new Error('Recovery paths must be canonical absolute private directories');
	}
	const includeFile = env.FH_RECOVERY_INCLUDE_FILE;
	if (includeFile !== undefined && !canonicalPath(includeFile))
		throw new Error('recovery include file must be an absolute path');
	const intervalSeconds = integerSetting(env, 'FH_RECOVERY_INTERVAL_SECONDS', 60, 1, 86_400);
	const maxUnsavedSeconds = integerSetting(env, 'FH_RECOVERY_MAX_UNSAVED_SECONDS', 300, 5, 604_800);
	const operationSeconds = integerSetting(
		env,
		'FH_RECOVERY_OPERATION_TIMEOUT_SECONDS',
		120,
		1,
		3_600
	);
	const probePort = integerSetting(env, 'FH_RECOVERY_PROBE_PORT', 0, 0, 65_535);
	if (probePort === Number(env.OPENCODE_PORT || 4096))
		throw new Error('Recovery probe cannot use the Assistant port');
	const toolsPath = '/opt/fhold/tools/package.json';
	let dependencies;
	try {
		dependencies = JSON.parse(readFileSync(toolsPath, 'utf8')).dependencies;
	} catch {
		dependencies = JSON.parse(
			readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tools/package.json'), 'utf8')
		).dependencies;
	}
	return {
		// Let the transport validate the original text, including dot segments and
		// escapes; URL normalization must not silently select another namespace.
		url: env.FH_RECOVERY_URL,
		instanceId: env.FH_INSTANCE_ID,
		privateDir,
		runtimeDir,
		includeFile,
		intervalSeconds,
		maxUnsavedSeconds,
		operationSeconds,
		probePort,
		versions: Object.fromEntries([
			...[
				'opencode-ai',
				'akm-cli',
				'akm-opencode',
				'@openai/codex',
				'@anthropic-ai/claude-code'
			].map((name) => [name, dependencies[name]]),
			['bun', Bun.version]
		]),
		image: env.PLATFORM_VERSION || 'development'
	};
}

async function privateDirectory(path) {
	await assertNoLinks(path);
	await fs.mkdir(path, { recursive: true, mode: 0o700 });
	await fs.chmod(path, 0o700);
}

async function writeStatus(path, value) {
	await assertNoLinks(path);
	const temp = `${path}.${process.pid}.tmp`;
	await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
	await fs.rename(temp, path);
}

export async function readRecoveryStatus(path) {
	await assertNoLinks(path);
	const handle = await fs.open(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
	);
	try {
		const limit = 8_192;
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > limit)
			throw new Error('recovery status file type/size rejected');
		const buffer = Buffer.alloc(limit + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > limit) throw new Error('recovery status file exceeds limit');
		// The publisher replaces the whole file atomically. This pinned descriptor
		// reads one complete publication even when rename unlinks its inode and
		// changes ctime. Ordinary backup files still use stricter capture checks.
		return JSON.parse(buffer.subarray(0, length).toString());
	} finally {
		await handle.close();
	}
}

async function nativeReady(env) {
	try {
		const password =
			env.OPENCODE_SERVER_PASSWORD ||
			(
				await readRegular(
					env.OPENCODE_SERVER_PASSWORD_FILE || '/run/secrets/opencode_server_password',
					16_384
				)
			)
				.toString()
				.trim();
		if (!password) return false;
		const response = await fetch(`http://127.0.0.1:${env.OPENCODE_PORT || 4096}/global/health`, {
			headers: {
				Authorization: `Basic ${Buffer.from(`${env.OPENCODE_SERVER_USERNAME || 'opencode'}:${password}`).toString('base64')}`
			},
			signal: AbortSignal.timeout(2_000)
		});
		return response.ok;
	} catch {
		return false;
	}
}

async function configuredEngine(config, env) {
	const selection = config.includeFile
		? await readSelection(config.includeFile, DEFAULT_LIMITS.maxManifestBytes)
		: undefined;
	const store = await createRecoveryStore(config.url, { env });
	return createEngine(
		{ ...config, selection },
		{ store, limits: { operationTimeoutMs: config.operationSeconds * 1_000 } }
	);
}

export async function runRecovery(config, { env = process.env, engine } = {}) {
	engine ??= await configuredEngine(config, env);
	process.umask(0o077);
	await privateDirectory(config.runtimeDir);
	const statusFile = join(config.runtimeDir, 'recovery-status.json');
	const restoredFile = join(config.runtimeDir, 'recovery-restored');
	const writersFile = join(config.runtimeDir, 'recovery-writers-started');
	const began = performance.now();
	let stopping = false;
	let owner = false;
	let failure = false;
	let failureCause;
	let lastLoggedFailure;
	let nextCapture = 0;
	let lastAttemptFailed = false;
	let state = 'restoring';
	let wake;
	let timer;
	let renewal;
	let renewing = false;
	let statusWrite = Promise.resolve();
	let probe;
	const stop = () => {
		stopping = true;
		clearTimeout(timer);
		wake?.();
	};
	process.on('SIGTERM', stop);
	process.on('SIGINT', stop);
	// Clock corrections must not hide an overdue-backup warning.
	// The engine owns accepted publication state; health must not keep a
	// second clock that can diverge from committed manifests and receipts.
	const age = () => (performance.now() - (engine.status().lastCheckpointTick ?? began)) / 1_000;
	const healthy = () => owner && !failure && !stopping && state === 'running';
	const publishStatus = () => {
		const checkpoint = engine.status();
		const value = {
			format: 1,
			state,
			healthy: healthy(),
			durable:
				healthy() &&
				!lastAttemptFailed &&
				Number.isFinite(checkpoint.lastCheckpointTick) &&
				age() < config.maxUnsavedSeconds,
			updatedAt: Date.now(),
			lastPublishedAt: checkpoint.lastCheckpointTick === null ? null : checkpoint.lastCheckpointAt,
			lastAttemptFailed,
			failure: failureCause ? sanitizeRecoveryError(failureCause) : engine.status().failure,
			maxUnsavedSeconds: config.maxUnsavedSeconds
		};
		const write = statusWrite.then(() => writeStatus(statusFile, value));
		statusWrite = write.catch(() => {});
		return write;
	};
	const captureFailed = (error) => {
		lastAttemptFailed = true;
		const reason = sanitizeRecoveryError(error);
		if (reason !== lastLoggedFailure) {
			process.stderr.write(`fhold recovery: checkpoint failed (${reason}).\n`);
			lastLoggedFailure = reason;
		}
	};
	if (config.probePort) {
		probe = Bun.serve({
			hostname: '0.0.0.0',
			port: config.probePort,
			fetch: async (request) => {
				const route = new URL(request.url).pathname;
				if (!['/live', '/ready'].includes(route)) return new Response('Not found', { status: 404 });
				const ready =
					route === '/live' ? !failure && !stopping : healthy() && (await nativeReady(env));
				return new Response(ready ? 'ok' : 'not ready', { status: ready ? 200 : 503 });
			}
		});
	}
	try {
		await publishStatus();
		await engine.acquireRestore();
		owner = true;
		await fs.writeFile(restoredFile, 'restored\n', { mode: 0o600, flag: 'wx' });
		state = 'waiting-for-writers';
		await publishStatus();
		// Renewal never shares the synchronous SQLite subprocess's event loop.
		const failClosed = (error) => {
			failure = true;
			failureCause ??= error;
			state = 'failed';
			stop();
			// Stop native writers promptly even while a bounded capture is in flight.
			const parent = Number(env.FH_RECOVERY_PARENT_PID);
			if (Number.isSafeInteger(parent) && parent === process.ppid && parent > 1) {
				try {
					process.kill(parent, 'SIGTERM');
				} catch {
					/* already stopping */
				}
			}
		};
		renewal = setInterval(() => {
			if (renewing || stopping) return;
			renewing = true;
			engine
				.renew()
				.then(publishStatus)
				.catch(failClosed)
				.finally(() => {
					renewing = false;
				});
		}, 1_000);
		while (!stopping) {
			if (
				await fs
					.lstat(writersFile)
					.then((stat) => stat.isFile() && !stat.isSymbolicLink())
					.catch(() => false)
			) {
				state = 'running';
				if (performance.now() >= nextCapture) {
					try {
						await engine.checkpoint();
						lastAttemptFailed = false;
						lastLoggedFailure = undefined;
					} catch (error) {
						captureFailed(error);
					}
					nextCapture = performance.now() + config.intervalSeconds * 1_000;
				}
			}
			await publishStatus();
			if (!stopping)
				await new Promise((resolveWait) => {
					wake = resolveWait;
					timer = setTimeout(resolveWait, 250);
				});
		}
		state = failure ? 'failed' : 'stopping';
		await publishStatus();
		// Entrypoint sends TERM here only after all state-writing descendants stop.
		if (!failure) {
			try {
				await engine.checkpoint();
				lastAttemptFailed = false;
			} catch (error) {
				failure = true;
				failureCause ??= error;
				captureFailed(error);
			}
		}
	} catch (error) {
		failure = true;
		failureCause ??= error;
	} finally {
		clearInterval(renewal);
		clearTimeout(timer);
		if (owner) {
			try {
				await engine.release();
			} catch (error) {
				failure = true;
				failureCause ??= error;
			}
		}
		state = failure ? 'failed' : 'stopped';
		await publishStatus().catch(() => {});
		probe?.stop(true);
		process.off('SIGTERM', stop);
		process.off('SIGINT', stop);
	}
	if (failure)
		throw failureCause ?? new Error('Recovery failed; no unsafe checkpoint was accepted');
}

async function main() {
	const command = process.argv[2];
	if (command === 'status') {
		const status = await readRecoveryStatus(
			join(process.env.FH_RUNTIME_DIR || '/tmp/fhold-runtime', 'recovery-status.json')
		);
		const now = Date.now();
		const healthy =
			status.healthy === true &&
			Number.isFinite(status.updatedAt) &&
			now - status.updatedAt < 5_000;
		process.stdout.write(`${JSON.stringify({ ...status, healthy })}\n`);
		if (!healthy) process.exitCode = 1;
		return;
	}
	const config = recoveryConfig();
	if (command === 'inspect' && process.argv.length === 3) {
		process.stdout.write(
			`${JSON.stringify(await (await configuredEngine(config, process.env)).inspect())}\n`
		);
		return;
	}
	if (
		command === 'restore' &&
		process.argv[3] === '--confirm-stopped' &&
		process.argv.length === 4
	) {
		const engine = await configuredEngine(config, process.env);
		try {
			await engine.acquireRestore();
			process.stdout.write('Recovery restored and validated without starting native writers.\n');
		} finally {
			await engine.release();
		}
		return;
	}
	if (
		command === 'init' &&
		process.argv[3] === '--confirm-new-instance' &&
		process.argv.length === 4
	) {
		await (await configuredEngine(config, process.env)).initialize();
		process.stdout.write(
			'Recovery namespace initialized. Start the instance to publish its first checkpoint.\n'
		);
		return;
	}
	if (
		command === 'unlock' &&
		process.argv[3] === '--confirm-stopped' &&
		process.argv[4] === '--owner' &&
		process.argv.length === 6
	) {
		await (await createRecoveryStore(config.url, { env: process.env })).breakOwnership(
			process.argv[5],
			config.instanceId,
			{ confirmedStopped: true }
		);
		process.stdout.write(
			'Confirmed stopped owner released. The next start must validate recovery normally.\n'
		);
		return;
	}
	if (command !== 'run' || process.argv.length !== 3)
		throw new Error(
			'Usage: fhold-recovery init --confirm-new-instance | inspect | restore --confirm-stopped | run | status | unlock --confirm-stopped --owner <nonce>'
		);
	await runRecovery(config);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => {
		process.stderr.write(
			`fhold recovery: ${sanitizeRecoveryError(error)}; check private recovery status and destination access.\n`
		);
		process.exitCode = 1;
	});
}

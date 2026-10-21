import * as fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { assertNoLinks, readRegular } from './directory-store.mjs';
import { canonicalPath, containsPath, overlapsPath } from './catalog.mjs';

// EXPERIMENTAL. These bounds and the cache format may change or be removed.
export const AKM_INDEX_CACHE_LIMITS = Object.freeze({ bytes: 64 * 1024 * 1024, timeoutMs: 5_000 });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exists = async (file) =>
	fs.lstat(file).catch((error) => {
		if (error.code === 'ENOENT') return null;
		throw error;
	});
const pick = (object, names) =>
	Object.fromEntries(
		names.filter((name) => object?.[name] !== undefined).map((name) => [name, object[name]])
	);

export function validAkmIndexCache(value, instanceId, maximum = AKM_INDEX_CACHE_LIMITS.bytes) {
	return Boolean(
		value &&
			value.format === 1 &&
			value.instanceId === instanceId &&
			/^[a-f0-9]{64}$/.test(value.profile) &&
			/^[a-f0-9]{64}$/.test(value.hash) &&
			Number.isSafeInteger(value.bytes) &&
			value.bytes > 0 &&
			value.bytes <= maximum &&
			Number.isSafeInteger(value.schema) &&
			value.schema > 0 &&
			Number.isSafeInteger(value.capturedAt) &&
			value.capturedAt > 0 &&
			value.complete === true &&
			/^[a-f0-9]{64}$/.test(value.sourceHash) &&
			Number.isSafeInteger(value.entries) &&
			value.entries >= 0 &&
			Number.isSafeInteger(value.embeddings) &&
			value.embeddings >= 0
	);
}

/** Native CLI completion, rather than index_meta.builtAt, is the admission
 * authority. Native writers only touch a private candidate and disposable
 * state/config; no live DB, source configuration or process lock is replaced. */
export function createAkmIndexCache({
	roots,
	privateDir,
	instanceId,
	env = process.env,
	bunPath = process.execPath,
	akmCommand = ['akm'],
	limits = AKM_INDEX_CACHE_LIMITS,
	checkStorage = async () => {}
}) {
	let state = { state: 'disabled', reason: null };
	let restored = false;
	const set = (next, reason = null) => {
		state = { state: next, reason };
		if (next === 'restored') restored = true;
	};
	const metadata = (reference) => validAkmIndexCache(reference, instanceId, limits.bytes);
	const nativeEnv = Object.fromEntries(
		Object.entries(env).filter(
			([key]) =>
				!/^(FH_RECOVERY_|FH_INSTANCE_ID$|AZURE_CLIENT_ID$|IDENTITY_|MSI_|IMDS_|FH_OPENCODE_ENV_MAP$)/.test(
					key
				)
		)
	);

	async function command(argv, candidateEnv, signal) {
		signal.throwIfAborted();
		return new Promise((resolve, reject) => {
			const child = spawn(argv[0], argv.slice(1), {
				cwd: privateDir,
				env: candidateEnv,
				stdio: ['ignore', 'pipe', 'ignore'],
				detached: true
			});
			const chunks = [];
			let bytes = 0;
			let overflow = false;
			let killTimer;
			const kill = (value) => {
				try {
					process.kill(-child.pid, value);
				} catch {
					/* exited */
				}
			};
			const abort = () => {
				kill('SIGTERM');
				killTimer = setTimeout(() => kill('SIGKILL'), 100);
			};
			signal.addEventListener('abort', abort, { once: true });
			child.stdout.on('data', (chunk) => {
				bytes += chunk.length;
				if (bytes > 1024 * 1024) {
					overflow = true;
					kill('SIGKILL');
				} else chunks.push(chunk);
			});
			const cleanup = () => {
				clearTimeout(killTimer);
				signal.removeEventListener('abort', abort);
			};
			child.once('error', () => {
				cleanup();
				reject(new Error('native-command-failed'));
			});
			child.once('close', (code) => {
				cleanup();
				if (signal.aborted) reject(new Error('deadline'));
				else if (code !== 0 || overflow) reject(new Error('native-command-failed'));
				else resolve(Buffer.concat(chunks));
			});
			if (signal.aborted) abort();
		});
	}

	async function sqlite(operation, source, destination, signal) {
		signal.throwIfAborted();
		await checkStorage(source);
		let bytes = 0;
		for (const file of [source, `${source}-wal`, `${source}-shm`]) {
			await assertNoLinks(file);
			const stat = await exists(file);
			if (stat && !stat.isFile()) throw new Error('sqlite-type');
			bytes += stat?.size ?? 0;
		}
		if (bytes > limits.bytes) throw new Error('size-limit');
		const original = await fs.stat(source);
		const output = await command(
			[
				bunPath,
				'--no-env-file',
				'--config=/dev/null',
				fileURLToPath(new URL('./sqlite-worker.mjs', import.meta.url)),
				operation,
				source,
				destination ?? '',
				String(limits.bytes)
			],
			{ PATH: env.PATH, HOME: roots.home },
			signal
		);
		const after = await fs.stat(source);
		if (original.dev !== after.dev || original.ino !== after.ino)
			throw new Error('sqlite-source-replaced');
		return output;
	}

	async function profile(catalog, signal) {
		signal.throwIfAborted();
		const file = path.join(roots.akmConfig, 'config.json');
		const bytes = (await exists(file))
			? await readRegular(file, 1024 * 1024, signal)
			: Buffer.from('{}');
		const config = JSON.parse(bytes.toString());
		// A filesystem-only initial scope avoids source hydration, inherited host
		// policy, and adapter-controlled network materialization during recovery.
		if (config.extends || config.sources || config.stashes)
			throw new Error('unsupported-source-policy');
		const sources = [env.AKM_BUNDLE_DIR || roots.stash];
		const bundles = [];
		for (const [id, bundle] of Object.entries(config.bundles ?? {})) {
			if (bundle.enabled === false) continue;
			if (!canonicalPath(bundle.path) || bundle.git || bundle.npm || bundle.website)
				throw new Error('unsupported-source-policy');
			const components = Object.values(bundle.components ?? { main: {} });
			if (components.length !== 1) throw new Error('unsupported-source-policy');
			const component = components[0];
			if (component.adapter && !['akm', 'agent-skills'].includes(component.adapter))
				throw new Error('unsupported-source-policy');
			const root = path.resolve(bundle.path, component.root ?? '.');
			if (!containsPath(bundle.path, root)) throw new Error('unsupported-source-policy');
			sources.push(root);
			bundles.push({
				id,
				path: bundle.path,
				registryId: bundle.registryId ?? null,
				writable: bundle.writable !== false,
				component: pick(component, ['root', 'adapter', 'writable'])
			});
		}
		const policy = [...catalog.policy.excludePaths, ...catalog.protectedPaths];
		const sourceStats = [];
		for (const root of [...new Set(sources)]) {
			if (!canonicalPath(root) || policy.some((excluded) => overlapsPath(root, excluded)))
				throw new Error('excluded-source');
			await assertNoLinks(root);
			await fs.access(root, constants.R_OK | constants.X_OK);
			const stat = await fs.stat(root);
			if (!stat.isDirectory()) throw new Error('source-unavailable');
			// Effective readability/search permission is checked each time. Owner
			// and directory-mode spelling may change during an ordinary restore.
			sourceStats.push(root);
		}
		const identity = {
			bundles,
			defaultBundle: config.defaultBundle ?? null,
			primary: sources[0],
			sources: sourceStats,
			selection: catalog.selection,
			semanticSearchMode: config.semanticSearchMode ?? 'off',
			embedding: pick(config.embedding, [
				'provider',
				'model',
				'dimension',
				'localModel',
				'documentTemplate',
				'queryTemplate',
				'maxInputTokens'
			]),
			index: Object.fromEntries(
				Object.entries(config.index ?? {}).map(([name, value]) => [
					name,
					pick(value, ['enabled', 'engine', 'model', 'timeoutMs'])
				])
			),
			redaction: pick(env, ['AKM_REDACT_HIGH_ENTROPY', 'AKM_REDACT_PII'])
		};
		return { hash: hash(JSON.stringify(identity)), config, bytes };
	}

	async function freshCandidate(stage, catalog, signal, input, before) {
		const data = path.join(stage, 'data');
		const configDir = path.join(stage, 'config');
		await fs.mkdir(data, { recursive: true, mode: 0o700 });
		await fs.mkdir(configDir, { mode: 0o700 });
		const candidate = path.join(data, 'index.db');
		if (input) await fs.writeFile(candidate, input, { flag: 'wx', mode: 0o600, signal });
		else await sqlite('capture', path.join(roots.akmData, 'index.db'), candidate, signal);
		const sourceHash = hash(await readRegular(candidate, limits.bytes, signal));
		const description = JSON.parse(
			(await sqlite('describe', candidate, undefined, signal)).toString()
		);
		if (!description.entries) throw new Error('empty-index');
		if (!description.builtAt || description.stashDir !== (env.AKM_BUNDLE_DIR || roots.stash))
			throw new Error('uninitialized-index');
		const stateDb = path.join(roots.akmData, 'state.db');
		if (await exists(stateDb))
			await sqlite('capture', stateDb, path.join(data, 'state.db'), signal);
		await fs.writeFile(path.join(configDir, 'config.json'), before.bytes, {
			flag: 'wx',
			mode: 0o600,
			signal
		});
		const candidateEnv = {
			...nativeEnv,
			AKM_BUNDLE_DIR: env.AKM_BUNDLE_DIR || roots.stash,
			AKM_CONFIG_DIR: configDir,
			AKM_DATA_DIR: data,
			AKM_STATE_DIR: path.join(stage, 'state'),
			AKM_AUTO_MEMORY: '0',
			AKM_AUTO_LEARNING: '0',
			BUN_OPTIONS: '--no-env-file --config=/dev/null'
		};
		const result = JSON.parse(
			(
				await command(
					[...akmCommand, 'index', '--clean', '--format', 'json', '-q'],
					candidateEnv,
					signal
				)
			).toString()
		);
		if (
			result.scanComplete !== true ||
			result.skipped ||
			!result.clean ||
			result.clean.dryRun ||
			result.verification?.ok !== true
		)
			throw new Error('refresh-incomplete');
		if ((await profile(catalog, signal)).hash !== before.hash)
			throw new Error('source-policy-changed');
		const snapshot = path.join(stage, 'complete.sqlite');
		await sqlite('capture', candidate, snapshot, signal);
		const bytes = await readRegular(snapshot, limits.bytes, signal);
		const finalDescription = JSON.parse(
			(await sqlite('describe', snapshot, undefined, signal)).toString()
		);
		return { bytes, result, sourceHash, schema: finalDescription.schema };
	}

	async function attempt(action) {
		const signal = AbortSignal.timeout(limits.timeoutMs);
		let stage;
		try {
			await assertNoLinks(privateDir);
			await fs.mkdir(privateDir, { recursive: true, mode: 0o700 });
			stage = await fs.mkdtemp(path.join(privateDir, 'akm-cache-'));
			return await action(stage, signal);
		} catch (error) {
			const reason = signal.aborted
				? 'deadline'
				: [
							'unsupported-source-policy',
							'excluded-source',
							'source-unavailable',
							'source-policy-changed',
							'refresh-incomplete',
							'size-limit',
							'empty-index',
							'uninitialized-index'
						].includes(error.message)
					? error.message
					: 'cache-unavailable';
			set('degraded', reason);
			return null;
		} finally {
			if (stage)
				await fs
					.rm(stage, { recursive: true, force: true })
					.catch(() => set('degraded', 'cleanup-failed'));
		}
	}

	return {
		status: () => ({ ...state, restored }),
		unavailable: () => set('degraded', 'cache-unavailable'),
		async retain({ catalog, reference }) {
			if (!metadata(reference)) {
				set('skipped', 'absent-or-incompatible');
				return null;
			}
			return attempt(async (_stage, signal) => {
				if ((await profile(catalog, signal)).hash !== reference.profile)
					throw new Error('source-policy-changed');
				set('retained');
				return reference;
			});
		},
		async capture({ catalog, store, ownership, previous }) {
			set('capturing');
			return attempt(async (stage, signal) => {
				const before = await profile(catalog, signal);
				if (!(await exists(path.join(roots.akmData, 'index.db')))) throw new Error('empty-index');
				const completed = await freshCandidate(stage, catalog, signal, null, before);
				// A complete unchanged scan under the same source/profile policy can
				// reuse the latest accepted object, without builtAt-based guesswork.
				if (
					metadata(previous) &&
					previous.profile === before.hash &&
					previous.sourceHash === completed.sourceHash &&
					completed.result.directoriesScanned === 0 &&
					completed.result.clean.removed === 0 &&
					previous.schema === completed.schema &&
					previous.entries === completed.result.totalEntries &&
					previous.embeddings === completed.result.verification.embeddingCount
				) {
					set('captured');
					return previous;
				}
				const reference = {
					format: 1,
					instanceId,
					profile: before.hash,
					schema: completed.schema,
					sourceHash: completed.sourceHash,
					hash: hash(completed.bytes),
					bytes: completed.bytes.length,
					capturedAt: Date.now(),
					complete: true,
					entries: completed.result.totalEntries,
					embeddings: completed.result.verification.embeddingCount
				};
				await store.createImmutable(`objects/${reference.hash}`, completed.bytes, ownership, {
					signal
				});
				signal.throwIfAborted();
				set('captured');
				return reference;
			});
		},
		async restore({ catalog, store, reference }) {
			set('restoring');
			const target = path.join(roots.akmData, 'index.db');
			// Never replace a surviving local DB or orphan WAL/SHM, even if invalid.
			if (
				(
					await Promise.all(['', '-wal', '-shm'].map((suffix) => exists(`${target}${suffix}`)))
				).some(Boolean)
			) {
				set('preserved-local');
				return null;
			}
			if (!metadata(reference)) {
				set('skipped', 'absent-or-incompatible');
				return null;
			}
			return attempt(async (stage, signal) => {
				const before = await profile(catalog, signal);
				if (reference.profile !== before.hash) throw new Error('source-policy-changed');
				const input = await store.read(`objects/${reference.hash}`, reference.bytes, { signal });
				if (input.length !== reference.bytes || hash(input) !== reference.hash)
					throw new Error('cache-checksum');
				const completed = await freshCandidate(stage, catalog, signal, input, before);
				await checkStorage(target);
				await assertNoLinks(target);
				signal.throwIfAborted();
				await fs.mkdir(roots.akmData, { recursive: true, mode: 0o700 });
				// Copy to the destination filesystem, then publish exclusively: the
				// private recovery directory may be on a different local mount.
				const snapshot = path.join(stage, 'complete.sqlite');
				const temporary = `${target}.cache-${randomUUID()}`;
				try {
					await fs.copyFile(snapshot, temporary, constants.COPYFILE_EXCL);
					const handle = await fs.open(temporary, 'r');
					try {
						await handle.sync();
					} finally {
						await handle.close();
					}
					signal.throwIfAborted();
					for (const suffix of ['-wal', '-shm'])
						if (await exists(`${target}${suffix}`)) throw new Error('local-index-appeared');
					await fs.link(temporary, target);
					const directory = await fs.open(roots.akmData, 'r');
					try {
						await directory.sync();
					} finally {
						await directory.close();
					}
				} finally {
					await fs.rm(temporary, { force: true });
				}
				set('restored');
				return { bytes: completed.bytes.length };
			});
		}
	};
}

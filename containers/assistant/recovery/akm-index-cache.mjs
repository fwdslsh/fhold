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
			value.format === 2 &&
			value.instanceId === instanceId &&
			/^[a-f0-9]{64}$/.test(value.profile) &&
			/^[a-f0-9]{64}$/.test(value.hash) &&
			Number.isSafeInteger(value.bytes) &&
			value.bytes > 0 &&
			value.bytes <= maximum &&
			Number.isSafeInteger(value.capturedAt) &&
			value.capturedAt > 0 &&
			Number.isSafeInteger(value.vectors) &&
			value.vectors >= 0
	);
}

/** AKM owns vector format, model/text matching and rebuilding from current
 * sources. fhold owns only bounded private staging and recovery integrity. */
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

	async function profile(catalog, signal, stage, selectedFile) {
		signal.throwIfAborted();
		// AKM_CONFIG_DIR is fixed to this native root. Resolve an explicit file
		// override natively once per attempt; later checks re-read the same file.
		// Usage capture stays in staging and credentials remain native-owned.
		const file = selectedFile ?? (nativeEnv.AKM_CONFIG_FILE === undefined
			? path.join(roots.akmConfig, 'config.json')
			: (await command(
				[...akmCommand, 'config', 'path', '--quiet'], candidateEnvironment(stage), signal
			)).toString().trimEnd());
		if (!canonicalPath(file)) throw new Error('unsupported-source-policy');
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
		let primaryDeclared = false;
		for (const [id, bundle] of Object.entries(config.bundles ?? {})) {
			if (bundle.enabled === false) continue;
			if (!canonicalPath(bundle.path) || bundle.git || bundle.npm || bundle.website)
				throw new Error('unsupported-source-policy');
			const components = Object.values(bundle.components ?? {});
			if (components.length !== 1) throw new Error('unsupported-source-policy');
			const component = components[0];
			// Native auto-detection can select other adapter families. Decline
			// caching rather than forcing a different adapter or widening consent.
			if (!['akm', 'agent-skills'].includes(component.adapter))
				throw new Error('unsupported-source-policy');
			const root = path.resolve(bundle.path, component.root ?? '.');
			if (!containsPath(bundle.path, root)) throw new Error('unsupported-source-policy');
			if (root === sources[0]) primaryDeclared = true;
			sources.push(root);
			bundles.push({
				id,
				path: bundle.path,
				registryId: bundle.registryId ?? null,
				writable: bundle.writable !== false,
				component: pick(component, ['root', 'adapter', 'writable'])
			});
		}
		if (!primaryDeclared) throw new Error('unsupported-source-policy');
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
			redaction: config.plugins?.redact ?? null
		};
		return { hash: hash(JSON.stringify(identity)), file };
	}

	function candidateEnvironment(stage) {
		return {
			...nativeEnv,
			AKM_BUNDLE_DIR: env.AKM_BUNDLE_DIR || roots.stash,
			// Native config/credentials remain native-owned and are read in place.
			// Explicit adapters above avoid native detection writes; only derived
			// data/state are isolated. No credential copying or parsing is needed.
			AKM_CONFIG_DIR: roots.akmConfig,
			AKM_DATA_DIR: path.join(stage, 'data'),
			AKM_STATE_DIR: path.join(stage, 'state'),
			BUN_OPTIONS: '--no-env-file --config=/dev/null'
		};
	}

	async function freshCandidate(stage, catalog, signal, input, before) {
		const candidateEnv = candidateEnvironment(stage);
		const vectors = path.join(stage, 'vectors');
		await fs.writeFile(vectors, input, { flag: 'wx', mode: 0o600, signal });
		const result = JSON.parse(
			(
				await command(
					[
						...akmCommand,
						'index',
						'--clean',
						'--import-vectors',
						vectors,
						'--format',
						'json',
						'-q'
					],
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
		if ((await profile(catalog, signal, stage, before.file)).hash !== before.hash)
			throw new Error('source-policy-changed');
		const snapshot = path.join(stage, 'complete.sqlite');
		await sqlite('capture', path.join(candidateEnv.AKM_DATA_DIR, 'index.db'), snapshot, signal);
		return snapshot;
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
							'empty-index'
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
			return attempt(async (stage, signal) => {
				if ((await profile(catalog, signal, stage)).hash !== reference.profile)
					throw new Error('source-policy-changed');
				set('retained');
				return reference;
			});
		},
		async capture({ catalog, store, ownership, previous }) {
			set('capturing');
			return attempt(async (stage, signal) => {
				const before = await profile(catalog, signal, stage);
				const index = path.join(roots.akmData, 'index.db');
				if (!(await exists(index))) throw new Error('empty-index');
				await checkStorage(index);
				let size = 0;
				for (const suffix of ['', '-wal', '-shm']) {
					const file = `${index}${suffix}`;
					await assertNoLinks(file);
					const stat = await exists(file);
					if (stat && !stat.isFile()) throw new Error('sqlite-type');
					size += stat?.size ?? 0;
				}
				if (size > limits.bytes) throw new Error('size-limit');
				const candidateEnv = candidateEnvironment(stage);
				const vectors = path.join(stage, 'vectors');
				const result = JSON.parse(
					(
						await command(
							[...akmCommand, 'index', '--export-vectors', vectors, '--format', 'json', '-q'],
							{ ...candidateEnv, AKM_DATA_DIR: roots.akmData },
							signal
						)
					).toString()
				);
				if (
					result.ok !== true ||
					!Number.isSafeInteger(result.exported?.vectors) ||
					result.exported.vectors < 0
				)
					throw new Error('refresh-incomplete');
				if ((await profile(catalog, signal, stage, before.file)).hash !== before.hash)
					throw new Error('source-policy-changed');
				if (result.exported.vectors === 0) {
					set('skipped', 'no-vectors');
					return null;
				}
				const bytes = await readRegular(vectors, limits.bytes, signal);
				if (
					metadata(previous) &&
					previous.profile === before.hash &&
					previous.hash === hash(bytes)
				) {
					set('captured');
					return previous;
				}
				const reference = {
					format: 2,
					instanceId,
					profile: before.hash,
					hash: hash(bytes),
					bytes: bytes.length,
					capturedAt: Date.now(),
					vectors: result.exported.vectors
				};
				await store.createImmutable(`objects/${reference.hash}`, bytes, ownership, {
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
				const before = await profile(catalog, signal, stage);
				if (reference.profile !== before.hash) throw new Error('source-policy-changed');
				const input = await store.read(`objects/${reference.hash}`, reference.bytes, { signal });
				if (input.length !== reference.bytes || hash(input) !== reference.hash)
					throw new Error('cache-checksum');
				const snapshot = await freshCandidate(stage, catalog, signal, input, before);
				await checkStorage(target);
				await assertNoLinks(target);
				signal.throwIfAborted();
				await fs.mkdir(roots.akmData, { recursive: true, mode: 0o700 });
				// Copy to the destination filesystem, then publish exclusively: the
				// private recovery directory may be on a different local mount.
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
				return { bytes: (await fs.stat(snapshot)).size };
			});
		}
	};
}

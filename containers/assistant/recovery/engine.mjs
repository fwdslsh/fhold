import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { assertNoLinks, createDirectoryStore, readRegular } from './directory-store.mjs';
import {
	CATALOG_VERSION,
	CUSTOM_CATALOG_VERSION,
	BOUNDARY_CATALOG_VERSION,
	DEFAULT_ROOTS,
	canonicalPath,
	containsPath,
	createCatalog,
	normalizeSelection,
	normalizeNetworkMounts,
	validPathCharacters
} from './catalog.mjs';
import { inspectMounts, readMountInfo } from './mounts.mjs';

export const FORMAT_VERSION = 1;
export { CATALOG_VERSION, DEFAULT_ROOTS };
export const DEFAULT_LIMITS = Object.freeze({
	maxFiles: 10000,
	maxFileBytes: 64 * 1024 * 1024,
	maxDatabaseBytes: 256 * 1024 * 1024,
	maxTotalBytes: 1024 * 1024 * 1024,
	maxManifestBytes: 4 * 1024 * 1024,
	operationTimeoutMs: 120000,
	sqliteTimeoutMs: 120000
});
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SAFE_FAILURES = new Set([
	'recovery Blob transport failed',
	'recovery Blob authentication failed',
	'recovery Blob object missing',
	'recovery Blob condition conflict',
	'recovery Blob deadline exceeded',
	'recovery Blob transport unavailable',
	'recovery Blob object exceeds limit',
	'recovery Blob incomplete read',
	'recovery Blob descriptor invalid',
	'recovery Blob checksum mismatch',
	'recovery Blob insecure endpoint must be local emulator',
	'recovery operation deadline exceeded',
	'initialized required SQLite member disappeared',
	'recovery ownership lost',
	'recovery manifest checksum mismatch',
	'recovery member checksum mismatch',
	'recovery descriptor identity/format rejected',
	'recovery manifest rejected',
	'recovery presence mismatch',
	'recovery descriptor conflict',
	'recovery claim conflict',
	'recovery publication readback failed',
	'recovery owner exists; no automatic takeover',
	'recovery namespace requires explicit initialization',
	'recovery descriptor busy; external recovery required after interruption',
	'incomplete recovery journal requires operator review',
	'local recovery receipt authority unresolved',
	'unreceipted local state would be overwritten',
	'recovery capture budget exceeded',
	'recovery member exceeds budget',
	'recovery total exceeds budget',
	'recovery file count exceeds budget',
	'recovery directory exceeds budget',
	'SQLite input exceeds budget',
	'SQLite snapshot deadline exceeded',
	'SQLite snapshot/validation failed',
	'SQLite source replaced during capture',
	'uncataloged SQLite member rejected',
	'uncataloged SQLite restore rejected',
	'recovery path contains a link',
	'recovery member link rejected',
	'recovery member type rejected',
	'recovery special file rejected',
	'recovery file type/size rejected',
	'recovery file grew beyond limit',
	'recovery manifest total exceeds budget',
	'recovery manifest exceeds budget',
	'recovery member mode rejected',
	'recovery excluded member rejected',
	'recovery file catalog mismatch',
	'recovery SQLite catalog mismatch',
	'recovery file cannot be SQLite',
	'recovery member rejected',
	'SQLite input type rejected',
	'recovery file changed during capture',
	'recovery include file requires paths and sqlite arrays',
	'recovery include paths must be canonical absolute paths',
	'recovery include file must be an absolute path',
	'recovery include file must be valid JSON',
	'recovery include path overlaps protected state or destination',
	'recovery SQLite path must name a file',
	'recovery selection identity rejected',
	'recovery network mount discovery must be boolean',
	'recovery mount policies conflict',
	'recovery mount table rejected',
	'recovery SQLite must use local storage',
	'recovery required external mount missing',
	'recovery external mount must be a directory',
	'recovery excluded path must be a directory',
	'recovery included mount missing',
	'recovery exclusions overlap required SQLite state',
	'recovery mount topology changed; stop writers and review mounts'
]);
export function sanitizeRecoveryError(error) {
	if (error && SAFE_FAILURES.has(error.message)) return error.message;
	const code = error?.code;
	if (['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'ETIMEDOUT', 'EEXIST'].includes(code))
		return `recovery filesystem failure (${code})`;
	return 'recovery operation failed';
}
const serialize = (value) => Buffer.from(JSON.stringify(value));
function same(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}
function relative(value) {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		!path.isAbsolute(value) &&
		!value.split('/').some((part) => !part || part === '.' || part === '..') &&
		validPathCharacters(value)
	);
}
function instance(value) {
	if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(value))
		throw new Error('invalid recovery instance identity');
	return value;
}
async function exists(target) {
	try {
		return await fs.lstat(target);
	} catch (error) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
}
async function privateWrite(target, value) {
	await assertNoLinks(target);
	const temp = `${target}.${randomUUID()}.tmp`;
	const handle = await fs.open(temp, 'wx', 0o600);
	try {
		await handle.writeFile(serialize(value));
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fs.rename(temp, target);
	const directory = await fs.open(path.dirname(target), 'r');
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

export function createEngine(config, options = {}) {
	const instanceId = instance(config.instanceId);
	const roots = { ...DEFAULT_ROOTS, ...options.roots };
	for (const root of Object.values(roots))
		if (!canonicalPath(root)) throw new Error('invalid native recovery root');
	const rootValues = Object.values(roots);
	if (
		rootValues.some((root, i) =>
			rootValues.some((other, j) => i !== j && (root === other || root.startsWith(`${other}/`)))
		)
	)
		throw new Error('native recovery roots overlap');
	const limits = { ...DEFAULT_LIMITS, ...options.limits };
	for (const value of Object.values(limits))
		if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid recovery limit');
	// Version provenance is diagnostic, not restore permission or compatibility.
	const versions = config.versions ?? {};
	const privateDir = config.privateDir ?? path.join(roots.home, '.fhold-recovery');
	if (!canonicalPath(privateDir)) throw new Error('invalid private recovery path');
	if (
		rootValues.some(
			(root) =>
				(privateDir === root ||
					privateDir.startsWith(`${root}/`) ||
					root.startsWith(`${privateDir}/`)) &&
				!(root === roots.home && privateDir === path.join(root, '.fhold-recovery'))
		)
	)
		throw new Error('private recovery directory overlaps native state');
	const store =
		options.store ??
		createDirectoryStore(config.url, {
			maxReadBytes: Math.max(limits.maxDatabaseBytes, limits.maxFileBytes, limits.maxManifestBytes)
		});
	if (
		store.root &&
		Object.values(roots).some(
			(root) =>
				store.root === root ||
				store.root.startsWith(`${root}/`) ||
				root.startsWith(`${store.root}/`)
		)
	)
		throw new Error('recovery destination must be outside live roots');
	if (
		store.root &&
		(store.root === privateDir ||
			store.root.startsWith(`${privateDir}/`) ||
			privateDir.startsWith(`${store.root}/`))
	)
		throw new Error('recovery destination overlaps private state');
	for (const privatePath of store.privatePaths ?? []) {
		const secretPath = typeof privatePath === 'string' ? path.resolve(privatePath) : '';
		if (
			typeof privatePath !== 'string' ||
			!path.isAbsolute(privatePath) ||
			rootValues.some(
				(root) =>
					(secretPath === root ||
						secretPath.startsWith(`${root}/`) ||
						root.startsWith(`${secretPath}/`)) &&
					!secretPath.startsWith(`${privateDir}/`)
			)
		)
			throw new Error('recovery transport secret overlaps native state');
	}
	const catalogOptions = {
		privateDir,
		runtimeDir: config.runtimeDir,
		store,
		includeFile: config.includeFile
	};
	if (
		(config.runtimeDir && !canonicalPath(config.runtimeDir)) ||
		(config.includeFile && !canonicalPath(config.includeFile))
	)
		throw new Error('recovery include paths must be canonical absolute paths');
	let catalog = createCatalog(roots, config.selection, catalogOptions);
	let mountBoundary;
	async function checkMounts() {
		const reviewed = await inspectMounts(catalog, await (options.readMounts ?? readMountInfo)());
		if (mountBoundary && mountBoundary.fingerprint !== reviewed.fingerprint)
			throw new Error('recovery mount topology changed; stop writers and review mounts');
		if (!mountBoundary) {
			catalog = createCatalog(roots, config.selection, {
				...catalogOptions,
				networkMounts: reviewed.networkMounts
			});
			mountBoundary = reviewed;
		}
		checkDeadline();
		return reviewed;
	}
	if (serialize(catalog.selection).length > limits.maxManifestBytes)
		throw new Error('recovery manifest exceeds budget');
	if (
		config.includeFile &&
		![privateDir, config.runtimeDir].some(
			(item) => item && containsPath(item, config.includeFile)
		) &&
		catalog.trees.some(([root, name]) =>
			containsPath(catalog.native(root, name), config.includeFile)
		)
	)
		throw new Error('recovery include path overlaps protected state or destination');
	// The configuration is externally supplied authority, never a restore member.
	let ownership;
	let head;
	let busy = false;
	let ready = false;
	let lastCheckpointAt = null;
	let lastCheckpointTick = null;
	let failure = null;
	let operationDeadline = 0;
	function checkDeadline() {
		if (busy && performance.now() >= operationDeadline)
			throw new Error('recovery operation deadline exceeded');
	}
	const stages = new Set();
	const native = (root, name) => catalog.native(root, name);
	const receiptPath = path.join(privateDir, 'receipt.json');
	const journalPath = path.join(privateDir, 'restore-journal.json');
	const validateDescriptor = (value) => {
		if (
			!value ||
			value.format !== FORMAT_VERSION ||
			value.product !== 'fhold' ||
			value.kind !== 'assistant-instance' ||
			![CATALOG_VERSION, CUSTOM_CATALOG_VERSION, BOUNDARY_CATALOG_VERSION].includes(
				value.catalog
			) ||
			value.instanceId !== instanceId ||
			!Number.isSafeInteger(value.epoch) ||
			value.epoch < 0 ||
			(value.generation !== null && !/^[a-f0-9]{64}$/.test(value.generation))
		)
			throw new Error('recovery descriptor identity/format rejected');
		if (
			(value.catalog !== CATALOG_VERSION && !/^[a-f0-9]{64}$/.test(value.selectionHash)) ||
			(value.catalog === CATALOG_VERSION && value.selectionHash !== undefined)
		)
			throw new Error('recovery selection identity rejected');
	};
	function savedCatalog(manifest, descriptor) {
		let selection;
		if (manifest.catalog === CATALOG_VERSION) {
			if (manifest.selection !== undefined || manifest.selectionHash !== undefined)
				throw new Error('recovery selection identity rejected');
			selection = normalizeSelection();
		} else if ([CUSTOM_CATALOG_VERSION, BOUNDARY_CATALOG_VERSION].includes(manifest.catalog)) {
			selection = normalizeSelection(manifest.selection);
			if (!same(selection, manifest.selection))
				throw new Error('recovery selection identity rejected');
		} else throw new Error('recovery selection identity rejected');
		let networkMounts = [];
		if (manifest.catalog === BOUNDARY_CATALOG_VERSION) {
			networkMounts = normalizeNetworkMounts(manifest.networkMounts);
			if (selection.version !== 1 || !same(networkMounts, manifest.networkMounts))
				throw new Error('recovery selection identity rejected');
		} else if (manifest.networkMounts !== undefined || selection.version !== undefined)
			throw new Error('recovery selection identity rejected');
		const saved = createCatalog(roots, selection, { ...catalogOptions, networkMounts });
		if (
			saved.metadata.catalog !== manifest.catalog ||
			saved.metadata.selectionHash !== manifest.selectionHash ||
			(descriptor &&
				(descriptor.catalog !== manifest.catalog ||
					descriptor.selectionHash !== manifest.selectionHash))
		)
			throw new Error('recovery selection identity rejected');
		return saved;
	}
	const selectedForRestore = (member, saved) => {
		const target = saved.native(member.root, member.path);
		return catalog.dbPaths.has(target) || catalog.allowsPath(target);
	};
	async function preparePrivate() {
		await assertNoLinks(privateDir);
		await fs.mkdir(privateDir, { recursive: true, mode: 0o700 });
		await fs.chmod(privateDir, 0o700);
	}
	async function owned(checkBoundary = false) {
		checkDeadline();
		if (checkBoundary) await checkMounts();
		if (!ownership) throw new Error('recovery not owned');
		await store.renew(ownership);
	}
	async function checkSQLiteStorage(target) {
		// Discovered databases use the same local-storage check as registered ones.
		await inspectMounts(
			{
				...catalog,
				sqliteFiles: new Set([...catalog.sqliteFiles, target, `${target}-wal`, `${target}-shm`])
			},
			await (options.readMounts ?? readMountInfo)()
		);
	}
	async function sqlite(operation, source, destination) {
		await checkMounts();
		await checkSQLiteStorage(source);
		await assertNoLinks(source);
		const maximum = limits.maxDatabaseBytes;
		let inputBytes = 0;
		for (const item of [source, `${source}-wal`, `${source}-shm`]) {
			await assertNoLinks(item);
			const stat = await exists(item);
			if (stat) {
				if (!stat.isFile()) throw new Error('SQLite input type rejected');
				inputBytes += stat.size;
			}
		}
		if (inputBytes > maximum) throw new Error('SQLite input exceeds budget');
		const original = await fs.stat(source);
		await new Promise((resolve, reject) => {
			const child = spawn(
				options.bunPath ?? process.execPath,
				[
					'--no-env-file',
					'--config=/dev/null',
					fileURLToPath(new URL('./sqlite-worker.mjs', import.meta.url)),
					operation,
					source,
					destination ?? '',
					String(maximum)
				],
				{
					stdio: 'ignore',
					cwd: privateDir,
					env: { PATH: process.env.PATH, HOME: roots.home },
					detached: false
				}
			);
			const timeout = setTimeout(
				() => {
					child.kill('SIGKILL');
				},
				Math.min(
					limits.sqliteTimeoutMs,
					limits.operationTimeoutMs,
					Math.max(1, operationDeadline - performance.now())
				)
			);
			child.once('error', (error) => {
				clearTimeout(timeout);
				reject(error);
			});
			child.once('exit', (code, signal) => {
				clearTimeout(timeout);
				if (code === 0) resolve();
				else
					reject(
						new Error(
							signal ? 'SQLite snapshot deadline exceeded' : 'SQLite snapshot/validation failed'
						)
					);
			});
		});
		const after = await fs.stat(source);
		if (original.dev !== after.dev || original.ino !== after.ino)
			throw new Error('SQLite source replaced during capture');
	}
	async function inventory(previousPresence = {}) {
		await checkMounts();
		const members = [];
		const presence = {};
		const seen = new Set();
		const visited = new Set();
		let bytes = 0;
		let traversed = 0;
		async function add(root, name, kind, id) {
			checkDeadline();
			const target = native(root, name);
			if (seen.has(target)) return;
			if (members.length >= limits.maxFiles) throw new Error('recovery file count exceeds budget');
			seen.add(target);
			const stat = await exists(target);
			if (!stat) return;
			if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('recovery member type rejected');
			if (kind === 'sqlite') await checkSQLiteStorage(target);
			const maximum = kind === 'sqlite' ? limits.maxDatabaseBytes : limits.maxFileBytes;
			if (stat.size > maximum) throw new Error('recovery member exceeds budget');
			bytes += stat.size;
			if (bytes > limits.maxTotalBytes) throw new Error('recovery total exceeds budget');
			members.push({ root, path: name, kind, mode: stat.mode & 0o700, ...(id ? { id } : {}) });
		}
		for (const [id, root, name] of catalog.databases) {
			checkDeadline();
			await assertNoLinks(native(root, name));
			const stat = await exists(native(root, name));
			for (const sidecar of [`${native(root, name)}-wal`, `${native(root, name)}-shm`]) {
				await assertNoLinks(sidecar);
				if (!stat && (await exists(sidecar))) throw new Error('SQLite input type rejected');
			}
			presence[id] = Boolean(stat);
			// Versioned Codex database names can change through native migrations.
			if (previousPresence[id] && !stat && !id.startsWith('codex-'))
				throw new Error('initialized required SQLite member disappeared');
			if (stat) {
				await add(root, name, 'sqlite', id);
			}
		}
		async function walk(root, name) {
			checkDeadline();
			const target = native(root, name);
			if (catalog.excluded(root, name) || visited.has(target)) return;
			visited.add(target);
			if (++traversed > limits.maxFiles) throw new Error('recovery directory exceeds budget');
			await assertNoLinks(target);
			const stat = await exists(target);
			if (!stat) return;
			if (stat.isSymbolicLink()) throw new Error('recovery member link rejected');
			if (stat.isDirectory()) {
				const entries = await fs.readdir(target);
				if (entries.length > limits.maxFiles) throw new Error('recovery directory exceeds budget');
				for (const entry of entries.sort()) await walk(root, name ? `${name}/${entry}` : entry);
			} else if (stat.isFile()) {
				if (catalog.sqliteFiles.has(target)) return;
				// Upstream tools and workspace apps can create new SQLite files. Detect
				// their content, not their extension, and snapshot them natively.
				if (/-wal$|-shm$/.test(name) && (await isSQLite(target.slice(0, -4)))) return;
				await add(root, name, await isSQLite(target) ? 'sqlite' : 'file');
			} else throw new Error('recovery special file rejected');
		}
		for (const [root, name] of catalog.trees) await walk(root, name);
		return { members, presence };
	}
	async function isSQLite(target) {
		await assertNoLinks(target);
		if (!(await exists(target))?.isFile()) return false;
		const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const magic = Buffer.alloc(16);
			await handle.read(magic, 0, 16, 0);
			return magic.toString() === 'SQLite format 3\0';
		} finally {
			await handle.close();
		}
	}
	function validateManifest(manifest, descriptor) {
		if (
			!manifest ||
			manifest.format !== FORMAT_VERSION ||
			manifest.product !== 'fhold' ||
			manifest.kind !== 'assistant-instance' ||
			![CATALOG_VERSION, CUSTOM_CATALOG_VERSION, BOUNDARY_CATALOG_VERSION].includes(
				manifest.catalog
			) ||
			manifest.instanceId !== instanceId ||
			!Array.isArray(manifest.members) ||
			manifest.members.length > limits.maxFiles ||
			!manifest.presence ||
			typeof manifest.presence !== 'object' ||
			Array.isArray(manifest.presence)
		)
			throw new Error('recovery manifest rejected');
		const saved = savedCatalog(manifest, descriptor);
		let bytes = 0;
		const seen = new Set();
		for (const member of manifest.members) {
			if (!member || typeof member !== 'object') throw new Error('recovery member rejected');
			if (
				!Object.hasOwn(saved.roots, member.root) ||
				!relative(member.path) ||
				!['file', 'sqlite'].includes(member.kind) ||
				!/^[a-f0-9]{64}$/.test(member.hash) ||
				!Number.isSafeInteger(member.bytes) ||
				member.bytes < 0 ||
				member.bytes > (member.kind === 'sqlite' ? limits.maxDatabaseBytes : limits.maxFileBytes)
			)
				throw new Error('recovery member rejected');
			const key = saved.native(member.root, member.path);
			if (seen.has(key)) throw new Error('recovery member rejected');
			seen.add(key);
			bytes += member.bytes;
			if (
				member.kind === 'sqlite' &&
				!saved.databases.some(
					([id, root, name]) => member.id === id && member.root === root && member.path === name
				) &&
				!(member.id === undefined && saved.allowsFile(member.root, member.path))
			)
				throw new Error('recovery SQLite catalog mismatch');
			if (member.kind === 'file' && !saved.allowsFile(member.root, member.path))
				throw new Error('recovery file catalog mismatch');
			if (
				member.kind === 'file' &&
				(member.id !== undefined || saved.sqliteFiles.has(key))
			)
				throw new Error('recovery file cannot be SQLite');
			if (
				!Number.isInteger(member.mode) ||
				member.mode < 0 ||
				member.mode > 0o700 ||
				member.mode & ~0o700
			)
				throw new Error('recovery member mode rejected');
			if (saved.excluded(member.root, member.path))
				throw new Error('recovery excluded member rejected');
		}
		if (bytes > limits.maxTotalBytes) throw new Error('recovery manifest total exceeds budget');
		for (const [id] of saved.databases)
			if (
				typeof manifest.presence[id] !== 'boolean' ||
				manifest.presence[id] !== manifest.members.some((m) => m.kind === 'sqlite' && m.id === id)
			)
				throw new Error('recovery presence mismatch');
		if (Object.keys(manifest.presence).length !== saved.databases.length)
			throw new Error('recovery presence mismatch');
		return saved;
	}
	async function manifestAt(generation, descriptor = head.value) {
		const bytes = await store.read(`manifests/${generation}`, limits.maxManifestBytes);
		if (digest(bytes) !== generation) throw new Error('recovery manifest checksum mismatch');
		const manifest = JSON.parse(bytes.toString());
		validateManifest(manifest, descriptor);
		return manifest;
	}
	async function writeReceipt(generation) {
		await checkMounts();
		await privateWrite(receiptPath, {
			format: FORMAT_VERSION,
			product: 'fhold',
			kind: 'assistant-instance',
			catalog: head.value.catalog,
			...(head.value.selectionHash ? { selectionHash: head.value.selectionHash } : {}),
			instanceId,
			versions,
			epoch: head.value.epoch,
			generation
		});
	}
	async function operation(task, startup = false) {
		if (busy) throw new Error('recovery operation already active');
		busy = true;
		operationDeadline = performance.now() + limits.operationTimeoutMs;
		try {
			failure = null;
			try {
				const result = await task();
				await checkMounts();
				checkDeadline();
				return result;
			} finally {
				for (const stage of stages) {
					// Keep journal-owned partial restore evidence; all other generated
					// staging is disposable. Cleanup failures remain operation failures.
					if (path.basename(stage).startsWith('restore-') && (await exists(journalPath))) continue;
					await fs.rm(stage, { recursive: true, force: true });
					stages.delete(stage);
				}
			}
		} catch (error) {
			if (startup) {
				ready = false;
				if (ownership) {
					try {
						await store.release(ownership);
						ownership = undefined;
					} catch {
						/* No writer was admitted; leave an unconfirmed persistent lock failclosed. */
					}
				}
			}
			failure = sanitizeRecoveryError(error);
			throw error;
		} finally {
			busy = false;
		}
	}
	return {
		async inspect() {
			const reviewed = await checkMounts();
			return {
				...catalog.metadata,
				selection: catalog.selection,
				trees: catalog.trees.map(([root, name]) => native(root, name)),
				sqlite: [...catalog.dbPaths.keys()],
				exclusions: catalog.policy.excludePaths.map((item) => ({
					path: item,
					reason: 'excluded-path'
				})),
				externalMounts: reviewed.externalMounts
			};
		},
		async initialize() {
			return operation(async () => {
				await checkMounts();
				await store.initialize({
					format: FORMAT_VERSION,
					product: 'fhold',
					kind: 'assistant-instance',
					...catalog.metadata,
					instanceId,
					versions,
					owner: null,
					epoch: 0,
					generation: null
				});
			});
		},
		async acquireRestore() {
			if (ownership) throw new Error('recovery already acquired');
			return operation(async () => {
				await checkMounts();
				const previous = await store.readDescriptor();
				if (!previous) throw new Error('recovery namespace requires explicit initialization');
				validateDescriptor(previous.value);
				// Validate saved content, then apply today's operator-selected coverage.
				// Excluded or no-longer-selected files stay in the historical checkpoint,
				// never get replayed onto independent mounts or outside current coverage.
				const manifest = previous.value.generation
					? await manifestAt(previous.value.generation, previous.value)
					: null;
				const saved = manifest ? savedCatalog(manifest, previous.value) : null;
				ownership = await store.acquire();
				try {
					head = await store.claim(previous.token, ownership);
					validateDescriptor(head.value);
					await preparePrivate();
					if (await exists(journalPath))
						throw new Error('incomplete recovery journal requires operator review');
					const generation = head.value.generation;
					const receiptBytes = (await exists(receiptPath))
						? await readRegular(receiptPath, 64 * 1024)
						: null;
					if (receiptBytes) {
						const receipt = JSON.parse(receiptBytes.toString());
						if (
							receipt.format !== FORMAT_VERSION ||
							receipt.product !== 'fhold' ||
							receipt.kind !== 'assistant-instance' ||
							receipt.catalog !== head.value.catalog ||
							receipt.selectionHash !== head.value.selectionHash ||
							receipt.instanceId !== instanceId ||
							receipt.generation !== generation
						)
							throw new Error('local recovery receipt authority unresolved');
					} else if (generation && (await inventory()).members.length) {
						throw new Error('unreceipted local state would be overwritten');
					}
					// A valid receipt identifies this disk. Preserve newer local data;
					// backup limits and inventory checks belong to capture, not warm boot.
					// An initialized destination with no checkpoint has nothing to replay.
					const restoreMembers = [];
					for (const member of manifest?.members ?? []) {
						if (!selectedForRestore(member, saved)) continue;
						const target = saved.native(member.root, member.path);
						if (receiptBytes && (await exists(target))) continue;
						if (member.kind === 'sqlite' &&
							((await exists(`${target}-wal`)) || (await exists(`${target}-shm`))))
							throw new Error('SQLite input type rejected');
						restoreMembers.push(member);
					}
					if (restoreMembers.length) {
						const stage = await fs.mkdtemp(path.join(privateDir, 'restore-'));
						stages.add(stage);
						for (const member of restoreMembers) {
							await owned();
							const bytes = await store.read(`objects/${member.hash}`, member.bytes);
							if (bytes.length !== member.bytes || digest(bytes) !== member.hash)
								throw new Error('recovery member checksum mismatch');
							if (
								member.kind === 'file' &&
								bytes.subarray(0, 16).toString() === 'SQLite format 3\0'
							)
								throw new Error('uncataloged SQLite restore rejected');
							const target = path.join(stage, member.root, member.path);
							await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
							await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
							if (member.kind === 'sqlite') {
								await checkSQLiteStorage(saved.native(member.root, member.path));
								await sqlite('verify', target);
							}
						}
						await checkMounts();
						await privateWrite(journalPath, { instanceId, generation, stage, phase: 'publishing' });
						// All staged content validated before first native target write. The
						// journal prevents partial publication from ever starting writers.
						for (const member of restoreMembers) {
							await owned(true);
							const target = saved.native(member.root, member.path);
							await assertNoLinks(target);
							await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
							await fs.copyFile(
								path.join(stage, member.root, member.path),
								target,
								constants.COPYFILE_EXCL
							);
							await fs.chmod(target, member.mode);
							const restored = await fs.open(target, 'r');
							try {
								await restored.sync();
							} finally {
								await restored.close();
							}
							const directory = await fs.open(path.dirname(target), 'r');
							try {
								await directory.sync();
							} finally {
								await directory.close();
							}
						}
						await writeReceipt(generation);
						await fs.unlink(journalPath);
						await fs.rm(stage, { recursive: true });
					}
					await writeReceipt(generation);
					lastCheckpointAt = manifest?.finishedAt ?? null;
					ready = true;
					return this.status();
				} catch (error) {
					ready = false;
					// The startup operation also releases after a late deadline/error;
					// no native writer was admitted and incomplete journals remain.
					throw error;
				}
			}, true);
		},
		async checkpoint() {
			return operation(async () => {
				if (!ready) throw new Error('recovery startup not complete');
				await owned(true);
				const previous = head.value.generation ? await manifestAt(head.value.generation) : null;
				const { members, presence } = await inventory(previous?.presence);
				const startedAt = Date.now();
				const stage = await fs.mkdtemp(path.join(privateDir, 'capture-'));
				stages.add(stage);
				const captured = [];
				let total = 0;
				for (const member of members) {
					await owned();
					const captureStartedAt = Date.now();
					const source = native(member.root, member.path);
					let bytes;
					if (member.kind === 'sqlite') {
						const target = path.join(
							stage,
							`${digest(serialize([member.root, member.path]))}.sqlite`
						);
						await sqlite('capture', source, target);
						bytes = await readRegular(target, limits.maxDatabaseBytes);
					} else {
						bytes = await readRegular(source, limits.maxFileBytes);
						if (bytes.subarray(0, 16).toString() === 'SQLite format 3\0')
							throw new Error('uncataloged SQLite member rejected');
					}
					total += bytes.length;
					if (total > limits.maxTotalBytes) throw new Error('recovery capture budget exceeded');
					checkDeadline();
					const hash = digest(bytes);
					await store.createImmutable(`objects/${hash}`, bytes, ownership);
					captured.push({
						...member,
						hash,
						bytes: bytes.length,
						captureStartedAt,
						captureFinishedAt: Date.now()
					});
				}
				const manifest = {
					format: FORMAT_VERSION,
					product: 'fhold',
					kind: 'assistant-instance',
					...catalog.metadata,
					...(catalog.metadata.catalog !== CATALOG_VERSION ? { selection: catalog.selection } : {}),
					...(catalog.metadata.catalog === BOUNDARY_CATALOG_VERSION
						? { networkMounts: catalog.networkMounts }
						: {}),
					instanceId,
					versions,
					...(config.image ? { image: config.image } : {}),
					presence,
					members: captured,
					epoch: head.value.epoch,
					startedAt,
					finishedAt: Date.now(),
					consistency: 'individual-sqlite-transactions-and-files-not-one-transaction'
				};
				validateManifest(manifest);
				const bytes = serialize(manifest);
				if (bytes.length > limits.maxManifestBytes)
					throw new Error('recovery manifest exceeds budget');
				const generation = digest(bytes);
				checkDeadline();
				await store.createImmutable(`manifests/${generation}`, bytes, ownership);
				await owned(true);
				head = await store.compareAndSwap(
					head.token,
					{ ...head.value, ...catalog.metadata, versions, generation, checkpointAt: manifest.finishedAt },
					ownership
				);
				await writeReceipt(generation);
				lastCheckpointAt = manifest.finishedAt;
				lastCheckpointTick = performance.now();
				await fs.rm(stage, { recursive: true });
				return this.status();
			});
		},
		async renew() {
			try {
				await owned(true);
			} catch (error) {
				ready = false;
				failure = sanitizeRecoveryError(error);
				throw error;
			}
			return this.status();
		},
		status() {
			return {
				ready,
				owned: Boolean(ownership),
				busy,
				instanceId,
				epoch: head?.value.epoch ?? null,
				generation: head?.value.generation ?? null,
				lastCheckpointAt,
				lastCheckpointTick,
				failure
			};
		},
		async release() {
			ready = false;
			if (busy) throw new Error('cannot release active recovery operation');
			if (ownership) {
				await store.release(ownership);
				ownership = undefined;
			}
		}
	};
}

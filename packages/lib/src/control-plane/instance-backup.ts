import { createHash } from 'node:crypto';
import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	lutimesSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	readSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeSync
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { assertProjectOwnership, runDocker } from './docker.js';
import { createFholdState, mergeEnvContent, readEnvFile, writeFileAtomic } from './foundation.js';
import { acquireStackLock, releaseStackLock } from './lock.js';
import { assertSafePortablePath } from './provider-files.js';
import { recordRuntimeActivation, runtimeRevision } from './runtime-revision.js';
import { readStackConfig } from './stack-config.js';
import { requireInstall } from './state.js';

const MANIFEST = 'fhold-backup.json';
const PAYLOAD = 'instance';
const MAX_ENTRIES = 1_000_000;
const MAX_MANIFEST_BYTES = 128 * 1024 * 1024;
// Only process coordination is omitted. Caches, dependency trees, WAL/SHM,
// credentials and all other instance-owned content are deliberately included.
export const INSTANCE_BACKUP_EXCLUSIONS = [
	'data/.lifecycle.lock',
	'data/.instance-restore.json',
	'data/assistant/.codex/tmp',
	'data/assistant/.codex/.tmp',
	'data/assistant/.codex/locks',
	'data/assistant/.codex/thread-writer-locks',
	'data/assistant/.codex/app-server-control/app-server-control.sock',
	'data/akm/data/locks'
] as const;

export const INSTANCE_BACKUP_NOTICE =
	'The entire instance folder is included: conversations, files, sign-ins, access keys, permissions, plugins and active task settings. All instance containers and other writers must be stopped for the whole operation; connections and scheduled work will be unavailable. The export is unencrypted: keep it private. External drives, named volumes, symlink targets outside the folder and container images are not included. Process locks, temporary Codex wrappers and sockets are omitted. Import requires an empty folder, keeps the saved instance name, ports and image versions, and leaves containers stopped. Never run the original and restored copies together. Review external mounts and any recovery destination before starting.';

type EntryBase = { path: string; mode: number; mtimeMs: number };
export type InstanceBackupEntry = EntryBase &
	(
		| { type: 'directory' }
		| { type: 'file'; bytes: number; sha256: string }
		| { type: 'symlink'; target: string }
	);
export type InstanceBackupManifest = {
	product: 'fhold';
	version: 1;
	scope: 'instance';
	createdAt: string;
	sourceHome: string;
	projectName: string;
	files: InstanceBackupEntry[];
	totalBytes: number;
	omittedPaths: string[];
	warnings: string[];
};
export type InstanceRestorePlan = {
	scope: 'instance';
	sourceHome: string;
	destinationHome: string;
	projectName: string;
	copyCount: number;
	totalBytes: number;
	warnings: string[];
	omittedPaths: string[];
	digest: string;
};
export type InstanceBackupOptions = {
	sourceHome: string;
	destination: string;
	confirmedStopped?: boolean;
};
export type InstanceRestoreOptions = {
	sourceHome: string;
	destinationHome: string;
	confirmedStopped?: boolean;
};

function inside(root: string, path: string): boolean {
	const value = relative(root, path);
	return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`));
}

/** Resolve missing leaves, refusing aliases in the requested path. */
function directory(path: string, mustExist = false): string {
	if (!path?.trim() || path.includes('\0'))
		throw new Error('Choose a real instance/export directory.');
	const requested = resolve(path);
	let current = requested;
	while (!lstatSync(current, { throwIfNoEntry: false })) current = dirname(current);
	if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink())
		throw new Error('Instance/export directories must not be symlinks.');
	const resolved = resolve(realpathSync(current), relative(current, requested));
	if (resolved !== requested)
		throw new Error('Choose the resolved directory, not a symlink alias.');
	if (mustExist && !lstatSync(resolved, { throwIfNoEntry: false })?.isDirectory())
		throw new Error(`Instance/export directory is missing: ${resolved}`);
	return resolved;
}

function separate(source: string, destination: string): void {
	if (inside(source, destination) || inside(destination, source))
		throw new Error('Instance and export directories must be separate and non-overlapping.');
}

function empty(path: string): void {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (stat && (!stat.isDirectory() || readdirSync(path).length))
		throw new Error(
			'Full-instance import/export requires a new or empty destination folder. Existing data is never overwritten.'
		);
}

function validPath(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length <= 4096 &&
		!isAbsolute(value) &&
		!value.includes('\\') &&
		![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
		value.split('/').every((part) => part && part !== '.' && part !== '..')
	);
}

function readJson(home: string, path: string, maximum: number): unknown {
	assertSafePortablePath(home, path);
	const descriptor = openSync(
		join(home, path),
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
	);
	try {
		const before = fstatSync(descriptor);
		if (!before.isFile() || before.size > maximum)
			throw new Error('Snapshot metadata must be a bounded regular file.');
		const bytes = Buffer.alloc(before.size + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(descriptor, bytes, length, bytes.length - length, null);
			if (!count) break;
			length += count;
		}
		const after = fstatSync(descriptor);
		assertSafePortablePath(home, path);
		if (
			length !== before.size ||
			after.size !== before.size ||
			after.ctimeMs !== before.ctimeMs ||
			lstatSync(join(home, path)).ino !== before.ino
		)
			throw new Error('Snapshot metadata changed while reading.');
		try {
			return JSON.parse(bytes.subarray(0, length).toString('utf8')) as unknown;
		} catch {
			throw new Error('Snapshot metadata contains invalid JSON. No contents were logged.');
		}
	} finally {
		closeSync(descriptor);
	}
}

function omitted(path: string): boolean {
	return INSTANCE_BACKUP_EXCLUSIONS.some((root) => path === root || path.startsWith(`${root}/`));
}

/** Hash/copy through a no-follow descriptor, never buffering a whole database. */
function transfer(
	home: string,
	path: string,
	destination?: string
): { bytes: number; sha256: string } {
	assertSafePortablePath(home, path);
	const source = join(home, path);
	const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	let output: number | undefined;
	try {
		const before = fstatSync(input);
		if (!before.isFile() || !Number.isSafeInteger(before.size))
			throw new Error(`Not a regular snapshot file: ${path}`);
		if (destination)
			output = openSync(
				destination,
				constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
				0o600
			);
		const hash = createHash('sha256');
		const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(before.size + 1, 1024 * 1024)));
		let bytes = 0;
		for (;;) {
			const count = readSync(input, chunk, 0, chunk.length, null);
			if (!count) break;
			bytes += count;
			if (bytes > before.size) throw new Error(`Snapshot file changed while reading: ${path}`);
			hash.update(chunk.subarray(0, count));
			if (output !== undefined) {
				let written = 0;
				while (written < count) {
					const amount = writeSync(output, chunk, written, count - written);
					if (!amount) throw new Error(`Snapshot file could not be written: ${path}`);
					written += amount;
				}
			}
		}
		assertSafePortablePath(home, path);
		const after = fstatSync(input);
		const named = lstatSync(source);
		if (
			bytes !== before.size ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs ||
			named.dev !== before.dev ||
			named.ino !== before.ino
		)
			throw new Error(`Snapshot file changed while reading: ${path}`);
		return { bytes, sha256: hash.digest('hex') };
	} finally {
		closeSync(input);
		if (output !== undefined) closeSync(output);
	}
}

function inventory(
	home: string,
	excludeCoordination: boolean
): { files: InstanceBackupEntry[]; omittedPaths: string[] } {
	const files: InstanceBackupEntry[] = [];
	const omittedPaths: string[] = [];
	const visit = (parent: string) => {
		for (const name of readdirSync(join(home, parent)).sort()) {
			const path = parent ? `${parent}/${name}` : name;
			if (!validPath(path)) throw new Error('Snapshot contains an unsupported file name.');
			if (excludeCoordination && omitted(path)) {
				omittedPaths.push(path);
				continue;
			}
			const absolute = join(home, path);
			const stat = lstatSync(absolute);
			const base = { path, mode: stat.mode & 0o777, mtimeMs: Math.trunc(stat.mtimeMs) };
			if (stat.isDirectory()) {
				assertSafePortablePath(home, path);
				files.push({ ...base, type: 'directory' });
				visit(path);
			} else if (stat.isFile()) files.push({ ...base, type: 'file', ...transfer(home, path) });
			else if (stat.isSymbolicLink())
				files.push({ ...base, type: 'symlink', target: readlinkSync(absolute) });
			else
				throw new Error(
					`Cannot snapshot special file ${path}. Stop its owner and remove only obsolete process coordination before retrying.`
				);
			if (files.length > MAX_ENTRIES) throw new Error(`Snapshot exceeds ${MAX_ENTRIES} entries.`);
		}
	};
	visit('');
	return { files, omittedPaths };
}

function validateHome(home: string): string {
	for (const path of [
		'system',
		'config',
		'knowledge',
		'workspace',
		'state',
		'data',
		'data/assistant',
		'data/akm/data',
		'system/stack/stack.compose.yml',
		'state/stack.json',
		'state/stack.env',
		'state/installation.json'
	])
		assertSafePortablePath(home, path);
	requireInstall(home);
	const stack = readStackConfig(home);
	if (!stack.ok) throw new Error(stack.error);
	return stack.config.deployment.projectName;
}

async function stopped(project: string, home: string): Promise<void> {
	await assertProjectOwnership(project, createFholdState(home).stackDir);
	const result = await runDocker(
		[
			'ps',
			'-a',
			'--filter',
			`label=com.docker.compose.project=${project}`,
			'--format',
			'{{.State}}'
		],
		{ timeoutMs: 10_000 }
	);
	if (!result.ok) throw new Error('Could not verify stopped containers. Check Docker and retry.');
	if (
		result.stdout
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.some((status) => !['exited', 'dead'].includes(status))
	)
		throw new Error(
			'Full-instance export/import requires all containers stopped, including one-off, paused and restarting containers. Run `fhold stop` first. Nothing was stopped automatically.'
		);
}

function warningsFor(manifest: Pick<InstanceBackupManifest, 'files' | 'sourceHome'>): string[] {
	const warnings = [
		'External bind mounts, named volumes, container images and other writers outside this folder need separate protection.'
	];
	for (const entry of manifest.files) {
		if (
			entry.type === 'symlink' &&
			!inside(
				manifest.sourceHome,
				resolve(dirname(join(manifest.sourceHome, entry.path)), entry.target)
			)
		)
			warnings.push(`External link preserved without its target: ${entry.path}`);
	}
	return warnings;
}

function copyEntries(
	source: string,
	destination: string,
	manifest: InstanceBackupManifest,
	rebaseLinks: boolean
): void {
	for (const entry of manifest.files) {
		const target = join(destination, entry.path);
		assertSafePortablePath(
			destination,
			relative(destination, dirname(target)).split(sep).join('/') || entry.path,
			true
		);
		if (entry.type === 'directory') mkdirSync(target, { recursive: true, mode: 0o700 });
		else if (entry.type === 'file') {
			const copied = transfer(source, entry.path, target);
			if (copied.bytes !== entry.bytes || copied.sha256 !== entry.sha256)
				throw new Error(`Snapshot file changed: ${entry.path}`);
			chmodSync(target, entry.mode);
			utimesSync(target, new Date(entry.mtimeMs), new Date(entry.mtimeMs));
		} else {
			let link = entry.target;
			if (readlinkSync(join(source, entry.path)) !== link)
				throw new Error(`Snapshot link changed: ${entry.path}`);
			if (rebaseLinks && isAbsolute(link) && inside(manifest.sourceHome, link))
				link =
					relative(dirname(target), join(destination, relative(manifest.sourceHome, link))) || '.';
			symlinkSync(link, target);
			lutimesSync(target, new Date(entry.mtimeMs), new Date(entry.mtimeMs));
		}
	}
	for (const entry of [...manifest.files].reverse())
		if (entry.type === 'directory') {
			chmodSync(join(destination, entry.path), entry.mode);
			utimesSync(join(destination, entry.path), new Date(entry.mtimeMs), new Date(entry.mtimeMs));
		}
}

export async function exportInstance(
	options: InstanceBackupOptions
): Promise<InstanceBackupManifest> {
	if (options.confirmedStopped !== true)
		throw new Error(`Full-instance export requires --confirm-stopped. ${INSTANCE_BACKUP_NOTICE}`);
	const source = directory(options.sourceHome, true);
	const destination = directory(options.destination);
	separate(source, destination);
	empty(destination);
	const project = validateHome(source);
	const lock = acquireStackLock(join(source, 'data'));
	if (!lock) throw new Error('lifecycle_in_progress: Another stack operation is running.');
	try {
		await stopped(project, source);
		const installation = readJson(source, 'state/installation.json', 1024 * 1024) as Record<
			string,
			unknown
		>;
		if (
			installation.product !== 'fhold' ||
			installation.homeDir !== source ||
			readEnvFile(join(source, 'state/stack.env')).FH_HOME !== source
		)
			throw new Error(
				'Reconcile this installation’s home metadata before a full-instance export. Nothing was copied.'
			);
		const selection = inventory(source, true);
		const manifest: InstanceBackupManifest = {
			product: 'fhold',
			version: 1,
			scope: 'instance',
			createdAt: new Date().toISOString(),
			sourceHome: source,
			projectName: project,
			...selection,
			totalBytes: selection.files.reduce(
				(sum, entry) => sum + (entry.type === 'file' ? entry.bytes : 0),
				0
			),
			warnings: warningsFor({ ...selection, sourceHome: source })
		};
		if (!Number.isSafeInteger(manifest.totalBytes))
			throw new Error('Instance export total size is unsafe.');
		const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
		if (Buffer.byteLength(manifestBytes) > MAX_MANIFEST_BYTES)
			throw new Error('Instance export manifest exceeds 128 MiB.');
		empty(destination);
		mkdirSync(destination, { recursive: true, mode: 0o700 });
		chmodSync(destination, 0o700);
		mkdirSync(join(destination, PAYLOAD), { mode: 0o700 });
		copyEntries(source, join(destination, PAYLOAD), manifest, false);
		const after = inventory(source, true);
		if (JSON.stringify(after) !== JSON.stringify(selection))
			throw new Error(
				'Instance changed during export. Stop all other writers and use a new export destination.'
			);
		await stopped(project, source);
		// An incomplete export never gets a supported manifest.
		if (lstatSync(join(destination, MANIFEST), { throwIfNoEntry: false }))
			throw new Error('Export destination changed during capture. Use a new empty folder.');
		writeFileAtomic(join(destination, MANIFEST), manifestBytes, 0o600);
		return manifest;
	} finally {
		releaseStackLock(lock);
	}
}

function readManifest(source: string): InstanceBackupManifest {
	const value = readJson(source, MANIFEST, MAX_MANIFEST_BYTES) as InstanceBackupManifest;
	if (
		value?.product !== 'fhold' ||
		value.version !== 1 ||
		value.scope !== 'instance' ||
		!Array.isArray(value.files) ||
		value.files.length > MAX_ENTRIES ||
		typeof value.sourceHome !== 'string' ||
		!isAbsolute(value.sourceHome) ||
		typeof value.projectName !== 'string' ||
		typeof value.createdAt !== 'string' ||
		!Array.isArray(value.omittedPaths) ||
		value.omittedPaths.some((path) => !validPath(path) || !omitted(path)) ||
		!Array.isArray(value.warnings) ||
		value.warnings.some((warning) => typeof warning !== 'string')
	)
		throw new Error(
			'A supported fhold full-instance export manifest is required. Portable exports use ordinary restore, without --full.'
		);
	const parents = new Map<string, InstanceBackupEntry>();
	for (const entry of value.files) {
		if (
			!entry ||
			!validPath(entry.path) ||
			omitted(entry.path) ||
			parents.has(entry.path) ||
			!Number.isInteger(entry.mode) ||
			entry.mode < 0 ||
			entry.mode > 0o777 ||
			!Number.isSafeInteger(entry.mtimeMs) ||
			!['directory', 'file', 'symlink'].includes(entry.type) ||
			(entry.type === 'file' &&
				(!Number.isSafeInteger(entry.bytes) ||
					entry.bytes < 0 ||
					!/^[a-f0-9]{64}$/.test(entry.sha256))) ||
			(entry.type === 'symlink' &&
				(typeof entry.target !== 'string' || !entry.target || entry.target.includes('\0')))
		)
			throw new Error('Instance export contains an invalid entry.');
		const parent = dirname(entry.path);
		if (parent !== '.' && parents.get(parent)?.type !== 'directory')
			throw new Error('Instance export entries must have real, preceding directory parents.');
		parents.set(entry.path, entry);
	}
	assertSafePortablePath(source, PAYLOAD);
	const actual = inventory(join(source, PAYLOAD), false).files;
	if (
		actual.length !== value.files.length ||
		actual.some((entry, index) => {
			const expected = value.files[index];
			if (
				entry.path !== expected.path ||
				entry.type !== expected.type ||
				entry.mode !== expected.mode ||
				entry.mtimeMs !== expected.mtimeMs
			)
				return true;
			if (entry.type === 'file' && expected.type === 'file')
				return entry.bytes !== expected.bytes || entry.sha256 !== expected.sha256;
			if (entry.type === 'symlink' && expected.type === 'symlink')
				return entry.target !== expected.target;
			return false;
		})
	)
		throw new Error('Instance export inventory/checksum mismatch. Nothing was restored.');
	const total = actual.reduce((sum, entry) => sum + (entry.type === 'file' ? entry.bytes : 0), 0);
	if (!Number.isSafeInteger(total) || total !== value.totalBytes)
		throw new Error('Instance export size mismatch.');
	if (validateHome(join(source, PAYLOAD)) !== value.projectName)
		throw new Error('Instance export identity mismatch.');
	const installation = readJson(
		join(source, PAYLOAD),
		'state/installation.json',
		1024 * 1024
	) as Record<string, unknown>;
	if (
		installation.product !== 'fhold' ||
		installation.homeDir !== value.sourceHome ||
		readEnvFile(join(source, PAYLOAD, 'state/stack.env')).FH_HOME !== value.sourceHome
	)
		throw new Error(
			'Instance export installation receipt or generated home metadata does not match its source.'
		);
	return value;
}

export async function planInstanceRestore(
	options: InstanceRestoreOptions
): Promise<InstanceRestorePlan> {
	const source = directory(options.sourceHome, true);
	const destination = directory(options.destinationHome);
	separate(source, destination);
	empty(destination);
	const manifest = readManifest(source);
	await stopped(manifest.projectName, destination);
	const plan = {
		scope: 'instance' as const,
		sourceHome: source,
		destinationHome: destination,
		projectName: manifest.projectName,
		copyCount: manifest.files.length,
		totalBytes: manifest.totalBytes,
		omittedPaths: manifest.omittedPaths,
		warnings: [
			...warningsFor(manifest),
			'Import preserves account authority and active scheduling intent. Start only after reviewing the saved name, ports, image versions, external mounts and checkpoint destination.'
		]
	};
	return {
		...plan,
		digest: createHash('sha256')
			.update(JSON.stringify([plan, manifest]))
			.digest('hex')
	};
}

export async function restoreInstance(
	options: InstanceRestoreOptions,
	expectedDigest?: string
): Promise<InstanceRestorePlan> {
	if (options.confirmedStopped !== true)
		throw new Error(`Full-instance import requires --confirm-stopped. ${INSTANCE_BACKUP_NOTICE}`);
	const plan = await planInstanceRestore(options);
	if (expectedDigest !== undefined && expectedDigest !== plan.digest)
		throw new Error('Instance export or destination changed after preview. Preview again.');
	const manifest = readManifest(plan.sourceHome);
	const home = plan.destinationHome;
	// Reserve this empty destination through the ordinary per-home lifecycle lock.
	mkdirSync(home, { recursive: true, mode: 0o700 });
	chmodSync(home, 0o700);
	const lock = acquireStackLock(join(home, 'data'));
	if (!lock) throw new Error('lifecycle_in_progress: Another stack operation is running.');
	const marker = join(home, 'data/.instance-restore.json');
	let marked = false;
	try {
		if (
			readdirSync(home).some((name) => name !== 'data') ||
			readdirSync(join(home, 'data')).some((name) => name !== '.lifecycle.lock')
		)
			throw new Error('Import destination is no longer empty. Nothing was copied.');
		await stopped(manifest.projectName, home);
		writeFileAtomic(
			marker,
			`${JSON.stringify({ product: 'fhold', phase: 'importing', digest: plan.digest })}\n`,
			0o600
		);
		marked = true;
		copyEntries(join(plan.sourceHome, PAYLOAD), home, manifest, true);
		for (const entry of manifest.files)
			if (entry.type === 'file') {
				const copied = transfer(home, entry.path);
				if (copied.sha256 !== entry.sha256 || copied.bytes !== entry.bytes)
					throw new Error(`Restored file verification failed: ${entry.path}`);
			}
		const envPath = join(home, 'state/stack.env');
		const owner = lstatSync(home);
		if (!owner.uid || !owner.gid)
			throw new Error('Restore as a non-root user; native containers must not run as root.');
		const updates: Record<string, string> = {
			FH_HOME: home,
			FH_UID: String(owner.uid),
			FH_GID: String(owner.gid)
		};
		const oldEnv = readFileSync(envPath, 'utf8');
		// Only generated host paths/ownership are reconciled; no seeding, upgrades,
		// schedule pausing, regenerated credentials or native database conversion.
		const recoveryDirectory = readEnvFile(envPath).FH_RECOVERY_DIRECTORY;
		if (recoveryDirectory && inside(manifest.sourceHome, recoveryDirectory))
			updates.FH_RECOVERY_DIRECTORY = join(home, relative(manifest.sourceHome, recoveryDirectory));
		writeFileAtomic(envPath, mergeEnvContent(oldEnv, updates), 0o600);
		const receiptPath = join(home, 'state/installation.json');
		const installation = readJson(home, 'state/installation.json', 1024 * 1024) as Record<
			string,
			unknown
		>;
		if (installation.product !== 'fhold' || installation.homeDir !== manifest.sourceHome)
			throw new Error('Original installation receipt does not match the exported home.');
		writeFileAtomic(
			receiptPath,
			`${JSON.stringify({ ...installation, homeDir: home }, null, 2)}\n`,
			0o600
		);
		recordRuntimeActivation(home, runtimeRevision(home));
		await stopped(manifest.projectName, home);
		writeFileAtomic(
			join(home, 'state/instance-restore-receipts', `${plan.digest}.json`),
			`${JSON.stringify({ ...plan, product: 'fhold', phase: 'complete', changedMetadata: ['state/stack.env', 'state/installation.json', 'state/applied-runtime.json'], containersStarted: false }, null, 2)}\n`,
			0o600
		);
		rmSync(marker);
		return plan;
	} catch (error) {
		if (marked)
			writeFileAtomic(
				marker,
				`${JSON.stringify({ product: 'fhold', phase: 'incomplete', digest: plan.digest })}\n`,
				0o600
			);
		throw error;
	} finally {
		releaseStackLock(lock);
	}
}

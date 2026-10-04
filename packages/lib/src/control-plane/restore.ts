import { createHash } from 'node:crypto';
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { parseOAuthConfig, parseOAuthIdentityMap } from './oauth-store.js';
import { parsePortalCredentialMap } from './portal-credential-store.js';
import { readStackConfig } from './stack-config.js';
import { inspectUnrestoredData, type PreservationItem } from './preservation.js';
import { managedComposeFile, stackConfigFile, writeFileAtomic } from './foundation.js';
import { classifyInstall, ensureRuntime } from './state.js';
import { createFholdState } from './foundation.js';
import { readSeedFile } from './seed.js';
import { acquireStackLock, releaseStackLock } from './lock.js';
import {
	assertSafePortablePath,
	hasInlineProviderCredentials,
	hasNonPortableNativeConfiguration,
	providerSecretFiles,
	readProviderSecretFile
} from './provider-files.js';

const MAX_FILES = 100_000;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const TASK_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.ya?ml$/;

export type RestoreOptions = {
	sourceHome: string;
	destinationHome: string;
	includeProviderAuth?: boolean;
	includeUserEnv?: boolean;
	includePortalMaps?: boolean;
	includeOAuth?: boolean;
	acknowledgeUnrestored?: boolean;
};

export type RestoreAction =
	| 'copy'
	| 'replace-pristine'
	| 'stage-task'
	| 'skip-identical'
	| 'conflict';

export type RestoreEntry = {
	source: string;
	destination: string;
	relativeSource: string;
	relativeDestination: string;
	category: 'knowledge' | 'task' | 'workspace' | 'config' | 'secret';
	action: RestoreAction;
	bytes: number;
	sha256: string;
	destinationSha256?: string;
};

export type RestorePlan = {
	version: 1;
	sourceHome: string;
	destinationHome: string;
	entries: RestoreEntry[];
	warnings: string[];
	preservation: PreservationItem[];
	reviewRequired: boolean;
	totalBytes: number;
	conflicts: number;
	copyCount: number;
	digest: string;
};

function realDirectory(path: string, label: string): string {
	const resolved = resolve(path);
	if (!existsSync(resolved)) throw new Error(`${label} does not exist: ${resolved}`);
	const stat = lstatSync(resolved);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error(`${label} must be a real directory: ${resolved}`);
	}
	return realpathSync(resolved);
}

function contained(root: string, path: string): boolean {
	const value = relative(root, path);
	return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

function assertDisjointHomes(sourceHome: string, destinationHome: string): void {
	if (contained(sourceHome, destinationHome) || contained(destinationHome, sourceHome)) {
		throw new Error('Restore source and destination must be separate, non-overlapping directories');
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function readRegularSource(
	path: string,
	maximum = MAX_FILE_BYTES
): { bytes: Buffer; mode: number } {
	const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const stat = fstatSync(descriptor);
		if (!stat.isFile()) throw new Error(`Restore source is not a regular file: ${path}`);
		if (stat.size > maximum) throw new Error(`Restore file is too large: ${path}`);
		return { bytes: readFileSync(descriptor), mode: stat.mode };
	} finally {
		closeSync(descriptor);
	}
}

function verifyBackupManifest(
	sourceHome: string
): { files: Set<string>; preservation: PreservationItem[]; warnings: string[] } {
	const path = join(sourceHome, 'fhold-backup.json');
	if (!existsSync(path)) throw new Error('A required fhold-backup.json manifest is missing');
	let value: unknown;
	try {
		value = JSON.parse(
			readRegularSource(path, MAX_MANIFEST_BYTES).bytes.toString('utf8')
		) as unknown;
	} catch {
		throw new Error('Backup manifest is invalid or unreadable');
	}
	const root = asRecord(value);
	if (root?.product !== 'fhold' || root?.version !== 1 || root.scope !== 'portable' || !Array.isArray(root.files) || root.files.length > MAX_FILES) {
		throw new Error('Backup manifest must identify fhold portable format version 1 with a bounded file list');
	}
	const verified = new Set<string>();
	let totalBytes = 0;
	for (const rawEntry of root.files) {
		const entry = asRecord(rawEntry);
		if (
			!entry ||
			typeof entry.path !== 'string' ||
			!Number.isSafeInteger(entry.bytes) ||
			(entry.bytes as number) < 0 ||
			typeof entry.sha256 !== 'string' ||
			!/^[a-f0-9]{64}$/.test(entry.sha256)
		) {
			throw new Error('Backup manifest contains an invalid file entry');
		}
		const parts = entry.path.split('/');
		if (
			entry.path.includes('\\') ||
			parts.some((part) => !part || part === '.' || part === '..') ||
			isAbsolute(entry.path) ||
			verified.has(entry.path)
		) {
			throw new Error(`Backup manifest contains an unsafe or duplicate path: ${entry.path}`);
		}
		const source = join(sourceHome, ...parts);
		if (!contained(sourceHome, source)) {
			throw new Error(`Backup manifest path escaped its source: ${entry.path}`);
		}
		assertSafePortablePath(sourceHome, entry.path);
		const file = readRegularSource(source);
		if (file.bytes.byteLength !== entry.bytes) {
			throw new Error(`Backup size mismatch: ${entry.path}`);
		}
		const digest = createHash('sha256').update(file.bytes).digest('hex');
		if (digest !== entry.sha256) throw new Error(`Backup checksum mismatch: ${entry.path}`);
		totalBytes += file.bytes.byteLength;
		if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Backup exceeds the 20 GiB safety limit');
		verified.add(entry.path);
	}
	if (!Number.isSafeInteger(root.totalBytes) || root.totalBytes !== totalBytes) {
		throw new Error('Backup manifest total size does not match its files');
	}
	const preservation: PreservationItem[] = [];
	if (root.preservation !== undefined) {
		if (!Array.isArray(root.preservation) || root.preservation.length > 100_000) {
			throw new Error('Backup preservation inventory is invalid');
		}
		for (const raw of root.preservation) {
			const item = asRecord(raw);
			if (
				!item ||
				typeof item.category !== 'string' ||
				item.category.length > 256 ||
				typeof item.note !== 'string' ||
				item.note.length > 4096 ||
				!['selected', 'review-required', 'excluded'].includes(String(item.disposition)) ||
				!Array.isArray(item.paths) ||
				item.paths.length > MAX_FILES ||
				item.paths.some((path) => typeof path !== 'string' || path.length > 4096)
			) {
				throw new Error('Backup preservation inventory contains an invalid entry');
			}
			preservation.push({
				category: item.category,
				disposition: item.disposition as PreservationItem['disposition'],
				paths: item.paths as string[],
				note: item.note
			});
		}
	}
	if (!Array.isArray(root.warnings) || root.warnings.length > MAX_FILES || root.warnings.some((item) => typeof item !== 'string' || item.length > 4096)) throw new Error('Backup warning inventory is invalid');
	return { files: verified, preservation, warnings: root.warnings as string[] };
}

function filesBelow(
	root: string,
	warnings: string[],
	skipDirectory: (path: string) => boolean = () => false
): string[] {
	if (!existsSync(root)) return [];
	const rootStat = lstatSync(root);
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
		warnings.push(`Skipped non-directory restore root: ${root}`);
		return [];
	}
	const output: string[] = [];
	const pending = [root];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) break;
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if ((entry.isDirectory() || entry.isSymbolicLink()) && skipDirectory(path)) continue;
			if ((entry.isDirectory() || entry.isSymbolicLink()) && entry.name === 'node_modules') {
				warnings.push(
					`Skipped generated dependencies: ${path}; reinstall dependencies after import.`
				);
				continue;
			}
			if (entry.isSymbolicLink()) {
				warnings.push(`Skipped symlink: ${path}`);
				continue;
			}
			if (entry.isDirectory()) {
				pending.push(path);
				continue;
			}
			if (!entry.isFile()) {
				warnings.push(`Skipped non-regular file: ${path}`);
				continue;
			}
			output.push(path);
			if (output.length > MAX_FILES) throw new Error(`Restore exceeds ${MAX_FILES} files`);
		}
	}
	return output.sort();
}

function sameBytes(path: string, bytes: Buffer): boolean {
	if (lstatSync(path).size !== bytes.byteLength) return false;
	return readRegularSource(path).bytes.equals(bytes);
}

function pristineDestination(relativePath: string, path: string): boolean {
	if (!existsSync(path) || !lstatSync(path).isFile()) return false;
	if (relativePath.startsWith('config/')) {
		try { return readRegularSource(path).bytes.equals(readSeedFile(relativePath)); }
		catch { return false; }
	}
	const text = readFileSync(path, 'utf8').trim();
	if (relativePath === 'knowledge/secrets/auth.json') return text === '' || text === '{}';
	if (relativePath === 'knowledge/env/user.env') return text === '';
	return false;
}

function validateMappedConfiguration(
	relativePath: string,
	source: string,
	destinationHome: string
): void {
	if (!relativePath.endsWith('.json')) return;
	let value: unknown;
	try {
		value = JSON.parse(readRegularSource(source).bytes.toString('utf8')) as unknown;
	} catch {
		throw new Error(`${relativePath} must contain valid JSON; no configuration values were logged`);
	}
	const stack = readStackConfig(destinationHome);
	if (!stack.ok) throw new Error(stack.error);
	if (relativePath.includes('/portal/')) {
		const portal = relativePath.includes('/discord/') ? 'discord' : 'slack';
		const parsed = parsePortalCredentialMap(portal, value);
		for (const username of Object.values(parsed.users)) {
			if (!Object.hasOwn(stack.config.credentials, username)) {
				throw new Error(
					`${relativePath} references credential ${username}; recreate it before restore`
				);
			}
		}
	}
	if (relativePath.endsWith('/oauth.json')) {
		parseOAuthConfig(value);
	}
	if (relativePath.endsWith('/oauth-identities.json')) {
		const parsed = parseOAuthIdentityMap(value);
		for (const identity of parsed.identities) {
			if (!Object.hasOwn(stack.config.credentials, identity.username)) {
				throw new Error(
					`${relativePath} references credential ${identity.username}; recreate it before restore`
				);
			}
		}
	}
}

type Candidate = Omit<RestoreEntry, 'action' | 'bytes' | 'sha256'> & {
	preferred: RestoreAction;
};

function candidate(
	sourceHome: string,
	destinationHome: string,
	source: string,
	destination: string,
	category: RestoreEntry['category'],
	preferred: RestoreAction = 'copy'
): Candidate {
	return {
		source,
		destination,
		relativeSource: relative(sourceHome, source).split(sep).join('/'),
		relativeDestination: relative(destinationHome, destination).split(sep).join('/'),
		category,
		preferred
	};
}

function ensureSafeDestinationParent(destinationHome: string, destination: string): void {
	if (!contained(destinationHome, destination)) {
		throw new Error(`Restore destination escapes its home: ${destination}`);
	}
	const parentRelative = relative(destinationHome, dirname(destination));
	let current = destinationHome;
	for (const part of parentRelative.split(sep).filter(Boolean)) {
		current = join(current, part);
		if (!existsSync(current)) {
			mkdirSync(current, { mode: 0o700 });
			continue;
		}
		const stat = lstatSync(current);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new Error(`Refusing unsafe restore destination directory: ${current}`);
		}
	}
	if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) {
		throw new Error(`Refusing symlink restore destination: ${destination}`);
	}
}

function addTree(
	candidates: Candidate[],
	warnings: string[],
	sourceHome: string,
	destinationHome: string,
	relativeRoot: string,
	category: RestoreEntry['category'],
	filter: (relativeFile: string) => boolean = () => true,
	skipDirectory: (path: string) => boolean = () => false
): void {
	const root = join(sourceHome, relativeRoot);
	assertSafePortablePath(sourceHome, relativeRoot, true);
	for (const source of filesBelow(root, warnings, skipDirectory)) {
		const file = relative(root, source);
		if (!filter(file)) continue;
		candidates.push(
			candidate(
				sourceHome,
				destinationHome,
				source,
				join(destinationHome, relativeRoot, file),
				category
			)
		);
	}
}

export function planRestore(options: RestoreOptions): RestorePlan {
	const sourceHome = realDirectory(options.sourceHome, 'Restore source');
	const destinationHome = realDirectory(options.destinationHome, 'Restore destination');
	assertDisjointHomes(sourceHome, destinationHome);
	const verifiedBackupFiles = verifyBackupManifest(sourceHome);
	if (classifyInstall(destinationHome) !== 'setup_incomplete') throw new Error('Restore requires a newly initialized fhold target before setup completes');
	if (
		!existsSync(managedComposeFile(destinationHome)) ||
		!existsSync(stackConfigFile(destinationHome))
	) {
		throw new Error('Restore destination must be a newly initialized fhold installation');
	}

	const warnings: string[] = [...verifiedBackupFiles.warnings];
	const candidates: Candidate[] = [];
	const knowledgeRoot = join(sourceHome, 'knowledge');
	addTree(
		candidates,
		warnings,
		sourceHome,
		destinationHome,
		'knowledge',
		'knowledge',
		(file) => {
			const first = file.split(sep)[0];
			return !['tasks', 'secrets', 'env', '.git', '.akm'].includes(first ?? '');
		},
		(path) => {
			const relativePath = relative(knowledgeRoot, path).split(sep).join('/');
			if (relativePath === '.akm') {
				warnings.push(
					'Skipped generated AKM metadata (knowledge/.akm): the fresh installation regenerates its indexes and runtime metadata. Source preserved.'
				);
				return true;
			}
			return ['tasks', 'secrets', 'env', '.git'].includes(relativePath);
		}
	);
	addTree(candidates, warnings, sourceHome, destinationHome, 'workspace', 'workspace');

	const tasksRoot = join(sourceHome, 'knowledge', 'tasks');
	assertSafePortablePath(sourceHome, 'knowledge/tasks', true);
	for (const source of filesBelow(tasksRoot, warnings)) {
		const name = basename(source);
		if (!TASK_FILE_RE.test(name)) {
			warnings.push(`Skipped unsupported task source: ${source}`);
			continue;
		}
		candidates.push(
			candidate(
				sourceHome,
				destinationHome,
				source,
				join(destinationHome, 'knowledge', 'imported-tasks', name),
				'task',
				'stage-task'
			)
		);
	}

	let nonPortableNativeConfiguration = false;
	for (const relativePath of [
		'config/assistant/opencode.json',
		'config/assistant/persona.md',
		'config/assistant/user-profile.md'
	]) {
		const source = join(sourceHome, relativePath);
		assertSafePortablePath(sourceHome, relativePath, true);
		if (existsSync(source) && lstatSync(source).isFile()) {
			if (relativePath.endsWith('/opencode.json')) {
				nonPortableNativeConfiguration = hasNonPortableNativeConfiguration(sourceHome);
				if (nonPortableNativeConfiguration) {
					warnings.push(
						'Skipped non-portable native OpenCode configuration: only $schema, model, small_model and provider preferences without executable SDK customization are portable. Review and recreate other customization separately; source preserved.'
					);
					continue;
				}
				if (hasInlineProviderCredentials(sourceHome) && !options.includeProviderAuth) {
					warnings.push(
						'Skipped native OpenCode configuration containing inline provider credentials: explicitly opt in with --include-provider-auth or sign in again. Source preserved.'
					);
					continue;
				}
			}
			candidates.push(
				candidate(
					sourceHome,
					destinationHome,
					source,
					join(destinationHome, relativePath),
					'config'
				)
			);
		}
	}

	let providerFiles: string[] = [];
	try {
		if (!nonPortableNativeConfiguration) providerFiles = providerSecretFiles(sourceHome);
	} catch (error) {
		if (options.includeProviderAuth) throw error;
		for (let index = candidates.length - 1; index >= 0; index--) {
			if (candidates[index]?.relativeSource === 'config/assistant/opencode.json') candidates.splice(index, 1);
		}
		warnings.push(
			'Provider file references could not be safely restored; configure the provider again or review references before opting in to --include-provider-auth.'
		);
	}
	if (!options.includeProviderAuth && providerFiles.length) {
		warnings.push(
			`Excluded ${providerFiles.length} referenced private provider file(s): use --include-provider-auth or configure the provider again before setup.`
		);
	}
	if (options.includeProviderAuth) {
		const authPath = 'knowledge/secrets/auth.json';
		assertSafePortablePath(sourceHome, authPath, true);
		if (existsSync(join(sourceHome, authPath))) providerFiles.push(authPath);
		for (const relativePath of new Set(providerFiles)) {
			const source = join(sourceHome, relativePath);
			readProviderSecretFile(sourceHome, relativePath);
			assertSafePortablePath(destinationHome, relativePath, true);
			candidates.push(
				candidate(
					sourceHome,
					destinationHome,
					source,
					join(destinationHome, relativePath),
					'secret'
				)
			);
		}
	}
	if (options.includeUserEnv) {
		const relativePath = 'knowledge/env/user.env';
		const source = join(sourceHome, relativePath);
		if (existsSync(source) && lstatSync(source).isFile()) {
			candidates.push(
				candidate(
					sourceHome,
					destinationHome,
					source,
					join(destinationHome, relativePath),
					'secret'
				)
			);
		}
	}
	if (options.includePortalMaps) {
		for (const portal of ['discord', 'slack']) {
			const relativePath = `config/portal/${portal}/credentials.json`;
			const source = join(sourceHome, relativePath);
			assertSafePortablePath(sourceHome, relativePath, true);
			if (existsSync(source) && lstatSync(source).isFile()) {
				validateMappedConfiguration(relativePath, source, destinationHome);
				candidates.push(
					candidate(
						sourceHome,
						destinationHome,
						source,
						join(destinationHome, relativePath),
						'config'
					)
				);
			}
		}
	}
	if (options.includeOAuth) {
		for (const name of ['oauth.json', 'oauth-identities.json']) {
			const relativePath = `config/guardian/${name}`;
			const source = join(sourceHome, relativePath);
			assertSafePortablePath(sourceHome, relativePath, true);
			if (existsSync(source) && lstatSync(source).isFile()) {
				validateMappedConfiguration(relativePath, source, destinationHome);
				candidates.push(
					candidate(
						sourceHome,
						destinationHome,
						source,
						join(destinationHome, relativePath),
						'config'
					)
				);
			}
		}
	}

	if (candidates.length > MAX_FILES)
		throw new Error(`Restore exceeds ${MAX_FILES} files across all categories`);
	let totalBytes = 0;
	const entries: RestoreEntry[] = [];
	for (const item of candidates) {
		assertSafePortablePath(sourceHome, item.relativeSource);
		assertSafePortablePath(destinationHome, item.relativeDestination, true);
		if (!verifiedBackupFiles.files.has(item.relativeSource)) {
			throw new Error(`Backup file is not recorded in its manifest: ${item.relativeSource}`);
		}
		const stat = lstatSync(item.source);
		if (!stat.isFile() || stat.isSymbolicLink()) continue;
		if (stat.size > MAX_FILE_BYTES) throw new Error(`Restore file is too large: ${item.source}`);
		const sourceFile =
			item.category === 'secret' && item.relativeSource.startsWith('knowledge/secrets/')
				? { bytes: readProviderSecretFile(sourceHome, item.relativeSource), mode: stat.mode }
				: readRegularSource(item.source);
		totalBytes += sourceFile.bytes.byteLength;
		if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Restore exceeds the 20 GiB safety limit');
		let action = item.preferred;
		if (existsSync(item.destination)) {
			if (!lstatSync(item.destination).isFile()) action = 'conflict';
			else if (sameBytes(item.destination, sourceFile.bytes)) action = 'skip-identical';
			else if (pristineDestination(item.relativeDestination, item.destination)) {
				action = 'replace-pristine';
			} else action = 'conflict';
		}
		const { preferred: _preferred, ...entry } = item;
		entries.push({
			...entry,
			action,
			...(existsSync(item.destination) && lstatSync(item.destination).isFile() ? { destinationSha256: createHash('sha256').update(readRegularSource(item.destination).bytes).digest('hex') } : {}),
			bytes: sourceFile.bytes.byteLength,
			sha256: createHash('sha256').update(sourceFile.bytes).digest('hex')
		});
	}

	const preservation = [...new Set(entries.map((entry) => entry.category))].map(
		(category): PreservationItem => ({
			category,
			disposition: 'selected',
			paths: [],
			note: `${entries.filter((entry) => entry.category === category).length} file(s), ${entries.filter((entry) => entry.category === category).reduce((bytes, entry) => bytes + entry.bytes, 0)} bytes inspected${category === 'task' ? '; staged inactive, not scheduled' : ''}. Conflicts must be resolved before apply.`
		})
	);
	preservation.push(
		...inspectUnrestoredData(sourceHome, warnings),
		...(verifiedBackupFiles?.preservation.filter((item) => item.disposition !== 'selected') ?? [])
	);
	const result: Omit<RestorePlan, 'digest'> = {
		version: 1,
		sourceHome,
		destinationHome,
		entries,
		warnings,
		preservation: [...new Map(preservation.map((item) => [JSON.stringify(item), item])).values()],
		reviewRequired: preservation.some((item) => item.disposition === 'review-required'),
		totalBytes,
		conflicts: entries.filter((entry) => entry.action === 'conflict').length,
		copyCount: entries.filter((entry) => !['conflict', 'skip-identical'].includes(entry.action))
			.length
	};
	return {
		...result,
		digest: createHash('sha256').update(JSON.stringify(result)).digest('hex')
	};
}

export function applyRestore(options: RestoreOptions, expectedDigest?: string): RestorePlan {
	const source = realDirectory(options.sourceHome, 'Restore source');
	const destination = realDirectory(options.destinationHome, 'Restore destination');
	assertDisjointHomes(source, destination);
	const lock = acquireStackLock(join(destination, 'data'));
	if (!lock) throw new Error('lifecycle_in_progress: Another stack operation is running.');
	try { return applyRestoreLocked(options, expectedDigest); }
	finally { releaseStackLock(lock); }
}

function applyRestoreLocked(options: RestoreOptions, expectedDigest?: string): RestorePlan {
	const plan = planRestore(options);
	if (expectedDigest !== undefined && plan.digest !== expectedDigest) {
		throw new Error('The restore source or destination changed after preview. Preview it again.');
	}
	if (plan.conflicts > 0) {
		throw new Error(
			`Restore has ${plan.conflicts} destination conflict(s). Resolve them and run --dry-run again.`
		);
	}
	if (plan.reviewRequired && options.acknowledgeUnrestored !== true) {
		throw new Error(
			'Some source data will not be restored. Review the preservation inventory and make a private recovery backup first, then explicitly use --acknowledge-unrestored to copy only portable files. This does not complete history recovery.'
		);
	}
	const receipt = join(plan.destinationHome, 'state', 'restore-receipts', `${plan.digest}.json`);
	ensureSafeDestinationParent(plan.destinationHome, receipt);
	const completed: string[] = [];
	const save = (phase: string) => writeFileAtomic(receipt, `${JSON.stringify({ ...plan, product: 'fhold', scope: 'portable-files', phase, completed, acknowledgeUnrestored: options.acknowledgeUnrestored === true }, null, 2)}\n`, 0o600);
	save('applying');
	try {
	for (const entry of plan.entries) {
		if (entry.action === 'skip-identical') continue;
		assertSafePortablePath(plan.sourceHome, entry.relativeSource);
		const sourceReal = realpathSync(entry.source);
		if (!contained(plan.sourceHome, sourceReal)) {
			throw new Error(`Restore source changed or escaped its home: ${entry.source}`);
		}
		const sourceFile =
			entry.category === 'secret' && entry.relativeSource.startsWith('knowledge/secrets/')
				? { bytes: readProviderSecretFile(plan.sourceHome, entry.relativeSource), mode: 0o600 }
				: readRegularSource(entry.source);
		const digest = createHash('sha256').update(sourceFile.bytes).digest('hex');
		if (digest !== entry.sha256) {
			throw new Error(`Restore source changed after preview: ${entry.relativeSource}`);
		}
		const mode = entry.category !== 'secret' && (sourceFile.mode & 0o111) !== 0 ? 0o700 : 0o600;
		ensureSafeDestinationParent(plan.destinationHome, entry.destination);
		const destinationStat = lstatSync(entry.destination, { throwIfNoEntry: false });
		if (entry.destinationSha256 === undefined ? destinationStat !== undefined :
			!destinationStat?.isFile() || createHash('sha256').update(readRegularSource(entry.destination).bytes).digest('hex') !== entry.destinationSha256) {
			throw new Error(`Restore destination changed during apply: ${entry.relativeDestination}`);
		}
		writeFileAtomic(entry.destination, sourceFile.bytes, mode);
		if (
			createHash('sha256').update(readRegularSource(entry.destination).bytes).digest('hex') !==
			entry.sha256
		) {
			throw new Error(`Restored file verification failed: ${entry.relativeDestination}`);
		}
		completed.push(entry.relativeDestination);
		save('applying');
	}
	ensureRuntime(createFholdState(plan.destinationHome));
	save('completed');
	} catch (error) {
		save('partial-failure');
		throw new Error(`Restore partially completed (${completed.length} file(s)); private receipt: ${receipt}. Re-preview to retry. ${error instanceof Error ? error.message : String(error)}`);
	}
	return plan;
}

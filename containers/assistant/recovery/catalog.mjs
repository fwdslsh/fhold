import path from 'node:path';
import { createHash } from 'node:crypto';
import { readRegular } from './directory-store.mjs';

export const CATALOG_VERSION = 1;
export const CUSTOM_CATALOG_VERSION = 2;
export const DEFAULT_ROOTS = Object.freeze({
	home: '/home/opencode',
	stash: '/stash',
	work: '/work',
	akmData: '/opt/akm/data',
	akmConfig: '/etc/akm'
});
const DATABASES = [
	['opencode', 'home', '.local/share/opencode/opencode.db'],
	['akm-state', 'akmData', 'state.db'],
	['akm-logs', 'akmData', 'logs.db'],
	['codex-state', 'home', '.codex/state_5.sqlite'],
	['codex-logs', 'home', '.codex/logs_2.sqlite'],
	['codex-goals', 'home', '.codex/goals_1.sqlite'],
	['codex-thread-history', 'home', '.codex/thread_history_1.sqlite'],
	['codex-memories', 'home', '.codex/memories_1.sqlite'],
	['codex-queue', 'home', '.codex/queue_1.sqlite']
];
const TREES = [
	['home', '.config/opencode'],
	['home', '.local/share/opencode'],
	['home', '.local/state/opencode'],
	['home', '.codex'],
	['home', '.claude'],
	['home', '.claude.json'],
	['stash', ''],
	['work', ''],
	['akmData', ''],
	['akmConfig', '']
];
const hash = (value) => createHash('sha256').update(value).digest('hex');
export const containsPath = (parent, child) => parent === child || child.startsWith(`${parent}/`);
export const overlapsPath = (a, b) => containsPath(a, b) || containsPath(b, a);
export const validPathCharacters = (value) =>
	!value.includes('\\') &&
	[...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);

export function canonicalPath(value) {
	return (
		typeof value === 'string' &&
		path.isAbsolute(value) &&
		value !== '/' &&
		path.resolve(value) === value &&
		validPathCharacters(value)
	);
}

/** Literal container paths, not globs or shell-expanded expressions. Resource
 * bounds apply to the resulting catalog, not to an arbitrary list-length cap. */
export function normalizeSelection(value = {}) {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !['paths', 'sqlite'].includes(key))
	)
		throw new Error('recovery include file requires paths and sqlite arrays');
	const result = {};
	for (const key of ['paths', 'sqlite']) {
		const list = value[key] === undefined ? [] : value[key];
		if (!Array.isArray(list) || list.some((item) => !canonicalPath(item)))
			throw new Error('recovery include paths must be canonical absolute paths');
		result[key] = [...new Set(list)].sort();
	}
	return result;
}

export async function readSelection(file, maximum) {
	if (!canonicalPath(file)) throw new Error('recovery include file must be an absolute path');
	let value;
	try {
		value = JSON.parse((await readRegular(file, maximum)).toString());
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error('recovery include file must be valid JSON');
		throw error;
	}
	return normalizeSelection(value);
}

function defaultExcluded(root, name) {
	if (root === 'akmData')
		return /^(index\.db(?:-wal|-shm)?|cache(?:\/|$))/.test(name);
	if (root !== 'home') return false;
	return (
		/^\.config\/opencode\/node_modules(\/|$)/.test(name) ||
		/^\.codex\/(cache|plugins\/cache)(\/|$)/.test(name) ||
		/^\.claude\/(cache|debug|plugins\/cache)(\/|$)/.test(name)
	);
}

export function selectionCovers(current, previous) {
	return (
		previous.paths.every((old) => current.paths.some((item) => containsPath(item, old))) &&
		previous.sqlite.every((old) => current.sqlite.includes(old))
	);
}

/** Roots in manifests are derived from the reviewed selection, never accepted
 * from the backup itself. External paths get stable IDs and the exact same
 * container destination on restore. Overlapping selections are deduplicated. */
export function createCatalog(
	baseRoots,
	value,
	{ privateDir, runtimeDir, store, includeFile } = {}
) {
	const selection = normalizeSelection(value);
	// Process coordination is never durable data. Selecting a native home may
	// include plugin caches, but must not opt into command wrappers or live locks.
	const blocked = [
		privateDir,
		runtimeDir,
		...['tmp', '.tmp', 'locks', 'thread-writer-locks'].map((name) => path.join(baseRoots.home, '.codex', name)),
		path.join(baseRoots.home, '.codex/app-server-control/app-server-control.sock'),
		path.join(baseRoots.akmData, 'locks')
	].filter(Boolean);
	const outside = [store.root, ...(store.privatePaths ?? []), includeFile].filter(
		(item) => item && !blocked.some((root) => containsPath(root, item))
	);
	for (const selected of [...selection.paths, ...selection.sqlite]) {
		if (
			['/proc', '/sys', '/dev'].some((root) => overlapsPath(root, selected)) ||
			blocked.some((root) => containsPath(root, selected)) ||
			outside.some((item) => overlapsPath(item, selected))
		)
			throw new Error('recovery include path overlaps protected state or destination');
	}
	const roots = { ...baseRoots };
	function location(target) {
		for (const [key, root] of Object.entries(baseRoots))
			if (containsPath(root, target)) return [key, path.relative(root, target)];
		const parent = path.dirname(target);
		const key = `custom-${hash(parent)}`;
		roots[key] = parent;
		return [key, path.basename(target)];
	}
	const native = (root, name) => path.join(roots[root], name);
	const trees = TREES.map((item) => [...item]);
	for (const item of selection.paths) trees.push(location(item));
	const databases = DATABASES.map((item) => [...item]);
	const dbPaths = new Map(databases.map(([id, root, name]) => [native(root, name), id]));
	for (const item of selection.sqlite) {
		if (dbPaths.has(item)) continue;
		const [root, name] = location(item);
		if (!name) throw new Error('recovery SQLite path must name a file');
		const id = `custom-${hash(item)}`;
		databases.push([id, root, name]);
		dbPaths.set(item, id);
	}
	const sqliteFiles = new Set(
		[...dbPaths.keys()].flatMap((item) => [item, `${item}-wal`, `${item}-shm`])
	);
	const metadata =
		selection.paths.length || selection.sqlite.length
			? { catalog: CUSTOM_CATALOG_VERSION, selectionHash: hash(JSON.stringify(selection)) }
			: { catalog: CATALOG_VERSION };
	const excluded = (root, name) => {
		const target = native(root, name);
		return (
			blocked.some((item) => containsPath(item, target)) ||
			outside.some((item) => containsPath(item, target)) ||
			(defaultExcluded(root, name) &&
				!selection.paths.some((item) => containsPath(item, target)) &&
				!selection.sqlite.includes(target))
		);
	};
	const allowsFile = (root, name) => {
		const target = native(root, name);
		return (
			trees.some(([treeRoot, treeName]) => containsPath(native(treeRoot, treeName), target)) &&
			!excluded(root, name)
		);
	};
	return {
		roots,
		native,
		trees,
		databases,
		dbPaths,
		sqliteFiles,
		excluded,
		allowsFile,
		metadata,
		selection
	};
}

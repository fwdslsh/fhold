import path from 'node:path';
import { createHash } from 'node:crypto';
import { readRegular } from './directory-store.mjs';
import { canonicalPath, containsPath, overlapsPath, normalizeSelection, boundaryPolicy } from './selection.mjs';
export { canonicalPath, containsPath, overlapsPath, validPathCharacters, normalizeSelection, boundaryPolicy } from './selection.mjs';

export const CATALOG_VERSION = 1;
export const CUSTOM_CATALOG_VERSION = 2;
export const BOUNDARY_CATALOG_VERSION = 3;
export const DEFAULT_ROOTS = Object.freeze({
	home: '/home/fhold',
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
export function normalizeNetworkMounts(value) {
	return normalizeSelection({ paths: value }).paths;
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
	if (root === 'akmData') return /^(index\.db(?:-wal|-shm)?|cache(?:\/|$))/.test(name);
	if (root !== 'home') return false;
	return (
		/^\.config\/opencode\/node_modules(\/|$)/.test(name) ||
		/^\.codex\/(cache|plugins\/cache)(\/|$)/.test(name) ||
		/^\.claude\/(cache|debug|plugins\/cache)(\/|$)/.test(name)
	);
}

// Native AKM v0.10.261009-beta paths with the image's AKM_STATE_DIR=data/state.
// akm.lock is durable bundle metadata; only its .lck sentinel is transient.
// The atomic lock helper also creates exact PID/UUID temporary/quarantine names.
const AKM_LOCK_FILES = ['index.db.write.lock', 'index.rebuild.lock', 'akm.lock.lck'];
const LOCK_COMPANION = /^\.(?:tmp|stale)-[1-9][0-9]*-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function nativeProcessState(baseRoots) {
	const claudeBackups = path.join(baseRoots.home, '.claude/backups');
	const directories = [
		...['state/locks', 'secret-locks', 'extract-locks', 'workflow-run-locks'].map(
			(name) => path.join(baseRoots.akmData, name)
		),
		// Claude owns these per-spawn argument files and removes them on child
		// exit. They are not conversation/auth state, even under an explicit home.
		path.join(baseRoots.home, '.claude/bridge-spawn')
	];
	const files = [
		...AKM_LOCK_FILES.map((name) => path.join(baseRoots.akmData, name)),
		path.join(baseRoots.akmConfig, 'config.json.lck')
	];
	return {
		paths: [...directories, ...files],
		contains: (target) =>
			// Claude rotates these five configuration copies while it runs. Keep
			// the actual config, corrupted-config evidence and unrelated files.
			(path.dirname(target) === claudeBackups &&
				/^\.claude\.json\.backup\.[0-9]+$/.test(path.basename(target))) ||
			directories.some((root) => containsPath(root, target)) ||
			files.some(
				(file) =>
					containsPath(file, target) ||
					(target.startsWith(file) && LOCK_COMPANION.test(target.slice(file.length).split('/')[0]))
			)
	};
}

/** Roots in manifests are derived from the reviewed selection, never accepted
 * from the backup itself. External paths get stable IDs and the exact same
 * container destination on restore. Overlapping selections are deduplicated. */
export function createCatalog(
	baseRoots,
	value,
	{
		privateDir,
		runtimeDir,
		store,
		includeFile,
		networkMounts = [],
		historicalProcessState = false
	} = {}
) {
	const selection = normalizeSelection(value);
	const policy = boundaryPolicy(selection);
	const networkRoots = normalizeNetworkMounts(networkMounts);
	if (networkRoots.length && !policy.autoExcludeNetworkMounts)
		throw new Error('recovery selection identity rejected');
	const exclusions = [...policy.excludePaths, ...policy.externalMounts, ...networkRoots];
	// Historical catalogs validate the original coverage only. Their transient
	// members are never eligible for restoration through today's catalog.
	const processState = nativeProcessState(baseRoots);
	const processStateExcluded = (target) => !historicalProcessState && processState.contains(target);
	// Process coordination is never durable data. Selecting a native home may
	// include plugin caches, but must not opt into command wrappers or live locks.
	const blocked = [
		privateDir,
		path.join(baseRoots.home, '.fhold-recovery'),
		runtimeDir,
		...['tmp', '.tmp', 'locks', 'thread-writer-locks'].map((name) =>
			path.join(baseRoots.home, '.codex', name)
		),
		path.join(baseRoots.home, '.codex/app-server-control/app-server-control.sock'),
		path.join(baseRoots.akmData, 'locks')
	].filter(Boolean);
	const outside = [store?.root, ...(store?.privatePaths ?? []), includeFile].filter(
		(item) => item && !blocked.some((root) => containsPath(root, item))
	);
	for (const selected of [...selection.paths, ...selection.sqlite]) {
		if (
			['/proc', '/sys', '/dev'].some((root) => overlapsPath(root, selected)) ||
			blocked.some((root) => containsPath(root, selected)) ||
			processStateExcluded(selected) ||
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
	if ([...sqliteFiles].some((item) => exclusions.some((root) => containsPath(root, item))))
		throw new Error('recovery exclusions overlap required SQLite state');
	const metadata =
		selection.version === 1
			? {
					catalog: BOUNDARY_CATALOG_VERSION,
					selectionHash: hash(JSON.stringify({ selection, networkMounts: networkRoots }))
				}
			: selection.paths.length || selection.sqlite.length
				? { catalog: CUSTOM_CATALOG_VERSION, selectionHash: hash(JSON.stringify(selection)) }
				: { catalog: CATALOG_VERSION };
	const excludedPath = (target) => {
		return (
			exclusions.some((item) => containsPath(item, target)) ||
			processStateExcluded(target) ||
			blocked.some((item) => containsPath(item, target)) ||
			outside.some((item) => containsPath(item, target)) ||
			(Object.entries(baseRoots).some(
				([root, base]) =>
					containsPath(base, target) && defaultExcluded(root, path.relative(base, target))
			) &&
				!selection.paths.some((item) => containsPath(item, target)) &&
				!selection.sqlite.includes(target))
		);
	};
	const excluded = (root, name) => excludedPath(native(root, name));
	const allowsPath = (target) => {
		return (
			trees.some(([treeRoot, treeName]) => containsPath(native(treeRoot, treeName), target)) &&
			!excludedPath(target)
		);
	};
	const allowsFile = (root, name) => allowsPath(native(root, name));
	return {
		roots,
		native,
		trees,
		databases,
		dbPaths,
		sqliteFiles,
		excluded,
		excludedPath,
		allowsPath,
		allowsFile,
		metadata,
		selection,
		networkMounts: networkRoots,
		policy,
		protectedPaths: [
			...blocked,
			...outside,
			...(!historicalProcessState ? processState.paths : [])
		],
		exclusions
	};
}

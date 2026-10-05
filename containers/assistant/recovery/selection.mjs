import path from 'node:path';

export const containsPath = (parent, child) =>
	parent === '/' || parent === child || child.startsWith(`${parent}/`);
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

/** Shared host/image validation; filesystem and checkpoint authority stay in the engine. */
export function normalizeSelection(value = {}) {
	const versioned = value?.version === 1;
	const keys = versioned
		? [
				'version',
				'paths',
				'sqlite',
				'excludePaths',
				'externalMounts',
				'autoExcludeNetworkMounts',
				'recoverMounts'
			]
		: ['paths', 'sqlite'];
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !keys.includes(key))
	)
		throw new Error('recovery include file requires paths and sqlite arrays');
	const result = versioned ? { version: 1 } : {};
	for (const key of versioned
		? ['paths', 'sqlite', 'excludePaths', 'externalMounts', 'recoverMounts']
		: ['paths', 'sqlite']) {
		const list = value[key] === undefined ? [] : value[key];
		if (!Array.isArray(list) || list.some((item) => !canonicalPath(item)))
			throw new Error('recovery include paths must be canonical absolute paths');
		result[key] = [...new Set(list)].sort();
	}
	if (versioned) {
		if (
			value.autoExcludeNetworkMounts !== undefined &&
			typeof value.autoExcludeNetworkMounts !== 'boolean'
		)
			throw new Error('recovery network mount discovery must be boolean');
		result.autoExcludeNetworkMounts = value.autoExcludeNetworkMounts ?? false;
		result.excludePaths = result.excludePaths.filter(
			(item, index, all) =>
				!all.some((parent, other) => other !== index && containsPath(parent, item))
		);
		if (
			result.recoverMounts.some((item) =>
				[...result.excludePaths, ...result.externalMounts].some((excluded) =>
					overlapsPath(item, excluded)
				)
			)
		)
			throw new Error('recovery mount policies conflict');
	}
	return result;
}

export function boundaryPolicy(selection) {
	return {
		excludePaths: selection.excludePaths ?? [],
		externalMounts: selection.externalMounts ?? [],
		autoExcludeNetworkMounts: selection.autoExcludeNetworkMounts ?? false,
		recoverMounts: selection.recoverMounts ?? []
	};
}

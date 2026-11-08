import { readFileSync } from 'node:fs';

export const imageComponents = ['assistant', 'guardian', 'portal'];
export const componentManifests = {
	assistant: ['packages/skeleton/package.json', 'plugins/fhold/.claude-plugin/plugin.json', 'plugins/fhold/.codex-plugin/plugin.json'],
	guardian: ['packages/guardian/package.json'],
	portal: ['packages/portal/package.json'],
	bridge: ['packages/claude-desktop/package.json', 'packages/claude-desktop/manifest.json']
};

/** Existing public component pins, not newly invented aliases for unchanged bytes. */
export function componentVersions(read = (path) => readFileSync(path, 'utf8')) {
	return Object.fromEntries(Object.entries(componentManifests).map(([component, files]) => {
		const versions = files.map((file) => JSON.parse(read(file)).version);
		if (typeof versions[0] !== 'string' || !versions[0] || versions.some((version) => version !== versions[0]))
			throw new Error(`Inconsistent ${component} manifest versions`);
		return [component, versions[0]];
	}));
}

export function releaseImages(scope) {
	if (scope === 'full') return [...imageComponents];
	if (scope === 'tools') return [];
	const selected = typeof scope === 'string' ? scope.split(',') : [];
	if (!selected.length || new Set(selected).size !== selected.length || selected.some((name) => !imageComponents.includes(name)))
		throw new Error('Release scope must be full, tools, or comma-separated assistant,guardian,portal');
	return imageComponents.filter((name) => selected.includes(name));
}

export function releaseManifests(release, scope) {
	if (scope === 'full') return release.manifests;
	return [...release.toolingManifests, ...releaseImages(scope).flatMap((name) => componentManifests[name])];
}

export function inferReleaseScope(version, read) {
	const versions = componentVersions(read);
	const selected = imageComponents.filter((name) => versions[name] === version);
	if (versions.bridge === version) {
		if (selected.length !== imageComponents.length) throw new Error('Extension changes require a full release');
		return 'full';
	}
	return selected.length ? selected.join(',') : 'tools';
}

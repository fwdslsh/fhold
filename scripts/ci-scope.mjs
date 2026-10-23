/** Conservative input classification shared by PR CI and tooling publication. */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLING_WORKSPACES = new Set(['packages/lib', 'packages/cli', 'packages/electron']);

// Compare what non-tooling consumers actually resolve, not Bun's hoisting paths.
// An Admin-only addition may rehoist YAML without changing any runtime dependency.
// Bun's v1 text lock uses package-name paths (scoped names count as one segment).
// Unknown formats still select full qualification; no package-specific exceptions.
function toolingLockChange(beforeText, afterText) {
	const before = Bun.JSONC.parse(beforeText);
	const after = Bun.JSONC.parse(afterText);
	const metadata = (lock) => {
		if (lock.lockfileVersion !== 1 || lock.configVersion !== 1 || !lock.packages)
			throw new Error('Unsupported lockfile');
		const copy = structuredClone(lock);
		delete copy.packages;
		for (const path of TOOLING_WORKSPACES)
			if (copy.workspaces?.[path])
				for (const key of ['version', 'dependencies', 'devDependencies', 'optionalDependencies'])
					delete copy.workspaces[path][key];
		return JSON.stringify(copy);
	};
	if (metadata(before) !== metadata(after)) return false;
	const names = (value) =>
		[
			...new Set([
				...Object.keys(value.dependencies ?? {}),
				...Object.keys(value.devDependencies ?? {}),
				...Object.keys(value.optionalDependencies ?? {}),
				...Object.keys(value.peerDependencies ?? {})
			])
		].sort();
	const resolution = (lock, parent, name) => {
		const parts = parent.match(/(?:@[^/]+\/)?[^/]+/g) ?? [];
		if (parts.join('/') !== parent) throw new Error('Unsupported package path');
		for (let count = parts.length; count >= 0; count--) {
			const path = [...parts.slice(0, count), name].join('/');
			if (Object.hasOwn(lock.packages, path)) return path;
		}
		return undefined; // Optional/platform/peer dependencies may be absent.
	};
	const node = (lock, path) => {
		const record = lock.packages[path];
		if (!Array.isArray(record) || typeof record[0] !== 'string')
			throw new Error('Unsupported package record');
		const workspace = record[0].split('@workspace:')[1];
		const value = workspace ? structuredClone(lock.workspaces[workspace]) : (record[2] ?? {});
		if (!value || value.bundled) throw new Error('Unsupported package metadata');
		if (workspace && TOOLING_WORKSPACES.has(workspace)) delete value.version;
		return { record: JSON.stringify(workspace ? [record, value] : record), value };
	};
	const compared = new Set();
	const same = (left, right) => {
		if (left === undefined || right === undefined) return left === right;
		const pair = JSON.stringify([left, right]);
		if (compared.has(pair)) return true;
		compared.add(pair);
		const a = node(before, left);
		const b = node(after, right);
		return (
			a.record === b.record &&
			names(a.value).every((name) =>
				same(resolution(before, left, name), resolution(after, right, name))
			)
		);
	};
	for (const [path, workspace] of Object.entries(before.workspaces)) {
		if (TOOLING_WORKSPACES.has(path)) continue;
		for (const name of names(workspace))
			if (!same(resolution(before, workspace.name, name), resolution(after, workspace.name, name)))
				return false;
	}
	// Every changed lock record must be owned by a workspace. Do not silently
	// discard unexplained/orphan entries from a malformed or future lock format.
	for (const lock of [before, after]) {
		const reached = new Set();
		const visit = (path) => {
			if (path === undefined || reached.has(path)) return;
			reached.add(path);
			for (const name of names(node(lock, path).value)) visit(resolution(lock, path, name));
		};
		for (const workspace of Object.values(lock.workspaces)) {
			visit(resolution(lock, '', workspace.name));
			for (const name of names(workspace)) visit(resolution(lock, workspace.name, name));
		}
		for (const path of Object.keys(lock.packages))
			if (
				!reached.has(path) &&
				JSON.stringify(before.packages[path]) !== JSON.stringify(after.packages[path])
			)
				return false;
	}
	return true;
}

export function changeScope(files, readBefore, readAfter) {
	for (const path of files) {
		if (path === 'bun.lock') {
			try {
				const normalize = (text) => {
					const lock = Bun.JSONC.parse(text);
					for (const workspace of ['packages/lib', 'packages/cli', 'packages/electron'])
						if (lock.workspaces?.[workspace]) {
							for (const key of [
								'version',
								'dependencies',
								'devDependencies',
								'optionalDependencies'
							])
								delete lock.workspaces[workspace][key];
						}
					return JSON.stringify(lock);
				};
				if (
					normalize(readBefore(path)) === normalize(readAfter(path)) ||
					toolingLockChange(readBefore(path), readAfter(path))
				)
					continue;
			} catch {
				/* Changed package resolutions or unreadable lock need runtime qualification. */
			}
			return 'full';
		}
		if (path === 'package.json') {
			const settings = (text) => {
				const json = JSON.parse(text);
				return JSON.stringify([
					json.dependencies,
					json.devDependencies,
					json.overrides,
					json.trustedDependencies,
					json.workspaces,
					json.packageManager,
					...['preinstall', 'install', 'postinstall', 'prepare'].map((name) => json.scripts?.[name])
				]);
			};
			try {
				if (settings(readBefore(path)) === settings(readAfter(path))) continue;
			} catch {}
			return 'full';
		}
		if (path === 'packages/lib/src/control-plane/seed-manifest.ts') return 'full';
		if (/^(?:packages\/(?:lib|cli|electron)\/|docs\/|website\/)/.test(path)) continue;
		if (/^(?:README|CHANGELOG|AGENTS|LICENSE)(?:\.md)?$/.test(path)) continue;
		if (
			[
				'.github/workflows/ci.yml',
				'.github/workflows/pr-admin.yml',
				'.github/workflows/gates.yml',
				'.github/workflows/release.yml',
				'.github/release-manifest.json',
				'scripts/ci-scope.mjs',
				'scripts/tooling-release.test.ts',
				'scripts/management-architecture.test.ts',
				'scripts/bump-release.mjs',
				'scripts/bump-release.test.ts',
				'scripts/validate-release-assets.mjs',
				'scripts/release-aggregates-hygiene.test.ts',
				'scripts/smoke-admin-artifact.mjs',
				'scripts/validate-admin-update-feeds.mjs',
				'scripts/admin-update-feeds.test.ts',
				'scripts/README.md',
				'.github/workflows/deploy-docs.yml'
			].includes(path)
		)
			continue;
		return 'full';
	}
	return 'tools';
}

export function gitScope(base, head = 'HEAD') {
	const git = (args) => execFileSync('git', args, { encoding: 'utf8' });
	const files = git(['diff', '--name-only', '-z', '--no-renames', base, head, '--'])
		.split('\0')
		.filter(Boolean);
	return changeScope(
		files,
		(path) => git(['show', `${base}:${path}`]),
		(path) => git(['show', `${head}:${path}`])
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const scope =
		!process.env.BASE_SHA || /^0+$/.test(process.env.BASE_SHA)
			? 'full'
			: gitScope(process.env.BASE_SHA, process.env.HEAD_SHA || 'HEAD');
	console.log(scope);
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `scope=${scope}\n`);
}

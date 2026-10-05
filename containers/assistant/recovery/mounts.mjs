import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { assertNoLinks } from './directory-store.mjs';
import { canonicalPath, containsPath, overlapsPath } from './catalog.mjs';

const NETWORK_FILESYSTEMS = new Set(['cifs', 'smb3', 'nfs', 'nfs4']);
const INVALID = 'recovery mount table rejected';
const decode = (value) =>
	value.replace(/\\(040|011|012|134)/g, (_, octal) =>
		String.fromCharCode(Number.parseInt(octal, 8))
	);

/** Use mount IDs/parents to resolve overmounts. Device IDs alone miss bind
 * boundaries. Sources and filesystem credentials are deliberately not retained. */
export function parseMountInfo(text) {
	if (typeof text !== 'string' || Buffer.byteLength(text) > 4 * 1024 * 1024)
		throw new Error(INVALID);
	const rows = text
		.trim()
		.split('\n')
		.map((line) => {
			const fields = line.split(' ');
			const separator = fields.indexOf('-');
			if (separator < 6 || fields.length !== separator + 4) throw new Error(INVALID);
			const [id, parent] = fields.slice(0, 2).map(Number);
			const root = decode(fields[3]);
			const point = decode(fields[4]);
			if (
				!Number.isSafeInteger(id) ||
				id < 1 ||
				!Number.isSafeInteger(parent) ||
				parent < 0 ||
				!/^\d+:\d+$/.test(fields[2]) ||
				!root ||
				!point.startsWith('/') ||
				point.includes('\0') ||
				root.includes('\0')
			)
				throw new Error(INVALID);
			return {
				id,
				parent,
				device: fields[2],
				root,
				point,
				filesystem: fields[separator + 1],
				options: fields[5],
				readOnly:
					fields[5].split(',').includes('ro') || fields[separator + 3].split(',').includes('ro')
			};
		});
	const byId = new Map(rows.map((row) => [row.id, row]));
	if (byId.size !== rows.length || rows.some((row) => row.point !== '/' && !byId.has(row.parent)))
		throw new Error(INVALID);
	for (const row of rows) {
		const visited = new Set();
		let parent = row;
		while (parent && !(parent.point === '/' && parent.id === parent.parent)) {
			if (visited.has(parent.id)) throw new Error(INVALID);
			visited.add(parent.id);
			parent = byId.get(parent.parent);
		}
	}
	const groups = new Map();
	for (const row of rows) {
		const group = groups.get(row.point) ?? [];
		group.push(row);
		groups.set(row.point, group);
	}
	const visible = [];
	const byPoint = new Map();
	for (const [point, group] of [...groups].sort(
		([a], [b]) => a.length - b.length || a.localeCompare(b)
	)) {
		let parentPoint = point;
		let ancestor;
		while (parentPoint !== '/') {
			parentPoint = parentPoint.slice(0, parentPoint.lastIndexOf('/')) || '/';
			ancestor = byPoint.get(parentPoint);
			if (ancestor) break;
		}
		const bases = group.filter((row) =>
			point === '/' ? row.parent === row.id || !byId.has(row.parent) : row.parent === ancestor?.id
		);
		if (!bases.length && point !== '/') continue; // hidden below another mount
		if (bases.length !== 1) throw new Error(INVALID);
		let top = bases[0];
		const visited = new Set([top.id]);
		for (;;) {
			const children = group.filter((row) => row.parent === top.id && row.id !== top.id);
			if (!children.length) break;
			if (children.length !== 1 || visited.has(children[0].id)) throw new Error(INVALID);
			top = children[0];
			visited.add(top.id);
		}
		visible.push(top);
		byPoint.set(point, top);
	}
	if (!visible.some((row) => row.point === '/')) throw new Error(INVALID);
	return visible.sort((a, b) => a.point.localeCompare(b.point));
}

export async function readMountInfo() {
	const handle = await fs.open('/proc/self/mountinfo', 'r');
	try {
		const bytes = Buffer.alloc(4 * 1024 * 1024 + 1);
		let size = 0;
		while (size < bytes.length) {
			const read = await handle.read(bytes, size, bytes.length - size, null);
			if (!read.bytesRead) break;
			size += read.bytesRead;
		}
		if (size === bytes.length) throw new Error(INVALID);
		return parseMountInfo(bytes.subarray(0, size).toString());
	} finally {
		await handle.close();
	}
}

export function mountForPath(mounts, target) {
	return mounts
		.filter((mount) => containsPath(mount.point, target))
		.sort((a, b) => b.point.length - a.point.length)[0];
}

export async function inspectMounts(catalog, mounts) {
	const selected = catalog.trees.map(([root, name]) => catalog.native(root, name));
	const databases = [...catalog.sqliteFiles];
	const policy = catalog.policy;
	const relevant = [
		...selected,
		...databases,
		...catalog.protectedPaths,
		...policy.excludePaths,
		...policy.externalMounts,
		...policy.recoverMounts
	];
	const discovered = policy.autoExcludeNetworkMounts
		? mounts
				.filter(
					(mount) =>
						mount.point !== '/' &&
						NETWORK_FILESYSTEMS.has(mount.filesystem) &&
						selected.some((item) => overlapsPath(item, mount.point)) &&
						![...policy.excludePaths, ...policy.externalMounts].some((root) =>
							containsPath(root, mount.point)
						) &&
						!policy.recoverMounts.includes(mount.point)
				)
				.map((mount) => mount.point)
				.sort()
		: [];
	const networkMounts = discovered.filter(
		(root) => !discovered.some((other) => other !== root && containsPath(other, root))
	);
	if (networkMounts.some((item) => !canonicalPath(item))) throw new Error(INVALID);
	if (
		policy.recoverMounts.some((root) =>
			networkMounts.some((external) => containsPath(external, root))
		)
	)
		throw new Error('recovery mount policies conflict');
	// Placement is checked even when a database has not been created yet and even
	// when automatic exclusion is disabled or the mount is opted into recovery.
	if (databases.some((item) => NETWORK_FILESYSTEMS.has(mountForPath(mounts, item)?.filesystem)))
		throw new Error('recovery SQLite must use local storage');
	if (policy.recoverMounts.some((root) => !mounts.some((mount) => mount.point === root)))
		throw new Error('recovery included mount missing');
	for (const root of policy.externalMounts) {
		if (!mounts.some((mount) => mount.point === root))
			throw new Error('recovery required external mount missing');
		await assertNoLinks(root);
		if (!(await fs.stat(root)).isDirectory())
			throw new Error('recovery external mount must be a directory');
		await fs.access(root, constants.R_OK | constants.X_OK);
	}
	for (const root of [...policy.excludePaths, ...networkMounts]) {
		await assertNoLinks(root);
		try {
			if (policy.excludePaths.includes(root) && !(await fs.stat(root)).isDirectory())
				throw new Error('recovery excluded path must be a directory');
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
	}
	const fingerprint = createHash('sha256')
		.update(
			JSON.stringify(
				mounts.filter(
					(mount) =>
						relevant.some((item) => overlapsPath(item, mount.point)) &&
						![...policy.excludePaths, ...policy.externalMounts, ...networkMounts].some(
							(root) => root !== mount.point && containsPath(root, mount.point)
						)
				)
			)
		)
		.digest('hex');
	return {
		networkMounts,
		fingerprint,
		externalMounts: [...new Set([...policy.externalMounts, ...networkMounts])]
			.sort()
			.map((root) => ({
				path: root,
				reason: policy.externalMounts.includes(root) ? 'declared-external-mount' : 'network-mount',
				readOnly: mounts.find((mount) => mount.point === root)?.readOnly ?? false
			}))
	};
}

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEngine } from '../containers/assistant/recovery/engine.mjs';
import { createDirectoryStore } from '../containers/assistant/recovery/directory-store.mjs';
import { normalizeSelection } from '../containers/assistant/recovery/catalog.mjs';
import { parseMountInfo, mountForPath } from '../containers/assistant/recovery/mounts.mjs';

const escapeMountPoint = (value: string) =>
	value.replaceAll('\\', '\\134').replaceAll(' ', '\\040');
const row = (id: number, parent: number, point: string, filesystem = 'ext4', options = 'rw') =>
	`${id} ${parent} 8:1 / ${escapeMountPoint(point)} ${options} unknown:future - ${filesystem} synthetic ${options}`;
const table = (extra: string[] = []) => parseMountInfo([row(1, 99, '/'), ...extra].join('\n'));

async function fixture() {
	const dir = await fs.mkdtemp('/tmp/fhold-mount-test-');
	const roots = Object.fromEntries(
		['home', 'work', 'stash', 'akmData', 'akmConfig'].map((name) => [
			name,
			path.join(dir, 'live', name)
		])
	);
	await Promise.all(Object.values(roots).map((root) => fs.mkdir(root, { recursive: true })));
	const store = createDirectoryStore(pathToFileURL(path.join(dir, 'backup')).href);
	let mounts = table();
	const config = {
		instanceId: 'mount-fixture',
		versions: { native: 'synthetic' },
		selection: { version: 1 }
	};
	const options = { roots, store, readMounts: async () => mounts };
	return {
		dir,
		roots,
		store,
		config,
		options,
		setMounts: (next: ReturnType<typeof table>) => {
			mounts = next;
		},
		engine: (selection: object = config.selection) =>
			createEngine({ ...config, selection }, options)
	};
}

async function manifest(f: Awaited<ReturnType<typeof fixture>>) {
	const head = await f.store.readDescriptor();
	if (!head) throw new Error('fixture requires a descriptor');
	return JSON.parse(
		(await f.store.read(`manifests/${head.value.generation}`, 4 * 1024 * 1024)).toString()
	);
}

describe('Linux mount namespace visibility', () => {
	test('decodes escaped paths, tolerates optional fields and resolves same-device overmounts by parent, not ID/order', () => {
		const mounts = table([
			row(7, 40, '/work'),
			row(41, 40, '/work/hidden'),
			row(40, 1, '/work'),
			row(8, 7, '/work/share data', 'nfs4', 'ro'),
			'9 1 0:4 net:[4026533521] /namespace rw - nsfs nsfs rw'
		]);
		expect(mounts.find((mount) => mount.point === '/work')?.id).toBe(7);
		expect(mounts.some((mount) => mount.id === 41)).toBe(false);
		expect(mountForPath(mounts, '/work/share data/file')?.readOnly).toBe(true);
		expect(mountForPath(mounts, '/workspace/file')?.point).toBe('/');
		expect(mounts[0]).not.toHaveProperty('source');
		expect(parseMountInfo('1 1 8:1 / / rw - ext4 none rw')).toHaveLength(1);
	});

	test('rejects malformed, ambiguous and cyclic mount tables', () => {
		for (const value of [
			'',
			'bad',
			row(1, 99, '/work'),
			[row(1, 99, '/'), row(1, 1, '/work')].join('\n'),
			[row(1, 99, '/'), row(2, 1, '/work'), row(3, 1, '/work')].join('\n'),
			[row(1, 99, '/'), row(2, 3, '/cycle'), row(3, 2, '/cycle')].join('\n')
		])
			expect(() => parseMountInfo(value)).toThrow('mount table');
	});
});

describe('versioned recovery mount policy', () => {
	test('keeps legacy selectors unchanged and normalizes only explicitly versioned policies', () => {
		expect(normalizeSelection({})).toEqual({ paths: [], sqlite: [] });
		expect(
			normalizeSelection({ version: 1, excludePaths: ['/work/tmp/a', '/work/tmp', '/work/tmp'] })
		).toEqual({
			version: 1,
			paths: [],
			sqlite: [],
			excludePaths: ['/work/tmp'],
			externalMounts: [],
			recoverMounts: [],
			autoExcludeNetworkMounts: false
		});
		for (const value of [
			{ excludePaths: [] },
			{ version: 2 },
			{ version: 1, autoExcludeNetworkMounts: 'yes' },
			{ version: 1, externalMounts: ['relative'] },
			{ version: 1, recoverMounts: ['/work/data'], excludePaths: ['/work'] }
		])
			expect(() => normalizeSelection(value)).toThrow();
	});

	test('prunes excluded content before traversal and preserves independent external contents on cold restore', async () => {
		const f = await fixture();
		const external = path.join(f.roots.work, 'drive');
		const omitted = path.join(f.roots.stash, 'temporary');
		await fs.mkdir(external);
		await fs.mkdir(omitted);
		await fs.writeFile(path.join(external, 'external.txt'), 'original-external');
		await fs.symlink('/nonexistent', path.join(omitted, 'must-not-traverse'));
		await fs.writeFile(path.join(f.roots.work, 'local.txt'), 'local-state');
		f.setMounts(table([row(2, 1, external)]));
		const selection = { version: 1, externalMounts: [external], excludePaths: [omitted] };
		const engine = f.engine(selection);
		const inspection = await engine.inspect();
		expect(inspection.externalMounts).toEqual([
			{ path: external, reason: 'declared-external-mount', readOnly: false }
		]);
		expect(
			await fs
				.access(path.join(f.dir, 'backup'))
				.then(() => true)
				.catch(() => false)
		).toBe(false);
		await engine.initialize();
		await engine.acquireRestore();
		await engine.checkpoint();
		await engine.release();
		const saved = await manifest(f);
		expect(saved.catalog).toBe(3);
		expect(saved.members.map((member) => member.path)).toEqual(['local.txt']);
		expect(saved.networkMounts).toEqual([]);
		// Retain synthetic original native state; leave the independent drive intact.
		await fs.rename(path.join(f.roots.work, 'local.txt'), path.join(f.dir, 'retained-local'));
		await fs.rename(
			path.join(f.roots.home, '.fhold-recovery'),
			path.join(f.dir, 'retained-private')
		);
		await fs.writeFile(path.join(external, 'external.txt'), 'newer-external');
		const replacement = f.engine(selection);
		await replacement.acquireRestore();
		await replacement.checkpoint();
		await replacement.release();
		expect(await fs.readFile(path.join(f.roots.work, 'local.txt'), 'utf8')).toBe('local-state');
		expect(await fs.readFile(path.join(external, 'external.txt'), 'utf8')).toBe('newer-external');
	});

	test('requires actual declared mount roots, even outside the catalog; exclusion alone does not require a mount', async () => {
		const f = await fixture();
		const external = path.join(f.dir, 'outside');
		await fs.mkdir(external);
		await expect(f.engine({ version: 1, externalMounts: [external] }).initialize()).rejects.toThrow(
			'mount missing'
		);
		expect(await f.store.readDescriptor()).toBe(null);
		await expect(
			f.engine({ version: 1, excludePaths: [path.join(f.dir, 'missing')] }).inspect()
		).resolves.toBeDefined();
		f.setMounts(table([row(2, 1, external, 'fuse.vendor', 'ro')]));
		expect(
			(await f.engine({ version: 1, externalMounts: [external] }).inspect()).externalMounts[0]
				.readOnly
		).toBe(true);
	});

	test('refuses excluded SQLite and sidecars even before their first creation', async () => {
		const f = await fixture();
		for (const excluded of [
			path.join(f.roots.home, '.codex'),
			path.join(f.roots.akmData, 'state.db-wal')
		])
			expect(() => f.engine({ version: 1, excludePaths: [excluded] })).toThrow('required SQLite');
		const db = path.join(f.roots.work, 'custom/state.db');
		expect(() =>
			f.engine({ version: 1, sqlite: [db], externalMounts: [path.dirname(db)] })
		).toThrow('required SQLite');
	});

	test('network discovery is opt-in and does not drop ordinary local volumes, tmpfs or unknown FUSE', async () => {
		const f = await fixture();
		const share = path.join(f.roots.work, 'share');
		await fs.mkdir(share);
		await fs.writeFile(path.join(share, 'note'), 'external');
		f.setMounts(
			table([
				row(2, 1, f.roots.work),
				row(3, 2, share, 'cifs', 'ro'),
				row(4, 1, f.roots.stash, 'tmpfs'),
				row(5, 1, f.roots.akmConfig, 'fuse.vendor')
			])
		);
		expect((await f.engine({ version: 1 }).inspect()).externalMounts).toEqual([]);
		const automatic = f.engine({ version: 1, autoExcludeNetworkMounts: true });
		expect((await automatic.inspect()).externalMounts).toEqual([
			{ path: share, reason: 'network-mount', readOnly: true }
		]);
		await automatic.initialize();
		await automatic.acquireRestore();
		await automatic.checkpoint();
		await automatic.release();
		expect((await manifest(f)).networkMounts).toEqual([share]);
		expect((await manifest(f)).members).toEqual([]);
		f.setMounts(table([row(2, 1, f.roots.work)]));
		await expect(
			f.engine({ version: 1, autoExcludeNetworkMounts: true }).acquireRestore()
		).rejects.toThrow('boundary policy');
		expect(f.engine().status().owned).toBe(false);
	});

	test('exact network-mount opt-ins capture regular files but never permit network SQLite', async () => {
		const f = await fixture();
		f.setMounts(table([row(2, 1, f.roots.work, 'nfs4')]));
		const selection = { version: 1, autoExcludeNetworkMounts: true, recoverMounts: [f.roots.work] };
		await fs.writeFile(path.join(f.roots.work, 'regular'), 'captured');
		expect((await f.engine(selection).inspect()).externalMounts).toEqual([]);
		await expect(
			f.engine({ ...selection, sqlite: [path.join(f.roots.work, 'absent.sqlite')] }).inspect()
		).rejects.toThrow('local storage');
		for (const [root, name] of [
			[f.roots.home, '.local/share/opencode'],
			[f.roots.akmData, '']
		] as const) {
			const point = path.join(root, name);
			f.setMounts(table([row(2, 1, point, 'nfs')]));
			await expect(f.engine().inspect()).rejects.toThrow('local storage');
		}
	});

	test('rejects symlink policy paths, non-directory exclusions and unknown SQLite in retained trees', async () => {
		const f = await fixture();
		const linked = path.join(f.roots.work, 'link');
		await fs.symlink(f.roots.stash, linked);
		await expect(f.engine({ version: 1, excludePaths: [linked] }).inspect()).rejects.toThrow(
			'link'
		);
		const file = path.join(f.roots.work, 'file');
		await fs.writeFile(file, 'ordinary');
		await expect(f.engine({ version: 1, excludePaths: [file] }).inspect()).rejects.toThrow(
			'directory'
		);
		await fs.rename(linked, path.join(f.dir, 'retained-link'));
		await fs.writeFile(path.join(f.roots.work, 'unknown.sqlite'), 'not-registered');
		const engine = f.engine();
		await engine.initialize();
		await expect(engine.acquireRestore()).rejects.toThrow('uncataloged');
	});

	test('handles selected-root, ancestor and file network mounts while leaving the filesystem root out of discovery', async () => {
		const f = await fixture();
		f.setMounts(table([row(2, 1, f.roots.work, 'nfs')]));
		expect(
			(await f.engine({ version: 1, autoExcludeNetworkMounts: true }).inspect()).externalMounts[0]
				.path
		).toBe(f.roots.work);
		const extra = path.join(f.dir, 'extra');
		await fs.mkdir(extra);
		f.setMounts(table([row(2, 1, extra, 'cifs')]));
		expect(
			(
				await f
					.engine({
						version: 1,
						paths: [path.join(extra, 'nested')],
						autoExcludeNetworkMounts: true
					})
					.inspect()
			).externalMounts[0].path
		).toBe(extra);
		const file = path.join(f.roots.work, 'remote-file');
		await fs.writeFile(file, 'independent');
		f.setMounts(table([row(2, 1, file, 'nfs4', 'ro')]));
		expect(
			(await f.engine({ version: 1, autoExcludeNetworkMounts: true }).inspect()).externalMounts[0]
				.path
		).toBe(file);
		f.setMounts(table([row(2, 1, path.join(f.roots.work, 'db.sqlite-wal'), 'nfs4')]));
		await expect(
			f.engine({ version: 1, sqlite: [path.join(f.roots.work, 'db.sqlite')] }).inspect()
		).rejects.toThrow('local storage');
		f.setMounts(
			parseMountInfo(
				[
					row(1, 99, '/', 'nfs'),
					...Object.values(f.roots).map((root, index) => row(index + 2, 1, root))
				].join('\n')
			)
		);
		expect(
			(await f.engine({ version: 1, autoExcludeNetworkMounts: true }).inspect()).externalMounts
		).toEqual([]);
	});

	test('collapses automatically excluded submounts and rejects nested opt-ins below an excluded ancestor', async () => {
		const f = await fixture();
		const external = path.join(f.roots.work, 'share');
		const nested = path.join(external, 'nested');
		await fs.mkdir(nested, { recursive: true });
		f.setMounts(table([row(2, 1, external, 'nfs'), row(3, 2, nested, 'nfs4')]));
		const engine = f.engine({ version: 1, autoExcludeNetworkMounts: true });
		await engine.initialize();
		await engine.acquireRestore();
		await engine.checkpoint();
		await engine.release();
		expect((await manifest(f)).networkMounts).toEqual([external]);
		await expect(
			f.engine({ version: 1, autoExcludeNetworkMounts: true, recoverMounts: [nested] }).inspect()
		).rejects.toThrow('policies conflict');
	});

	test('does not bind independent nested mounts into policy when an explicit external root already owns them', async () => {
		const f = await fixture();
		const external = path.join(f.roots.work, 'drive');
		await fs.mkdir(external);
		f.setMounts(table([row(2, 1, external)]));
		const engine = f.engine({
			version: 1,
			externalMounts: [external],
			autoExcludeNetworkMounts: true
		});
		await engine.initialize();
		await engine.acquireRestore();
		await engine.checkpoint();
		f.setMounts(table([row(2, 1, external), row(3, 2, path.join(external, 'nested'), 'nfs')]));
		await engine.checkpoint();
		await engine.release();
		expect((await manifest(f)).networkMounts).toEqual([]);
	});
});

describe('accepted policy and topology fencing', () => {
	test('cold restore retains old absolute destinations when an additive parent selection changes custom root IDs', async () => {
		const f = await fixture();
		const extra = path.join(f.dir, 'extra');
		const file = path.join(extra, 'nested/note');
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, 'original');
		const old = f.engine({ version: 1, paths: [file] });
		await old.initialize();
		await old.acquireRestore();
		await old.checkpoint();
		await old.release();
		await fs.rename(extra, path.join(f.dir, 'retained-extra'));
		await fs.rename(
			path.join(f.roots.home, '.fhold-recovery'),
			path.join(f.dir, 'retained-private')
		);
		const expanded = f.engine({ version: 1, paths: [extra] });
		await expanded.acquireRestore();
		await expanded.checkpoint();
		await expanded.release();
		expect(await fs.readFile(file, 'utf8')).toBe('original');
	});

	test('rejects policy ownership changes before claiming; unchanged policy allows additive inclusions and WAL snapshots', async () => {
		const f = await fixture();
		const databasePath = path.join(f.roots.work, 'custom.sqlite');
		const db = new Database(databasePath);
		db.exec(
			"PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('committed')"
		);
		const selection = {
			version: 1,
			sqlite: [databasePath],
			excludePaths: [path.join(f.roots.work, 'cache')]
		};
		const engine = f.engine(selection);
		await engine.initialize();
		await engine.acquireRestore();
		await engine.checkpoint();
		await engine.release();
		const previous = await f.store.readDescriptor();
		for (const changed of [
			{ ...selection, excludePaths: [] },
			{ ...selection, autoExcludeNetworkMounts: true }
		]) {
			const attempted = f.engine(changed);
			await expect(attempted.acquireRestore()).rejects.toThrow('boundary policy');
			expect(attempted.status().owned).toBe(false);
			expect(previous).not.toBe(null);
			expect((await f.store.readDescriptor())?.value.epoch).toBe(previous?.value.epoch);
		}
		const expanded = f.engine({ ...selection, paths: [path.join(f.dir, 'optional')] });
		await expanded.acquireRestore();
		await expanded.checkpoint();
		await expanded.release();
		expect((await manifest(f)).members.filter((member) => member.kind === 'sqlite')).toHaveLength(
			1
		);
		db.close();
	});

	test('does not accept a checkpoint after mounts change during object upload; renewal withdraws readiness', async () => {
		const f = await fixture();
		await fs.writeFile(path.join(f.roots.work, 'note'), 'local');
		const engine = f.engine();
		await engine.initialize();
		await engine.acquireRestore();
		await engine.checkpoint();
		const previous = await f.store.readDescriptor();
		const original = f.store.createImmutable;
		f.store.createImmutable = async (...args) => {
			const result = await original(...args);
			f.setMounts(table([row(2, 1, f.roots.work)]));
			return result;
		};
		await expect(engine.checkpoint()).rejects.toThrow('topology changed');
		expect(previous).not.toBe(null);
		expect((await f.store.readDescriptor())?.value.generation).toBe(previous?.value.generation);
		await expect(engine.renew()).rejects.toThrow('topology changed');
		expect(engine.status().ready).toBe(false);
		await engine.release();
	});

	test('keeps a partial-restore journal if topology changes during native publication', async () => {
		const f = await fixture();
		await fs.writeFile(path.join(f.roots.work, 'a'), 'a');
		await fs.writeFile(path.join(f.roots.work, 'b'), 'b');
		const initial = f.engine();
		await initial.initialize();
		await initial.acquireRestore();
		await initial.checkpoint();
		await initial.release();
		await fs.rename(path.join(f.dir, 'live'), path.join(f.dir, 'retained-live'));
		await Promise.all(Object.values(f.roots).map((root) => fs.mkdir(root, { recursive: true })));
		f.options.readMounts = async () =>
			await fs
				.access(path.join(f.roots.work, 'a'))
				.then(() => table([row(2, 1, f.roots.work)]))
				.catch(() => table());
		const replacement = f.engine();
		await expect(replacement.acquireRestore()).rejects.toThrow('topology changed');
		expect(replacement.status().ready).toBe(false);
		expect(replacement.status().owned).toBe(false);
		expect(
			await fs
				.access(path.join(f.roots.home, '.fhold-recovery/restore-journal.json'))
				.then(() => true)
		).toBe(true);
		expect(
			await fs
				.access(path.join(f.roots.work, 'b'))
				.then(() => true)
				.catch(() => false)
		).toBe(false);
	});

	test('supports a reviewed stopped-writer transition through a fresh namespace without editing old authority', async () => {
		const f = await fixture();
		await fs.writeFile(path.join(f.roots.work, 'state'), 'retain');
		const old = f.engine({});
		await old.initialize();
		await old.acquireRestore();
		await old.checkpoint();
		await old.release();
		const oldHead = await f.store.readDescriptor();
		const newStore = createDirectoryStore(pathToFileURL(path.join(f.dir, 'new-backup')).href);
		const external = path.join(f.roots.work, 'independent');
		await fs.mkdir(external);
		f.setMounts(table([row(2, 1, external)]));
		const transition = createEngine(
			{
				...f.config,
				privateDir: path.join(f.dir, 'new-private'),
				selection: { version: 1, paths: [f.roots.home], externalMounts: [external] }
			},
			{ ...f.options, store: newStore }
		);
		await transition.initialize();
		await transition.acquireRestore();
		await transition.checkpoint();
		await transition.release();
		expect(await f.store.readDescriptor()).toEqual(oldHead);
		const newHead = await newStore.readDescriptor();
		if (!newHead) throw new Error('fixture requires a descriptor');
		const saved = JSON.parse(
			(await newStore.read(`manifests/${newHead.value.generation}`, 4 * 1024 * 1024)).toString()
		);
		expect(saved.members.map((member) => member.path)).toEqual(['state']);
		expect(await fs.readFile(path.join(f.roots.work, 'state'), 'utf8')).toBe('retain');
	});
});

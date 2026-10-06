import { describe, expect, test, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
	mkdtemp,
	mkdir,
	writeFile,
	readFile,
	rm,
	symlink,
	chmod,
	stat,
	rename,
	copyFile
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { createServer } from 'node:net';
// Image-baked ESM runtime is also exercised directly by Bun fixtures.
import { createEngine, DEFAULT_LIMITS } from '../containers/assistant/recovery/engine.mjs';
import { createDirectoryStore } from '../containers/assistant/recovery/directory-store.mjs';
import {
	normalizeSelection,
	readSelection,
	createCatalog
} from '../containers/assistant/recovery/catalog.mjs';
import {
	parseBlobDestination,
	createBlobStore
} from '../containers/assistant/recovery/blob-store.mjs';

async function fixture() {
	const dir = await mkdtemp('/tmp/fhold-recovery-test-');
	const roots = Object.fromEntries(
		['home', 'stash', 'work', 'akmData', 'akmConfig'].map((key) => [
			key,
			path.join(dir, 'live', key)
		])
	);
	await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })));
	const versions = {
		image: 'synthetic',
		opencode: '1.18.34',
		akm: '0.9.24',
		codex: '0.160.0',
		claude: '2.1.289'
	};
	const config = {
		url: pathToFileURL(path.join(dir, 'backup')).href,
		instanceId: 'fixture-instance',
		versions,
		privateDir: path.join(roots.home, '.fhold-recovery')
	};
	const options = { roots, bunPath: process.execPath };
	return { dir, roots, config, options, engine: () => createEngine(config, options) };
}

async function savedManifest(f: Awaited<ReturnType<typeof fixture>>) {
	const head = await createDirectoryStore(f.config.url).readDescriptor();
	if (!head) throw new Error('fixture has no recovery descriptor');
	const manifest = JSON.parse(
		await readFile(path.join(f.dir, 'backup/manifests', head.value.generation), 'utf8')
	);
	return { head, manifest };
}

describe('operator-selected recovery paths and SQLite databases', () => {
	test('uses one strict literal-path JSON format and deduplicates lists deterministically', async () => {
		const f = await fixture();
		const configFile = path.join(f.dir, 'include.json');
		await writeFile(
			configFile,
			JSON.stringify({ paths: ['/custom/b', '/custom/a', '/custom/b'], sqlite: ['/custom/db'] })
		);
		expect(await readSelection(configFile, 4096)).toEqual({
			paths: ['/custom/a', '/custom/b'],
			sqlite: ['/custom/db']
		});
		for (const value of [
			null,
			[],
			{ folders: [] },
			{ paths: null },
			{ sqlite: 'db' },
			{ paths: ['relative'] },
			{ paths: ['/'] },
			{ paths: ['/custom/../else'] },
			{ paths: ['/custom//a'] },
			{ paths: ['/custom/a/'] },
			{ paths: ['/custom/line\nbreak'] },
			{ sqlite: ['/custom\\alias'] }
		])
			expect(() => normalizeSelection(value)).toThrow();
		await writeFile(configFile, '{broken-json');
		await expect(readSelection(configFile, 4096)).rejects.toThrow('valid JSON');
		await writeFile(configFile, '{}');
		await symlink(configFile, path.join(f.dir, 'linked-include'));
		await expect(readSelection(path.join(f.dir, 'linked-include'), 4096)).rejects.toThrow('link');
		await expect(readSelection(f.dir, 4096)).rejects.toThrow('type/size');
		await expect(readSelection(configFile, 1)).rejects.toThrow('type/size');
	});

	test('restores overlapping directories, individual files, optional paths and several WAL-backed databases', async () => {
		const f = await fixture();
		const extra = path.join(f.dir, 'extra with spaces');
		const individual = path.join(f.dir, "individual's settings.json");
		const plugin = path.join(f.roots.home, '.vendor');
		await mkdir(path.join(extra, 'nested'), { recursive: true });
		await mkdir(plugin, { recursive: true });
		await writeFile(path.join(extra, 'nested/note'), 'extra-note', { mode: 0o700 });
		await writeFile(individual, 'individual-file');
		await writeFile(path.join(plugin, 'auth.json'), 'synthetic-private-account', { mode: 0o600 });
		await writeFile(path.join(f.roots.home, 'not-selected'), 'do-not-include');
		const dbPaths = [
			path.join(extra, 'nested/custom.db'),
			path.join(f.roots.work, 'workspace.sqlite'),
			path.join(f.dir, 'standalone.sqlite')
		];
		const databases = dbPaths.map((file, index) => {
			const db = new Database(file);
			db.exec(
				'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE marker(id INTEGER PRIMARY KEY, value TEXT)'
			);
			db.query('INSERT INTO marker(value) VALUES(?)').run(`committed-wal-${index}`);
			return db;
		});
		const config = {
			...f.config,
			selection: {
				paths: [
					extra,
					individual,
					plugin,
					path.join(extra, 'nested'),
					path.join(f.dir, 'not-yet-created')
				],
				sqlite: [...dbPaths, dbPaths[0]]
			}
		};
		const engine = createEngine(config, f.options);
		await engine.initialize();
		await engine.acquireRestore();
		await engine.checkpoint();
		await engine.release();
		const { head, manifest } = await savedManifest(f);
		expect(head.value.catalog).toBe(2);
		expect(head.value.selectionHash).toBe(manifest.selectionHash);
		expect(manifest.members.filter((member) => member.kind === 'sqlite')).toHaveLength(3);
		expect(manifest.members.some((member) => /-wal$|-shm$|not-selected/.test(member.path))).toBe(
			false
		);
		expect(manifest.members.filter((member) => member.path.endsWith('note'))).toHaveLength(1);
		for (const db of databases) db.close();
		// Retain generated source data; the replacement uses the same container paths.
		await rename(path.join(f.dir, 'live'), path.join(f.dir, 'retained-live'));
		await rename(extra, `${extra}-retained`);
		await rename(individual, `${individual}-retained`);
		await rename(dbPaths[2], `${dbPaths[2]}-retained`);
		const replacement = createEngine(
			{
				...config,
				selection: { paths: [...config.selection.paths].reverse(), sqlite: [...dbPaths].reverse() }
			},
			f.options
		);
		await replacement.acquireRestore();
		expect(await readFile(path.join(extra, 'nested/note'), 'utf8')).toBe('extra-note');
		expect((await stat(path.join(extra, 'nested/note'))).mode & 0o777).toBe(0o700);
		expect(await readFile(individual, 'utf8')).toBe('individual-file');
		expect(await readFile(path.join(plugin, 'auth.json'), 'utf8')).toBe(
			'synthetic-private-account'
		);
		expect((await stat(path.join(plugin, 'auth.json'))).mode & 0o777).toBe(0o600);
		for (const [index, file] of dbPaths.entries()) {
			const restored = new Database(file, { readonly: true });
			expect(restored.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
			expect(restored.query('SELECT value FROM marker').get()).toEqual({
				value: `committed-wal-${index}`
			});
			restored.close();
		}
		expect(await stat(path.join(f.roots.home, 'not-selected')).catch(() => null)).toBeNull();
		await replacement.checkpoint();
		await replacement.release();
	});

	test('has no fixed list-length cap and keeps the descriptor compact', async () => {
		const f = await fixture();
		const paths = Array.from({ length: 300 }, (_, i) => path.join(f.dir, `custom-${i}.txt`));
		const sqlite = Array.from({ length: 300 }, (_, i) => path.join(f.dir, `optional-${i}.sqlite`));
		await Promise.all(paths.map((file) => writeFile(file, file)));
		const engine = createEngine({ ...f.config, selection: { paths, sqlite } }, f.options);
		await engine.initialize();
		await engine.acquireRestore();
		await engine.checkpoint();
		await engine.release();
		const { head, manifest } = await savedManifest(f);
		expect(manifest.members).toHaveLength(300);
		expect(manifest.selection.paths).toHaveLength(300);
		expect(manifest.selection.sqlite).toHaveLength(300);
		expect(Object.keys(manifest.presence)).toHaveLength(309);
		expect(JSON.stringify(head.value).length).toBeLessThan(4096);
		const retained = path.join(f.dir, 'retained-custom');
		await mkdir(retained);
		await Promise.all(paths.map((file) => rename(file, path.join(retained, path.basename(file)))));
		await rename(path.join(f.dir, 'live'), path.join(f.dir, 'retained-live'));
		const replacement = createEngine({ ...f.config, selection: { paths, sqlite } }, f.options);
		await replacement.acquireRestore();
		for (const file of paths) expect(await readFile(file, 'utf8')).toBe(file);
		await replacement.release();
	}, 30_000); // Real 300-file capture/restore; the five-second unit default is too short.

	test('lets existing default and custom checkpoints gain additional selections without reinitialization', async () => {
		const f = await fixture();
		await writeFile(path.join(f.roots.work, 'original'), 'preserve-original');
		const original = f.engine();
		await original.initialize();
		await original.acquireRestore();
		await original.checkpoint();
		await original.release();
		expect((await savedManifest(f)).head.value.catalog).toBe(1);
		const extra = path.join(f.dir, 'extra');
		await mkdir(extra);
		await writeFile(path.join(extra, 'first'), 'newly-included');
		let config = {
			...f.config,
			selection: { paths: [path.join(extra, 'first')], sqlite: [] as string[] }
		};
		const firstAddition = createEngine(config, f.options);
		await firstAddition.acquireRestore();
		await firstAddition.checkpoint();
		await firstAddition.release();
		expect((await savedManifest(f)).head.value.catalog).toBe(2);
		const databasePath = path.join(extra, 'app.db');
		const db = new Database(databasePath);
		db.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('new-db')");
		db.close();
		config = { ...config, selection: { paths: [extra], sqlite: [databasePath] } };
		const secondAddition = createEngine(config, f.options);
		await secondAddition.acquireRestore();
		await secondAddition.checkpoint();
		await secondAddition.release();
		await rename(path.join(f.dir, 'live'), path.join(f.dir, 'retained-live'));
		await rename(extra, `${extra}-retained`);
		const replacement = createEngine(config, f.options);
		await replacement.acquireRestore();
		expect(await readFile(path.join(f.roots.work, 'original'), 'utf8')).toBe('preserve-original');
		expect(await readFile(path.join(extra, 'first'), 'utf8')).toBe('newly-included');
		const restored = new Database(databasePath, { readonly: true });
		expect(restored.query('SELECT value FROM marker').get()).toEqual({ value: 'new-db' });
		restored.close();
		await replacement.release();
	});

	test('cold restores a previous selection while admitting newly added missing paths', async () => {
		const f = await fixture();
		await writeFile(path.join(f.roots.work, 'original'), 'previous-checkpoint');
		const engine = f.engine();
		await engine.initialize();
		await engine.acquireRestore();
		await engine.checkpoint();
		await engine.release();
		await rename(path.join(f.dir, 'live'), path.join(f.dir, 'retained-live'));
		const config = {
			...f.config,
			selection: {
				paths: [path.join(f.dir, 'new-directory')],
				sqlite: [path.join(f.dir, 'new.sqlite')]
			}
		};
		const replacement = createEngine(config, f.options);
		await replacement.acquireRestore();
		expect(await readFile(path.join(f.roots.work, 'original'), 'utf8')).toBe('previous-checkpoint');
		await replacement.checkpoint();
		await replacement.release();
		expect((await savedManifest(f)).head.value.catalog).toBe(2);
	});

	test('rejects omissions and forged selection identity before claiming or restoring', async () => {
		const f = await fixture();
		const extra = path.join(f.dir, 'extra');
		await mkdir(extra);
		await writeFile(path.join(extra, 'note'), 'keep-me');
		const databasePath = path.join(f.dir, 'custom.sqlite');
		const db = new Database(databasePath);
		db.exec('CREATE TABLE marker(value TEXT)');
		db.close();
		const config = { ...f.config, selection: { paths: [extra], sqlite: [databasePath] } };
		const engine = createEngine(config, f.options);
		await engine.initialize();
		await engine.acquireRestore();
		await engine.checkpoint();
		await engine.release();
		await rename(path.join(f.dir, 'live'), path.join(f.dir, 'retained-live'));
		await rename(extra, `${extra}-retained`);
		await rename(databasePath, `${databasePath}-retained`);
		const before = await readFile(path.join(f.dir, 'backup/descriptor.json'), 'utf8');
		for (const selection of [
			{ paths: [], sqlite: [databasePath] },
			{ paths: [extra], sqlite: [] }
		]) {
			await expect(
				createEngine({ ...f.config, selection }, f.options).acquireRestore()
			).rejects.toThrow('does not cover');
			expect(await readFile(path.join(f.dir, 'backup/descriptor.json'), 'utf8')).toBe(before);
			expect(await stat(f.config.privateDir).catch(() => null)).toBeNull();
		}
		const { head } = await savedManifest(f);
		head.value.selectionHash = 'f'.repeat(64);
		await writeFile(path.join(f.dir, 'backup/descriptor.json'), JSON.stringify(head.value));
		await expect(createEngine(config, f.options).acquireRestore()).rejects.toThrow(
			'selection identity'
		);
		expect(await stat(extra).catch(() => null)).toBeNull();
	});

	test('rejects protected paths, destinations, transport credentials and inclusion of its own config', async () => {
		const f = await fixture();
		const store = createDirectoryStore(f.config.url);
		const secret = path.join(f.dir, 'secrets/transport');
		const includeFile = path.join(f.dir, 'settings/include.json');
		const runtimeDir = path.join(f.dir, 'runtime');
		for (const selected of [
			'/proc',
			'/dev/random',
			'/sys',
			f.config.privateDir,
			path.join(f.config.privateDir, 'receipt.json'),
			runtimeDir,
			path.join(runtimeDir, 'status'),
			path.join(f.dir, 'backup'),
			path.join(f.dir, 'backup/objects'),
			secret,
			path.dirname(secret),
			includeFile,
			path.dirname(includeFile),
			f.dir
		]) {
			for (const key of ['paths', 'sqlite'])
				expect(() =>
					createEngine(
						{ ...f.config, runtimeDir, includeFile, selection: { [key]: [selected] } },
						{ ...f.options, store: { ...store, privatePaths: [secret] } }
					)
				).toThrow('protected state');
		}
		expect(() =>
			createEngine({ ...f.config, includeFile: path.join(f.roots.work, 'include.json') }, f.options)
		).toThrow('protected state');
	});

	test('native coordination remains excluded while explicit native homes include plugin payloads', async () => {
		const f = await fixture();
		const cache = path.join(f.roots.home, '.codex/plugins/cache/plugin/skill.md');
		await mkdir(path.dirname(cache), { recursive: true });
		await writeFile(cache, 'persistent plugin payload');
		const transient = ['.codex/tmp', '.codex/.tmp', '.codex/locks', '.codex/thread-writer-locks'];
		for (const name of transient) {
			const folder = path.join(f.roots.home, name);
			await mkdir(folder, { recursive: true });
			await symlink(cache, path.join(folder, 'native-wrapper'));
			for (const key of ['paths', 'sqlite'])
				expect(() => createEngine({ ...f.config, selection: { [key]: [path.join(folder, 'native-wrapper')] } }, f.options)).toThrow('protected state');
		}
		const akmLock = path.join(f.roots.akmData, 'locks');
		await mkdir(akmLock);
		await symlink(cache, path.join(akmLock, 'process'));
		const config = { ...f.config, selection: { paths: [f.roots.home, f.roots.akmData] } };
		const engine = createEngine(config, f.options);
		await engine.initialize();
		await engine.acquireRestore();
		await engine.checkpoint();
		await engine.release();
		const { manifest } = await savedManifest(f);
		expect(manifest.members.map((member) => member.path)).toEqual(['.codex/plugins/cache/plugin/skill.md']);
		await rename(path.join(f.dir, 'live'), path.join(f.dir, 'retained-live'));
		const restored = createEngine(config, f.options);
		await restored.acquireRestore();
		expect(await readFile(cache, 'utf8')).toBe('persistent plugin payload');
		for (const name of transient) expect(await stat(path.join(f.roots.home, name)).catch(() => null)).toBeNull();
		expect(await stat(akmLock).catch(() => null)).toBeNull();
		await restored.release();
	});

	test('a deliberate home selection still excludes private engine and runtime state', async () => {
		const f = await fixture();
		const runtimeDir = path.join(f.roots.home, 'runtime');
		await mkdir(runtimeDir);
		await writeFile(path.join(runtimeDir, 'status'), 'never-capture');
		await mkdir(f.config.privateDir);
		const includeFile = path.join(f.config.privateDir, 'include.json');
		await writeFile(includeFile, JSON.stringify({ paths: [f.roots.home] }));
		await writeFile(path.join(f.roots.home, 'custom-file'), 'included');
		const engine = createEngine(
			{ ...f.config, runtimeDir, includeFile, selection: { paths: [f.roots.home] } },
			f.options
		);
		await engine.initialize();
		await engine.acquireRestore();
		await engine.checkpoint();
		await engine.release();
		const { manifest } = await savedManifest(f);
		expect(manifest.members.map((member) => member.path)).toEqual(['custom-file']);
	});

	test('still rejects unknown SQLite content, sidecar links and initialized database disappearance', async () => {
		const f = await fixture();
		const extra = path.join(f.dir, 'extra');
		await mkdir(extra);
		const file = path.join(extra, 'opaque-state');
		const db = new Database(file);
		db.exec('CREATE TABLE marker(value TEXT)');
		db.close();
		const unknown = createEngine({ ...f.config, selection: { paths: [extra] } }, f.options);
		await unknown.initialize();
		await expect(unknown.acquireRestore()).rejects.toThrow('uncataloged SQLite');
		const config = {
			...f.config,
			url: pathToFileURL(path.join(f.dir, 'cataloged-backup')).href,
			selection: { paths: [extra], sqlite: [file] }
		};
		const engine = createEngine(config, f.options);
		await engine.initialize();
		await engine.acquireRestore();
		await engine.checkpoint();
		await symlink(path.join(f.dir, 'outside-wal'), `${file}-wal`);
		await expect(engine.checkpoint()).rejects.toThrow('link');
		await rename(`${file}-wal`, `${file}-wal-retained`);
		await rename(file, `${file}-retained`);
		await expect(engine.checkpoint()).rejects.toThrow('initialized required SQLite');
		await engine.release();
	});

	test('rejects malformed custom SQLite and enforces ordinary-file and catalog budgets', async () => {
		const f = await fixture();
		const file = path.join(f.dir, 'invalid.sqlite');
		await writeFile(file, 'not a SQLite database');
		const engine = createEngine({ ...f.config, selection: { sqlite: [file] } }, f.options);
		await engine.initialize();
		await engine.acquireRestore();
		await expect(engine.checkpoint()).rejects.toThrow('snapshot/validation');
		await engine.release();
		expect(() =>
			createEngine(
				{ ...f.config, selection: { paths: [file] } },
				{ ...f.options, limits: { maxManifestBytes: 5 } }
			)
		).toThrow('manifest exceeds budget');
		const bounded = createEngine(
			{
				...f.config,
				url: pathToFileURL(path.join(f.dir, 'bounded-backup')).href,
				selection: { paths: [path.join(f.dir, 'oversized-file')] }
			},
			{ ...f.options, limits: { maxFileBytes: 5 } }
		);
		// A separate namespace avoids intentionally narrowing an accepted selection.
		await writeFile(path.join(f.dir, 'oversized-file'), 'too-large');
		await bounded.initialize();
		await expect(bounded.acquireRestore()).rejects.toThrow('member exceeds budget');
	});

	test('does not publish a file that changes into unregistered SQLite after inventory', async () => {
		const f = await fixture();
		const original = path.join(f.roots.work, 'b-state');
		await writeFile(path.join(f.roots.work, 'a-note'), 'first');
		await writeFile(original, 'ordinary-file');
		const source = path.join(f.dir, 'generated-sqlite');
		const db = new Database(source);
		db.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('new-database')");
		db.close();
		const store = createDirectoryStore(f.config.url);
		let changed = false;
		const engine = createEngine(f.config, {
			...f.options,
			store: {
				...store,
				async createImmutable(...args) {
					if (!changed && args[0].startsWith('objects/')) {
						changed = true;
						await rename(original, `${original}-retained`);
						await copyFile(source, original);
					}
					return store.createImmutable(...args);
				}
			}
		});
		await engine.initialize();
		await engine.acquireRestore();
		await expect(engine.checkpoint()).rejects.toThrow('uncataloged SQLite');
		expect((await store.readDescriptor())?.value.generation).toBeNull();
		await engine.release();
	});

	test('derives external roots from selections and rejects duplicate physical restore targets', async () => {
		const f = await fixture();
		const extra = path.join(f.dir, 'extra');
		await mkdir(path.join(extra, 'nested'), { recursive: true });
		await writeFile(path.join(extra, 'nested/note'), 'one-target');
		const config = { ...f.config, selection: { paths: [extra, path.join(extra, 'nested')] } };
		const engine = createEngine(config, f.options);
		await engine.initialize();
		await engine.acquireRestore();
		await engine.checkpoint();
		await engine.release();
		const { head, manifest } = await savedManifest(f);
		const catalog = createCatalog(f.roots, config.selection, {
			privateDir: f.config.privateDir,
			store: createDirectoryStore(f.config.url)
		});
		const alias = catalog.trees.find(
			([root, name]) => catalog.native(root, name) === path.join(extra, 'nested')
		);
		if (!alias) throw new Error('fixture has no expected alias');
		manifest.members.push({ ...manifest.members[0], root: alias[0], path: `${alias[1]}/note` });
		const bytes = Buffer.from(JSON.stringify(manifest));
		const generation = createHash('sha256').update(bytes).digest('hex');
		await writeFile(path.join(f.dir, 'backup/manifests', generation), bytes);
		head.value.generation = generation;
		await writeFile(path.join(f.dir, 'backup/descriptor.json'), JSON.stringify(head.value));
		await rename(path.join(f.dir, 'live'), path.join(f.dir, 'retained-live'));
		await rename(extra, `${extra}-retained`);
		await expect(createEngine(config, f.options).acquireRestore()).rejects.toThrow(
			'member rejected'
		);
		expect(await stat(extra).catch(() => null)).toBeNull();
		expect((await createDirectoryStore(f.config.url).readDescriptor())?.value).toEqual(head.value);
		expect(await stat(path.join(f.dir, 'backup/owner/nonce')).catch(() => null)).toBeNull();
	});
});

describe('same-instance local recovery engine', () => {
	test('late startup deadline releases ownership and never reports ready', async () => {
		const f = await fixture();
		const store = createDirectoryStore(f.config.url);
		const engine = createEngine(f.config, {
			...f.options,
			limits: { operationTimeoutMs: 100 },
			store: {
				...store,
				async claim(...args) {
					const result = await store.claim(...args);
					await new Promise((resolve) => setTimeout(resolve, 150));
					return result;
				}
			}
		});
		await engine.initialize();
		await expect(engine.acquireRestore()).rejects.toThrow('deadline');
		expect(engine.status().ready).toBe(false);
		expect(engine.status().owned).toBe(false);
		const retry = f.engine();
		await retry.acquireRestore();
		await retry.release();
	});
	test('deadline after successful startup work still revokes readiness and releases owner', async () => {
		const f = await fixture();
		const engine = createEngine(f.config, { ...f.options, limits: { operationTimeoutMs: 100 } });
		await engine.initialize();
		const monotonic = spyOn(performance, 'now').mockImplementation(() =>
			engine.status().ready ? 200 : 0
		);
		try {
			await expect(engine.acquireRestore()).rejects.toThrow('deadline');
			expect(engine.status().ready).toBe(false);
			expect(engine.status().owned).toBe(false);
		} finally {
			monotonic.mockRestore();
		}
		const retry = f.engine();
		await retry.acquireRestore();
		await retry.release();
	});
	test('default SQLite deadline is finite and transport credential paths cannot enter captures', async () => {
		const f = await fixture();
		expect(() =>
			createEngine({ ...f.config, privateDir: `${f.roots.home}/../../live/work` }, f.options)
		).toThrow('private recovery path');
		expect(() =>
			createEngine(f.config, {
				...f.options,
				roots: { ...f.roots, work: `${f.roots.work}/../work` }
			})
		).toThrow('native recovery root');
		expect(DEFAULT_LIMITS.sqliteTimeoutMs).toBe(120000);
		const store = createDirectoryStore(f.config.url);
		for (const secret of [
			path.join(f.roots.work, 'credentials'),
			path.join(f.roots.stash, 'credentials'),
			path.join(f.roots.home, '.config/opencode/credentials'),
			`${f.dir}/other/../live/work/credentials`,
			path.join(f.dir, 'live')
		])
			expect(() =>
				createEngine(f.config, { ...f.options, store: { ...store, privatePaths: [secret] } })
			).toThrow('secret overlaps');
		for (const secret of [
			'/run/secrets/fhold-recovery',
			path.join(f.config.privateDir, 'credentials')
		])
			expect(() =>
				createEngine(f.config, { ...f.options, store: { ...store, privatePaths: [secret] } })
			).not.toThrow();
	});
	test('Blob destination parser refuses secret and normalized path aliases', () => {
		expect(parseBlobDestination('azblob://devstoreaccount1/recovery-test/native')).toEqual({
			account: 'devstoreaccount1',
			container: 'recovery-test',
			prefix: 'native/'
		});
		for (const url of [
			'azblob://account/container?sig=synthetic',
			'azblob://user:secret@account/container',
			'azblob://account/container/prefix/../escape',
			'azblob://account/container/%2e%2e',
			'azblob://Account/container',
			'https://account.blob.core.windows.net/container'
		])
			expect(() => parseBlobDestination(url)).toThrow();
	});
	test('pinned Codex 0.160.0 catalog preserves all six native SQLite files and identity', async () => {
		const f = await fixture();
		const codex = path.join(f.roots.home, '.codex');
		await mkdir(path.join(codex, '.tmp'), { recursive: true });
		await symlink('/synthetic/generated-target', path.join(codex, '.tmp/generated-link'));
		for (const name of [
			'state_5.sqlite',
			'logs_2.sqlite',
			'goals_1.sqlite',
			'thread_history_1.sqlite',
			'memories_1.sqlite',
			'queue_1.sqlite'
		]) {
			const database = new Database(path.join(codex, name));
			database.exec(
				'PRAGMA journal_mode=WAL; CREATE TABLE marker(id INTEGER PRIMARY KEY, value TEXT)'
			);
			database.query('INSERT INTO marker(value) VALUES(?)').run(name);
			database.close();
		}
		for (const name of ['installation_id', '.sandbox_migration', 'hooks.json', 'auth.json'])
			await writeFile(path.join(codex, name), `synthetic-${name}`);
		const engine = f.engine();
		await engine.initialize();
		await engine.acquireRestore();
		await engine.checkpoint();
		await engine.release();
		await rm(path.join(f.dir, 'live'), { recursive: true });
		const replacement = f.engine();
		await replacement.acquireRestore();
		for (const name of [
			'state_5.sqlite',
			'logs_2.sqlite',
			'goals_1.sqlite',
			'thread_history_1.sqlite',
			'memories_1.sqlite',
			'queue_1.sqlite'
		]) {
			const database = new Database(path.join(codex, name), { readonly: true });
			expect(database.query('SELECT value FROM marker').get()).toEqual({ value: name });
			database.close();
		}
		for (const name of ['installation_id', '.sandbox_migration', 'hooks.json', 'auth.json'])
			expect(await readFile(path.join(codex, name), 'utf8')).toBe(`synthetic-${name}`);
		await replacement.release();
	});
	for (const includeHome of [false, true]) test(`preserves existing native control metadata and excludes live sockets (whole-home selection: ${includeHome})`, async () => {
		const f = await fixture();
		const config = { ...f.config, ...(includeHome ? { selection: { paths: [f.roots.home], sqlite: [] } } : {}) };
		const control = path.join(f.roots.home, '.codex/app-server-control');
		await mkdir(control, { recursive: true });
		await writeFile(path.join(control, 'app-server-startup.lock'), '');
		await writeFile(path.join(f.roots.home, '.codex/auth.json'), 'synthetic native account');
		const previous = createEngine(config, f.options);
		await previous.initialize(); await previous.acquireRestore(); await previous.checkpoint(); await previous.release();
		// Earlier native checkpoints contain a regular startup lock, never a live
		// socket. Restoring that format must still work before any writer starts.
		await rm(path.join(f.dir, 'live'), { recursive: true });
		const engine = createEngine(config, f.options); await engine.acquireRestore();
		expect(await readFile(path.join(control, 'app-server-startup.lock'), 'utf8')).toBe('');
		const server = createServer();
		await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path.join(control, 'app-server-control.sock'), resolve); });
		try {
			await engine.checkpoint(); await engine.release();
			const { manifest } = await savedManifest(f);
			expect(manifest.members.some((file: { path: string }) => file.path.endsWith('app-server-control.sock'))).toBe(false);
			expect(manifest.members.some((file: { path: string }) => file.path.endsWith('app-server-startup.lock'))).toBe(true);
		} finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
		await rm(path.join(f.dir, 'live'), { recursive: true });
		const restored = createEngine(config, f.options); await restored.acquireRestore();
		expect(await readFile(path.join(f.roots.home, '.codex/auth.json'), 'utf8')).toBe('synthetic native account');
		expect(await readFile(path.join(control, 'app-server-startup.lock'), 'utf8')).toBe('');
		expect(await stat(path.join(control, 'app-server-control.sock')).catch(() => null)).toBeNull();
		await restored.release();
	});
	test('excludes only the pinned generated OpenCode dependency tree', async () => {
		const f = await fixture();
		const configRoot = path.join(f.roots.home, '.config/opencode');
		await mkdir(path.join(configRoot, 'node_modules/.bin'), { recursive: true });
		await symlink('../../uuid/bin/uuid', path.join(configRoot, 'node_modules/.bin/uuid'));
		await writeFile(path.join(configRoot, 'opencode.json'), '{"model":"synthetic/provider"}');
		await mkdir(path.join(f.roots.home, '.local/share/opencode'), { recursive: true });
		await writeFile(
			path.join(f.roots.home, '.local/share/opencode/auth.json'),
			'{"fixture":"synthetic"}'
		);
		await mkdir(path.join(f.roots.work, 'node_modules'), { recursive: true });
		await writeFile(path.join(f.roots.work, 'node_modules/operator-file'), 'user-owned');
		const engine = f.engine();
		await engine.initialize();
		await engine.acquireRestore();
		await engine.checkpoint();
		await engine.release();
		await rm(path.join(f.dir, 'live'), { recursive: true });
		const replacement = f.engine();
		await replacement.acquireRestore();
		expect(await readFile(path.join(configRoot, 'opencode.json'), 'utf8')).toContain(
			'synthetic/provider'
		);
		expect(
			await readFile(path.join(f.roots.home, '.local/share/opencode/auth.json'), 'utf8')
		).toContain('synthetic');
		expect(await readFile(path.join(f.roots.work, 'node_modules/operator-file'), 'utf8')).toBe(
			'user-owned'
		);
		expect(await stat(path.join(configRoot, 'node_modules')).catch(() => null)).toBeNull();
		await replacement.release();
	});
	test('paused owner is never timed out; confirmed break fences its stale publisher', async () => {
		const f = await fixture();
		await writeFile(path.join(f.roots.work, 'note'), 'checkpoint');
		const first = f.engine();
		await first.initialize();
		await first.acquireRestore();
		await first.checkpoint();
		const second = f.engine();
		await expect(second.acquireRestore()).rejects.toThrow('owner exists');
		const store = createDirectoryStore(f.config.url);
		const descriptor = await store.readDescriptor();
		await expect(store.breakOwnership(descriptor.value.owner, f.config.instanceId)).rejects.toThrow(
			'confirmed'
		);
		await expect(
			store.breakOwnership(descriptor.value.owner, 'different-instance', { confirmedStopped: true })
		).rejects.toThrow('mismatch');
		// Synthetic operator confirms the fixture has no running native writers.
		await store.breakOwnership(descriptor.value.owner, f.config.instanceId, {
			confirmedStopped: true
		});
		await expect(first.checkpoint()).rejects.toThrow();
		await second.acquireRestore();
		expect(second.status().ready).toBe(true);
		await second.release();
	});
	test('preserves WAL commits, private auth, executable files, repo state and deletions after replacement', async () => {
		const f = await fixture();
		const db = new Database(path.join(f.roots.akmData, 'state.db'));
		db.exec(
			"PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO records(value) VALUES ('wal-marker')"
		);
		await mkdir(path.join(f.roots.home, '.local/share/opencode'), { recursive: true });
		await writeFile(
			path.join(f.roots.home, '.local/share/opencode/auth.json'),
			'{"synthetic":"not-a-secret"}'
		);
		await mkdir(path.join(f.roots.work, '.git'), { recursive: true });
		await writeFile(path.join(f.roots.work, '.git/HEAD'), 'ref: refs/heads/main');
		await writeFile(path.join(f.roots.work, 'script.sh'), '#!/bin/sh\nexit 0\n');
		await chmod(path.join(f.roots.work, 'script.sh'), 0o700);
		await writeFile(path.join(f.roots.work, 'dependency.lock'), 'preserved');
		await writeFile(path.join(f.roots.stash, 'deleted.txt'), 'delete-before-checkpoint');
		const engine = f.engine();
		await engine.initialize();
		await engine.acquireRestore();
		await engine.checkpoint();
		await rm(path.join(f.roots.stash, 'deleted.txt'));
		await engine.checkpoint();
		await engine.release();
		db.close();
		// Only this generated disposable fixture is replaced.
		await rm(path.join(f.dir, 'live'), { recursive: true });
		const replacement = f.engine();
		await replacement.acquireRestore();
		const restored = new Database(path.join(f.roots.akmData, 'state.db'), { readonly: true });
		expect(restored.query('SELECT value FROM records').get()).toEqual({ value: 'wal-marker' });
		restored.close();
		expect(
			await readFile(path.join(f.roots.home, '.local/share/opencode/auth.json'), 'utf8')
		).toContain('not-a-secret');
		expect((await stat(path.join(f.roots.work, 'script.sh'))).mode & 0o700).toBe(0o700);
		expect(await readFile(path.join(f.roots.work, '.git/HEAD'), 'utf8')).toContain('main');
		expect(await readFile(path.join(f.roots.work, 'dependency.lock'), 'utf8')).toBe('preserved');
		expect(await stat(path.join(f.roots.stash, 'deleted.txt')).catch(() => null)).toBeNull();
		await replacement.release();
	});
	test('surviving local state is newer and must not be overwritten', async () => {
		const f = await fixture();
		await writeFile(path.join(f.roots.work, 'note.txt'), 'old');
		const first = f.engine();
		await first.initialize();
		await first.acquireRestore();
		await first.checkpoint();
		await writeFile(path.join(f.roots.work, 'note.txt'), 'newer unsaved');
		await first.release();
		const second = f.engine();
		await second.acquireRestore();
		expect(await readFile(path.join(f.roots.work, 'note.txt'), 'utf8')).toBe('newer unsaved');
		await second.release();
	});
	test('receipted mixed storage restores missing files/databases and preserves newer surviving state', async () => {
		const f = await fixture();
		const ephemeral = path.join(f.dir, 'ephemeral');
		await mkdir(ephemeral);
		const extraDatabase = path.join(ephemeral, 'client.sqlite');
		const durableDatabase = path.join(f.roots.akmData, 'state.db');
		for (const file of [extraDatabase, durableDatabase]) {
			const db = new Database(file);
			db.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('checkpoint')");
			db.close();
		}
		await writeFile(path.join(ephemeral, 'settings.json'), 'restore this missing account-style file');
		await writeFile(path.join(f.roots.work, 'note.txt'), 'checkpoint');
		const config = { ...f.config, selection: { paths: [ephemeral], sqlite: [extraDatabase] } };
		const first = createEngine(config, f.options);
		await first.initialize(); await first.acquireRestore(); await first.checkpoint(); await first.release();
		const newer = new Database(durableDatabase);
		newer.exec("INSERT INTO marker VALUES('newer local commit')"); newer.close();
		await writeFile(path.join(f.roots.work, 'note.txt'), 'newer local text');
		const durableBytes = await readFile(durableDatabase);
		// Only the generated ephemeral portion disappears; native data and the exact receipt survive.
		await rm(ephemeral, { recursive: true });
		const replacement = createEngine(config, f.options);
		await replacement.acquireRestore();
		expect(await readFile(path.join(ephemeral, 'settings.json'), 'utf8')).toBe('restore this missing account-style file');
		expect(await readFile(durableDatabase)).toEqual(durableBytes);
		expect(await readFile(path.join(f.roots.work, 'note.txt'), 'utf8')).toBe('newer local text');
		const restored = new Database(extraDatabase, { readonly: true });
		expect(restored.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
		expect(restored.query('SELECT value FROM marker').get()).toEqual({ value: 'checkpoint' });
		restored.close();
		await replacement.checkpoint(); await replacement.release();
		const { manifest } = await savedManifest(f);
		expect(Object.values(manifest.presence).filter(Boolean)).toHaveLength(2);
	});
	for (const failure of ['unreceipted', 'orphaned SQLite sidecar', 'corrupt object'])
		test(`mixed-storage restore refuses ${failure} before filling any missing target`, async () => {
			const f = await fixture();
			const ephemeral = path.join(f.dir, 'ephemeral'); await mkdir(ephemeral);
			const extraDatabase = path.join(ephemeral, 'client.sqlite');
			const db = new Database(extraDatabase); db.exec('CREATE TABLE marker(value TEXT)'); db.close();
			await writeFile(path.join(ephemeral, 'settings.json'), 'checkpoint');
			await writeFile(path.join(f.roots.work, 'note.txt'), 'checkpoint');
			const config = { ...f.config, selection: { paths: [ephemeral], sqlite: [extraDatabase] } };
			const first = createEngine(config, f.options);
			await first.initialize(); await first.acquireRestore(); await first.checkpoint(); await first.release();
			await rm(ephemeral, { recursive: true });
			await writeFile(path.join(f.roots.work, 'note.txt'), 'keep newer surviving content');
			if (failure === 'unreceipted') await rm(f.config.privateDir, { recursive: true });
			else if (failure === 'orphaned SQLite sidecar') {
				await mkdir(ephemeral); await writeFile(`${extraDatabase}-wal`, 'unresolved local WAL');
			} else {
				const { manifest } = await savedManifest(f);
				const member = manifest.members.find((member: { path: string }) => member.path.endsWith('settings.json'));
				await writeFile(path.join(f.dir, 'backup/objects', member.hash), 'corrupted');
			}
			const replacement = createEngine(config, f.options);
			await expect(replacement.acquireRestore()).rejects.toThrow(failure === 'unreceipted' ? 'unreceipted' : failure === 'orphaned SQLite sidecar' ? 'SQLite input type' : 'checksum');
			expect(await stat(extraDatabase).catch(() => null)).toBeNull();
			expect(await stat(path.join(ephemeral, 'settings.json')).catch(() => null)).toBeNull();
			expect(await readFile(path.join(f.roots.work, 'note.txt'), 'utf8')).toBe('keep newer surviving content');
			expect(replacement.status().ready).toBe(false);
		});
	test('initialized database disappearance fails closed', async () => {
		const f = await fixture();
		const db = new Database(path.join(f.roots.akmData, 'state.db'));
		db.exec('CREATE TABLE records(id INTEGER PRIMARY KEY)');
		db.close();
		const engine = f.engine();
		await engine.initialize();
		await engine.acquireRestore();
		await engine.checkpoint();
		await rm(path.join(f.roots.akmData, 'state.db'));
		await expect(engine.checkpoint()).rejects.toThrow('disappeared');
		await engine.release();
	});
	test('unknown databases, links and invalid instance IDs are rejected', async () => {
		const f = await fixture();
		expect(() => createEngine({ ...f.config, instanceId: '../escape' }, f.options)).toThrow(
			'identity'
		);
		const engine = f.engine();
		await engine.initialize();
		await engine.acquireRestore();
		await symlink('/etc/passwd', path.join(f.roots.work, 'escape'));
		await expect(engine.checkpoint()).rejects.toThrow('link');
		await rm(path.join(f.roots.work, 'escape'));
		const db = new Database(path.join(f.roots.work, 'arbitrary.data'));
		db.exec('CREATE TABLE records(id INTEGER PRIMARY KEY)');
		db.close();
		await expect(engine.checkpoint()).rejects.toThrow('uncataloged');
		await engine.release();
	});
	test('publication failure retains previously accepted generation', async () => {
		const f = await fixture();
		await writeFile(path.join(f.roots.work, 'note'), 'first');
		const engine = f.engine();
		await engine.initialize();
		await engine.acquireRestore();
		await engine.checkpoint();
		const original = engine.status().generation;
		await writeFile(path.join(f.roots.work, 'note'), 'second');
		await mkdir(path.join(f.dir, 'backup/descriptor-mutation'));
		await expect(engine.checkpoint()).rejects.toThrow('busy');
		expect(
			JSON.parse(await readFile(path.join(f.dir, 'backup/descriptor.json'), 'utf8')).generation
		).toBe(original);
		await rm(path.join(f.dir, 'backup/descriptor-mutation'), { recursive: true });
		await engine.release();
	});
	test('bounded SQLite subprocess rejects a busy source without publishing', async () => {
		const f = await fixture();
		const db = new Database(path.join(f.roots.akmData, 'state.db'));
		db.exec('CREATE TABLE records(id INTEGER PRIMARY KEY); INSERT INTO records VALUES(1)');
		const engine = createEngine(f.config, { ...f.options, limits: { sqliteTimeoutMs: 30 } });
		await engine.initialize();
		await engine.acquireRestore();
		db.exec('BEGIN EXCLUSIVE; INSERT INTO records VALUES(2)');
		await expect(engine.checkpoint()).rejects.toThrow('deadline');
		expect(engine.status().generation).toBeNull();
		db.exec('ROLLBACK');
		expect(db.query('SELECT COUNT(*) as count FROM records').get()).toEqual({ count: 1 });
		db.close();
		await engine.release();
	});
});

// Fault-injection unit evidence only. Real SDK constructors still parse the
// disposable synthetic account; a scoped client-method spy prevents any network.
async function blobFaultFixture() {
	const dir = await mkdtemp('/tmp/fhold-blob-fault-test-');
	const credential = path.join(dir, 'credential');
	await writeFile(
		credential,
		'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Zml4dHVyZS1rZXk=;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;',
		{ mode: 0o600 }
	);
	let value = { instanceId: 'fault-fixture', owner: null, epoch: 0, generation: null };
	let token = 1;
	let failRead = false;
	let unknownUpload = false;
	let alreadyAborted = false;
	let uploads = 0;
	let renewals = 0;
	const client = {
		async download() {
			if (failRead) throw { statusCode: 500 };
			if (alreadyAborted) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return {
					contentLength: 1,
					etag: String(token),
					readableStreamBody: new Readable({ read() {} })
				};
			}
			const bytes = Buffer.from(JSON.stringify(value));
			return {
				contentLength: bytes.length,
				etag: String(token),
				readableStreamBody: Readable.from([bytes])
			};
		},
		async upload(bytes, _length, options) {
			if (options.conditions.ifMatch !== String(token)) throw { statusCode: 412 };
			uploads++;
			value = JSON.parse(bytes.toString());
			token++;
			if (unknownUpload) {
				unknownUpload = false;
				throw { name: 'AbortError' };
			}
		},
		getBlobLeaseClient() {
			return {
				async acquireLease() {},
				async renewLease() {
					renewals++;
				},
				async releaseLease() {}
			};
		}
	};
	const require = createRequire(
		new URL('../containers/assistant/tools/package.json', import.meta.url)
	);
	const { BlobServiceClient } = require('@azure/storage-blob');
	const spy = spyOn(BlobServiceClient.prototype, 'getContainerClient').mockImplementation(() => ({
		getBlockBlobClient: () => client
	}));
	const create = (operationTimeoutMs = 10000) =>
		createBlobStore('azblob://devstoreaccount1/fault-fixture', {
			env: { FH_RECOVERY_CREDENTIAL_FILE: credential, FH_RECOVERY_ALLOW_INSECURE: '1' },
			operationTimeoutMs
		});
	return {
		create,
		restore: () => spy.mockRestore(),
		value: () => value,
		uploads: () => uploads,
		renewals: () => renewals,
		failRead: (enabled) => {
			failRead = enabled;
		},
		unknownUpload: () => {
			unknownUpload = true;
		},
		alreadyAborted: () => {
			alreadyAborted = true;
		}
	};
}

describe('Blob ownership fault regressions (no-network unit evidence)', () => {
	test('a paused owner crossing its monotonic safety window cannot publish, clear HEAD or reacquire', async () => {
		const fixture = await blobFaultFixture();
		let now = 0;
		const monotonic = spyOn(performance, 'now').mockImplementation(() => now);
		try {
			const store = await fixture.create();
			const owner = await store.acquire();
			let head = await store.readDescriptor();
			head = await store.claim(head.token, owner);
			now = 45001;
			await expect(
				store.compareAndSwap(head.token, { ...head.value, generation: 'stale' }, owner)
			).rejects.toThrow('ownership lost');
			await expect(store.release(owner)).rejects.toThrow('ownership lost');
			expect(fixture.value().owner).toBe(owner.nonce);
			expect(fixture.uploads()).toBe(1);
			const replacement = await fixture.create();
			await expect(replacement.acquire()).rejects.toThrow('no automatic takeover');
		} finally {
			monotonic.mockRestore();
			fixture.restore();
		}
	});
	test('wrong owner does not poison the valid owner and unknown-success CAS is reconciled', async () => {
		const fixture = await blobFaultFixture();
		let store: Awaited<ReturnType<typeof createBlobStore>> | undefined;
		let owner: { nonce: string } | undefined;
		try {
			store = await fixture.create();
			owner = await store.acquire();
			let head = await store.readDescriptor();
			head = await store.claim(head.token, owner);
			await expect(store.renew({ nonce: 'not-the-owner' })).rejects.toThrow('ownership lost');
			await expect(store.renew(owner)).resolves.toEqual(owner);
			fixture.unknownUpload();
			const accepted = await store.compareAndSwap(
				head.token,
				{ ...head.value, generation: 'synthetic-generation' },
				owner
			);
			expect(accepted.value.generation).toBe('synthetic-generation');
			expect(fixture.uploads()).toBe(2);
		} finally {
			if (store && owner) await store.release(owner);
			fixture.restore();
		}
	});
	test('failed release stops own renewal and expired owners cannot publish or clear HEAD', async () => {
		const fixture = await blobFaultFixture();
		let store: Awaited<ReturnType<typeof createBlobStore>> | undefined;
		let owner: { nonce: string } | undefined;
		try {
			store = await fixture.create();
			owner = await store.acquire();
			const head = await store.readDescriptor();
			await store.claim(head.token, owner);
			fixture.failRead(true);
			await expect(store.release(owner)).rejects.toThrow('unavailable');
			fixture.failRead(false);
			await expect(store.renew(owner)).rejects.toThrow('ownership lost');
			expect(fixture.value().owner).toBe(owner.nonce);
			expect(fixture.uploads()).toBe(1);
		} finally {
			fixture.restore();
		}
	});
	test('an already-aborted download signal destroys an otherwise hanging body', async () => {
		const fixture = await blobFaultFixture();
		try {
			const store = await fixture.create(1);
			fixture.alreadyAborted();
			await expect(store.readDescriptor()).rejects.toThrow('deadline');
		} finally {
			fixture.restore();
		}
	}, 1000);
});

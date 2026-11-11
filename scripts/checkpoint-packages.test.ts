import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createEngine } from '../containers/assistant/recovery/engine.mjs';
import { createDirectoryStore } from '../containers/assistant/recovery/directory-store.mjs';

async function fixture() {
	const dir = await fs.mkdtemp('/tmp/fhold-checkpoint-package-test-');
	async function target(name: string) {
		const roots = Object.fromEntries(
			['home', 'stash', 'work', 'akmData', 'akmConfig'].map((root) => [
				root,
				path.join(dir, name, root)
			])
		);
		await Promise.all(Object.values(roots).map((root) => fs.mkdir(root, { recursive: true })));
		const config = {
			url: pathToFileURL(path.join(dir, name, 'backup')).href,
			instanceId: 'same-assistant',
			privateDir: path.join(roots.home, '.fhold-recovery')
		};
		const options = { roots, bunPath: process.execPath };
		return {
			roots,
			config,
			options,
			store: createDirectoryStore(config.url),
			engine: () => createEngine(config, options)
		};
	}
	return { dir, target, packagePath: path.join(dir, 'package') };
}

describe('Assistant checkpoint packages', () => {
	test('packages a live accepted WAL snapshot without source ownership changes and restores through the native engine', async () => {
		const f = await fixture();
		const source = await f.target('source');
		const target = await f.target('target');
		const native = path.join(source.roots.home, '.local/share/opencode/opencode.db');
		await fs.mkdir(path.dirname(native), { recursive: true });
		const db = new Database(native);
		db.exec(
			"PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE messages(value TEXT); INSERT INTO messages VALUES ('accepted')"
		);
		const engine = source.engine();
		try {
			await engine.initialize();
			await engine.acquireRestore();
			await engine.checkpoint();
			const before = await source.store.readDescriptor();
			const owner = await fs.readFile(path.join(f.dir, 'source/backup/owner/nonce'), 'utf8');
			const plan = await engine.exportPackage(f.packagePath);
			await expect(
				engine.importPackage(f.packagePath, {
					confirmedStopped: true,
					previewDigest: plan.previewDigest
				})
			).rejects.toThrow('idle unowned');
			expect(await source.store.readDescriptor()).toEqual(before);
			expect(await fs.readFile(path.join(f.dir, 'source/backup/owner/nonce'), 'utf8')).toBe(owner);
			expect((await fs.readdir(f.packagePath)).sort()).toEqual(['checkpoint.json', 'manifests', 'objects']);
			const completion = JSON.parse(
				await fs.readFile(path.join(f.packagePath, 'checkpoint.json'), 'utf8')
			);
			expect(completion.descriptor).toMatchObject({ owner: null, epoch: 0 });
			expect(JSON.stringify(completion)).not.toContain(owner);
			db.exec("INSERT INTO messages VALUES ('after export')");
			await engine.checkpoint();
			const restoring = target.engine();
			const preview = await restoring.previewPackage(f.packagePath);
			expect(preview.previewDigest).toBe(plan.previewDigest);
			await restoring.importPackage(f.packagePath, {
				confirmedStopped: true,
				previewDigest: plan.previewDigest
			});
			const restored = new Database(
				path.join(target.roots.home, '.local/share/opencode/opencode.db'),
				{ readonly: true }
			);
			try {
				expect(restored.query('SELECT value FROM messages').all()).toEqual([{ value: 'accepted' }]);
			} finally {
				restored.close();
			}
			expect((await target.store.readDescriptor()).value.owner).not.toBe(owner);
			expect(await fs.lstat(path.join(f.dir, 'target/backup/owner')).catch(() => null)).toBeNull();
			expect(
				JSON.parse(await fs.readFile(path.join(target.config.privateDir, 'receipt.json'), 'utf8'))
					.generation
			).toBe(plan.generation);
			expect((await source.store.readDescriptor()).value.owner).toBe(before.value.owner);
		} finally {
			db.close();
			await engine.release();
			await fs.rm(f.dir, { recursive: true });
		}
	});

	test('rejects corrupt, changed and populated-target imports before creating destination authority', async () => {
		const f = await fixture();
		const source = await f.target('source');
		const target = await f.target('target');
		const engine = source.engine();
		try {
			await fs.writeFile(path.join(source.roots.work, 'note'), 'private content');
			await engine.initialize();
			await engine.acquireRestore();
			await engine.checkpoint();
			const plan = await engine.exportPackage(f.packagePath);
			const restoring = target.engine();
			await expect(
				restoring.importPackage(f.packagePath, { confirmedStopped: true, previewDigest: 'stale' })
			).rejects.toThrow('preview');
			expect(await target.store.readDescriptor()).toBeNull();
			await fs.writeFile(path.join(target.roots.work, 'survivor'), 'keep');
			await expect(
				restoring.importPackage(f.packagePath, {
					confirmedStopped: true,
					previewDigest: plan.previewDigest
				})
			).rejects.toThrow('empty native');
			expect(await target.store.readDescriptor()).toBeNull();
			const hash = createHash('sha256').update('private content').digest('hex');
			await fs.writeFile(path.join(f.packagePath, 'objects', hash), 'corruption');
			await expect(restoring.previewPackage(f.packagePath)).rejects.toThrow('checksum');
			expect(await fs.readFile(path.join(target.roots.work, 'survivor'), 'utf8')).toBe('keep');
			expect(await target.store.readDescriptor()).toBeNull();
		} finally {
			await engine.release();
			await fs.rm(f.dir, { recursive: true });
		}
	});

	test('an interrupted export has no completion record and leaves the accepted source unchanged', async () => {
		const f = await fixture();
		const source = await f.target('source');
		const engine = source.engine();
		try {
			await fs.writeFile(path.join(source.roots.work, 'note'), 'content');
			await engine.initialize();
			await engine.acquireRestore();
			await engine.checkpoint();
			const before = await source.store.readDescriptor();
			const store = {
				...source.store,
				read: async (key: string, limit: number) => {
					if (key.startsWith('objects/'))
						throw Object.assign(new Error('interrupted transfer'), { code: 'EIO' });
					return source.store.read(key, limit);
				}
			};
			const exporter = createEngine(source.config, { ...source.options, store });
			await expect(exporter.exportPackage(f.packagePath)).rejects.toThrow('interrupted');
			expect(
				await fs.lstat(path.join(f.packagePath, 'checkpoint.json')).catch(() => null)
			).toBeNull();
			expect(await source.store.readDescriptor()).toEqual(before);
		} finally {
			await engine.release();
			await fs.rm(f.dir, { recursive: true });
		}
	});

	test('does not accept copied owner authority, wrong identities or a package overlapping live state', async () => {
		const f = await fixture();
		const source = await f.target('source');
		const engine = source.engine();
		try {
			await engine.initialize();
			await engine.acquireRestore();
			await engine.checkpoint();
			await expect(engine.exportPackage(path.join(source.roots.work, 'package'))).rejects.toThrow(
				'separate'
			);
			await engine.exportPackage(f.packagePath);
			const file = path.join(f.packagePath, 'checkpoint.json');
			const metadata = JSON.parse(await fs.readFile(file, 'utf8'));
			metadata.descriptor.owner = 'copied owner';
			await fs.writeFile(file, JSON.stringify(metadata));
			await expect(engine.previewPackage(f.packagePath)).rejects.toThrow('format');
			metadata.descriptor.owner = null;
			metadata.descriptor.instanceId = 'different-assistant';
			await fs.writeFile(file, JSON.stringify(metadata));
			await expect(engine.previewPackage(f.packagePath)).rejects.toThrow('identity');
		} finally {
			await engine.release();
			await fs.rm(f.dir, { recursive: true });
		}
	});
	test('interrupted import leaves native roots untouched and releases only its newly acquired ownership', async () => {
		const f = await fixture(),
			source = await f.target('source'),
			target = await f.target('target');
		const engine = source.engine();
		try {
			await fs.writeFile(path.join(source.roots.work, 'note'), 'accepted');
			await engine.initialize();
			await engine.acquireRestore();
			await engine.checkpoint();
			const plan = await engine.exportPackage(f.packagePath),
				before = await source.store.readDescriptor();
			const store = {
				...target.store,
				createImmutable: async () => {
					throw Object.assign(new Error('interrupted copy'), { code: 'EIO' });
				}
			};
			const importing = createEngine(target.config, { ...target.options, store });
			await expect(
				importing.importPackage(f.packagePath, {
					confirmedStopped: true,
					previewDigest: plan.previewDigest
				})
			).rejects.toThrow('interrupted');
			expect(await fs.readdir(target.roots.work)).toEqual([]);
			expect((await target.store.readDescriptor()).value.generation).toBeNull();
			expect(await fs.lstat(path.join(f.dir, 'target/backup/owner')).catch(() => null)).toBeNull();
			expect(await source.store.readDescriptor()).toEqual(before);
			const retry = await f.target('retry');
			await retry.engine().importPackage(f.packagePath, {
				confirmedStopped: true,
				previewDigest: plan.previewDigest
			});
			expect(await fs.readFile(path.join(retry.roots.work, 'note'), 'utf8')).toBe('accepted');
		} finally {
			await engine.release();
			await fs.rm(f.dir, { recursive: true });
		}
	});
	test('inventories optional cache inclusion explicitly and verifies its object when present', async () => {
		const f = await fixture(),
			source = await f.target('source'),
			engine = source.engine();
		const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
		try {
			await engine.initialize();
			await engine.acquireRestore();
			await engine.checkpoint();
			const head = await source.store.readDescriptor(),
				owner = {
					nonce: (await fs.readFile(path.join(f.dir, 'source/backup/owner/nonce'))).toString()
				};
			const manifest = JSON.parse(
				(await source.store.read(`manifests/${head.value.generation}`)).toString()
			);
			const bytes = Buffer.from('synthetic native cache artifact');
			manifest.akmIndexCache = {
				format: 2,
				instanceId: source.config.instanceId,
				profile: 'a'.repeat(64),
				hash: hash(bytes),
				bytes: bytes.length,
				capturedAt: Date.now(),
				vectors: 1
			};
			const manifestBytes = Buffer.from(JSON.stringify(manifest)),
				generation = hash(manifestBytes);
			await source.store.createImmutable(`manifests/${generation}`, manifestBytes, owner);
			await source.store.compareAndSwap(head.token, { ...head.value, generation }, owner);
			const omitted = path.join(f.dir, 'omitted');
			await engine.exportPackage(omitted);
			expect(
				JSON.parse(await fs.readFile(path.join(omitted, 'checkpoint.json'), 'utf8'))
					.optionalCacheIncluded
			).toBe(false);
			expect((await engine.previewPackage(omitted)).warnings.join(' ')).toContain(
				'cache is omitted'
			);
			await source.store.createImmutable(`objects/${hash(bytes)}`, bytes, owner);
			await engine.exportPackage(f.packagePath);
			expect(
				JSON.parse(await fs.readFile(path.join(f.packagePath, 'checkpoint.json'), 'utf8'))
					.optionalCacheIncluded
			).toBe(true);
			expect((await engine.previewPackage(f.packagePath)).warnings.join(' ')).toContain(
				'cache object is included'
			);
			await fs.writeFile(
				path.join(f.packagePath, 'objects', hash(bytes)),
				'corrupt optional cache'
			);
			await expect(engine.previewPackage(f.packagePath)).rejects.toThrow('checksum');
		} finally {
			await engine.release();
			await fs.rm(f.dir, { recursive: true });
		}
	});
});

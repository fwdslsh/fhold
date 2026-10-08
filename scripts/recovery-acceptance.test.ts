import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Real directory transport acceptance. Synthetic private fixtures are retained
// under /tmp; no live home, account or network filesystem is touched.
import { createDirectoryStore } from '../containers/assistant/recovery/directory-store.mjs';
import { createEngine } from '../containers/assistant/recovery/engine.mjs';

const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'fhold-recovery-acceptance-'));
	return { root, store: createDirectoryStore(pathToFileURL(join(root, 'backup')).href) };
}

describe('real directory recovery destination', () => {
	it('requires explicit init, exclusive ownership and fenced publication', async () => {
		const { store } = await fixture();
		expect(await store.readDescriptor()).toBeNull();
		await store.initialize({ format: 1, instanceId: 'synthetic', owner: null, epoch: 0, generation: null });
		await expect(store.initialize({})).rejects.toThrow();
		const first = await store.acquire();
		await expect(store.acquire()).rejects.toThrow('no automatic takeover');
		const initial = await store.readDescriptor();
		const claimed = await store.claim(initial.token, first);
		const bytes = Buffer.from('synthetic private contents');
		const key = `objects/${hash(bytes)}`;
		await store.createImmutable(key, bytes, first);
		await store.createImmutable(key, bytes, first);
		expect(await store.read(key)).toEqual(bytes);
		await expect(store.compareAndSwap(initial.token, claimed.value, first)).rejects.toThrow();
		await store.release(first);
		await expect(store.createImmutable(key, bytes, first)).rejects.toThrow();
		const second = await store.acquire();
		const next = await store.claim(claimed.token, second);
		expect(next.value.epoch).toBe(2);
		await expect(store.compareAndSwap(next.token, { ...next.value, owner: first.nonce }, first)).rejects.toThrow();
		await store.release(second);
	});

	it('rejects symlink destination and object tampering without rewriting bytes', async () => {
		const { root, store } = await fixture();
		await store.initialize({ owner: null, epoch: 0 });
		const owner = await store.acquire();
		const bytes = Buffer.from('original fixture');
		const key = `objects/${hash(bytes)}`;
		await store.createImmutable(key, bytes, owner);
		const target = join(store.root, key);
		await writeFile(target, 'corrupt fixture');
		await expect(store.createImmutable(key, bytes, owner)).rejects.toThrow('immutable object conflict');
		expect((await readFile(target)).toString()).toBe('corrupt fixture');
		await store.release(owner);
		const link = join(root, 'linked-backup');
		await symlink(store.root, link);
		const linked = createDirectoryStore(pathToFileURL(link).href);
		await expect(linked.acquire()).rejects.toThrow('link');
	});
});

describe('same-instance engine replacement on a real directory', () => {
	it('rejects an expired snapshot deadline without publishing partial output', async () => {
		const root = await mkdtemp(join(tmpdir(), 'fhold-deadline-acceptance-'));
		const roots = { home: join(root, 'home'), stash: join(root, 'stash'), work: join(root, 'work'), akmData: join(root, 'akm'), akmConfig: join(root, 'config') };
		await mkdir(roots.akmData, { recursive: true });
		const db = new Database(join(roots.akmData, 'state.db'));
		db.exec('CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES (\'preserved\')');
		const url = pathToFileURL(join(root, 'backup')).href;
		const engine = createEngine({ url, instanceId: 'deadline-fixture', versions: { test: '1' }, privateDir: join(root, 'private') }, { roots, bunPath: process.execPath, limits: { sqliteTimeoutMs: 1 } });
		await engine.initialize();
		await engine.acquireRestore();
		await expect(engine.checkpoint()).rejects.toThrow();
		expect(engine.status().generation).toBeNull();
		expect(JSON.parse(await readFile(join(root, 'backup/descriptor.json'), 'utf8')).generation).toBeNull();
		expect(db.query('SELECT * FROM marker').all()).toEqual([{ value: 'preserved' }]);
		db.close();
		await engine.release();
	});

	it('captures valid WAL snapshots while a separate process commits', async () => {
		const root = await mkdtemp(join(tmpdir(), 'fhold-concurrent-acceptance-'));
		const roots = { home: join(root, 'home'), stash: join(root, 'stash'), work: join(root, 'work'), akmData: join(root, 'akm'), akmConfig: join(root, 'config') };
		await mkdir(roots.akmData, { recursive: true });
		const dbPath = join(roots.akmData, 'state.db');
		const db = new Database(dbPath);
		db.exec('PRAGMA journal_mode=WAL; CREATE TABLE commits(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO commits(value) VALUES (\'baseline\')');
		const engine = createEngine({ url: pathToFileURL(join(root, 'backup')).href, instanceId: 'concurrent-fixture', versions: { test: '1' }, privateDir: join(root, 'private') }, { roots, bunPath: process.execPath });
		await engine.initialize();
		await engine.acquireRestore();
		const child = spawn(process.execPath, ['--eval', 'import {Database} from "bun:sqlite"; const d=new Database(process.argv[1]); d.exec("PRAGMA busy_timeout=1000"); for(let i=0;i<100;i++){d.query("INSERT INTO commits(value) VALUES (?)").run("writer-"+i); await Bun.sleep(2)} d.close();', dbPath], { stdio: 'ignore' });
		const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
		for (let i = 0; i < 3; i++) {
			await engine.checkpoint();
			const generation = engine.status().generation;
			const manifest = JSON.parse(await readFile(join(root, 'backup/manifests', generation), 'utf8'));
			const member = manifest.members.find((entry: { id: string }) => entry.id === 'akm-state');
			const snapshot = new Database(join(root, 'backup/objects', member.hash), { readonly: true });
			expect(snapshot.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
			expect((snapshot.query('SELECT COUNT(*) AS n FROM commits').get() as { n: number }).n).toBeGreaterThanOrEqual(1);
			snapshot.close();
		}
		expect(await done).toBe(0);
		expect(db.query('SELECT COUNT(*) AS n FROM commits').get()).toEqual({ n: 101 });
		db.close();
		await engine.release();
	});

	it('refuses missing namespaces and different identities before becoming ready', async () => {
		const root = await mkdtemp(join(tmpdir(), 'fhold-engine-refusal-'));
		const url = pathToFileURL(join(root, 'backup')).href;
		const roots = { home: join(root, 'home'), stash: join(root, 'stash'), work: join(root, 'work'), akmData: join(root, 'akm'), akmConfig: join(root, 'config') };
		const make = (instanceId: string) => createEngine({ url, instanceId, versions: { test: '1' }, privateDir: join(root, 'private') }, { roots, bunPath: process.execPath });
		const original = make('owner-one');
		await expect(original.acquireRestore()).rejects.toThrow('explicit initialization');
		expect(original.status().ready).toBe(false);
		await original.initialize();
		const wrong = make('owner-two');
		await expect(wrong.acquireRestore()).rejects.toThrow('identity');
		expect(wrong.status().ready).toBe(false);
		expect(wrong.status().owned).toBe(false);
	});

	it('preserves committed WAL rows, private fixture files and manifest deletions', async () => {
		const fixtureRoot = await mkdtemp(join(tmpdir(), 'fhold-engine-acceptance-'));
		const url = pathToFileURL(join(fixtureRoot, 'backup')).href;
		const make = (name: string) => {
			const roots = Object.fromEntries(['home', 'stash', 'work', 'akmData', 'akmConfig'].map((key) => [key, join(fixtureRoot, name, key)]));
			return { roots, engine: createEngine({ url, instanceId: 'fixture-owner', versions: { test: '1' }, privateDir: join(fixtureRoot, name, 'private') }, { roots, bunPath: process.execPath }) };
		};
		const first = make('original');
		const dbPath = join(first.roots.home, '.local/share/opencode/opencode.db');
		await mkdir(join(first.roots.home, '.local/share/opencode'), { recursive: true });
		await mkdir(join(first.roots.home, '.codex'), { recursive: true });
		const codexDatabases = ['state_5.sqlite', 'logs_2.sqlite', 'goals_1.sqlite', 'thread_history_1.sqlite', 'memories_1.sqlite', 'queue_1.sqlite'];
		for (const name of codexDatabases) {
			const native = new Database(join(first.roots.home, '.codex', name));
			native.exec('CREATE TABLE fixture(value TEXT)');
			native.query('INSERT INTO fixture VALUES (?)').run(name);
			native.close();
		}
		await mkdir(first.roots.work, { recursive: true });
		await mkdir(first.roots.stash, { recursive: true });
		const db = new Database(dbPath);
		db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE events(id INTEGER PRIMARY KEY, value TEXT); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO events(value) VALUES (\'committed-wal-marker\')');
		await writeFile(join(first.roots.home, '.codex/auth.json'), '{"fake_account":"synthetic-only"}');
		await writeFile(join(first.roots.home, '.codex/config.toml'), '[projects."/work"]\ntrust_level="trusted"\n');
		await writeFile(join(first.roots.work, 'draft.txt'), 'uncommitted fixture');
		await mkdir(join(first.roots.work, '.git'), { recursive: true });
		await writeFile(join(first.roots.work, '.git/HEAD'), 'ref: refs/heads/fixture\n');
		await writeFile(join(first.roots.work, 'dependency.lock'), 'fixture lockfile');
		await writeFile(join(first.roots.work, 'run.sh'), '#!/bin/sh\nexit 0\n');
		await chmod(join(first.roots.work, 'run.sh'), 0o700);
		await writeFile(join(first.roots.stash, 'removed.txt'), 'delete before next checkpoint');
		await first.engine.initialize();
		await first.engine.acquireRestore();
		await first.engine.checkpoint();
		await unlink(join(first.roots.stash, 'removed.txt'));
		db.exec('INSERT INTO events(value) VALUES (\'second-wal-marker\')');
		await first.engine.checkpoint();
		const generation = first.engine.status().generation;
		db.close();
		await first.engine.release();
		const replacement = make('replacement-empty');
		await replacement.engine.acquireRestore();
		expect(replacement.engine.status().generation).toBe(generation);
		const restored = new Database(join(replacement.roots.home, '.local/share/opencode/opencode.db'), { readonly: true });
		expect(restored.query('SELECT value FROM events ORDER BY id').all()).toEqual([{ value: 'committed-wal-marker' }, { value: 'second-wal-marker' }]);
		expect(restored.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
		restored.close();
		expect(await readFile(join(replacement.roots.work, 'draft.txt'), 'utf8')).toBe('uncommitted fixture');
		expect(await readFile(join(replacement.roots.work, '.git/HEAD'), 'utf8')).toContain('refs/heads/fixture');
		expect(await readFile(join(replacement.roots.work, 'dependency.lock'), 'utf8')).toBe('fixture lockfile');
		expect((await stat(join(replacement.roots.work, 'run.sh'))).mode & 0o700).toBe(0o700);
		expect(await readFile(join(replacement.roots.home, '.codex/auth.json'), 'utf8')).toContain('synthetic-only');
		expect(await readFile(join(replacement.roots.home, '.codex/config.toml'), 'utf8')).toContain('trust_level="trusted"');
		for (const name of codexDatabases) {
			const native = new Database(join(replacement.roots.home, '.codex', name), { readonly: true });
			expect(native.query('SELECT * FROM fixture').all()).toEqual([{ value: name }]);
			expect(native.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
			native.close();
		}
		await expect(readFile(join(replacement.roots.stash, 'removed.txt'))).rejects.toThrow();
		// Native versioned Codex filenames can migrate; losing the core session
		// database still must not replace the accepted checkpoint with empty state.
		await unlink(join(replacement.roots.home, '.local/share/opencode/opencode.db'));
		await expect(replacement.engine.checkpoint()).rejects.toThrow('disappeared');
		expect(replacement.engine.status().generation).toBe(generation);
		await replacement.engine.release();
		const manifest = JSON.parse(await readFile(join(fixtureRoot, 'backup/manifests', generation), 'utf8'));
		const member = manifest.members.find((entry: { kind: string }) => entry.kind === 'sqlite');
		await writeFile(join(fixtureRoot, 'backup/objects', member.hash), 'corrupted-synthetic-snapshot');
		const corrupted = make('corrupt-replacement-empty');
		await expect(corrupted.engine.acquireRestore()).rejects.toThrow('checksum');
		expect(corrupted.engine.status().ready).toBe(false);
		await expect(readFile(join(corrupted.roots.work, 'draft.txt'))).rejects.toThrow();
		// No writers were ever admitted in this isolated fixture.
		await corrupted.engine.release();
	});
});

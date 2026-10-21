import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createEngine } from '../containers/assistant/recovery/engine.mjs';
import { createDirectoryStore } from '../containers/assistant/recovery/directory-store.mjs';
import { validAkmIndexCache } from '../containers/assistant/recovery/akm-index-cache.mjs';

const require = createRequire(import.meta.url);
const cli = path.join(
	path.dirname(
		require.resolve('akm-cli/package.json', {
			paths: [path.resolve('containers/assistant/tools')]
		})
	),
	'dist/cli.js'
);
const temporary: string[] = [];
afterEach(async () => {
	for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
	const dir = await fs.mkdtemp('/tmp/fhold-akm-cache-');
	temporary.push(dir);
	const roots = Object.fromEntries(
		['home', 'stash', 'work', 'akmData', 'akmConfig'].map((key) => [
			key,
			path.join(dir, 'live', key)
		])
	);
	for (const root of Object.values(roots)) await fs.mkdir(root, { recursive: true, mode: 0o700 });
	const bundle = path.join(dir, 'persistent-bundle');
	await fs.mkdir(path.join(bundle, 'knowledge'), { recursive: true });
	const config = {
		configVersion: '0.9.0',
		semanticSearchMode: 'off',
		defaultBundle: 'fixture',
		bundles: { fixture: { path: bundle, components: { main: { adapter: 'akm' } } } }
	};
	await fs.writeFile(path.join(roots.akmConfig, 'config.json'), JSON.stringify(config));
	const env = {
		PATH: process.env.PATH,
		HOME: roots.home,
		XDG_CONFIG_HOME: path.join(dir, 'xdg-config'),
		XDG_DATA_HOME: path.join(dir, 'xdg-data'),
		XDG_STATE_HOME: path.join(dir, 'xdg-state'),
		XDG_CACHE_HOME: path.join(dir, 'xdg-cache'),
		AKM_BUNDLE_DIR: bundle,
		AKM_CONFIG_DIR: roots.akmConfig,
		AKM_DATA_DIR: roots.akmData,
		AKM_STATE_DIR: path.join(roots.akmData, 'state'),
		AKM_CACHE_DIR: path.join(dir, 'cache'),
		AKM_AUTO_MEMORY: '0',
		AKM_AUTO_LEARNING: '0',
		BUN_OPTIONS: '--no-env-file --config=/dev/null'
	};
	const options = { roots, env, bunPath: process.execPath, akmCommand: [process.execPath, cli] };
	const recovery = {
		instanceId: 'fixture',
		url: pathToFileURL(path.join(dir, 'backup')).href,
		privateDir: path.join(roots.home, '.fhold-recovery'),
		akmIndexCapture: true,
		akmIndexRestore: true
	};
	const asset = (name: string, content: string) =>
		fs.writeFile(
			path.join(bundle, 'knowledge', `${name}.md`),
			`---\nname: ${name}\ndescription: ${content}\n---\n\n# ${name}\n\n${content}\n`
		);
	const native = async (args = ['index', '--clean', '--format', 'json', '-q']) => {
		const child = Bun.spawn([process.execPath, cli, ...args], {
			env,
			cwd: dir,
			stdout: 'pipe',
			stderr: 'pipe'
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited
		]);
		if (code !== 0) throw new Error(`Native AKM failed (${code}): ${stderr}`);
		return JSON.parse(stdout);
	};
	const saved = async () => {
		const head = await createDirectoryStore(recovery.url).readDescriptor();
		const file = path.join(dir, 'backup/manifests', head.value.generation);
		return { head, file, manifest: JSON.parse(await fs.readFile(file, 'utf8')) };
	};
	const replacement = async () => {
		await fs.rename(path.join(dir, 'live'), path.join(dir, `retained-${Date.now()}`));
	};
	const entries = () => {
		const db = new Database(path.join(roots.akmData, 'index.db'), { readonly: true });
		try {
			return db.query('SELECT concept_id, document_json FROM entries ORDER BY concept_id').all();
		} finally {
			db.close();
		}
	};
	await asset('keep', 'Original surviving synthetic knowledge');
	await asset('deleted', 'Deleted synthetic knowledge must not return after recovery');
	await native();
	return {
		dir,
		roots,
		bundle,
		config,
		env,
		options,
		recovery,
		asset,
		native,
		saved,
		replacement,
		entries,
		engine: (patch = {}, optionPatch = {}) =>
			createEngine({ ...recovery, ...patch }, { ...options, ...optionPatch })
	};
}

describe('experimental AKM cache using the pinned native CLI', () => {
	for (const inference of [
		'missing-components',
		'missing-adapter',
		'implicit-primary',
		'component-root-does-not-describe-primary'
	])
		test(`${inference} declines caching without forcing native adapter detection`, async () => {
			const f = await fixture();
			const bundle =
				inference === 'missing-components'
					? { path: f.bundle }
					: inference === 'missing-adapter'
						? { path: f.bundle, components: { main: {} } }
						: inference === 'component-root-does-not-describe-primary'
							? { path: f.bundle, components: { main: { root: 'knowledge', adapter: 'akm' } } }
							: f.config.bundles.fixture;
			if (inference === 'implicit-primary') {
				f.env.AKM_BUNDLE_DIR = path.join(f.dir, 'undeclared-primary');
				await fs.mkdir(f.env.AKM_BUNDLE_DIR);
			}
			const configFile = path.join(f.roots.akmConfig, 'config.json');
			const configBefore = JSON.stringify({ ...f.config, bundles: { fixture: bundle } });
			await fs.writeFile(configFile, configBefore);
			const source = f.engine();
			await source.initialize();
			await source.acquireRestore();
			await source.checkpoint();
			expect(source.status().ready).toBe(true);
			expect(source.status().akmIndexCache.reason).toBe('unsupported-source-policy');
			expect((await f.saved()).manifest.akmIndexCache).toBeUndefined();
			expect(await fs.readFile(configFile, 'utf8')).toBe(configBefore);
			await source.release();
		});

	test('primary matching an explicitly supported component content root remains eligible', async () => {
		const f = await fixture();
		f.env.AKM_BUNDLE_DIR = path.join(f.bundle, 'knowledge');
		await fs.writeFile(
			path.join(f.roots.akmConfig, 'config.json'),
			JSON.stringify({
				...f.config,
				bundles: {
					fixture: { path: f.bundle, components: { main: { root: 'knowledge', adapter: 'akm' } } }
				}
			})
		);
		await f.native();
		const source = f.engine();
		await source.initialize();
		await source.acquireRestore();
		await source.checkpoint();
		expect(source.status().akmIndexCache.state).toBe('captured');
		expect((await f.saved()).manifest.akmIndexCache).toBeDefined();
		await source.release();
	});

	for (const capture of [false, true])
		for (const restore of [false, true])
			test(`independent switches capture=${capture} restore=${restore}`, async () => {
				const f = await fixture();
				const source = f.engine({ akmIndexCapture: capture, akmIndexRestore: false });
				await source.initialize();
				await source.acquireRestore();
				await source.checkpoint();
				await source.release();
				const { manifest } = await f.saved();
				expect(Boolean(manifest.akmIndexCache)).toBe(capture);
				expect(manifest.members.some((m) => m.path === 'index.db')).toBe(false);
				await f.asset('keep', 'Changed surviving synthetic knowledge');
				await fs.unlink(path.join(f.bundle, 'knowledge/deleted.md'));
				await f.asset('added', 'New synthetic knowledge');
				await f.replacement();
				const target = f.engine({ akmIndexCapture: false, akmIndexRestore: restore });
				await target.acquireRestore();
				expect(target.status().ready).toBe(true);
				if (capture && restore) {
					expect(target.status().akmIndexCache.state).toBe('restored');
					expect(f.entries().map((row) => row.concept_id)).toEqual([
						'knowledge/added',
						'knowledge/keep'
					]);
					expect(JSON.stringify(f.entries())).toContain('Changed surviving');
				} else {
					expect(
						await fs.stat(path.join(f.roots.akmData, 'index.db')).catch(() => null)
					).toBeNull();
					await f.native();
					expect(f.entries()).toHaveLength(2);
				}
				await target.release();
			});

	for (const failure of [
		'missing',
		'corrupt',
		'future-schema',
		'oversized',
		'wrong-instance',
		'wrong-format'
	])
		test(`${failure} optional cache falls back without blocking essential restore`, async () => {
			const f = await fixture();
			const source = f.engine();
			await source.initialize();
			await source.acquireRestore();
			await source.checkpoint();
			await source.release();
			const { manifest, head } = await f.saved();
			expect(validAkmIndexCache(manifest.akmIndexCache, 'fixture')).toBe(true);
			const object = path.join(f.dir, 'backup/objects', manifest.akmIndexCache.hash);
			if (failure === 'missing') await fs.unlink(object);
			if (failure === 'corrupt') await fs.writeFile(object, 'not sqlite');
			if (failure === 'future-schema') {
				const db = new Database(object);
				db.exec("UPDATE index_meta SET value='99999' WHERE key='version'");
				db.close();
				const bytes = await fs.readFile(object);
				manifest.akmIndexCache.hash = hash(bytes);
				manifest.akmIndexCache.bytes = bytes.length;
				await fs.writeFile(path.join(f.dir, 'backup/objects', hash(bytes)), bytes);
			}
			if (failure === 'oversized') manifest.akmIndexCache.bytes = 65 * 1024 * 1024;
			if (failure === 'wrong-instance') manifest.akmIndexCache.instanceId = 'another';
			if (failure === 'wrong-format') manifest.akmIndexCache.format = 99;
			if (!['missing', 'corrupt'].includes(failure)) {
				const bytes = Buffer.from(JSON.stringify(manifest));
				const generation = hash(bytes);
				await fs.writeFile(path.join(f.dir, 'backup/manifests', generation), bytes);
				await fs.writeFile(
					path.join(f.dir, 'backup/descriptor.json'),
					JSON.stringify({ ...head.value, generation })
				);
			}
			await f.replacement();
			const target = f.engine();
			await target.acquireRestore();
			expect(target.status().ready).toBe(true);
			expect(await fs.readFile(path.join(f.roots.akmConfig, 'config.json'), 'utf8')).toContain(
				'fixture'
			);
			expect(await fs.stat(path.join(f.roots.akmData, 'index.db')).catch(() => null)).toBeNull();
			await f.native();
			expect(f.entries()).toHaveLength(2);
			await target.release();
		});

	test('candidate refresh leaves live index and config unchanged; unchanged snapshots reuse the latest object', async () => {
		const f = await fixture();
		const engine = f.engine();
		await engine.initialize();
		await engine.acquireRestore();
		const configBefore = await fs.readFile(path.join(f.roots.akmConfig, 'config.json'));
		const indexBefore = await fs.readFile(path.join(f.roots.akmData, 'index.db'));
		await engine.checkpoint();
		const first = (await f.saved()).manifest.akmIndexCache;
		await engine.checkpoint();
		const second = (await f.saved()).manifest.akmIndexCache;
		expect(first.hash).toBe(second.hash);
		expect(await fs.readFile(path.join(f.roots.akmConfig, 'config.json'))).toEqual(configBefore);
		expect(await fs.readFile(path.join(f.roots.akmData, 'index.db'))).toEqual(indexBefore);
		await engine.release();
		const restart = f.engine();
		await restart.acquireRestore();
		expect(restart.status().akmIndexCache.state).toBe('preserved-local');
		expect(await fs.readFile(path.join(f.roots.akmData, 'index.db'))).toEqual(indexBefore);
		await restart.release();
	});

	test('cache deadline and byte budget leave essential checkpoint successful', async () => {
		const f = await fixture();
		for (const limits of [
			{ bytes: 64 * 1024 * 1024, timeoutMs: 1 },
			{ bytes: 1, timeoutMs: 5000 }
		]) {
			const engine = f.engine({}, { akmIndexCacheLimits: limits });
			if (!(await createDirectoryStore(f.recovery.url).readDescriptor())) await engine.initialize();
			await engine.acquireRestore();
			await engine.checkpoint();
			expect(engine.status().lastCheckpointTick).not.toBeNull();
			expect((await f.saved()).manifest.akmIndexCache).toBeUndefined();
			await engine.release();
		}
	});

	test('missing source and unsupported inherited/network source policies omit cache', async () => {
		const f = await fixture();
		await fs.writeFile(
			path.join(f.roots.akmConfig, 'config.json'),
			JSON.stringify({ ...f.config, extends: ['not-allowed.json'] })
		);
		const engine = f.engine();
		await engine.initialize();
		await engine.acquireRestore();
		await engine.checkpoint();
		expect((await f.saved()).manifest.akmIndexCache).toBeUndefined();
		expect(engine.status().akmIndexCache.reason).toBe('unsupported-source-policy');
		await fs.writeFile(path.join(f.roots.akmConfig, 'config.json'), JSON.stringify(f.config));
		await fs.rename(f.bundle, `${f.bundle}-unmounted`);
		await engine.checkpoint();
		expect((await f.saved()).manifest.akmIndexCache).toBeUndefined();
		expect(engine.status().ready).toBe(true);
		await engine.release();
	});

	test('restore-only carries eligible references; both off ignores payload and drops reference', async () => {
		const f = await fixture();
		const source = f.engine();
		await source.initialize();
		await source.acquireRestore();
		await source.checkpoint();
		await source.release();
		const original = (await f.saved()).manifest.akmIndexCache;
		await f.replacement();
		const restoring = f.engine({ akmIndexCapture: false });
		await restoring.acquireRestore();
		await restoring.checkpoint();
		await restoring.release();
		expect((await f.saved()).manifest.akmIndexCache.hash).toBe(original.hash);
		const store = createDirectoryStore(f.recovery.url);
		const read = store.read.bind(store);
		store.read = async (key, ...args) => {
			if (key === `objects/${original.hash}`) throw new Error('off must not fetch cache');
			return read(key, ...args);
		};
		await f.replacement();
		const disabled = f.engine({ akmIndexCapture: false, akmIndexRestore: false }, { store });
		await disabled.acquireRestore();
		await disabled.checkpoint();
		expect((await f.saved()).manifest.akmIndexCache).toBeUndefined();
		expect(disabled.status().ready).toBe(true);
		await disabled.release();
	});

	test('source/redaction policy changes and explicit source exclusions reject old cache', async () => {
		const f = await fixture();
		const source = f.engine();
		await source.initialize();
		await source.acquireRestore();
		await source.checkpoint();
		await source.release();
		await f.replacement();
		const target = f.engine({}, { env: { ...f.env, AKM_REDACT_PII: '1' } });
		await target.acquireRestore();
		expect(target.status().akmIndexCache.reason).toBe('source-policy-changed');
		expect(await fs.stat(path.join(f.roots.akmData, 'index.db')).catch(() => null)).toBeNull();
		await target.release();
		const excluded = f.engine({ selection: { version: 1, excludePaths: [f.bundle] } });
		await excluded.acquireRestore();
		await excluded.checkpoint();
		expect(excluded.status().akmIndexCache.reason).toBe('excluded-source');
		expect((await f.saved()).manifest.akmIndexCache).toBeUndefined();
		await excluded.release();
	});

	test('read-only filesystem source needs no writes and native candidate stays isolated', async () => {
		const f = await fixture();
		const source = f.engine();
		await fs.chmod(f.bundle, 0o500);
		await fs.chmod(path.join(f.bundle, 'knowledge'), 0o500);
		try {
			await source.initialize();
			await source.acquireRestore();
			await source.checkpoint();
			await source.release();
			expect((await f.saved()).manifest.akmIndexCache.complete).toBe(true);
			await f.replacement();
			const target = f.engine();
			await target.acquireRestore();
			expect(target.status().akmIndexCache.state).toBe('restored');
			await target.release();
		} finally {
			await fs.chmod(f.bundle, 0o700);
			await fs.chmod(path.join(f.bundle, 'knowledge'), 0o700);
		}
	});

	test('a concurrent native first-use index cannot be overwritten by cache publication', async () => {
		const f = await fixture();
		const source = f.engine();
		await source.initialize();
		await source.acquireRestore();
		await source.checkpoint();
		await source.release();
		const reference = (await f.saved()).manifest.akmIndexCache;
		await f.replacement();
		const store = createDirectoryStore(f.recovery.url);
		const read = store.read.bind(store);
		let firstUseBytes = Buffer.alloc(0);
		store.read = async (key, ...args) => {
			if (key === `objects/${reference.hash}`) {
				await f.native();
				firstUseBytes = await fs.readFile(path.join(f.roots.akmData, 'index.db'));
			}
			return read(key, ...args);
		};
		const target = f.engine({}, { store });
		await target.acquireRestore();
		expect(target.status().ready).toBe(true);
		expect(await fs.readFile(path.join(f.roots.akmData, 'index.db'))).toEqual(firstUseBytes);
		await target.release();
	});

	for (const result of [
		{ skipped: { reason: 'lock-held' } },
		{ scanComplete: false, clean: { removed: 0 } }
	])
		test(`native zero-exit ${JSON.stringify(result)} never proves completion and retries later`, async () => {
			const f = await fixture();
			const fake = path.join(f.dir, 'incomplete.mjs');
			await fs.writeFile(fake, `console.log(${JSON.stringify(JSON.stringify(result))});`);
			const source = f.engine({}, { akmCommand: [process.execPath, fake] });
			await source.initialize();
			await source.acquireRestore();
			await source.checkpoint();
			expect((await f.saved()).manifest.akmIndexCache).toBeUndefined();
			expect(source.status().akmIndexCache.reason).toBe('refresh-incomplete');
			await source.release();
			const retry = f.engine();
			await retry.acquireRestore();
			await retry.checkpoint();
			expect((await f.saved()).manifest.akmIndexCache.complete).toBe(true);
			await retry.release();
		});

	test('interrupted native admission leaves no partial live index; actual native bootstrap can recover', async () => {
		const f = await fixture();
		const source = f.engine();
		await source.initialize();
		await source.acquireRestore();
		await source.checkpoint();
		await source.release();
		await f.replacement();
		const target = f.engine({}, { akmIndexCacheLimits: { bytes: 64 * 1024 * 1024, timeoutMs: 1 } });
		await target.acquireRestore();
		expect(target.status().ready).toBe(true);
		expect(await fs.stat(path.join(f.roots.akmData, 'index.db')).catch(() => null)).toBeNull();
		expect(
			(await fs.readdir(f.recovery.privateDir)).filter((name) => name.startsWith('akm-cache-'))
		).toEqual([]);
		await f.native();
		expect(f.entries()).toHaveLength(2);
		await target.release();
	});

	test('essential payload corruption remains fail-closed despite a valid optional cache', async () => {
		const f = await fixture();
		const source = f.engine();
		await source.initialize();
		await source.acquireRestore();
		await source.checkpoint();
		await source.release();
		const { manifest } = await f.saved();
		const essential = manifest.members.find((member) => member.path === 'config.json');
		await fs.writeFile(path.join(f.dir, 'backup/objects', essential.hash), 'corrupt-essential');
		await f.replacement();
		const target = f.engine();
		await expect(target.acquireRestore()).rejects.toThrow('checksum');
		expect(target.status().ready).toBe(false);
		expect(await fs.stat(path.join(f.roots.akmData, 'index.db')).catch(() => null)).toBeNull();
	});

	test('an older native SQLite layout migrates without an exact package-version gate', async () => {
		const f = await fixture();
		const source = f.engine();
		await source.initialize();
		await source.acquireRestore();
		await source.checkpoint();
		await source.release();
		const { manifest, head } = await f.saved();
		const object = path.join(f.dir, 'backup/objects', manifest.akmIndexCache.hash);
		const db = new Database(object);
		db.exec("UPDATE index_meta SET value='25' WHERE key='version'");
		db.close();
		const bytes = await fs.readFile(object);
		manifest.akmIndexCache.hash = hash(bytes);
		manifest.akmIndexCache.bytes = bytes.length;
		manifest.akmIndexCache.schema = 25;
		await fs.writeFile(path.join(f.dir, 'backup/objects', hash(bytes)), bytes);
		const body = Buffer.from(JSON.stringify(manifest));
		const generation = hash(body);
		await fs.writeFile(path.join(f.dir, 'backup/manifests', generation), body);
		await fs.writeFile(
			path.join(f.dir, 'backup/descriptor.json'),
			JSON.stringify({ ...head.value, generation })
		);
		await f.replacement();
		const target = f.engine({ versions: { akm: 'different-image-provenance' } });
		await target.acquireRestore();
		expect(target.status().akmIndexCache.state).toBe('restored');
		expect(f.entries()).toHaveLength(2);
		await target.release();
	});

	test('native semantic vectors and environment credential references work in private candidates', async () => {
		const f = await fixture();
		let calls = 0;
		let inputs = 0;
		let authenticated = true;
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			async fetch(request) {
				calls++;
				authenticated &&= request.headers.get('authorization') === 'Bearer synthetic-test-only';
				const body = await request.json();
				const documents = Array.isArray(body.input) ? body.input : [body.input];
				inputs += documents.length;
				return Response.json({
					object: 'list',
					data: documents.map((_text, index) => ({
						object: 'embedding',
						index,
						embedding: [1, 0.5, 0.25, 0.125, 0.1, 0.05, 0.025, 0.01]
					}))
				});
			}
		});
		try {
			Object.assign(f.env, { ISSUE48_EMBED_KEY: 'synthetic-test-only' });
			const semantic = {
				...f.config,
				semanticSearchMode: 'auto',
				embedding: {
					endpoint: `http://127.0.0.1:${server.port}/v1/embeddings`,
					model: 'fixture-embedding',
					dimension: 8,
					apiKey: '$ISSUE48_EMBED_KEY',
					timeoutMs: 1000
				}
			};
			await fs.writeFile(path.join(f.roots.akmConfig, 'config.json'), JSON.stringify(semantic));
			expect((await f.native()).verification.ok).toBe(true);
			expect(inputs).toBe(2);
			expect(authenticated).toBe(true);
			const initialCalls = calls;
			const source = f.engine();
			await source.initialize();
			await source.acquireRestore();
			await source.checkpoint();
			expect((await f.saved()).manifest.akmIndexCache.embeddings).toBe(2);
			expect(calls).toBe(initialCalls);
			await f.asset('keep', 'Changed semantic fixture requires one new embedding');
			await source.checkpoint();
			expect(inputs).toBe(3);
			expect(authenticated).toBe(true);
			await source.release();
			await f.replacement();
			const target = f.engine();
			await target.acquireRestore();
			expect(target.status().akmIndexCache.state).toBe('restored');
			expect(inputs).toBe(3);
			expect(JSON.stringify(f.entries())).toContain('Changed semantic');
			await target.release();
			// Preserve the essential receipt/config but remove only the disposable
			// fixture index while every writer is stopped, then change the model.
			for (const suffix of ['', '-wal', '-shm'])
				await fs.rm(path.join(f.roots.akmData, `index.db${suffix}`), { force: true });
			await fs.writeFile(
				path.join(f.roots.akmConfig, 'config.json'),
				JSON.stringify({
					...semantic,
					embedding: { ...semantic.embedding, model: 'another-model' }
				})
			);
			const changed = f.engine();
			await changed.acquireRestore();
			expect(changed.status().akmIndexCache.reason).toBe('source-policy-changed');
			expect(inputs).toBe(3);
			expect(changed.status().ready).toBe(true);
			await changed.release();
		} finally {
			await server.stop(true);
		}
	});
});

import { afterEach, describe, expect, it } from 'bun:test';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporary: string[] = [];
const home = () => {
	const path = mkdtempSync(join(tmpdir(), 'fhold-runtime-test-'));
	temporary.push(path);
	return path;
};
afterEach(() => {
	for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('Assistant readiness and optional-feature degradation', () => {
	it('keeps a usable authenticated agent healthy when scheduling or reconciliation fails', async () => {
		const root = home();
		const script = join(import.meta.dir, '../containers/assistant/healthcheck.sh');
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch: (request) =>
				request.headers.get('authorization') ===
				`Basic ${Buffer.from('opencode:fixture-only').toString('base64')}`
					? new Response('{}')
					: new Response('Unauthorized', { status: 401 })
		});
		const run = async () => {
			const child = Bun.spawn(['bash', script], {
				env: {
					...process.env,
					FH_RUNTIME_DIR: root,
					FH_SCHEDULER_ENABLED: '1',
					FH_RECOVERY_URL: '',
					FH_KEEPALIVE_URL: '',
					FH_CODEX_REMOTE: '0',
					FH_CLAUDE_REMOTE: '0',
					OPENCODE_PORT: String(server.port),
					OPENCODE_SERVER_PASSWORD: 'fixture-only'
				},
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'ignore',
				timeout: 2000,
				killSignal: 'SIGKILL'
			});
			const exitCode = await child.exited;
			// A killed or timed-out shell is not a successful unhealthy-state check.
			expect(child.signalCode).toBeNull();
			return { exitCode, output: await new Response(child.stdout).text() };
		};
		try {
			expect((await run()).exitCode).toBe(1);
			for (const child of ['assistant', 'scheduler', 'reconciliation'])
				writeFileSync(join(root, `${child}.pid`), String(process.pid));
			writeFileSync(join(root, 'tasks-synced'), String(Math.floor(Date.now() / 1000) - 181));
			const stale = await run();
			expect(stale.exitCode).toBe(0);
			expect(stale.output).toContain('degraded: Task reconciliation');
			writeFileSync(join(root, 'tasks-synced'), String(Math.floor(Date.now() / 1000)));
			writeFileSync(join(root, 'scheduler.pid'), '999999999');
			const dead = await run();
			expect(dead.exitCode).toBe(0);
			expect(dead.output).toContain('degraded: Scheduled tasks');
			writeFileSync(join(root, 'scheduler.pid'), String(process.pid));
			expect(await run()).toEqual({ exitCode: 0, output: '' });
			writeFileSync(join(root, 'tasks-synced'), String(Math.floor(Date.now() / 1000) + 3600));
			expect((await run()).exitCode).toBe(0);
			writeFileSync(join(root, 'assistant.pid'), '999999999');
			expect((await run()).exitCode).not.toBe(0);
		} finally {
			server.stop(true);
		}
	});
});

describe('optional AKM integration failures', () => {
	async function plugin(
		upstream: string,
		run: (
			create: (context: unknown) => Promise<void>,
			hooks: Map<string, (input: unknown) => unknown>,
			root: string
		) => Promise<void>
	) {
		const root = home();
		const { createRequire } = await import('node:module');
		const require = createRequire(new URL('../plugins/fhold/package.json', import.meta.url));
		const effectPath = require.resolve('effect');
		const { Effect, Stream } = await import(effectPath);
		const dependency = join(root, 'upstream.mjs');
		writeFileSync(dependency, `import { Effect } from ${JSON.stringify(effectPath)};\n${upstream}`);
		const source = readFileSync(join(import.meta.dir, '../plugins/fhold/knowledge.js'), 'utf8')
			.replace(
				"'@opencode/plugin/effect'",
				JSON.stringify(
					import.meta.resolve('../plugins/fhold/node_modules/@opencode/plugin/dist/effect/index.js')
				)
			)
			.replace("'effect'", JSON.stringify(effectPath))
			.replace("'akm-opencode-v2'", JSON.stringify(dependency))
			;
		const entry = join(root, 'plugin.mjs');
		writeFileSync(entry, source);
		const previous = process.env.FH_RUNTIME_DIR;
		process.env.FH_RUNTIME_DIR = root;
		const hooks = new Map<string, (input: unknown) => unknown>();
		try {
			const definition = (await import(entry)).default;
			const context = {
				location: { directory: '/work' },
				event: { subscribe: () => Stream.never },
				session: {
					get: ({ sessionID }: { sessionID: string }) =>
						Effect.succeed({ agent: 'custom', ...(sessionID === 'remote' ? { metadata: { fholdGuardian: {}, fholdGuardianKnowledge: false } } : {}) }),
					hook: (name: string, hook: (input: unknown) => unknown) =>
						Effect.sync(() => hooks.set(name, (input) => Effect.runPromise(hook(input))))
				}
			};
			await run(() => Effect.runPromise(Effect.scoped(definition.effect(context))), hooks, root);
		} finally {
			if (previous === undefined) delete process.env.FH_RUNTIME_DIR;
			else process.env.FH_RUNTIME_DIR = previous;
		}
	}
	it('reports failed initialization without rejecting native plugin startup', async () => {
		await plugin(
			'export default {effect: () => Effect.fail(Error("private-upstream-payload"))}',
			async (create, _hooks, root) => {
				await create({});
				const warning = readFileSync(join(root, 'degraded-knowledge'), 'utf8');
				expect(warning).toContain('Knowledge integration is unavailable');
				expect(warning).not.toContain('private-upstream-payload');
			}
		);
	});
	it('isolates failed native hooks, preserves the warning when limited Guardian turns skip, and clears it on recovery', async () => {
		await plugin(
			'export default {effect: ctx => ctx.session.hook("context", input => input.fail ? Effect.fail(Error("private-upstream-payload")) : Effect.void)}',
			async (create, hooks, root) => {
				await create({});
				const hook = hooks.get('context')!;
				await hook({ sessionID: 'owner', agent: 'build', fail: true });
				expect(existsSync(join(root, 'degraded-knowledge'))).toBe(true);
				await hook({ sessionID: 'remote', agent: 'remote' });
				expect(existsSync(join(root, 'degraded-knowledge'))).toBe(true);
				await hook({ sessionID: 'owner', agent: 'build' });
				expect(existsSync(join(root, 'degraded-knowledge'))).toBe(false);
			}
		);
	});
});

describe('published AKM scheduler compatibility', () => {
	// Real native CLI calls each retain their 30s subprocess deadline;
	// Bun's default 5s whole-test deadline is too short under full-suite load.
	it('uses native host-local activation without modifying task source for pause/resume', () => {
		const root = home();
		const bin = join(root, 'bin');
		const config = join(root, 'config');
		const knowledge = join(root, 'knowledge');
		for (const path of [bin, config, knowledge]) mkdirSync(path);
		const settings = JSON.parse(
			readFileSync(join(import.meta.dir, '../packages/skeleton/config/akm/config.json'), 'utf8')
		);
		// The host fixture has its own content roots; the image uses /stash and
		// /fhold-bundle. Keep the same native bundle/component schema in both.
		settings.bundles.stash.path = knowledge;
		settings.bundles.fhold.path = join(import.meta.dir, '../packages/skeleton/system/assistant');
		writeFileSync(join(config, 'config.json'), JSON.stringify(settings));
		const crontab = join(bin, 'crontab');
		writeFileSync(
			crontab,
			`#!/usr/bin/env bun\nimport { existsSync, readFileSync, writeFileSync } from 'node:fs';\nconst path = process.env.FH_TEST_CRONTAB;\nconst arg = process.argv[2];\nif (arg === '-l') { if (existsSync(path)) process.stdout.write(readFileSync(path)); }\nelse { writeFileSync(path, arg === '-' ? await Bun.stdin.text() : readFileSync(arg)); }\n`
		);
		chmodSync(crontab, 0o755);
		const configFile = join(config, 'config.json');
		const helper = join(import.meta.dir, '../containers/assistant/fhold-task.mjs');
		const toolsBin = join(import.meta.dir, '../containers/assistant/tools/node_modules/.bin');
		const env = {
			...process.env,
			HOME: root,
			AKM_BUNDLE_DIR: knowledge,
			AKM_CONFIG_DIR: config,
			AKM_CACHE_DIR: join(root, 'cache'),
			AKM_DATA_DIR: join(root, 'data'),
			AKM_STATE_DIR: join(root, 'state'),
			PATH: `${bin}:${toolsBin}:${process.env.PATH ?? ''}`,
			FH_KNOWLEDGE_DIR: knowledge,
			FH_TEST_CRONTAB: join(root, 'crontab'),
			TZ: 'America/Chicago'
		};
		const run = (...args: string[]) =>
			Bun.spawnSync([process.execPath, helper, ...args], {
				env,
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: 30000
			});
		const keepalive = '*/20 * * * * * * /usr/local/bin/fhold-keepalive tick';
		writeFileSync(env.FH_TEST_CRONTAB, `${keepalive}\n`);
		const created = run(
			'create',
			'published-check',
			'--schedule',
			'* * * * *',
			'--prompt',
			'Return an acceptance marker'
		);
		expect(new TextDecoder().decode(created.stderr)).not.toContain('error');
		expect(created.exitCode).toBe(0);
		const listed = run('list', '--format', 'json');
		expect(listed.stderr.toString()).not.toContain('error');
		expect(listed.exitCode).toBe(0);
		expect(listed.stdout.toString()).toContain('tasks/published-check');
		const source = readFileSync(join(knowledge, 'tasks', 'published-check.yml'), 'utf8');
		expect(source).not.toContain('enabled:');
		expect(JSON.parse(readFileSync(configFile, 'utf8')).scheduler.enabled).toHaveLength(1);
		expect(run('pause', 'published-check').exitCode).toBe(0);
		expect(JSON.parse(readFileSync(configFile, 'utf8')).scheduler.enabled).toEqual([]);
		expect(run('resume', 'published-check').exitCode).toBe(0);
		expect(JSON.parse(readFileSync(configFile, 'utf8')).scheduler.enabled).toHaveLength(1);
		expect(readFileSync(join(knowledge, 'tasks', 'published-check.yml'), 'utf8')).toBe(source);
		mkdirSync(join(knowledge, 'imported-tasks'));
		const staged = join(knowledge, 'imported-tasks', 'adopted-check.yml');
		const quotedSource = source
			.replace(/^uses:.*$/m, 'uses: "akm/command"')
			.replace(/^engine:.*$/m, 'engine: "scheduled"');
		writeFileSync(staged, quotedSource);
		const adopted = run('adopt', staged);
		expect(adopted.stderr.toString()).not.toContain('fhold-task:');
		expect(adopted.exitCode).toBe(0);
		expect(readFileSync(staged, 'utf8')).toBe(quotedSource);
		expect(readFileSync(join(knowledge, 'tasks', 'adopted-check.yml'), 'utf8')).toBe(quotedSource);
		const activated = JSON.parse(readFileSync(configFile, 'utf8')).scheduler.enabled as Array<
			string | { ref: string }
		>;
		expect(
			activated.some((entry) =>
				(typeof entry === 'string' ? entry : entry.ref).endsWith('/adopted-check')
			)
		).toBe(false);
		for (const [name, invalid] of [
			['shell-target', source.replace(/^uses:.*$/m, 'run: "echo must-not-run"')],
			['invalid-native-source', source.replace(/^version:.*$/m, 'version: 999')]
		]) {
			const file = join(knowledge, 'imported-tasks', `${name}.yml`);
			writeFileSync(file, invalid);
			expect(run('adopt', file).exitCode).not.toBe(0);
			expect(readFileSync(file, 'utf8')).toBe(invalid);
			expect(existsSync(join(knowledge, 'tasks', `${name}.yml`))).toBe(false);
			expect(JSON.parse(readFileSync(configFile, 'utf8')).scheduler.enabled).toHaveLength(1);
		}
		expect(run('remove', 'published-check').exitCode).toBe(0);
		expect(JSON.parse(readFileSync(configFile, 'utf8')).scheduler.enabled).toEqual([]);
		expect(existsSync(join(knowledge, 'tasks', 'published-check.yml'))).toBe(false);
		expect(readFileSync(env.FH_TEST_CRONTAB, 'utf8')).toContain(keepalive);
	}, 160_000);
});

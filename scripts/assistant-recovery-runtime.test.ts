import { describe, expect, it } from 'bun:test';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

const source = readFileSync(
	new URL('../containers/assistant/entrypoint.sh', import.meta.url),
	'utf8'
);

function fixture(extra: Record<string, string | undefined> = {}) {
	const root = mkdtempSync(join(tmpdir(), 'fhold-recovery-runtime-'));
	const bin = join(root, 'bin');
	mkdirSync(bin);
	const log = join(root, 'events');
	const script = join(root, 'entrypoint.sh');
	// Substitute only physical image filesystem preparation in this host fixture.
	// Real command stubs and the production restore/supervision code still run.
	const isolated = source
		.replace('prepare_identity\numask', 'printf "identity\\n" >>"$EVENTS"\numask')
		.replace(
			'prepare_filesystem\nload_opencode_password',
			'printf "seed\\n" >>"$EVENTS"\nload_opencode_password'
		)
		.replace('cd /work', 'cd "$FIXTURE_ROOT"')
		.replace(
			'readonly TASK_SPOOL_DIR=/tmp/fhold-crontabs',
			`readonly TASK_SPOOL_DIR="${root}/crontabs"`
		)
		.replace('readonly TASK_BIN_DIR=/tmp/fhold-bin', `readonly TASK_BIN_DIR="${root}/cronbin"`);
	writeFileSync(script, isolated);
	const writerCheck = `
if [ "$FIXTURE_CHECK_ENV" = 1 ]; then
  for name in FH_RECOVERY_URL FH_RECOVERY_INCLUDE_FILE FH_RECOVERY_PARENT_PID FH_INSTANCE_ID AZURE_CLIENT_ID IDENTITY_ENDPOINT MSI_ENDPOINT IMDS_ENDPOINT; do
    if printenv "$name" >/dev/null; then printf 'environment-leak\n' >>"$EVENTS"; exit 71; fi
  done
  test "$FH_AUTOMATIC_MEMORY" = 1
  test -n "$OPENCODE_SERVER_PASSWORD"
  test "$AZURE_OPENAI_API_KEY" = synthetic-provider-value
fi
`;
	const stub = (name: string, body: string) => {
		const path = join(bin, name);
		const check = ['akm', 'supercronic', 'opencode', 'fhold-remote'].includes(name)
			? writerCheck
			: '';
		writeFileSync(path, `#!/usr/bin/env bash\nset -eu\n${check}${body}\n`);
		chmodSync(path, 0o755);
	};
	stub('akm', 'printf "sync\\n" >>"$EVENTS"');
	stub('fhold-keepalive', ':');
	stub('supercronic', "trap 'exit 0' TERM; while sleep 0.1; do :; done");
	stub(
		'fhold-remote',
		'printf "remote\\nremote-%s\\n" "$1" >>"$EVENTS"; trap \'exit 0\' TERM; while sleep 0.1; do :; done'
	);
	stub(
		'fixture-descendant',
		'printf "descendant\\n" >>"$EVENTS"; trap \'printf "descendant-stopped\\n" >>"$EVENTS"; exit 0\' TERM; while sleep 0.1; do :; done'
	);
	stub(
		'opencode',
		`
printf 'native\n' >>"$EVENTS"
if [ "\${FIXTURE_DESCENDANT:-0}" = 1 ]; then
  setsid fixture-descendant &
fi
trap 'printf "native-stopped\\n" >>"$EVENTS"; exit 0' TERM
while sleep 0.1; do :; done`
	);
	stub(
		'fhold-recovery',
		`
if [ "$1" = status ]; then exit 0; fi
printf 'recovery\n' >>"$EVENTS"
if [ "$FIXTURE_CHECK_ENV" = 1 ]; then
  test -n "$FH_RECOVERY_URL"
  test "$FH_RECOVERY_INCLUDE_FILE" = /run/synthetic-includes.json
  test -n "$FH_RECOVERY_PARENT_PID"
  test "$FH_INSTANCE_ID" = synthetic-instance
  test "$AZURE_CLIENT_ID" = synthetic-identity
  printf 'recovery-environment-retained\n' >>"$EVENTS"
fi
test ! -e "$FH_RUNTIME_DIR/recovery-writers-started"
test ! -e "$FH_RUNTIME_DIR/recovery-status.json"
trap 'printf "final-checkpoint\\n" >>"$EVENTS"; sleep "\${FIXTURE_FINAL_SECONDS:-0}"; printf "final-complete\\n" >>"$EVENTS"; printf "released\\n" >>"$EVENTS"; exit 0' TERM
if [ "\${FIXTURE_RESTORE_FAIL:-0}" = 1 ]; then exit 1; fi
sleep 0.3
printf 'restored\n' >>"$EVENTS"
touch "$FH_RUNTIME_DIR/recovery-restored"
while sleep 0.1; do :; done`
	);
	if (extra.FIXTURE_STALE_RUNTIME === '1') {
		const runtime = join(root, 'runtime');
		mkdirSync(runtime);
		for (const name of ['recovery-restored', 'recovery-writers-started', 'recovery-status.json']) {
			writeFileSync(join(runtime, name), 'stale fixture');
		}
	}
	const child = spawn('bash', [script], {
		env: {
			...process.env,
			PATH: `${bin}:/usr/bin:/bin`,
			EVENTS: log,
			FIXTURE_ROOT: root,
			FIXTURE_CHECK_ENV: '0',
			FH_RUNTIME_DIR: join(root, 'runtime'),
			FH_SCHEDULER_ENABLED: '0',
			FH_CODEX_REMOTE: '0',
			FH_CLAUDE_REMOTE: '0',
			FH_SHUTDOWN_SECONDS: '2',
			OPENCODE_SERVER_PASSWORD: 'fixture-only',
			...extra
		},
		stdio: 'ignore'
	});
	return {
		child,
		root,
		events: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])
	};
}

const finished = (child: ChildProcess) =>
	new Promise<number | null>((resolve) => {
		if (child.exitCode !== null) resolve(child.exitCode);
		else child.once('exit', resolve);
	});

async function until(check: () => boolean) {
	const deadline = Date.now() + 4000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error('fixture deadline exceeded');
		await Bun.sleep(20);
	}
}

describe('Assistant recovery lifecycle command fixtures', () => {
	it('rejects malformed recovery operation budgets before bootstrap writes', async () => {
		for (const value of ['0', '-1', 'false', '1.5', '3601']) {
			const run = fixture({ FH_RECOVERY_OPERATION_TIMEOUT_SECONDS: value });
			expect(await finished(run.child)).toBe(1);
			expect(run.events()).toEqual([]);
			expect(existsSync(join(run.root, 'runtime'))).toBe(false);
		}
	});

	it('allows final recovery to outlast the independent writer shutdown budget', async () => {
		const run = fixture({
			FH_RECOVERY_URL: 'file:///fixture',
			FH_SHUTDOWN_SECONDS: '1',
			FH_RECOVERY_OPERATION_TIMEOUT_SECONDS: '2',
			FIXTURE_FINAL_SECONDS: '2'
		});
		await until(() => run.events().includes('native'));
		run.child.kill('SIGTERM');
		expect(await finished(run.child)).toBe(0);
		const events = run.events();
		expect(events).toContain('final-complete');
		expect(events).toContain('released');
		expect(events.indexOf('native-stopped')).toBeLessThan(events.indexOf('final-checkpoint'));
		expect(events.indexOf('final-complete')).toBeLessThan(events.indexOf('released'));
	});
	it('rejects an invalid primary scheduler flag before runtime/filesystem/native writes', async () => {
		const run = fixture({ FH_SCHEDULER_ENABLED: 'false' });
		expect(await finished(run.child)).toBe(1);
		expect(run.events()).toEqual([]);
		expect(existsSync(join(run.root, 'runtime'))).toBe(false);
	});
	for (const name of ['FH_CODEX_REMOTE', 'FH_CLAUDE_REMOTE', 'FH_CODEX_SANDBOX'])
		it(`invalid optional ${name} does not prevent native assistant startup`, async () => {
			const run = fixture({ [name]: 'false' });
			try {
				await until(() => run.events().includes('native'));
				expect(run.child.exitCode).toBeNull();
			} finally {
				run.child.kill('SIGTERM');
				await finished(run.child);
			}
		});

	for (const tool of ['codex', 'claude'] as const)
		it(`restores before writers and starts enabled ${tool} with scheduling off on every boot`, async () => {
			const run = fixture({
				FH_RECOVERY_URL: 'file:///fixture',
				[`FH_${tool.toUpperCase()}_REMOTE`]: '1',
				FH_CODEX_SANDBOX: 'danger-full-access'
			});
			try {
				await until(() =>
					[`remote-${tool}`, 'native'].every((event) => run.events().includes(event))
				);
				const events = run.events();
				expect(events.indexOf('restored')).toBeLessThan(events.indexOf('seed'));
				expect(events.indexOf('seed')).toBeLessThan(events.indexOf('native'));
				expect(events.indexOf('restored')).toBeLessThan(events.indexOf(`remote-${tool}`));
				expect(events).not.toContain(`remote-${tool === 'claude' ? 'codex' : 'claude'}`);
				expect(events).not.toContain('sync');
				expect(existsSync(join(run.root, 'crontabs'))).toBe(false);
			} finally {
				run.child.kill('SIGTERM');
				await finished(run.child);
			}
		});

	for (const recoveryUrl of [undefined, 'file:///fixture'])
		it(`starts both native workers with omitted flags, scheduling off and recovery ${recoveryUrl ? 'on' : 'off'}`, async () => {
			const run = fixture({
				FH_RECOVERY_URL: recoveryUrl,
				FH_CODEX_REMOTE: undefined,
				FH_CLAUDE_REMOTE: undefined
			});
			try {
				await until(() =>
					['remote-claude', 'remote-codex', 'native'].every((event) => run.events().includes(event))
				);
				if (recoveryUrl) {
					for (const tool of ['claude', 'codex'])
						expect(run.events().indexOf('restored')).toBeLessThan(run.events().indexOf(`remote-${tool}`));
				}
				expect(run.events()).not.toContain('sync');
			} finally {
				run.child.kill('SIGTERM');
				await finished(run.child);
			}
		});

	it('keeps explicitly disabled native workers off even though startup defaults on', async () => {
		const run = fixture({ FH_RECOVERY_URL: 'file:///fixture' });
		try {
			await until(() => run.events().includes('native'));
			expect(run.events()).not.toContain('remote');
			expect(run.events()).not.toContain('sync');
		} finally {
			run.child.kill('SIGTERM');
			await finished(run.child);
		}
	});

	it('failed restore never starts state writers', async () => {
		const run = fixture({ FH_RECOVERY_URL: 'file:///fixture', FIXTURE_RESTORE_FAIL: '1' });
		expect(await finished(run.child)).toBe(1);
		expect(run.events()).not.toContain('seed');
		expect(run.events()).not.toContain('sync');
		expect(run.events()).not.toContain('native');
	});
	it('retains recovery authority only in the recovery worker environment', async () => {
		const run = fixture({
			FIXTURE_CHECK_ENV: '1',
			FH_RECOVERY_URL: 'file:///fixture',
			FH_INSTANCE_ID: 'synthetic-instance',
			FH_RECOVERY_INCLUDE_FILE: '/run/synthetic-includes.json',
			AZURE_CLIENT_ID: 'synthetic-identity',
			AZURE_OPENAI_API_KEY: 'synthetic-provider-value',
			IDENTITY_ENDPOINT: 'synthetic-endpoint',
			MSI_ENDPOINT: 'synthetic-endpoint',
			IMDS_ENDPOINT: 'synthetic-endpoint',
			FH_AUTOMATIC_MEMORY: '1',
			FH_CODEX_REMOTE: '1',
			FH_SCHEDULER_ENABLED: '1'
		});
		try {
			await until(() =>
				['remote', 'native', 'sync', 'recovery-environment-retained'].every((event) =>
					run.events().includes(event)
				)
			);
			expect(run.events()).toContain('recovery-environment-retained');
			expect(run.events()).toContain('sync');
			expect(run.events()).toContain('native');
			expect(run.events()).not.toContain('environment-leak');
		} finally {
			run.child.kill('SIGTERM');
			await finished(run.child);
		}
	});

	it('clears generated stale restore and writer gates before the new worker starts', async () => {
		const run = fixture({ FH_RECOVERY_URL: 'file:///fixture', FIXTURE_STALE_RUNTIME: '1' });
		try {
			await until(() => run.events().includes('native'));
			expect(run.events().indexOf('restored')).toBeLessThan(run.events().indexOf('seed'));
		} finally {
			run.child.kill('SIGTERM');
			await finished(run.child);
		}
	});

	it('refuses relative, root-alias, and symbolic-link runtime paths before writes', async () => {
		for (const runtime of ['relative', '/', '/tmp/..', '/tmp/./private', '/tmp//private']) {
			const run = fixture({ FH_RUNTIME_DIR: runtime });
			expect(await finished(run.child)).toBe(1);
			expect(run.events()).toEqual([]);
		}
	});

	it('stops native writers and descendants before final checkpoint and release', async () => {
		const run = fixture({ FH_RECOVERY_URL: 'file:///fixture', FIXTURE_DESCENDANT: '1' });
		await until(() => run.events().includes('descendant'));
		run.child.kill('SIGTERM');
		expect(await finished(run.child)).toBe(0);
		const events = run.events();
		expect(events).toContain('descendant-stopped');
		expect(events).toContain('native-stopped');
		expect(events.indexOf('descendant-stopped')).toBeLessThan(events.indexOf('final-checkpoint'));
		expect(events.indexOf('native-stopped')).toBeLessThan(events.indexOf('final-checkpoint'));
		expect(events.indexOf('final-checkpoint')).toBeLessThan(events.indexOf('released'));
	});

	it('default scheduler continues task synchronization', async () => {
		const run = fixture({ FH_SCHEDULER_ENABLED: '1' });
		try {
			await until(() => run.events().includes('native'));
			expect(run.events()).toContain('sync');
			expect(existsSync(join(run.root, 'runtime', 'scheduler.pid'))).toBe(true);
			expect(existsSync(join(run.root, 'runtime', 'reconciliation.pid'))).toBe(true);
		} finally {
			run.child.kill('SIGTERM');
			await finished(run.child);
		}
	});
});

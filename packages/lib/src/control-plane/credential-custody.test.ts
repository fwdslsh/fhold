import { expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { manageCustody, parseCustodyRequest } from './credential-custody.js';
import { parseOperationInput } from '../management/operation-input.js';
import { parseManagementInput } from '../management/wire-input.js';
import { installHome } from './install.js';
import { markInstalled } from './state.js';
import { createFholdState } from './foundation.js';
import { buildComposeCliArgs, buildComposeOptions } from './compose.js';
import { composeProcessEnvironment, runDocker } from './docker.js';

it('validates custody ingress without reflecting private input and strips unknown fields', () => {
	const canary = 'private-input-canary';
	for (const request of [
		{ action: 'set-secret', name: '../../escape', value: canary },
		{ action: 'approve', name: 'probe', digest: canary },
		{ action: 'save-task', name: 'probe', credential: 'x\nALL', script: canary },
		{ action: 'set-secret', name: 'probe', value: canary + '\0' }
	]) {
		try {
			parseCustodyRequest(request);
			throw Error('unexpected success');
		} catch (error) {
			expect(String(error)).not.toContain(canary);
			expect(String(error)).not.toContain('unexpected success');
		}
	}
	expect(parseCustodyRequest({ action: 'inspect', value: canary })).toEqual({ action: 'inspect' });
	const input = { action: 'set-secret', name: 'service', value: canary };
	expect(parseOperationInput('agent.custody', input)).toEqual(input);
	expect(parseManagementInput('agent.custody', input)).toEqual(input);
});

it('requires explicit confirmation before any credential mutation or Docker invocation', async () => {
	await expect(
		manageCustody(createFholdState('/nonexistent/custody-test'), {
			action: 'set-secret',
			name: 'probe',
			value: 'canary'
		})
	).rejects.toThrow('Confirm');
});

// Explicit image-backed check: FH_CUSTODY_IMAGE=fhold/credential-custody-slim:ci
it.skipIf(!process.env.FH_CUSTODY_IMAGE)(
	'uses the native image for private entry, reviewed grants, rotation and revocation',
	async () => {
		const home = mkdtempSync(join(tmpdir(), 'fhold-admin-custody-'));
		const state = createFholdState(home);
		const image = process.env.FH_CUSTODY_IMAGE!;
		await installHome({
			homeDir: home,
			name: `custody-${process.pid}`,
			automaticPorts: false,
			edition: image.includes('slim') ? 'slim' : 'aio'
		});
		markInstalled(home);
		const overlay = readFileSync(
			resolve(import.meta.dir, '../../../../docs/examples/credential-custody.compose.yml'),
			'utf8'
		).replace(
			'  assistant:\n',
			`  assistant:\n    image: ${image}\n    ports: !override []\n    environment:\n      FH_CODEX_REMOTE: "0"\n      FH_CLAUDE_REMOTE: "0"\n`
		);
		writeFileSync(join(home, 'config/stack/custom.compose.yml'), overlay);
		const compose = ['compose', ...buildComposeCliArgs(state)];
		const run = (args: string[]) =>
			runDocker([...compose, ...args], {
				env: composeProcessEnvironment(buildComposeOptions(state).envFiles)
			});
		const call = (input: Parameters<typeof manageCustody>[1]) => manageCustody(state, input, true);
		try {
			const up = await run(['up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '90']);
			expect(up.ok, up.stderr).toBe(true);
			const planted = await run([
				'exec',
				'-T',
				'assistant',
				'/bin/sh',
				'-eu',
				'-c',
				`
mkdir -p /home/fhold/.local/bin
printf '#!/bin/sh\\ntouch /tmp/custody-startup-compromised\\nexec /usr/bin/env "$@"\\n' > /home/fhold/.local/bin/env
printf 'preload = ["./custody-attack.ts"]\\n' > /work/bunfig.toml
printf 'require("node:fs").writeFileSync("/tmp/custody-startup-compromised","preload");' > /work/custody-attack.ts
/usr/bin/chmod 755 /home/fhold /home/fhold/.local /home/fhold/.local/bin /home/fhold/.local/bin/env /work
/usr/bin/chmod 644 /work/bunfig.toml /work/custody-attack.ts
`
			]);
			expect(planted.ok).toBe(true);
			expect((await call({ action: 'inspect' })).enabled).toBe(true);
			const secret = 'synthetic-admin-credential';
			const saved = await call({ action: 'set-secret', name: 'service', value: secret });
			expect(saved).toEqual({ enabled: true, saved: true });
			const privateExec = (code: string) =>
				run([
					'exec',
					'-T',
					'--user',
					'1101:1101',
					'--workdir',
					'/var/lib/fhold-credentials',
					'assistant',
					'/usr/bin/env',
					'-i',
					'PATH=/usr/local/bin:/usr/bin:/bin',
					'/usr/local/bin/node',
					'-e',
					code
				]);
			expect(
				(
					await privateExec(
						"require('node:fs').rmSync('/var/lib/fhold-credentials/akm/scripts',{recursive:true,force:true})"
					)
				).ok
			).toBe(true);
			expect((await call({ action: 'inspect' })).tasks).toEqual([]);
			const draft = {
				action: 'save-task' as const,
				name: 'probe',
				credential: 'service',
				script: '#!/bin/sh\nset -eu\ntouch /tmp/admin-custody-task-executed\nprintf "used %s\\n" "$CREDENTIAL"\n'
			};
			const review = (await call(draft)).review!;
			expect(review.approved).toBe(false);
			expect(JSON.stringify(review)).not.toContain(secret);
			const command = [
				'exec',
				'-T',
				'assistant',
				'sudo',
				'-n',
				'-H',
				'-u',
				'fhold-credentials',
				'/usr/local/bin/akm',
				'run',
				'tasks/admin-probe'
			];
			expect((await run(command)).ok).toBe(false);
			await expect(
				call({ action: 'approve', name: 'probe', digest: '0'.repeat(64) })
			).rejects.toThrow('changed since review');
			// The operator can draft before entering a credential. Approval must
			// use AKM's native dependency check, not just fhold's JSON template.
			const missing = (await call({ ...draft, name: 'missing', credential: 'not-entered' })).review!;
			await expect(call({ action: 'approve', name: 'missing', digest: missing.digest }))
				.rejects.toThrow('Native AKM task validation failed');
			expect((await call({ action: 'inspect' })).grants).not.toContain('missing');
			// A failed validation leaves the draft reviewable and can be repaired
			// by entering the referenced secret, without replacing approved code.
			await call({ action: 'set-secret', name: 'not-entered', value: 'synthetic-missing-now-present' });
			expect((await call({ action: 'approve', name: 'missing', digest: missing.digest })).review?.approved).toBe(true);
			await call({ action: 'revoke', name: 'missing' });
			expect((await privateExec("const fs=require('node:fs');fs.unlinkSync('/var/lib/fhold-credentials/akm/scripts/admin-missing.sh');fs.unlinkSync('/var/lib/fhold-credentials/akm/tasks/admin-missing.yml');")).ok).toBe(true);
			expect(
				(await call({ action: 'approve', name: 'probe', digest: review.digest })).review?.approved
			).toBe(true);
			expect((await run(['exec', '-T', 'assistant', '/usr/bin/test', '-e', '/tmp/admin-custody-task-executed'])).ok).toBe(false);
			const result = await run(command);
			expect(result.ok).toBe(true);
			expect(result.stdout).toContain('[REDACTED]');
			expect(result.stdout + result.stderr).not.toContain(secret);
			await expect(call(draft)).rejects.toThrow('operation failed');
			expect((await call({ action: 'review', name: 'probe' })).review?.digest).toBe(review.digest);
			await call({ action: 'set-secret', name: 'service', value: 'synthetic-rotated' });
			const rotated = await run(command);
			expect(rotated.ok).toBe(true);
			expect(rotated.stdout).not.toContain('synthetic-rotated');
			await call({ action: 'revoke', name: 'probe' });
			expect((await run(command)).ok).toBe(false);
			expect((await call({ action: 'review', name: 'probe' })).review?.approved).toBe(false);
			expect((await call({ action: 'inspect' })).tasks).toEqual(['probe']);
			await call({ action: 'approve', name: 'probe', digest: review.digest });
			const allowed = [
				'exec',
				'-T',
				'assistant',
				'sudo',
				'-n',
				'-l',
				'-u',
				'fhold-credentials',
				'/usr/local/bin/akm',
				'run',
				'tasks/admin-probe'
			];
			expect((await run(allowed)).ok).toBe(true);
			expect(
				(
					await privateExec(
						"const fs=require('node:fs');fs.unlinkSync('/var/lib/fhold-credentials/akm/scripts/admin-probe.sh');fs.unlinkSync('/var/lib/fhold-credentials/akm/tasks/admin-probe.yml');"
					)
				).ok
			).toBe(true);
			await expect(call({ action: 'review', name: 'probe' })).rejects.toThrow('operation failed');
			expect((await call({ action: 'inspect' })).grants).toEqual(['probe']);
			expect((await call({ action: 'inspect' })).tasks).toEqual(['probe']);
			await call({ action: 'revoke', name: 'probe' });
			expect((await run(allowed)).ok).toBe(false);
			expect((await call({ action: 'inspect' })).tasks).toEqual([]);
			expect(
				(
					await run([
						'exec',
						'-T',
						'assistant',
						'/usr/bin/test',
						'-e',
						'/tmp/custody-startup-compromised'
					])
				).ok
			).toBe(false);
			expect(
				(await privateExec("require('node:fs').chmodSync('/var/lib/fhold-credentials',0o777)")).ok
			).toBe(true);
			await expect(
				call({ action: 'set-secret', name: 'unsafe-home', value: 'synthetic-unsafe' })
			).rejects.toThrow('operation failed');
		} finally {
			await run(['down', '-v', '--remove-orphans']);
			rmSync(home, { recursive: true, force: true });
		}
	},
	180_000
);

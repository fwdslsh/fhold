import { expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

it.skipIf(!process.env.FH_NATIVE_RECOVERY_INIT_IMAGE)(
	'initializes recovery through the published non-root direct command with empty runtime mounts',
	async () => {
		const image = process.env.FH_NATIVE_RECOVERY_INIT_IMAGE!;
		expect(image).toMatch(/^fwdslsh\/fhold-assistant@sha256:[a-f0-9]{64}$/);
		const root = mkdtempSync(join(tmpdir(), 'fhold-native-init-'));
		const destination = join(root, 'recovery');
		const policy = join(root, 'include.json');
		const password = join(root, 'password');
		mkdirSync(destination, { mode: 0o700 });
		writeFileSync(
			policy,
			JSON.stringify({ version: 1, paths: [], sqlite: [], externalMounts: [] }),
			{ mode: 0o600 }
		);
		writeFileSync(password, randomUUID(), { mode: 0o600 });
		const execute = promisify(execFile);
		const mounts = ['/home/fhold', '/work', '/stash', '/opt/akm/data', '/etc/akm'];
		const common = [
			'run',
			'--rm',
			'--cap-drop=ALL',
			'--security-opt=no-new-privileges',
			...mounts.flatMap((path) => ['--tmpfs', `${path}:rw,nosuid,nodev,mode=0755`]),
			'--mount',
			`type=bind,src=${destination},dst=/recovery`,
			'--mount',
			`type=bind,src=${policy},dst=/run/fhold-recovery-policy/include.json,readonly`,
			'--mount',
			`type=bind,src=${password},dst=/run/secrets/opencode-password,readonly`,
			'--env',
			'FH_RECOVERY_URL=file:///recovery',
			'--env',
			'FH_INSTANCE_ID=native-init-test',
			'--env',
			'FH_RECOVERY_INCLUDE_FILE=/run/fhold-recovery-policy/include.json',
			'--env',
			'OPENCODE_SERVER_PASSWORD_FILE=/run/secrets/opencode-password'
		];
		await execute('docker', [
			...common,
			'--entrypoint',
			'/usr/local/bin/fhold-recovery',
			image,
			'init',
			'--confirm-new-instance'
		]);
		// Inspect exact generated descriptor, not a normal startup/restore success.
		const descriptor = JSON.parse(
			readFileSync(join(destination, 'descriptor.json'), 'utf8')
		) as Record<string, unknown>;
		const value = (descriptor.value ?? descriptor) as Record<string, unknown>;
		expect(value.instanceId).toBe('native-init-test');
		expect(value.generation).toBeNull();
		expect(value.owner).toBeNull();
		const probe = await execute('docker', [
			...common,
			'--entrypoint',
			'node',
			image,
			'-e',
			`const fs=require('node:fs');const paths=${JSON.stringify(mounts)};console.log(JSON.stringify({uid:process.getuid(),readable:['/run/fhold-recovery-policy/include.json','/run/secrets/opencode-password'].every(p=>{try{fs.accessSync(p,fs.constants.R_OK);return true;}catch{return false;}}),writable:paths.map(path=>{try{fs.accessSync(path,fs.constants.W_OK);return true;}catch{return false;}})}));`
		]);
		const observed = JSON.parse(probe.stdout);
		expect(observed.uid).not.toBe(0);
		expect(observed.readable).toBe(true);
		expect(observed.writable).toEqual(mounts.map(() => false));
		writeFileSync(
			join(root, 'qualification.json'),
			JSON.stringify(
				{
					image,
					directInitialization: true,
					...observed,
					destinationFiles: readdirSync(destination),
					limits:
						'Synthetic local directory only. Root-owned mode0755 empty mounts are NOT writable by the image user; this is not ACA secret/mount or Blob MI qualification.'
				},
				null,
				2
			),
			{ mode: 0o600 }
		);
		console.log(
			`Direct init passed; root-owned empty runtime mounts are NOT writable. Private evidence: ${root}`
		);
	},
	60_000
);

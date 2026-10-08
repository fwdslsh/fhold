import { afterEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFholdState, readEnvFile, stackEnvFile, writeFileAtomic } from './foundation.js';
import { defaultStackConfig, parseStackConfig } from './stack-config.js';
import {
	directoryRecoveryDestination,
	recoveryEnvironment,
	recoveryStopGrace
} from './recovery-config.js';
import { installHome } from './install.js';
import { recordAppliedRuntime, restartStatus, runtimeRevision } from './runtime-revision.js';
import {
	recoverySnapshot,
	runRecoveryOperation,
	saveRecoveryCredential,
	saveRecoverySettings
} from './recovery.js';
import { buildComposeOptions } from './compose.js';
import { composeConfigJson } from './docker.js';
import { auditCompose } from './secret-audit.js';
import { createBackup } from './backup.js';
import { assertManagedHarnessImage } from './activation.js';

const roots: string[] = [];
const originalDocker = process.env.FH_DOCKER_BIN;
afterEach(() => {
	if (originalDocker === undefined) delete process.env.FH_DOCKER_BIN;
	else process.env.FH_DOCKER_BIN = originalDocker;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'fhold-managed-recovery-test-'));
	roots.push(root);
	const home = join(root, 'home');
	await installHome({ homeDir: home, automaticPorts: false });
	return { home, root };
}

describe('managed runtime recovery', () => {
	it('reads earlier intent with recovery off without mutating it', async () => {
		const { home } = await fixture();
		const old = JSON.parse(readFileSync(join(home, 'state/stack.json'), 'utf8'));
		delete old.recovery;
		writeFileSync(join(home, 'state/stack.json'), JSON.stringify(old));
		const before = readFileSync(join(home, 'state/stack.json'));
		expect(recoverySnapshot(home).settings.enabled).toBe(false);
		expect(readFileSync(join(home, 'state/stack.json'))).toEqual(before);
	});
	it('does not invent a pending restart while reading an earlier recovery-off installation', async () => {
		const { home } = await fixture();
		const compose = join(home, 'system/stack/stack.compose.yml');
		writeFileSync(
			compose,
			readFileSync(compose, 'utf8').replaceAll(
				'/run/fhold-recovery/include.json',
				'/unused-policy-file'
			)
		);
		const path = join(home, 'state/stack.json');
		const old = JSON.parse(readFileSync(path, 'utf8'));
		delete old.recovery;
		writeFileSync(path, JSON.stringify(old));
		const baseline = runtimeRevision(home);
		recordAppliedRuntime(home, baseline);
		const before = readFileSync(path);
		expect(recoverySnapshot(home).settings.enabled).toBe(false);
		expect(restartStatus(home).required).toBe(false);
		expect(readFileSync(path)).toEqual(before);
		old.recovery = {
			...recoverySnapshot(home).settings,
			instanceId: 'different-off-default',
			intervalSeconds: 90
		};
		writeFileSync(path, JSON.stringify(old));
		expect(runtimeRevision(home)).toBe(baseline);
		old.recovery.enabled = true;
		old.recovery.destination = 'azblob://account123/private/agent';
		writeFileSync(path, JSON.stringify(old));
		expect(runtimeRevision(home)).not.toBe(baseline);
	});
	it('requires the native mixed-storage recovery capability only when recovery is enabled', async () => {
		const { root } = await fixture();
		const docker = join(root, 'docker');
		process.env.FH_DOCKER_BIN = docker;
		const config = {
			services: {
				assistant: {
					image: 'synthetic/reviewed:fixture',
					volumes: [{ target: '/etc/codex/requirements.toml' }],
					environment: { FH_RECOVERY_URL: '' }
				}
			}
		};
		writeFileAtomic(
			docker,
			`#!${process.execPath}\nconst label = process.argv[5];\nconsole.log(label.includes('managed-harness-policy') ? '1' : '<no value>');\n`,
			0o700
		);
		await expect(assertManagedHarnessImage(config)).resolves.toBeUndefined();
		config.services.assistant.environment.FH_RECOVERY_URL = 'file:///recovery';
		await expect(assertManagedHarnessImage(config)).rejects.toThrow('mixed-storage recovery');
		writeFileAtomic(docker, `#!${process.execPath}\nconsole.log('1');\n`, 0o700);
		await expect(assertManagedHarnessImage(config)).resolves.toBeUndefined();
	});
	it('derives a fresh recovery identity from the final explicit instance name', async () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-recovery-name-test-'));
		roots.push(root);
		const home = join(root, 'arbitrary-folder');
		await installHome({ homeDir: home, name: 'personal-agent', automaticPorts: false });
		expect(recoverySnapshot(home).settings.instanceId).toBe('personal-agent');
	});
	it('validates destinations, stable identity and bounded timers without inline credentials', () => {
		const base = defaultStackConfig('/tmp/recovery-settings');
		for (const destination of [
			'file:///tmp/private%20backups',
			'azblob://account123/private/agent'
		]) {
			expect(
				parseStackConfig({ ...base, recovery: { ...base.recovery, enabled: true, destination } }).ok
			).toBe(true);
		}
		for (const recovery of [
			{ enabled: true },
			{ destination: 'https://storage.example?secret=test' },
			{ destination: 'file:///' },
			{ destination: 'file:///tmp/../backup' },
			{ destination: 'azblob://account123/bad--container' },
			{ destination: 'azblob://account123/private/a%2fb' },
			{ instanceId: 'user/other' },
			{ instanceId: '' },
			{ intervalSeconds: 0 },
			{ maxUnsavedSeconds: 1 },
			{ operationTimeoutSeconds: 3_601 },
			{ authentication: 'host-cli' },
			{ clientId: 'not-a-uuid' },
			{ token: 'forbidden' }
		])
			expect(parseStackConfig({ ...base, recovery: { ...base.recovery, ...recovery } }).ok).toBe(
				false
			);
		expect(recoveryStopGrace({ ...base.recovery, enabled: true })).toBe(297);
		expect(recoveryStopGrace(base.recovery)).toBe(30);
		expect(parseStackConfig({ ...base, recovery: { ...base.recovery, intervalSeconds: 3600 } }).ok).toBe(true);
	});
	it('saves additive coverage only, derives exact mounts/inputs and retains persistent restart state', async () => {
		const { home, root } = await fixture();
		recordAppliedRuntime(home, runtimeRevision(home));
		const current = recoverySnapshot(home);
		const selection = {
			version: 1,
			paths: Array.from({ length: 150 }, (_, index) => `/work/extra-${index}`),
			sqlite: ['/work/state.db'],
			excludePaths: ['/work/scratch', '/work/scratch/child']
		};
		const settings = {
			...current.settings,
			enabled: true,
			destination: directoryRecoveryDestination(join(root, 'backups'))
		};
		saveRecoverySettings(home, { settings, selection, baselineDigest: current.digest });
		expect(recoverySnapshot(home).selection.paths.length).toBe(150);
		expect(recoverySnapshot(home).selection.excludePaths).toEqual(['/work/scratch']);
		expect(restartStatus(home).required).toBe(true);
		const env = readEnvFile(stackEnvFile(home));
		expect(env.FH_RECOVERY_DIRECTORY).toBe(join(root, 'backups'));
		expect(env.FH_RECOVERY_URL).toBe('file:///recovery');
		expect(env.FH_ASSISTANT_STOP_GRACE).toBe('297s');
		expect(existsSync(join(root, 'backups/descriptor.json'))).toBe(false);
		const resolved = await composeConfigJson(buildComposeOptions(createFholdState(home)));
		if (!resolved.ok) throw new Error(resolved.stderr);
		expect(auditCompose(resolved.config, home)).toEqual([]);
		const config = resolved.config as {
			services: {
				assistant: {
					environment: Record<string, string>;
					stop_grace_period: string;
					volumes: { source: string; target: string }[];
				};
			};
		};
		config.services.assistant.environment.FH_RECOVERY_URL = 'file:///other';
		expect(auditCompose(config, home)).toContain(
			'assistant FH_RECOVERY_URL must match recovery intent'
		);
		config.services.assistant.environment.FH_RECOVERY_URL = 'file:///recovery';
		config.services.assistant.stop_grace_period = '10s';
		expect(auditCompose(config, home)).toContain(
			'Assistant termination grace must cover writer shutdown and both recovery phases.'
		);
		config.services.assistant.stop_grace_period = '297s';
		const mount = config.services.assistant.volumes.find((mount) => mount.target === '/recovery');
		if (!mount) throw new Error('Fixture must have a recovery mount.');
		mount.source = '/tmp/unreviewed';
		expect(auditCompose(config, home).length).toBeGreaterThan(0);
		const before = readFileSync(join(home, 'config/recovery/include.json'));
		expect(() =>
			saveRecoverySettings(home, {
				settings,
				selection: { paths: ['relative'] },
				baselineDigest: recoverySnapshot(home).digest
			})
		).toThrow();
		expect(readFileSync(join(home, 'config/recovery/include.json'))).toEqual(before);
		expect(() =>
			saveRecoverySettings(home, { settings, selection, baselineDigest: current.digest })
		).toThrow('changed');
	});
	it('refuses nested, ancestor and symlink backup destinations before altering settings', async () => {
		const { home, root } = await fixture();
		const current = recoverySnapshot(home);
		for (const directory of [home, join(home, 'workspace/backup'), root]) {
			expect(() =>
				saveRecoverySettings(home, {
					settings: {
						...current.settings,
						enabled: true,
						destination: directoryRecoveryDestination(directory)
					},
					selection: current.selection,
					baselineDigest: current.digest
				})
			).toThrow('outside');
		}
		mkdirSync(join(home, 'workspace/inside'));
		symlinkSync(join(home, 'workspace/inside'), join(root, 'linked'));
		expect(() =>
			saveRecoverySettings(home, {
				settings: {
					...current.settings,
					enabled: true,
					destination: directoryRecoveryDestination(join(root, 'linked'))
				},
				selection: current.selection,
				baselineDigest: current.digest
			})
		).toThrow();
		expect(recoverySnapshot(home).settings).toEqual(current.settings);
	});
	it('stores Blob credentials privately, never exports or ports them, and tracks changes for restart', async () => {
		const { home, root } = await fixture();
		const current = recoverySnapshot(home);
		const settings = {
			...current.settings,
			enabled: true,
			destination: 'azblob://account123/private/agent'
		};
		saveRecoverySettings(home, {
			settings,
			selection: current.selection,
			baselineDigest: current.digest
		});
		recordAppliedRuntime(home, runtimeRevision(home));
		const secret =
			'DefaultEndpointsProtocol=https;AccountName=account123;AccountKey=synthetic-secret-not-live;EndpointSuffix=core.windows.net';
		saveRecoveryCredential(home, secret);
		expect(
			lstatSync(join(home, 'state/secrets/fhold_recovery_connection_string')).mode & 0o777
		).toBe(0o600);
		expect(recoverySnapshot(home).credentialConfigured).toBe(true);
		expect(JSON.stringify(recoverySnapshot(home))).not.toContain('synthetic-secret');
		expect(readFileSync(stackEnvFile(home), 'utf8')).not.toContain('synthetic-secret');
		expect(readFileSync(join(home, 'state/stack.json'), 'utf8')).not.toContain('synthetic-secret');
		expect(restartStatus(home).required).toBe(true);
		const backup = await createBackup({ sourceHome: home, destination: join(root, 'portable') });
		expect(backup.files.some((file) => file.path.includes('recovery'))).toBe(false);
		expect(JSON.stringify(backup)).not.toContain('synthetic-secret');
	});
	it('saves changed coverage in the same namespace without replacing native receipts', async () => {
		const { home, root } = await fixture();
		const current = recoverySnapshot(home);
		const settings = {
			...current.settings,
			enabled: true,
			destination: directoryRecoveryDestination(join(root, 'checkpoints'))
		};
		saveRecoverySettings(home, {
			settings,
			selection: current.selection,
			baselineDigest: current.digest
		});
		const namespace = recoveryEnvironment(settings).FH_RECOVERY_STATE_DIR.split('/').at(-1);
		if (!namespace) throw new Error('Fixture needs a namespace.');
		const receipt = join(home, 'data/recovery', namespace, 'receipt.json');
		writeFileAtomic(receipt, 'preserve exact native receipt');
		const selection = { ...current.selection, excludePaths: ['/work/private-drive'] };
		saveRecoverySettings(home, {
			settings,
			selection,
			baselineDigest: recoverySnapshot(home).digest
		});
		expect(recoverySnapshot(home).selection.excludePaths).toEqual(selection.excludePaths);
		expect(readFileSync(receipt, 'utf8')).toBe('preserve exact native receipt');
		const next = {
			...settings,
			destination: directoryRecoveryDestination(join(root, 'new-checkpoints'))
		};
		saveRecoverySettings(home, {
			settings: next,
			selection,
			baselineDigest: recoverySnapshot(home).digest
		});
		expect(readFileSync(receipt, 'utf8')).toBe('preserve exact native receipt');
		expect(recoveryEnvironment(next).FH_RECOVERY_STATE_DIR).not.toBe(
			recoveryEnvironment(settings).FH_RECOVERY_STATE_DIR
		);
	});
	it('requires confirmation and stopped writers before init/restore, without automatic down or takeover', async () => {
		const { home, root } = await fixture();
		await expect(runRecoveryOperation(home, 'init')).rejects.toThrow('Confirm');
		const current = recoverySnapshot(home);
		saveRecoverySettings(home, {
			settings: {
				...current.settings,
				enabled: true,
				destination: directoryRecoveryDestination(join(root, 'backups'))
			},
			selection: current.selection,
			baselineDigest: current.digest
		});
		const docker = join(root, 'docker');
		process.env.FH_DOCKER_BIN = docker;
		for (const status of ['running', 'paused', 'restarting', 'created', 'unknown']) {
			writeFileAtomic(
				docker,
				`#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args[0] === 'ps') console.log(args.includes('{{.State}}') ? '${status}' : '');\nelse throw new Error('Unexpected Docker operation: ' + args.join(' '));\n`,
				0o700
			);
			for (const action of ['init', 'restore'] as const)
				await expect(runRecoveryOperation(home, action, true)).rejects.toThrow(
					'Stop this instance'
				);
		}
		expect(existsSync(join(root, 'backups/descriptor.json'))).toBe(false);
	});
});

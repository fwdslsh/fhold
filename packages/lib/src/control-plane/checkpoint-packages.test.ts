import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
	symlinkSync
} from 'node:fs';
import { join } from 'node:path';
import { defaultStackConfig } from './stack-config.js';
import { defaultRecoverySettings } from './recovery-config.js';
import { installHome } from './install.js';
import { runRecoveryOperation } from './recovery.js';
import {
	assertCheckpointImportPaths,
	exportCheckpointPackage,
	importCheckpointPackage,
	previewCheckpointPackage
} from './checkpoint-packages.js';
import { classifyInstall } from './state.js';

test('checkpoint import refuses overlapping and linked paths before any target writes', async () => {
	const root = mkdtempSync('/tmp/fhold-package-path-test-');
	const home = join(root, 'source');
	await installHome({ homeDir: home, automaticPorts: false });
	const input = {
		directory: join(root, 'package'),
		destinationHome: join(root, 'target'),
		backupDirectory: join(root, 'backups'),
		previewDigest: 'a'.repeat(64)
	};
	for (const backupDirectory of [
		home,
		join(home, 'new-backups'),
		input.directory,
		join(input.directory, 'backup')
	]) {
		await expect(
			importCheckpointPackage(home, { ...input, backupDirectory }, true)
		).rejects.toThrow('separate');
		expect(existsSync(input.destinationHome)).toBe(false);
	}
	mkdirSync(join(root, 'real'));
	symlinkSync(join(root, 'real'), join(root, 'linked'));
	expect(() =>
		assertCheckpointImportPaths(home, { ...input, backupDirectory: join(root, 'linked', 'backup') })
	).toThrow('unsafe');
	expect(existsSync(input.destinationHome)).toBe(false);
});

const image = process.env.FH_CHECKPOINT_PACKAGE_IMAGE;
test.skipIf(!image)(
	'native image exports with recurring backups off and restores an empty home before normal seeding',
	async () => {
		const match = image?.match(/^(.+)\/fhold-assistant:([^:]+)$/);
		if (!match) throw new Error('Use an exact fhold-assistant image tag.');
		const root = mkdtempSync(
			join(process.env.FH_CHECKPOINT_PACKAGE_TEST_ROOT || '/tmp', 'fhold-package-native-')
		);
		const home = join(root, 'source'),
			target = join(root, 'restored'),
			directory = join(root, 'package,100% 空'),
			backupDirectory = join(root, 'backups,100% 空');
		const config = defaultStackConfig(home);
		config.deployment.projectName = `package-${root.slice(-6).toLowerCase()}`;
		config.deployment.imageNamespace = match[1];
		config.deployment.images.assistant = match[2];
		config.recovery = defaultRecoverySettings(config.deployment.projectName);
		await installHome({ homeDir: home, config, automaticPorts: false });
		const native = join(home, 'data/assistant/.local/share/opencode/opencode.db');
		const db = new Database(native);
		db.exec(
			"PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE package_wal_fixture(value TEXT); INSERT INTO package_wal_fixture VALUES ('committed WAL')"
		);
		const settingsBefore = readFileSync(join(home, 'state/stack.json'), 'utf8');
		try {
			const exported = await exportCheckpointPackage(home, directory);
			expect(exported.scope).toBe('assistant-checkpoint');
			expect(readFileSync(join(home, 'state/stack.json'), 'utf8')).toBe(settingsBefore);
			expect(existsSync(join(home, 'data/recovery/receipt.json'))).toBe(false);
			const preview = await previewCheckpointPackage(home, directory);
			expect(preview.previewDigest).toBe(exported.previewDigest);
			const result = await importCheckpointPackage(
				home,
				{
					directory,
					destinationHome: target,
					backupDirectory,
					previewDigest: preview.previewDigest
				},
				true
			);
			expect(result.homeDir).toBe(target);
			expect(classifyInstall(target)).toBe('setup_incomplete');
			const restored = new Database(
				join(target, 'data/assistant/.local/share/opencode/opencode.db'),
				{ readonly: true }
			);
			try {
				expect(restored.query('SELECT value FROM package_wal_fixture').all()).toEqual([
					{ value: 'committed WAL' }
				]);
			} finally {
				restored.close();
			}
			expect(await runRecoveryOperation(target, 'restore', true)).toContain(
				'restored and validated'
			);
			expect(readFileSync(join(home, 'state/stack.json'), 'utf8')).toBe(settingsBefore);
			expect(db.query('SELECT value FROM package_wal_fixture').all()).toEqual([
				{ value: 'committed WAL' }
			]);
			const cli = process.env.FH_CHECKPOINT_PACKAGE_CLI;
			if (cli) {
				const cliTarget = join(root, 'cli-restored');
				const env = { ...process.env };
				delete env.FH_SKELETON_DIR;
				delete env.FH_REPO_ROOT;
				const imported = spawnSync(
					cli,
					[
						'--name',
						home,
						'recovery',
						'import',
						'--from',
						directory,
						'--home',
						cliTarget,
						'--backups',
						join(root, 'cli-backups'),
						'--preview-digest',
						preview.previewDigest,
						'--confirm-stopped'
					],
					{ env, cwd: root, encoding: 'utf8', timeout: 60_000 }
				);
				expect(imported.error).toBeUndefined();
				expect(imported.status, imported.stderr).toBe(0);
				expect(JSON.parse(imported.stdout)).toMatchObject({
					restored: true,
					homeDir: cliTarget,
					generation: preview.generation
				});
				expect(existsSync(join(cliTarget, 'system/stack/stack.compose.yml'))).toBe(true);
				expect(await runRecoveryOperation(cliTarget, 'restore', true)).toContain(
					'restored and validated'
				);
			}
			writeFileSync(
				join(root, 'qualification.json'),
				JSON.stringify(
					{
						image,
						exported,
						restored: result,
						sameAssistant: true,
						sourceUnchanged: true,
						nativeWAL: true,
						compiledCli: Boolean(cli)
					},
					null,
					2
				),
				{ mode: 0o600 }
			);
			console.info(`Checkpoint package native evidence: ${root}`);
		} finally {
			db.close();
		}
	},
	90_000
);

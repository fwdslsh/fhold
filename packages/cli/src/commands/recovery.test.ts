import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHome, recoverySnapshot, restartStatus } from '@fhold/lib';
import { main } from '../main.js';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('recovery CLI saves directory/policy/credentials without starting, claiming or exposing anything', async () => {
	const root = mkdtempSync(join(tmpdir(), 'fhold-recovery-cli-test-'));
	roots.push(root);
	const home = join(root, 'home');
	await installHome({ homeDir: home, automaticPorts: false });
	const selection = join(root, 'selection.json');
	writeFileSync(
		selection,
		JSON.stringify({
			version: 1,
			paths: ['/work/extra'],
			sqlite: ['/work/extra/state.sqlite'],
			excludePaths: ['/work/scratch']
		})
	);
	await main([
		'--name',
		home,
		'recovery',
		'configure',
		'--directory',
		join(root, 'checkpoints'),
		'--selection-file',
		selection,
		'--interval',
		'30',
		'--instance-id',
		'cli-agent'
	]);
	expect(recoverySnapshot(home).settings).toMatchObject({
		enabled: true,
		instanceId: 'cli-agent',
		intervalSeconds: 30
	});
	expect(recoverySnapshot(home).selection.sqlite).toEqual(['/work/extra/state.sqlite']);
	expect(restartStatus(home).required).toBe(true);
	expect(existsSync(join(root, 'checkpoints/descriptor.json'))).toBe(false);
	await expect(main(['--name', home, 'recovery', 'init'])).rejects.toThrow('Confirm');
	await expect(main(['--name', home, 'recovery', 'restore'])).rejects.toThrow('Confirm');
	const credential = join(root, 'private-connection');
	writeFileSync(
		credential,
		'DefaultEndpointsProtocol=https;AccountName=account123;AccountKey=synthetic-not-real;EndpointSuffix=core.windows.net',
		{ mode: 0o600 }
	);
	await main(['--name', home, 'recovery', 'credential', '--from', credential]);
	expect(recoverySnapshot(home).credentialConfigured).toBe(true);
	expect(JSON.stringify(recoverySnapshot(home))).not.toContain('synthetic-not-real');
	await main(['--name', home, 'recovery', 'disable']);
	expect(recoverySnapshot(home).settings.enabled).toBe(false);
	expect(
		readFileSync(join(home, 'state/secrets/fhold_recovery_connection_string'), 'utf8')
	).toContain('synthetic-not-real');
});

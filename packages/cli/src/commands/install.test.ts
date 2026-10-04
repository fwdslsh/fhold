import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCredentialId, defaultStackConfig } from '@fhold/lib';

import { bootstrapInstall } from './install.js';

const roots: string[] = [];
const originalHome = process.env.FH_HOME;
const originalRepo = process.env.FH_REPO_ROOT;

afterEach(() => {
	if (originalHome === undefined) delete process.env.FH_HOME;
	else process.env.FH_HOME = originalHome;
	if (originalRepo === undefined) delete process.env.FH_REPO_ROOT;
	else process.env.FH_REPO_ROOT = originalRepo;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('install', () => {
	it('preserves a custom configuration name as project intent and the derived hostname without Docker', async () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-named-install-'));
		roots.push(root);
		process.env.FH_HOME = join(root, 'home');
		process.env.FH_REPO_ROOT = join(import.meta.dir, '../../../..');
		const intent = defaultStackConfig(process.env.FH_HOME);
		intent.deployment.projectName = 'personal-agent';
		const configFile = join(root, 'stack.json');
		writeFileSync(configFile, JSON.stringify(intent));
		await bootstrapInstall({ start: false, configFile });
		const config = JSON.parse(
			readFileSync(join(process.env.FH_HOME, 'state', 'stack.json'), 'utf8')
		);
		expect(config.deployment.projectName).toBe('personal-agent');
		expect(readFileSync(join(process.env.FH_HOME, 'state', 'stack.env'), 'utf8')).toContain(
			'FH_INSTANCE_HOSTNAME=personal-agent'
		);
	});
	it('refuses invalid configuration names before materializing a new home', async () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-invalid-name-'));
		roots.push(root);
		process.env.FH_HOME = join(root, 'home');
		const configFile = join(root, 'stack.json');
		for (const name of ['', 'Agent', 'my agent', '-agent', 'agent/slash', 'a'.repeat(129)]) {
			const config = defaultStackConfig(process.env.FH_HOME);
			config.deployment.projectName = name;
			writeFileSync(configFile, JSON.stringify(config));
			await expect(bootstrapInstall({ start: false, configFile })).rejects.toThrow('valid project');
			expect(existsSync(process.env.FH_HOME)).toBe(false);
		}
	});
	it('materializes one-stack intent without launching a browser or Docker', async () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-install-'));
		roots.push(root);
		process.env.FH_HOME = join(root, 'home');
		process.env.FH_REPO_ROOT = join(import.meta.dir, '../../../..');

		await bootstrapInstall({ start: false });

		const config = JSON.parse(
			readFileSync(join(process.env.FH_HOME, 'state', 'stack.json'), 'utf8')
		) as {
			version: number;
			assistant: { bindAddress: string; port: number };
			gateway: { enabled: boolean };
			credentials: Record<string, { policy: string }>;
		};
		expect(config).toMatchObject({
			version: 1,
			assistant: { bindAddress: '127.0.0.1' },
			gateway: { enabled: false },
			credentials: { owner: { policy: 'full' } }
		});
		expect(config.assistant.port).toBeGreaterThan(0);
		expect(config.assistant.port).toBeLessThanOrEqual(65535);
		expect(
			readFileSync(join(process.env.FH_HOME, 'system', 'stack', 'stack.compose.yml'), 'utf8')
		).toContain('assistant:');
		expect(readFileSync(join(process.env.FH_HOME, 'state', 'stack.env'), 'utf8')).toContain(
			'FH_ENABLED_ADDONS='
		);
		expect(
			readFileSync(join(process.env.FH_HOME, 'state', 'credentials', 'owner', 'key'), 'utf8').trim()
		).toHaveLength(43);
		expect(readFileSync(join(process.env.FH_HOME, 'state', 'stack.env'), 'utf8')).toContain(
			'FH_SETUP_COMPLETE=false'
		);
		expect(existsSync(join(process.env.FH_HOME, 'config', 'assistant', 'persona.md'))).toBe(true);
		expect(
			JSON.parse(readFileSync(join(process.env.FH_HOME, 'config', 'akm', 'config.json'), 'utf8'))
		).toMatchObject({ defaults: { engine: 'scheduled' } });
		expect(
			existsSync(join(process.env.FH_HOME, 'system', 'assistant', 'agents', 'scheduled.md'))
		).toBe(true);
	});

	it('reconciles named keys and portal bundles to supplied install intent', async () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-install-config-'));
		roots.push(root);
		process.env.FH_HOME = join(root, 'home');
		process.env.FH_REPO_ROOT = join(import.meta.dir, '../../../..');
		const config = defaultStackConfig();
		config.assistant.port = 43110;
		config.gateway.port = 43130;
		config.credentials.automation = { id: createCredentialId(), policy: 'read' };
		config.portals.discord.credential = 'automation';
		const configFile = join(root, 'stack.json');
		writeFileSync(configFile, JSON.stringify(config));

		await bootstrapInstall({ start: false, configFile });
		const persisted = JSON.parse(readFileSync(join(process.env.FH_HOME, 'state', 'stack.json'), 'utf8'));
		expect(persisted.assistant.port).toBe(43110);
		expect(persisted.gateway.port).toBe(43130);

		expect(existsSync(join(process.env.FH_HOME, 'state', 'credentials', 'automation', 'key'))).toBe(
			true
		);
		const bundle = JSON.parse(
			readFileSync(
				join(process.env.FH_HOME, 'state', 'portal-credentials', 'discord', 'credentials.json'),
				'utf8'
			)
		) as { default: string; credentials: Record<string, string> };
		expect(bundle.default).toBe('automation');
		expect(Object.keys(bundle.credentials)).toEqual(['automation']);
	});
});

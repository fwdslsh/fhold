import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStackConfig } from '@fhold/lib';

import cliPackage from '../../package.json' with { type: 'json' };

import { bootstrapInstall } from './install.js';
import { connectionDetails } from './connect.js';

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

async function setup(): Promise<string> {
	const root = mkdtempSync(join(tmpdir(), 'fhold-connect-command-'));
	roots.push(root);
	process.env.FH_HOME = join(root, 'home');
	process.env.FH_REPO_ROOT = join(import.meta.dir, '../../../..');
	await bootstrapInstall({ start: false });
	return process.env.FH_HOME;
}

describe('connection guidance', () => {
	it('describes trusted native OpenCode access without exposing its password', async () => {
		const home = await setup();
		const details = connectionDetails(home, 'opencode');
		const saved = readStackConfig(home);
		if (!saved.ok) throw new Error(saved.error);
		expect(details.url).toBe(`http://127.0.0.1:${saved.config.assistant.port}`);
		expect(details.username).toBe('opencode');
		expect(details.passwordFile).toEndWith('/state/secrets/fhold_opencode_password');
		expect(details).not.toHaveProperty('password');
	});

	it('describes MCP and Claude configuration without revealing keys by default', async () => {
		const home = await setup();
		const mcp = connectionDetails(home, 'mcp', { credential: 'owner' });
		const saved = readStackConfig(home);
		if (!saved.ok) throw new Error(saved.error);
		expect(mcp.url).toBe(`http://127.0.0.1:${saved.config.gateway.port}/mcp`);
		expect(mcp.credentialKey).toBeUndefined();
		const revealed = connectionDetails(home, 'claude', {
			credential: 'owner',
			showKey: true
		});
		expect(revealed.credentialKey?.length).toBeGreaterThanOrEqual(32);
		expect(revealed.extension).toBeUndefined();
		expect(revealed.note).toContain('No public MCPB download is published');
		expect(revealed.note).toContain(`artifacts/fhold-claude-desktop-${cliPackage.version}.mcpb`);
		expect(revealed.note).toContain('bun run --cwd packages/claude-desktop pack');
	});
});

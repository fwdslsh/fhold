import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredential, mapPortalUser, rotateCredential, savePortalTokens, saveStackIntent, setCredentialPolicy } from './operations.js';
import { installHome } from './install.js';
import { defaultStackConfig, readStackConfig } from './stack-config.js';
import { acquireStackLock, releaseStackLock } from './lock.js';

const roots: string[] = [];
async function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'fhold-operation-test-')); roots.push(root);
	const home = join(root, 'home');
	await installHome({ homeDir: home });
	return { root, home };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('competing installs cannot overwrite the first installation intent or credentials', async () => {
	const root = mkdtempSync(join(tmpdir(), 'fhold-install-race-')); roots.push(root);
	const home = join(root, 'home');
	const first = defaultStackConfig(home); first.assistant.port = 4191;
	const second = defaultStackConfig(home); second.assistant.port = 4192;
	const results = await Promise.allSettled([installHome({ homeDir: home, config: first }), installHome({ homeDir: home, config: second })]);
	expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
	const config = readStackConfig(home); expect(config.ok && config.config.assistant.port).toBe(4191);
	expect(readFileSync(join(home, 'state/credentials/owner/key'), 'utf8').trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test('shared credential changes reconcile scoped bundles and read latest intent under exclusion', async () => {
	const { home } = await fixture();
	createCredential(home, { username: 'family', policy: 'read' });
	mapPortalUser(home, { portal: 'discord', userId: '123456789012345678', username: 'family' });
	const before = readFileSync(join(home, 'state/credentials/family/key'), 'utf8');
	rotateCredential(home, 'family');
	expect(readFileSync(join(home, 'state/credentials/family/key'), 'utf8')).not.toBe(before);
	setCredentialPolicy(home, 'family', 'chat');
	const bundle = JSON.parse(readFileSync(join(home, 'state/portal-credentials/discord/credentials.json'), 'utf8'));
	expect(bundle.users['123456789012345678']).toBe('family');
	const config = readStackConfig(home); expect(config.ok && config.config.credentials.family?.policy).toBe('chat');
	const lock = acquireStackLock(join(home, 'data'));
	try { expect(() => createCredential(home, { username: 'blocked', policy: 'read' })).toThrow('lifecycle_in_progress'); }
	finally { releaseStackLock(lock); }
	expect(existsSync(join(home, 'state/credentials/blocked'))).toBe(false);
});

test('settings saves refuse stale whole snapshots without losing later credential changes', async () => {
	const { home } = await fixture();
	const result = readStackConfig(home); if (!result.ok) throw new Error(result.error);
	const baseline = structuredClone(result.config);
	const stale = structuredClone(baseline); stale.assistant.port = 4921;
	createCredential(home, { username: 'later', policy: 'read' });
	expect(() => saveStackIntent(home, stale, baseline)).toThrow('changed since refresh');
	const latest = readStackConfig(home); expect(latest.ok && latest.config.credentials.later?.policy).toBe('read');
	expect(latest.ok && latest.config.assistant.port).toBe(baseline.assistant.port);
});

test('canonical aliases share the same persisted project and selected instance', async () => {
	const { home, root } = await fixture();
	const alias = join(root, 'alias'); symlinkSync(home, alias);
	await expect(installHome({ homeDir: alias })).rejects.toThrow('already installed');
	expect(readStackConfig(alias)).toEqual(readStackConfig(home));
});

test('a later unsafe token destination fails before replacing any earlier portal token', async () => {
	const { home, root } = await fixture();
	const bot = join(home, 'state/secrets/slack_bot_token');
	const app = join(home, 'state/secrets/slack_app_token');
	const outside = join(root, 'outside-token'); writeFileSync(outside, 'outside sentinel');
	const before = readFileSync(bot, 'utf8');
	// Only this generated fixture leaf is replaced; no real user data is involved.
	unlinkSync(app); symlinkSync(outside, app);
	expect(() => savePortalTokens(home, { portal: 'slack', botToken: 'new-bot-token', appToken: 'new-app-token' })).toThrow('unsafe component');
	expect(readFileSync(bot, 'utf8')).toBe(before);
	expect(readFileSync(outside, 'utf8')).toBe('outside sentinel');
});

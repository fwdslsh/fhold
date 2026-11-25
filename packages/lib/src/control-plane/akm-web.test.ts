import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { akmWebComposeFile, akmWebSecretFile, readAkmWebSecret } from './akm-web.js';
import { defaultStackConfig, parseStackConfig, writeStackConfig } from './stack-config.js';
import { installHome } from './install.js';
import { createFholdState } from './foundation.js';
import { buildComposeOptions } from './compose.js';
import { KnowledgeUi } from '../management/knowledge-ui.js';
import { runtimeRevision } from './runtime-revision.js';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
	const home = mkdtempSync(join(tmpdir(), 'fhold-web-'));
	roots.push(home);
	await installHome({ homeDir: home, automaticPorts: false });
	return home;
}
const settings = {
	enabled: true,
	origin: 'http://localhost:3811',
	publish: true,
	port: 3811,
	bindAddress: '127.0.0.1'
};

test('disabled hosting requires no credential, overlay, or port; enabling generates only a dedicated private secret', async () => {
	const home = await fixture();
	expect(existsSync(akmWebSecretFile(home))).toBe(false);
	expect(buildComposeOptions(createFholdState(home)).files).not.toContain(akmWebComposeFile(home));
	const config = defaultStackConfig(home);
	config.assistant.web = settings;
	writeStackConfig(home, config);
	const secret = readAkmWebSecret(home);
	expect(secret).toMatch(/^[a-f0-9]{64}$/);
	expect(statSync(akmWebSecretFile(home)).mode & 0o777).toBe(0o600);
	const overlay = readFileSync(akmWebComposeFile(home), 'utf8');
	expect(overlay).not.toContain(secret);
	expect(JSON.parse(overlay).services.assistant.ports[0].host_ip).toBe('127.0.0.1');
	expect(buildComposeOptions(createFholdState(home)).files).toContain(akmWebComposeFile(home));
	writeStackConfig(home, config);
	expect(readAkmWebSecret(home)).toBe(secret);
	config.assistant.web = { ...settings, enabled: false };
	writeStackConfig(home, config);
	expect(buildComposeOptions(createFholdState(home)).files).not.toContain(akmWebComposeFile(home));
	expect(readAkmWebSecret(home)).toBe(secret); // disabling never destroys operator credentials
});

test('persistent access returns the canonical URL and private credential without spawning or owning a process', async () => {
	const home = await fixture();
	const config = defaultStackConfig(home);
	config.assistant.web = { ...settings, origin: 'https://knowledge.example', publish: false };
	writeStackConfig(home, config);
	const ui = new KnowledgeUi(home);
	try {
		expect(await ui.open({ loopbackPort: 40000 })).toEqual({
			mode: 'persistent',
			url: 'https://knowledge.example/',
			secret: readAkmWebSecret(home)
		});
	} finally {
		await ui.close();
	}
	expect(readAkmWebSecret(home)).toHaveLength(64);
	expect(
		JSON.parse(readFileSync(akmWebComposeFile(home), 'utf8')).services.assistant.ports
	).toBeUndefined();
});

test('native origin and publication conflicts are rejected before settings are written', async () => {
	const home = await fixture();
	for (const origin of [
		'',
		'https://example/akm',
		'https://user:secret@example',
		'https://example?login=x'
	]) {
		const config = defaultStackConfig(home);
		config.assistant.web = { ...settings, origin };
		expect(parseStackConfig(config).ok).toBe(false);
	}
	const config = defaultStackConfig(home);
	config.assistant.web = { ...settings, port: config.assistant.port };
	expect(() => writeStackConfig(home, config)).toThrow('conflicts');
	expect(existsSync(akmWebSecretFile(home))).toBe(false);
});

test('web publication accounts for Guardian activated by a portal', () => {
	const config = defaultStackConfig('/synthetic/home');
	config.gateway.enabled = false;
	config.portals.discord.enabled = true;
	config.assistant.web = { ...settings, port: config.gateway.port };
	expect(parseStackConfig(config).ok).toBe(false);
});

test('secret rotation changes restart inputs while snapshots contain settings only', async () => {
	const home = await fixture();
	const config = defaultStackConfig(home);
	config.assistant.web = settings;
	writeStackConfig(home, config);
	const before = runtimeRevision(home);
	writeFileSync(akmWebSecretFile(home), `${'b'.repeat(64)}\n`, { mode: 0o600 });
	expect(runtimeRevision(home)).not.toBe(before);
	expect(readFileSync(join(home, 'state/stack.json'), 'utf8')).not.toContain('b'.repeat(64));
});

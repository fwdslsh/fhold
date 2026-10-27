import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repository = join(import.meta.dir, '../../../..');

function asset(path: string): string {
	return readFileSync(join(repository, path), 'utf8');
}

describe('release surface', () => {
	it('ships one core service and only three optional profiles', () => {
		const compose = asset('packages/skeleton/system/stack/stack.compose.yml');
		const serviceBlock = compose.slice(
			compose.indexOf('services:'),
			compose.indexOf('\nnetworks:')
		);
		const services = [...serviceBlock.matchAll(/^ {2}([a-z][a-z0-9_-]+):$/gm)].map(
			(match) => match[1]
		);
		expect(services).toEqual(['assistant', 'guardian', 'discord', 'slack']);
		expect(compose).toContain('profiles: [gateway, discord, slack]');
		expect(compose).toContain('networks: [agent_net]');
		expect(compose).not.toContain('/v1/chat/completions');
		expect(compose.match(/cap_drop: \[ALL\]/g)).toHaveLength(4);
		expect(compose.match(/no-new-privileges:true/g)).toHaveLength(4);
		expect(compose.match(/init: true/g)).toHaveLength(4);
		expect(compose).not.toContain('OPENCODE_DISABLE_PROJECT_CONFIG');
		expect(compose).toContain('${FH_HOME:?}/config/assistant:/home/fhold/.config/opencode');
		expect(compose).toContain('${FH_HOME:?}/system/assistant:/etc/opencode:ro');
		expect(compose).not.toContain(':/etc/opencode/opencode.json:ro');
		expect(compose).toContain('${FH_HOME:?}/system/codex/config.toml:/etc/codex/config.toml:ro');
		expect(compose).toContain('${FH_HOME:?}/system/codex/requirements.toml:/etc/codex/requirements.toml:ro');
		expect(compose).toContain('${FH_HOME:?}/system/claude/managed-settings.json:/etc/claude-code/managed-settings.json:ro');
		expect(compose).not.toContain(':/etc/codex:ro');
		expect(compose).not.toContain(':/etc/claude-code:ro');
		expect(compose).not.toContain('FH_OPENCODE_PREFERENCES_FILE:-opencode.json}:/');
		expect(compose).not.toContain('GUARDIAN_MODERATOR_URL');
		expect(compose).toContain('fhold-healthcheck');
		expect(compose).toContain('host_ip: "${FH_ASSISTANT_BIND_ADDRESS:-127.0.0.1}"');
		expect(compose).toContain('GUARDIAN_AUTH_DIR: /run/fhold-credentials');
		expect(compose).toContain('${FH_HOME:?}/state/credentials:/run/fhold-credentials:ro');
		expect(compose).toContain(
			'${FH_HOME:?}/state/portal-credentials/discord:/run/fhold-credentials:ro'
		);
		expect(compose).toContain('PORTAL_CREDENTIALS_FILE: /run/fhold-credentials/credentials.json');
		expect(compose).not.toContain('GUARDIAN_OWNER_POLICY:');
	});

	it('ships explicit Guardian chat, read, and full agent profiles', () => {
		const remote = asset('packages/skeleton/system/assistant/agents/remote.md');
		const read = asset('packages/skeleton/system/assistant/agents/remote-read.md');
		const full = asset('packages/skeleton/system/assistant/agents/remote-full.md');
		expect(remote).toContain('action: "*", resource: "*", effect: deny');
		expect(remote).toContain('Restricted agent used only by the Guardian MCP gateway');
		expect(read).toContain('action: "*", resource: "*", effect: deny');
		expect(read).toContain('action: "read", resource: "*", effect: allow');
		expect(read).toContain('action: "read", resource: "*.env", effect: deny');
		expect(read).toContain('action: "external_directory", resource: "/stash/*", effect: allow');
		expect(read).toContain('action: "read", resource: "/stash/secrets/*", effect: deny');
		expect(read).toContain('action: "read", resource: "/stash/env/*", effect: deny');
		expect(read).not.toContain('  grep: allow');
		expect(full).not.toContain('permission:');
		expect(full).toContain("Assistant's OpenCode permission configuration");
	});

	it('uses native task engine and agent selection without a product sandbox', () => {
		const config = JSON.parse(asset('packages/skeleton/config/akm/config.json'));
		expect(config.harnesses).toEqual({ opencode: { args: ['run', '--standalone'] } });
		expect(config.engines).toBeUndefined();
	});

	it('keeps shared instructions policy-aware without forbidding full remote work', () => {
		const instructions = asset('packages/skeleton/system/assistant/AGENTS.md');
		expect(instructions).toContain('The `remote` (chat) profile cannot use tools.');
		expect(instructions).toContain('The `remote-full` profile may use');
		expect(instructions).toContain('explicit nonsecret knowledge saves');
		expect(instructions).toContain('Native tool approvals still apply');
		expect(instructions).toContain('native AKM plugins');
		expect(instructions).not.toContain('not the Guardian MCP endpoint');
	});
});

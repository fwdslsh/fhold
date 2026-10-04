import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { auditCompose } from './secret-audit.js';
import {
	defaultStackConfig,
	readStackConfig,
	stackConfigEnv,
	writeStackConfig
} from './stack-config.js';
import libPackage from '../../package.json' with { type: 'json' };

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const assistantEnvironment = {
	AKM_BUNDLE_DIR: '/stash',
	AKM_CACHE_DIR: '/opt/akm/cache',
	AKM_CONFIG_DIR: '/etc/akm',
	AKM_DATA_DIR: '/opt/akm/data',
	AKM_STATE_DIR: '/opt/akm/data/state',
	AKM_AUTO_MEMORY: '0',
	AKM_AUTO_LEARNING: '0',
	AKM_REDACT_HIGH_ENTROPY: '1',
	AKM_REDACT_PII: '1',
	FH_AUTOMATIC_MEMORY: '1',
	FH_CODEX_REMOTE: '1',
	FH_CODEX_SANDBOX: 'workspace-write',
	FH_CLAUDE_REMOTE: '1',
	TZ: defaultStackConfig().assistant.timezone,
	HOME: '/home/fhold',
	OPENCODE_CONFIG_DIR: '/etc/opencode',
	OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
	OPENCODE_DISABLE_CLAUDE_CODE: 'true',
	OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
	OPENCODE_DISABLE_EMBEDDED_WEB_UI: 'true',
	OPENCODE_API_URL: 'http://127.0.0.1:4096',
	OPENCODE_PORT: '4096',
	OPENCODE_SERVER_USERNAME: 'user',
	OPENCODE_SERVER_PASSWORD_FILE: '/run/secrets/opencode_server_password',
	TERM: 'xterm-256color'
};

function assistantService(homeDir = '/tmp/home') {
	const stack = readStackConfig(homeDir);
	return {
		image: `fwdslsh/fhold-assistant:${libPackage.version}`,
		hostname: stack.ok ? stackConfigEnv(stack.config).FH_INSTANCE_HOSTNAME : 'fhold',
		init: true,
		user: '1000:1000',
		cap_drop: ['ALL'],
		security_opt: ['no-new-privileges:true'],
		environment: { ...assistantEnvironment },
		secrets: [
			{
				source: 'opencode_server_password',
				target: '/run/secrets/opencode_server_password'
			}
		],
		networks: ['agent_net'],
		ports: [
			{
				host_ip: '127.0.0.1',
				target: 4096,
				published: '3810',
				protocol: 'tcp',
				mode: 'ingress'
			}
		],
		volumes: [
			...[
				['opencode/opencode.json', 'opencode/opencode.json'],
				['codex/config.toml', 'codex/config.toml'],
				['codex/requirements.toml', 'codex/requirements.toml'],
				['claude/managed-settings.json', 'claude-code/managed-settings.json']
			].map(([source, target]) => ({
				type: 'bind',
				source: `${homeDir}/config/${source}`,
				target: `/etc/${target}`,
				read_only: true
			})),
			{ type: 'bind', source: `${homeDir}/data/assistant`, target: '/home/fhold' },
			{
				type: 'bind',
				source: `${homeDir}/config/assistant`,
				target: '/home/fhold/.config/opencode',
				read_only: true
			},
			{
				type: 'bind',
				source: `${homeDir}/knowledge/secrets/auth.json`,
				target: '/home/fhold/.local/share/opencode/auth.json'
			},
			{
				type: 'bind',
				source: `${homeDir}/system/assistant`,
				target: '/etc/opencode',
				read_only: true
			},
			{
				type: 'bind',
				source: `${homeDir}/config/akm`,
				target: '/etc/akm'
			},
			{ type: 'bind', source: `${homeDir}/knowledge`, target: '/stash' },
			{ type: 'bind', source: `${homeDir}/data/akm/cache`, target: '/opt/akm/cache' },
			{ type: 'bind', source: `${homeDir}/data/akm/data`, target: '/opt/akm/data' },
			{ type: 'bind', source: `${homeDir}/workspace`, target: '/work' }
		],
		healthcheck: {
			test: ['CMD', 'fhold-healthcheck']
		},
		logging: {
			driver: 'json-file',
			options: { 'max-size': '10m', 'max-file': '3' }
		}
	};
}

function baseConfig(homeDir = '/tmp/home') {
	const stack = readStackConfig(homeDir);
	const project = stack.ok ? stack.config.deployment.projectName : 'fhold';
	return {
		secrets: {
			opencode_server_password: {
				file: `${homeDir}/state/secrets/fhold_opencode_password`
			}
		},
		networks: { agent_net: { name: `${project}_agent_net`, ipam: {} } },
		services: { assistant: assistantService(homeDir) }
	};
}

function auditHome(): string {
	const root = mkdtempSync(join(tmpdir(), 'fhold-audit-'));
	roots.push(root);
	writeStackConfig(root, defaultStackConfig());
	return root;
}

describe('Compose security audit', () => {
	it('allows only the exact read-only optional Claude managed MCP mount', () => {
		const home = auditHome();
		const config = baseConfig(home);
		const mount = {
			type: 'bind',
			source: `${home}/config/claude/managed-mcp.json`,
			target: '/etc/claude-code/managed-mcp.json',
			read_only: true
		};
		config.services.assistant.volumes.push(mount);
		expect(auditCompose(config, home)).toEqual([]);
		mount.read_only = false;
		expect(auditCompose(config, home).length).toBeGreaterThan(0);
		mount.read_only = true;
		mount.source = `${home}/workspace/managed-mcp.json`;
		expect(auditCompose(config, home).length).toBeGreaterThan(0);
	});
	it('accepts the generic keep-alive overlay without granting additional secrets or mounts', () => {
		const home = auditHome();
		const config = baseConfig(home);
		Object.assign(config.services.assistant.environment, {
			FH_KEEPALIVE_URL: 'https://agent.example/global/health',
			FH_KEEPALIVE_AUTH: 'opencode'
		});
		expect(auditCompose(config, home)).toEqual([]);
		Object.assign(config.services.assistant.environment, {
			FH_KEEPALIVE_AUTH: 'none',
			FH_KEEPALIVE_AUTHORIZATION_FILE: '/home/fhold/.config/keepalive-authorization'
		});
		expect(auditCompose(config, home)).toEqual([]);
		Object.assign(config.services.assistant.environment, { FH_KEEPALIVE_AUTH: 'opencode' });
		expect(auditCompose(config, home)).toContain(
			'service assistant keep-alive must select only one authentication source'
		);
		Object.assign(config.services.assistant.environment, {
			FH_KEEPALIVE_URL: 'https://user:secret@agent.example/'
		});
		expect(auditCompose(config, home)).toContain(
			'service assistant keep-alive requires an HTTP(S) URL without inline credentials or a fragment'
		);
	});

	it('requires native remote startup to match explicit intent, never an overlay override', () => {
		const home = auditHome();
		const config = baseConfig(home);
		for (const key of ['FH_CODEX_REMOTE', 'FH_CLAUDE_REMOTE'] as const) {
			const expected = assistantEnvironment[key];
			config.services.assistant.environment[key] = expected === '1' ? '0' : '1';
			expect(auditCompose(config, home)).toContain(
				`assistant ${key} must match StackConfig intent`
			);
			config.services.assistant.environment[key] = 'not-a-boolean';
			expect(auditCompose(config, home)).toContain(`service assistant ${key} must be 0 or 1`);
			config.services.assistant.environment[key] = expected;
		}
		const intent = defaultStackConfig();
		intent.assistant.codexRemote = true;
		intent.assistant.claudeRemote = true;
		writeStackConfig(home, intent);
		config.services.assistant.environment.FH_CODEX_REMOTE = '1';
		config.services.assistant.environment.FH_CLAUDE_REMOTE = '1';
		expect(auditCompose(config, home)).toEqual([]);
	});
	it('accepts explicit container isolation without widening mounts, credentials or capabilities', () => {
		const home = auditHome();
		const intent = defaultStackConfig();
		intent.assistant.codexSandbox = 'danger-full-access';
		writeStackConfig(home, intent);
		const config = baseConfig(home);
		expect(auditCompose(config, home)).toContain(
			'assistant Codex sandbox must match StackConfig intent'
		);
		config.services.assistant.environment.FH_CODEX_SANDBOX = 'danger-full-access';
		expect(auditCompose(config, home)).toEqual([]);
		Object.assign(config.services.assistant, { cap_add: ['SYS_ADMIN'] });
		expect(auditCompose(config, home)).toContain('service assistant may not add capabilities');
	});
	it('accepts managed networks for an explicitly resolved Compose project', () => {
		const home = auditHome();
		const config = baseConfig(home);
		config.networks.agent_net.name = 'fhold-admin-e2e_agent_net';
		expect(auditCompose(config, home, 'fhold-admin-e2e')).toEqual([]);
		expect(auditCompose(config, home, 'another-project')).toContain(
			'managed network agent_net must remain project-scoped'
		);
	});

	it('accepts the narrow Assistant grant and rejects boundary expansion', () => {
		const home = auditHome();
		const base = baseConfig(home);
		expect(auditCompose(base, home)).toEqual([]);
		base.services.assistant.networks.push('ingress_net');
		base.services.assistant.environment = {
			...base.services.assistant.environment,
			API_TOKEN: 'plaintext'
		};
		const issues = auditCompose(base, home);
		expect(issues).toContain('service assistant has unsupported environment key API_TOKEN');
		expect(issues).toContain('service assistant exposes secret-like environment key API_TOKEN');
		expect(issues).toContain('service assistant may not bridge agent_net and ingress_net');
		expect(issues).toContain('service assistant has unexpected network ingress_net');
	});

	it('allows the persisted instance hostname without allowing an overlay to rename it', () => {
		const home = auditHome();
		const base = baseConfig(home);
		expect(auditCompose(base, home)).toEqual([]);
		base.services.assistant.hostname = 'unrelated-agent';
		expect(auditCompose(base, home)).toContain(
			'assistant hostname must match StackConfig instance name'
		);
	});

	it('prevents an overlay from silently re-enabling memory or changing schedule timezone', () => {
		const home = auditHome();
		const intent = defaultStackConfig();
		intent.assistant.automaticMemory = false;
		intent.assistant.timezone = 'America/Chicago';
		writeStackConfig(home, intent);
		const config = baseConfig(home);
		expect(auditCompose(config, home)).toContain(
			'assistant automatic memory must match StackConfig intent'
		);
		expect(auditCompose(config, home)).toContain(
			'assistant timezone must match StackConfig intent'
		);
		config.services.assistant.environment.FH_AUTOMATIC_MEMORY = '0';
		config.services.assistant.environment.TZ = 'America/Chicago';
		expect(auditCompose(config, home)).toEqual([]);
	});

	it('rejects privilege, runtime socket, and public Assistant overrides', () => {
		const home = auditHome();
		const config = {
			secrets: {
				opencode_server_password: {
					file: `${home}/state/secrets/fhold_opencode_password`
				}
			},
			services: {
				assistant: {
					init: true,
					user: '0:0',
					privileged: true,
					cap_add: ['SYS_ADMIN'],
					cap_drop: ['ALL'],
					security_opt: ['no-new-privileges:true'],
					environment: {
						...assistantEnvironment,
						OPENCODE_PERMISSION: '{"*":"allow"}'
					},
					secrets: ['opencode_server_password'],
					networks: ['agent_net'],
					ports: [{ host_ip: '0.0.0.0', target: 4096, published: '3810' }],
					volumes: ['/var/run/docker.sock:/var/run/docker.sock']
				}
			}
		};
		expect(auditCompose(config, home)).toContain('service assistant may not be privileged');
		expect(auditCompose(config, home)).toContain(
			'service assistant may not mount a container runtime'
		);
		expect(auditCompose(config, home)).toContain('assistant must publish only 127.0.0.1:3810:4096');
		expect(auditCompose(config, home)).toContain('service assistant must run as a non-root user');
		expect(auditCompose(config, home)).toContain(
			'service assistant may not set OPENCODE_PERMISSION'
		);
	});

	it('accepts a non-loopback Assistant bind only when it matches StackConfig intent', () => {
		const root = auditHome();
		const intent = defaultStackConfig();
		intent.assistant.bindAddress = '0.0.0.0';
		intent.assistant.port = 4910;
		writeStackConfig(root, intent);
		const config = baseConfig(root);
		config.services.assistant.ports[0] = {
			host_ip: '0.0.0.0',
			target: 4096,
			published: '4910',
			protocol: 'tcp',
			mode: 'ingress'
		};
		expect(auditCompose(config, root)).toEqual([]);
	});

	it('rejects replacement images, executable hooks, mounts, and extra ports', () => {
		const home = auditHome();
		const config = baseConfig(home);
		config.services.assistant.image = 'attacker/assistant:latest';
		Object.assign(config.services.assistant, {
			entrypoint: ['/bin/sh', '-c', 'steal-secrets'],
			post_start: [{ command: 'steal-secrets' }]
		});
		config.services.assistant.volumes.push({
			type: 'bind',
			source: '/tmp',
			target: '/host'
		});
		config.services.assistant.ports.push({
			host_ip: '0.0.0.0',
			target: 4096,
			published: '9999',
			protocol: 'tcp',
			mode: 'ingress'
		});

		const issues = auditCompose(config, home);
		expect(issues).toContain(
			`service assistant must use managed image fwdslsh/fhold-assistant:${libPackage.version}`
		);
		expect(issues).toContain('service assistant may not override entrypoint');
		expect(issues).toContain('service assistant may not override post_start');
		expect(issues).toContain('service assistant has unexpected mount /host');
		expect(issues).toContain('assistant must publish only 127.0.0.1:3810:4096');
	});

	it('prevents a portal override from sending its bearer credential elsewhere', () => {
		const issues = auditCompose(
			{
				services: {
					discord: {
						environment: { MCP_SERVER_URL: 'https://attacker.example/mcp' }
					}
				}
			},
			'/tmp/home'
		);
		expect(issues).toContain('service discord must set MCP_SERVER_URL to http://guardian:8080/mcp');
	});

	it('rejects unsupported per-portal policy injection into Guardian', () => {
		const issues = auditCompose(
			{
				services: {
					guardian: {
						environment: {
							GUARDIAN_OWNER_POLICY: 'chat',
							GUARDIAN_DISCORD_POLICY: 'chat',
							GUARDIAN_SLACK_POLICY: 'chat'
						}
					}
				}
			},
			'/tmp/home'
		);
		expect(issues).toContain(
			'service guardian has unsupported environment key GUARDIAN_OWNER_POLICY'
		);
	});
});

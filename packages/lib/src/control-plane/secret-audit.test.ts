import { describe, expect, it } from 'bun:test';

import { auditCompose } from './secret-audit.js';

const home = '/tmp/fhold-audit-home';

function baseConfig() {
	return {
		secrets: {
			opencode_server_password: { file: `${home}/state/secrets/fhold_opencode_password` }
		},
		services: {
			assistant: {
				image: 'fwdslsh/fhold-assistant:test',
				user: '1000:1000',
				cap_drop: ['ALL'],
				environment: { OPERATOR_SETTING: 'custom-value' } as Record<string, string>,
				secrets: ['opencode_server_password'],
				volumes: [
					{ type: 'bind', source: `${home}/workspace`, target: '/work' },
					{ type: 'bind', source: '/srv/operator-data', target: '/operator-data' }
				] as unknown[]
			} as Record<string, unknown>
		}
	};
}

describe('Compose security defaults', () => {
	it('accepts operator customizations that keep the shipped security defaults', () => {
		const config = baseConfig();
		Object.assign(config.services, {
			sidecar: { image: 'operator/sidecar:latest', environment: { API_TOKEN: 'operator-owned' } }
		});
		expect(auditCompose(config, home)).toEqual([]);
	});

	it('reports privilege, added capabilities and container runtime mounts on any service', () => {
		const config = baseConfig();
		Object.assign(config.services.assistant, { privileged: true, cap_add: ['SYS_ADMIN'] });
		(config.services.assistant.volumes as unknown[]).push('/var/run/docker.sock:/var/run/docker.sock');
		Object.assign(config.services, {
			sidecar: { volumes: [{ type: 'bind', source: '/run/containerd/containerd.sock', target: '/sock' }] }
		});
		expect(auditCompose(config, home)).toEqual([
			'service assistant may not be privileged',
			'service assistant may not add capabilities',
			'service assistant may not mount a container runtime',
			'service sidecar may not mount a container runtime'
		]);
	});

	it('reports host namespaces, host devices and agent_net access beyond Guardian', () => {
		const config = baseConfig();
		Object.assign(config.services.assistant, {
			network_mode: 'host',
			pid: 'host',
			ipc: 'host',
			devices: ['/dev/kvm']
		});
		Object.assign(config.services, {
			guardian: { user: '1000:1000', networks: ['agent_net', 'ingress_net'] },
			discord: { user: '1000:1000', networks: ['agent_net', 'ingress_net'] },
			sidecar: { networks: { agent_net: {} } }
		});
		expect(auditCompose(config, home)).toEqual([
			'service assistant may not share the host network namespace',
			'service assistant may not share the host PID namespace',
			'service assistant may not share the host IPC namespace',
			'service assistant may not mount host devices',
			'service discord may not join the private agent_net',
			'service discord may not bridge agent_net and ingress_net',
			'service sidecar may not join the private agent_net'
		]);
	});

	it('requires product services to run as a non-root user', () => {
		for (const user of [undefined, '', '0:0', 'root']) {
			const config = baseConfig();
			config.services.assistant.user = user;
			expect(auditCompose(config, home)).toEqual(['service assistant must run as a non-root user']);
		}
		const config = baseConfig();
		Object.assign(config.services, { sidecar: { image: 'operator/sidecar:latest' } });
		expect(auditCompose(config, home)).toEqual([]);
	});

	it('requires file secrets inside FH_HOME', () => {
		const config = baseConfig();
		Object.assign(config.secrets, {
			outside: { file: '/etc/shadow' },
			environment: { environment: 'SOME_VALUE' }
		});
		expect(auditCompose(config, home)).toEqual([
			'secret outside escapes FH_HOME',
			'secret environment must use a file source'
		]);
	});
});

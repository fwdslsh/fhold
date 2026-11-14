import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

// The shipped product services. Operator-added services own their own user.
const CORE_SERVICES = new Set(['assistant', 'guardian', 'discord', 'slack']);

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function strings(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
	const object = record(value);
	return object ? Object.keys(object) : [];
}

function normalizedPath(path: string): string {
	const absolute = resolve(path);
	return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

function isWithin(path: string, parent: string): boolean {
	const child = normalizedPath(path);
	const root = normalizedPath(parent);
	const result = relative(root, child);
	return result === '' || (!result.startsWith('..') && !isAbsolute(result));
}

function isRootUser(value: unknown): boolean {
	if (typeof value !== 'string' || !value.trim()) return true;
	const user = value.trim().split(':', 1)[0]?.toLowerCase();
	return user === '0' || user === 'root';
}

function volumeText(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => {
		if (typeof entry === 'string') return entry;
		const item = record(entry);
		return [item?.source, item?.target]
			.filter((part): part is string => typeof part === 'string')
			.join(':');
	});
}

/**
 * Optional doctor diagnostics for the shipped security defaults: non-root product
 * services, no container runtime mounts, no privilege, added capabilities, host
 * namespaces or devices, Guardian-only access to agent_net, and file secrets
 * inside FH_HOME. Never a lifecycle authorization gate.
 */
export function auditCompose(config: unknown, homeDir: string): string[] {
	const root = record(config);
	const services = record(root?.services) ?? {};
	const secrets = record(root?.secrets) ?? {};
	const issues: string[] = [];

	for (const [name, rawDefinition] of Object.entries(secrets)) {
		const file = record(rawDefinition)?.file;
		if (typeof file !== 'string') issues.push(`secret ${name} must use a file source`);
		else if (!isWithin(file, homeDir)) issues.push(`secret ${name} escapes FH_HOME`);
	}

	for (const [name, rawService] of Object.entries(services)) {
		const service = record(rawService) ?? {};
		if (service.privileged === true) issues.push(`service ${name} may not be privileged`);
		if (strings(service.cap_add).length > 0)
			issues.push(`service ${name} may not add capabilities`);
		for (const [field, label] of [
			['network_mode', 'network namespace'],
			['pid', 'PID namespace'],
			['ipc', 'IPC namespace']
		] as const)
			if (service[field] === 'host') issues.push(`service ${name} may not share the host ${label}`);
		if (Array.isArray(service.devices) && service.devices.length > 0)
			issues.push(`service ${name} may not mount host devices`);
		// Network membership is the Guardian boundary: only Assistant and Guardian
		// join agent_net, and only Guardian bridges it to ingress_net.
		const networks = new Set(strings(service.networks));
		if (networks.has('agent_net') && name !== 'assistant' && name !== 'guardian')
			issues.push(`service ${name} may not join the private agent_net`);
		if (networks.has('agent_net') && networks.has('ingress_net') && name !== 'guardian')
			issues.push(`service ${name} may not bridge agent_net and ingress_net`);
		if (
			volumeText(service.volumes).some((volume) =>
				/(?:docker\.sock|containerd\.sock|\/run\/podman|\/var\/lib\/docker)/i.test(volume)
			)
		) {
			issues.push(`service ${name} may not mount a container runtime`);
		}
		if (CORE_SERVICES.has(name) && isRootUser(service.user))
			issues.push(`service ${name} must run as a non-root user`);
	}
	return issues;
}

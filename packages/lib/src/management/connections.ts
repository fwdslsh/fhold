import { createFholdState } from '../control-plane/foundation.js';
import { runDocker } from '../control-plane/docker.js';
import type { HostingSnapshot } from '../hosting/types.js';

/** Read only public labels/ports, never container environment or credentials. */
export async function publishedConnections(
	homeDir: string,
	snapshot: HostingSnapshot,
	run: typeof runDocker = runDocker
): Promise<Partial<Record<'assistant' | 'guardian', string>>> {
	const services = snapshot.services.filter(
		(service) =>
			['assistant', 'guardian'].includes(service.name) && service.state === 'running' && service.id
	);
	if (!services.length) return {};
	const format =
		'{"id":{{json .Id}},"home":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"ports":{{json .NetworkSettings.Ports}}}';
	const result = await run([
		'inspect',
		'--format',
		format,
		...services.map((service) => service.id!)
	]);
	if (!result.ok)
		throw Error(
			'Could not resolve the selected instance’s active connection. Settings remain available; check Docker and retry.'
		);
	const expected = createFholdState(homeDir).stackDir;
	const endpoints: Partial<Record<'assistant' | 'guardian', string>> = {};
	for (const line of result.stdout.trim().split('\n')) {
		const container = JSON.parse(line) as {
			id: string;
			home?: string;
			ports?: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
		};
		const service = services.find((service) => container.id.startsWith(service.id!));
		if (!service) continue;
		if (container.home !== expected)
			throw Error(
				'These running containers belong to another instance folder. Settings remain available; select their actual home before connecting.'
			);
		const name = service.name as 'assistant' | 'guardian';
		const binding = container.ports?.[name === 'assistant' ? '4096/tcp' : '8080/tcp']?.[0];
		if (!binding) continue;
		const host =
			binding.HostIp === '0.0.0.0' || !binding.HostIp
				? '127.0.0.1'
				: binding.HostIp === '::'
					? '::1'
					: binding.HostIp;
		endpoints[name] = `http://${host.includes(':') ? `[${host}]` : host}:${binding.HostPort}`;
	}
	return endpoints;
}

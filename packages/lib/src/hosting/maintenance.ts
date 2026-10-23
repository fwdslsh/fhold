import { hostingProvider } from './provider.js';
import { runHostingProcess, type HostingProcess } from '../control-plane/process.js';
import type { HostingConnection, ConnectionCheck } from './types.js';

export async function checkHostingConnection(
	connection: HostingConnection,
	run: HostingProcess = runHostingProcess
): Promise<ConnectionCheck> {
	const provider = hostingProvider(connection, run);
	if (provider.check) return provider.check();
	const result: ConnectionCheck = { ok: false, checks: [], instances: [] };
	try {
		result.instances = await provider.listInstances();
		result.checks.push({
			name: 'Discovery',
			ok: true,
			detail: result.instances.length
				? `Found ${result.instances.length} instance(s).`
				: provider.emptyHint || 'No instances found on this connection.'
		});
		result.ok = true;
	} catch (error) {
		result.checks.push({
			name: 'Connection / discovery',
			ok: false,
			detail: error instanceof Error ? error.message : 'Connection check failed.'
		});
	}
	return result;
}

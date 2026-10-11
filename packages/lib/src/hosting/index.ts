import { parseHostingConnection, parseInstanceRef } from './preferences.js';
import { localDockerProvider } from './local-docker.js';
import { sshDockerProvider } from './ssh-docker.js';
import { azureContainerAppsProvider } from './azure-container-apps.js';
import type { HostingConnection, HostingProvider, InstanceRef, InstanceSession } from './types.js';

export function hostingProvider(value: HostingConnection): HostingProvider {
	const connection = parseHostingConnection(value);
	switch (connection.kind) {
		case 'local-docker':
			return localDockerProvider;
		case 'ssh-docker':
			return sshDockerProvider(connection);
		case 'azure-container-apps':
			return azureContainerAppsProvider(connection);
	}
}
export function openHostingInstance(
	connection: HostingConnection,
	value: InstanceRef
): InstanceSession {
	const ref = parseInstanceRef(value);
	if (ref.kind !== connection.kind || ref.connectionId !== connection.id)
		throw new Error('The instance does not belong to this hosting connection.');
	return hostingProvider(connection).open(ref);
}
export * from './types.js';
export {
	HostingPreferencesStore,
	hostingPreferencesFile,
	parseHostingConnection,
	parseInstanceRef
} from './preferences.js';
export {
	inspectLocalInstance,
	listLocalInstances,
	operateLocalInstance,
	localInstanceLogs
} from './local-docker.js';
export { HOSTING_WIRE_VERSION, type MachineRequest, type MachineResponse } from './ssh-docker.js';
export { hostingMachineRequest } from './machine.js';

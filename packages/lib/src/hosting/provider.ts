import { parseHostingConnection, parseInstanceRef } from './preferences.js';
import { localDockerProvider } from './local-docker.js';
import { sshDockerProvider } from './ssh-docker.js';
import { azureContainerAppsProvider } from './azure-container-apps.js';
import { azureClient } from './azure-client.js';
import type { HostingProcess } from './process.js';
import type { HostingConnection, HostingProvider, InstanceRef, InstanceSession } from './types.js';
import { composeInstanceSession, type ComposedInstanceSession } from '../management/index.js';
import { hostOperations } from '../management/host-operations.js';

/** The composition root: clients depend on provider capabilities, not vendor branches. */
export function hostingProvider(value: HostingConnection, run?: HostingProcess): HostingProvider {
	const connection = parseHostingConnection(value);
	switch (connection.kind) {
		case 'local-docker':
			return localDockerProvider;
		case 'ssh-docker':
			return sshDockerProvider(connection, run);
		case 'azure-container-apps':
			return azureContainerAppsProvider(connection, run);
	}
}
export function hostingConnectionSetup(kind: unknown, run?: HostingProcess) {
	return kind === 'azure-container-apps' ? azureClient(run).setup : undefined;
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

/**
 * The application composition root. The selected host contributes its own
 * bindings, so this common path never branches on a hosting-provider kind.
 */
export function openInstanceSession(
	connection: HostingConnection,
	value: InstanceRef,
	options?: { setupName?: string; openUrl?: (url: string) => void }
): ComposedInstanceSession {
	const hostSession = openHostingInstance(connection, value);
	const { host, inspectHost } = hostOperations(hostSession);
	return composeInstanceSession({
		ref: hostSession.ref,
		host,
		inspectHost,
		...hostSession.applicationBindings?.(options)
	});
}

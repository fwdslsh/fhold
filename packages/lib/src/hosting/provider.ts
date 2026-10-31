import { parseHostingConnection, parseInstanceRef } from './preferences.js';
import { localDockerProvider } from './local-docker.js';
import { sshDockerProvider } from './ssh-docker.js';
import { azureContainerAppsProvider } from './azure-container-apps.js';
import { azureClient } from './azure-client.js';
import type { HostingProcess } from '../control-plane/process.js';
import type { HostingConnection, HostingProvider, InstanceRef, InstanceSession } from './types.js';
import { composeInstanceSession, type ComposedInstanceSession } from '../management/index.js';
import { hostOperations } from '../management/host-operations.js';
import { directoryProvisioning } from './provisioning.js';
import { dockerDeploymentOperations } from './docker-deployment.js';

/** The composition root: clients depend on provider capabilities, not vendor branches. */
export function hostingProvider(value: HostingConnection, run?: HostingProcess): HostingProvider {
	const connection = parseHostingConnection(value);
	switch (connection.kind) {
		case 'local-docker':
			return { ...localDockerProvider, provisioning: directoryProvisioning(localDockerProvider) };
		case 'ssh-docker': {
			const provider = sshDockerProvider(connection, run);
			return { ...provider, provisioning: directoryProvisioning(provider) };
		}
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
	const bindings = hostSession.applicationBindings?.(options);
	let inspectDeployment = inspectHost;
	if (bindings?.docker) {
		const deployment = dockerDeploymentOperations(
			hostSession.ref,
			bindings.docker,
			host,
			inspectHost,
			async () => (await bindings.inspectApplication?.())?.docker?.config
		);
		host.deployment = deployment.operations;
		inspectDeployment = deployment.inspectHost;
	}
	return composeInstanceSession({
		ref: hostSession.ref,
		host,
		inspectHost: inspectDeployment,
		...bindings
	});
}

import { parseHostingConnection, parseInstanceRef } from './preferences.js';
import { localDockerProvider } from './local-docker.js';
import { sshDockerProvider } from './ssh-docker.js';
import { azureContainerAppsProvider } from './azure-container-apps.js';
import { azureClient } from './azure-client.js';
import type { HostingProcess } from '../control-plane/process.js';
import type { HostingConnection, HostingProvider, InstanceRef, InstanceSession } from './types.js';
import { composeInstanceSession, type ComposedInstanceSession } from '../management/index.js';
import { hostOperations } from '../management/host-operations.js';
import { invokeOperation, supportedOperation } from '../management/contracts.js';
import { directoryProvisioning } from './provisioning.js';

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
	if (bindings?.docker) {
		const docker = bindings.docker;
		host.deployment.update = supportedOperation(async (input, context) => {
			if (input.container || input.image)
				throw new Error('Use Docker deployment settings to change an explicit image pin.');
			await invokeOperation(docker.update, { pull: input.pull }, context);
			return { state: 'completed', step: 'updated' };
		});
		host.deployment.apply = supportedOperation(async (_input, context) => {
			await invokeOperation(host.restart, undefined, context);
			return { state: 'completed', step: 'applied' };
		});
	}
	return composeInstanceSession({
		ref: hostSession.ref,
		host,
		inspectHost,
		...bindings
	});
}

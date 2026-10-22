import { parseHostingConnection, parseInstanceRef } from './preferences.js';
import { localDockerProvider } from './local-docker.js';
import { sshDockerProvider } from './ssh-docker.js';
import { azureContainerAppsProvider } from './azure-container-apps.js';
import { azureClient } from './azure-client.js';
import type { HostingProcess } from './process.js';
import type { HostingConnection, HostingProvider, InstanceRef, InstanceSession } from './types.js';
import {
	composeInstanceSession,
	legacyManagementBindings,
	type ComposedInstanceSession
} from '../management/index.js';
import { localInstanceManagement } from '../management/instance.js';
import { SshInstanceManagement } from '../management/ssh.js';
import { httpsAgentBindings } from '../management/https-agent-session.js';
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
 * The application composition root. Host adapters remain responsible for
 * lifecycle and inspection; local/SSH command compatibility is adapted here
 * into named agent/app/data operations instead of leaking its RPC to callers.
 */
export function openInstanceSession(
	connection: HostingConnection,
	value: InstanceRef,
	options?: { setupName?: string; openUrl?: (url: string) => void }
): ComposedInstanceSession {
	const hostSession = openHostingInstance(connection, value);
	const { host, inspectHost, latest } = hostOperations(hostSession);
	const ref = hostSession.ref;
	const management =
		ref.kind === 'local-docker'
			? localInstanceManagement(ref.homeDir, {
					...options,
					host: {
						inspect: async () => hostSession.inspect(),
						operate: async (_homeDir, action) => {
							await hostSession.operate(action, true);
						},
						logs: async (_homeDir, logOptions) => hostSession.logs(logOptions)
					}
				})
			: ref.kind === 'ssh-docker'
				? new SshInstanceManagement(
						connection as Extract<HostingConnection, { kind: 'ssh-docker' }>,
						ref.remoteHome,
						options
					)
				: undefined;
	const application =
		ref.kind === 'azure-container-apps'
			? httpsAgentBindings({ inspectHost: () => hostSession.inspect() })
			: management
				? legacyManagementBindings(
						management,
						management instanceof SshInstanceManagement
							? {
									supports: (method) => latest()?.managementMethods?.includes(method) === true,
									passiveSnapshot: () => management.inspectPassive()
								}
							: {}
					)
				: {};
	return composeInstanceSession({
		ref: hostSession.ref,
		host,
		inspectHost,
		...application
	});
}

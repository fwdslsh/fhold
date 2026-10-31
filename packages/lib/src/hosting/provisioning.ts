import { dirname } from 'node:path';
import { defaultFholdHome } from '../control-plane/foundation.js';
import { defaultStackConfig } from '../control-plane/stack-config.js';
import {
	invokeOperation,
	supportedOperation,
	unsupportedOperation,
	type ProvisioningOperations,
	type ProvisioningRequest
} from '../management/contracts.js';
import { parseProvisioningRequest } from '../control-plane/provisioning-input.js';
export {
	parseProvisioningRequest,
	parseDeploymentPatch,
	DEPLOYMENT_ENVIRONMENT
} from '../control-plane/provisioning-input.js';
import type { HostingProvider } from './types.js';

/** Connection-scoped facade delegates Docker installation to its existing domain operation. */
export function directoryProvisioning(provider: HostingProvider): ProvisioningOperations {
	async function options() {
		const info = provider.installation
			? await provider.installation.info()
			: { instancesDirectory: dirname(defaultFholdHome()), defaultHome: defaultFholdHome() };
		return { kind: 'directory' as const, ...info, config: defaultStackConfig(info.defaultHome) };
	}
	async function preview(value: ProvisioningRequest) {
		const request = parseProvisioningRequest(value);
		if (request.kind !== 'directory')
			throw new Error('Choose an instance directory for this connection.');
		const ref = await provider.selectInstance(request.directory);
		return {
			ref,
			image: request.config.deployment.images.assistant,
			summary: `Install ${request.name} at ${request.directory}.`,
			resources: [
				{ name: request.directory, type: 'instance directory', action: 'create' as const }
			],
			warnings: []
		};
	}
	return {
		options: supportedOperation(options),
		preview: supportedOperation(preview),
		install: supportedOperation(async (value, context) => {
			if (!context.confirmed) throw new Error('Confirm installation before creating resources.');
			const request = parseProvisioningRequest(value);
			if (request.kind !== 'directory') throw new Error('Choose an instance directory.');
			const { ref } = await preview(request);
			const bindings = provider.open(ref).applicationBindings?.();
			if (!bindings?.docker) throw new Error('Installation is unavailable on this connection.');
			try {
				await invokeOperation(
					bindings.docker.install,
					{ config: request.config, automaticPorts: request.automaticPorts },
					context
				);
				return { ref, state: 'completed', step: 'installed' };
			} finally {
				await bindings.close?.();
			}
		}),
		resume: unsupportedOperation('Reopen this instance directory to continue native setup.')
	};
}

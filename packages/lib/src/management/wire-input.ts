import { parseOperationInput, type OperationInputName } from './operation-input.js';
import type { ManagementOperation, ManagementOperationMap } from './types.js';

type WireParsers = {
	[N in ManagementOperation]: (value: unknown) => ManagementOperationMap[N]['input'];
};

function none(value: unknown): void {
	if (value !== undefined) throw new Error('This operation takes no input.');
}
function text(value: unknown): string {
	if (typeof value !== 'string' || !value || value.includes('\0'))
		throw new Error('A text operation input is required.');
	return value;
}
function named<N extends OperationInputName>(name: N) {
	return (value: unknown) => parseOperationInput(name, value);
}

/** Every operation the SSH/stdin envelope accepts, with its untrusted-input parser. */
const parsers: WireParsers = {
	snapshot: none,
	'agent.providers': none,
	'agent.setKey': named('agent.setKey'),
	'agent.saveEndpoint': named('agent.saveEndpoint'),
	'agent.discoverModels': named('agent.discoverModels'),
	'agent.selectModel': named('agent.selectModel'),
	'agent.removeProvider': named('agent.removeProvider'),
	'agent.oauthStart': named('agent.oauthStart'),
	'agent.oauthFinish': named('agent.oauthFinish'),
	'agent.readiness': named('agent.readiness'),
	'agent.assistantPassword': none,
	'agent.remote': named('agent.remote'),
	'agent.codexRecall': named('agent.codexRecall'),
	'apps.credentials.create': named('apps.credentials.create'),
	'apps.credentials.updatePolicy': named('apps.credentials.updatePolicy'),
	'apps.credentials.rotate': named('apps.credentials.rotate'),
	'apps.credentials.remove': named('apps.credentials.remove'),
	'apps.credentials.revealKey': named('apps.credentials.revealKey'),
	'apps.portal.mapUser': named('apps.portal.mapUser'),
	'apps.portal.saveToken': named('apps.portal.saveToken'),
	'data.knowledgeUi': (value) => {
		if (value === undefined) return undefined;
		const loopbackPort =
			value && typeof value === 'object' && !Array.isArray(value)
				? (value as Record<string, unknown>).loopbackPort
				: undefined;
		if (
			typeof loopbackPort !== 'number' ||
			!Number.isInteger(loopbackPort) ||
			loopbackPort < 1024 ||
			loopbackPort > 65535
		)
			throw new Error('A valid AKM UI loopback port is required.');
		return { loopbackPort };
	},
	'data.backup': named('data.backup'),
	'data.restoreData': named('data.restoreData'),
	'data.restoreInstance': named('data.restoreInstance'),
	'data.recovery.status': named('data.recovery.status'),
	'data.recovery.inspect': named('data.recovery.inspect'),
	'data.recovery.initialize': named('data.recovery.initialize'),
	'data.recovery.restore': named('data.recovery.restore'),
	'data.recovery.save': named('data.recovery.save'),
	'data.recovery.setCredential': named('data.recovery.setCredential'),
	'data.recovery.package': named('data.recovery.package'),
	'docker.install': named('docker.install'),
	'docker.saveConfig': named('docker.saveConfig'),
	'docker.update': named('docker.update'),
	'docker.directory': named('docker.directory'),
	'transfer.create': none,
	'transfer.release': text,
	'transfer.pack': text,
	'transfer.unpack': text
};

export function isManagementOperation(value: unknown): value is ManagementOperation {
	return typeof value === 'string' && Object.hasOwn(parsers, value);
}

export function parseManagementInput<N extends ManagementOperation>(
	operation: N,
	value: unknown
): ManagementOperationMap[N]['input'] {
	return parsers[operation](value);
}

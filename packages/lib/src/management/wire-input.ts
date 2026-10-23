import { parseStackConfig } from '../control-plane/stack-config.js';
import {
	parseLegacyCredentialOperation,
	parseLegacyRecoveryOperation,
	parseOperationInput,
	parseRequestContext
} from './operation-input.js';
import type { ManagementMethod, ManagementRequestArgs } from './types.js';

type WireParser<M extends ManagementMethod> = (
	value: unknown,
	extra: unknown[]
) => ManagementRequestArgs<M>;
type WireParsers = { [M in ManagementMethod]: WireParser<M> };

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid instance operation input.');
	return value as Record<string, unknown>;
}
function string(value: unknown): string {
	if (typeof value !== 'string' || !value || value.includes('\0'))
		throw new Error('A text operation input is required.');
	return value;
}

/** Published wire compatibility is parsed here, not inside native account use cases. */
const parsers: WireParsers = {
	snapshot: () => [],
	providers: () => [],
	logs: () => [],
	assistantPassword: () => [],
	transferCreate: () => [],
	directory: (value) => [value === undefined ? undefined : string(value)],
	transferRelease: (value) => [string(value)],
	transferPack: (value) => [string(value)],
	transferUnpack: (value) => [string(value)],
	install: (value, extra) => {
		const config = parseStackConfig(value);
		if (!config.ok) throw new Error(config.error);
		if (extra[0] !== undefined && typeof extra[0] !== 'boolean')
			throw new Error('Automatic port selection must be true or false.');
		return [config.config, extra[0]];
	},
	saveConfig: (value) => [parseOperationInput('docker.saveConfig', value)],
	action: (value) => {
		const input = object(value);
		if (input.action !== 'start' && input.action !== 'stop' && input.action !== 'restart')
			throw new Error('Choose a lifecycle action.');
		return [{ action: input.action, confirmed: parseRequestContext(input).confirmed === true }];
	},
	update: (value) => [
		{
			...parseOperationInput('docker.update', value),
			confirmed: parseRequestContext(value).confirmed === true
		}
	],
	providerKey: (value) => [parseOperationInput('agent.setKey', value)],
	providerEndpoint: (value) => [parseOperationInput('agent.saveEndpoint', value)],
	providerModels: (value) => [parseOperationInput('agent.discoverModels', value)],
	providerUse: (value) => [parseOperationInput('agent.selectModel', value)],
	providerRemove: (value) => [parseOperationInput('agent.removeProvider', value)],
	providerOAuthStart: (value) => [parseOperationInput('agent.oauthStart', value)],
	providerOAuthFinish: (value) => [parseOperationInput('agent.oauthFinish', value)],
	readiness: (value) => [parseOperationInput('agent.readiness', value)],
	credentialKey: (value) => [
		parseOperationInput('apps.credentials.revealKey', { username: value }).username
	],
	credential: (value) => {
		const parsed = parseLegacyCredentialOperation(value);
		switch (parsed.name) {
			case 'apps.credentials.create':
				return [{ action: 'create', ...parsed.input }];
			case 'apps.credentials.updatePolicy':
				return [{ action: 'policy', ...parsed.input }];
			case 'apps.credentials.rotate':
				return [{ action: 'rotate', ...parsed.input }];
			case 'apps.credentials.remove':
				return [{ action: 'remove', ...parsed.input }];
		}
	},
	mapPortalUser: (value) => [parseOperationInput('apps.portal.mapUser', value)],
	portalToken: (value) => [parseOperationInput('apps.portal.saveToken', value)],
	backup: (value) => [
		{ ...parseOperationInput('data.backup', value), ...parseRequestContext(value) }
	],
	restoreData: (value) => [
		{ ...parseOperationInput('data.restoreData', value), ...parseRequestContext(value) }
	],
	restoreInstance: (value) => [
		{ ...parseOperationInput('data.restoreInstance', value), ...parseRequestContext(value) }
	],
	codexRecall: (value) => [
		{ ...parseOperationInput('agent.codexRecall', value), ...parseRequestContext(value) }
	],
	remote: (value) => {
		const input = object(value);
		const context = parseRequestContext({ confirmed: input.restartConfirmed });
		return [
			{
				...parseOperationInput('agent.remote', input),
				...(context.confirmed === undefined ? {} : { restartConfirmed: context.confirmed })
			}
		];
	},
	recovery: (value) => {
		const parsed = parseLegacyRecoveryOperation(value);
		switch (parsed.name) {
			case 'data.recovery.status':
				return [{ action: 'status' }];
			case 'data.recovery.inspect':
				return [{ action: 'inspect', ...parsed.context }];
			case 'data.recovery.initialize':
				return [{ action: 'init', ...parsed.context }];
			case 'data.recovery.restore':
				return [{ action: 'restore', ...parsed.context }];
			case 'data.recovery.save':
				return [{ action: 'save', ...parsed.input }];
			case 'data.recovery.setCredential':
				return [{ action: 'credential', ...parsed.input }];
		}
	}
};

export function parseManagementArgs<M extends ManagementMethod>(
	method: M,
	value: unknown,
	extra: unknown[] = []
): ManagementRequestArgs<M> {
	if (extra.length > (method === 'install' ? 1 : 0)) throw new Error('Invalid operation options.');
	return parsers[method](value, extra);
}

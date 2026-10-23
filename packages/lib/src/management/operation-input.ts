import { parseStackConfig, type GuardianPolicy } from '../control-plane/stack-config.js';
import { parseRecoverySettings } from '../control-plane/recovery-config.js';
import { normalizeSelection } from '../../../../containers/assistant/recovery/selection.mjs';
import type {
	AgentOperations,
	AppOperations,
	RequestContext,
	DataOperations,
	DockerOperations,
	HostOperations
} from './contracts.js';
/**
 * Extract from the callable branch only. Inferring from the whole Operation
 * union widens every ingress shape to `unknown` through unsupported slots.
 */
type OperationInputOf<T> = T extends {
	support: 'supported';
	invoke(input: infer Input, context: RequestContext): Promise<unknown>;
}
	? Input
	: never;

/** Input shapes accepted by named normalized session operations. */
export type OperationInputMap = {
	'host.logs': OperationInputOf<HostOperations['logs']>;
	'host.restart': OperationInputOf<HostOperations['restart']>;
	'host.console': OperationInputOf<HostOperations['console']>;
	'agent.connect': OperationInputOf<AgentOperations['connect']>;
	'agent.setKey': OperationInputOf<AgentOperations['setKey']>;
	'agent.saveEndpoint': OperationInputOf<AgentOperations['saveEndpoint']>;
	'agent.discoverModels': OperationInputOf<AgentOperations['discoverModels']>;
	'agent.selectModel': OperationInputOf<AgentOperations['selectModel']>;
	'agent.removeProvider': OperationInputOf<AgentOperations['removeProvider']>;
	'agent.oauthStart': OperationInputOf<AgentOperations['oauthStart']>;
	'agent.oauthFinish': OperationInputOf<AgentOperations['oauthFinish']>;
	'agent.readiness': OperationInputOf<AgentOperations['readiness']>;
	'agent.remote': OperationInputOf<AgentOperations['remote']>;
	'agent.codexRecall': OperationInputOf<AgentOperations['codexRecall']>;
	'apps.credentials.create': OperationInputOf<AppOperations['credentials']['create']>;
	'apps.credentials.updatePolicy': OperationInputOf<AppOperations['credentials']['updatePolicy']>;
	'apps.credentials.rotate': OperationInputOf<AppOperations['credentials']['rotate']>;
	'apps.credentials.remove': OperationInputOf<AppOperations['credentials']['remove']>;
	'apps.credentials.revealKey': OperationInputOf<AppOperations['credentials']['revealKey']>;
	'apps.portal.mapUser': OperationInputOf<AppOperations['portal']['mapUser']>;
	'apps.portal.saveToken': OperationInputOf<AppOperations['portal']['saveToken']>;
	'data.backup': OperationInputOf<DataOperations['backup']>;
	'data.restoreData': OperationInputOf<DataOperations['restoreData']>;
	'data.restoreInstance': OperationInputOf<DataOperations['restoreInstance']>;
	'data.recovery.status': undefined;
	'data.recovery.inspect': undefined;
	'data.recovery.initialize': undefined;
	'data.recovery.restore': undefined;
	'data.recovery.save': OperationInputOf<DataOperations['recovery']['save']>;
	'data.recovery.setCredential': OperationInputOf<DataOperations['recovery']['setCredential']>;
	'docker.install': OperationInputOf<DockerOperations['install']>;
	'docker.saveConfig': OperationInputOf<DockerOperations['saveConfig']>;
	'docker.update': OperationInputOf<DockerOperations['update']>;
	'docker.directory': OperationInputOf<DockerOperations['directory']>;
};
export type OperationInputName = keyof OperationInputMap;
export type LegacyRecoveryOperation =
	| { name: 'data.recovery.status'; input: undefined; context: RequestContext }
	| { name: 'data.recovery.inspect'; input: undefined; context: RequestContext }
	| { name: 'data.recovery.initialize'; input: undefined; context: RequestContext }
	| { name: 'data.recovery.restore'; input: undefined; context: RequestContext }
	| {
			name: 'data.recovery.save';
			input: OperationInputMap['data.recovery.save'];
			context: RequestContext;
	  }
	| {
			name: 'data.recovery.setCredential';
			input: OperationInputMap['data.recovery.setCredential'];
			context: RequestContext;
	  };
export type LegacyCredentialOperation =
	| { name: 'apps.credentials.create'; input: OperationInputMap['apps.credentials.create'] }
	| {
			name: 'apps.credentials.updatePolicy';
			input: OperationInputMap['apps.credentials.updatePolicy'];
	  }
	| { name: 'apps.credentials.rotate'; input: OperationInputMap['apps.credentials.rotate'] }
	| { name: 'apps.credentials.remove'; input: OperationInputMap['apps.credentials.remove'] };

function record(value: unknown, error: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(error);
	return value as Record<string, unknown>;
}
function text(value: unknown, error: string, maximum = 16_384): string {
	if (typeof value !== 'string' || !value || value.length > maximum || value.includes('\0'))
		throw new Error(error);
	return value;
}
function optionalText(value: unknown, error: string, maximum = 16_384): string | undefined {
	if (value === undefined) return undefined;
	return text(value, error, maximum);
}
/** UI forms use an empty optional key to mean “do not change/provide a key”. */
function optionalKey(value: unknown, error: string): string | undefined {
	if (value === undefined || value === '') return undefined;
	return text(value, error);
}
function optionalBoolean(value: unknown, error: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'boolean') throw new Error(error);
	return value;
}
function policy(value: unknown): GuardianPolicy {
	if (value !== 'chat' && value !== 'read' && value !== 'full')
		throw new Error('Policy must be chat, read, or full.');
	return value;
}
function optionalStringMap(value: unknown, error: string): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	const input = record(value, error);
	if (
		Object.keys(input).length > 32 ||
		Object.entries(input).some(
			([key, item]) =>
				!/^[A-Za-z0-9._-]{1,128}$/.test(key) || typeof item !== 'string' || item.length > 4_096
		)
	)
		throw new Error(error);
	return input as Record<string, string>;
}

/** Extract only explicit confirmation intent; callers supply this separately from operation data. */
export function parseRequestContext(value: unknown): RequestContext {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	const confirmed = (value as Record<string, unknown>).confirmed;
	if (confirmed === undefined) return {};
	if (typeof confirmed !== 'boolean') throw new Error('Confirmation must be true or false.');
	return { confirmed };
}

/** Translate the retained SSH/Admin recovery action envelope exactly once at ingress. */
export function parseLegacyRecoveryOperation(value: unknown): LegacyRecoveryOperation {
	const input = record(value, 'Invalid recovery action.');
	const context = parseRequestContext(input);
	switch (input.action) {
		case 'status':
			return { name: 'data.recovery.status', input: undefined, context };
		case 'inspect':
			return { name: 'data.recovery.inspect', input: undefined, context };
		case 'init':
			return { name: 'data.recovery.initialize', input: undefined, context };
		case 'restore':
			return { name: 'data.recovery.restore', input: undefined, context };
		case 'save':
			return {
				name: 'data.recovery.save',
				input: parseOperationInput('data.recovery.save', input),
				context
			};
		case 'credential':
			return {
				name: 'data.recovery.setCredential',
				input: parseOperationInput('data.recovery.setCredential', input),
				context
			};
		default:
			throw new Error('Invalid recovery action.');
	}
}

type OperationInputParser<N extends OperationInputName> = (value: unknown) => OperationInputMap[N];
type OperationInputParsers = { [N in OperationInputName]: OperationInputParser<N> };

function input(value: unknown, name: OperationInputName): Record<string, unknown> | undefined {
	return value === undefined ? undefined : record(value, `Invalid ${name} request.`);
}
function target(value: Record<string, unknown>) {
	const revision = optionalText(value.revision, 'Invalid revision.', 256);
	const replica = optionalText(value.replica, 'Invalid replica.', 256);
	const container = optionalText(value.container, 'Invalid container.', 256);
	return {
		...(revision === undefined ? {} : { revision }),
		...(replica === undefined ? {} : { replica }),
		...(container === undefined ? {} : { container })
	};
}
function providerAuth(source: Record<string, unknown> | undefined) {
	const method = source?.method;
	if (typeof method !== 'number' || !Number.isSafeInteger(method) || method < 0 || method > 1_024)
		throw new Error('Invalid provider authentication method.');
	const inputs = optionalStringMap(source?.inputs, 'Invalid provider sign-in fields.');
	return {
		provider: text(source?.provider, 'Provider is required.', 128),
		method,
		...(inputs === undefined ? {} : { inputs })
	};
}
function portal(source: Record<string, unknown> | undefined): 'discord' | 'slack' {
	const result = source?.portal;
	if (result !== 'discord' && result !== 'slack')
		throw new Error('Portal must be discord or slack.');
	return result;
}

/** Complete, compiler-checked parser table for every public normalized operation. */
const parsers: OperationInputParsers = {
	'host.logs': (value) => {
		if (value === undefined) return undefined;
		const source = input(value, 'host.logs')!;
		const type = source.type;
		if (type !== undefined && type !== 'system' && type !== 'console')
			throw new Error('Log type must be system or console.');
		const tail = source.tail;
		if (
			tail !== undefined &&
			(typeof tail !== 'number' || !Number.isSafeInteger(tail) || tail < 0 || tail > 10_000)
		)
			throw new Error('Log tail must be a whole number from 0 to 10000.');
		return {
			...(type === undefined ? {} : { type }),
			...(tail === undefined ? {} : { tail }),
			...target(source)
		};
	},
	'host.restart': (value) => {
		if (value === undefined) return undefined;
		const revision = optionalText(input(value, 'host.restart')!.revision, 'Invalid revision.', 256);
		return revision === undefined ? {} : { revision };
	},
	'host.console': (value) =>
		value === undefined ? undefined : target(input(value, 'host.console')!),
	'agent.connect': (value) => {
		if (value === undefined) return {};
		const password = optionalText(
			input(value, 'agent.connect')!.password,
			'Invalid native agent password.'
		);
		return password === undefined ? {} : { password };
	},
	'agent.setKey': (value) => {
		const source = input(value, 'agent.setKey');
		return {
			provider: text(source?.provider, 'Provider is required.', 128),
			key: text(source?.key, 'Provider key is required.')
		};
	},
	'agent.saveEndpoint': (value) => {
		const source = input(value, 'agent.saveEndpoint');
		const key = optionalKey(source?.key, 'Invalid provider key.');
		return {
			provider: text(source?.provider, 'Provider is required.', 128),
			name: text(source?.name, 'Service name is required.', 128),
			url: text(source?.url, 'Service URL is required.', 4_096),
			model: text(source?.model, 'Model is required.', 512),
			...(key === undefined ? {} : { key })
		};
	},
	'agent.discoverModels': (value) => {
		const source = input(value, 'agent.discoverModels');
		const key = optionalKey(source?.key, 'Invalid provider key.');
		return {
			url: text(source?.url, 'Server URL is required.', 4_096),
			...(key === undefined ? {} : { key })
		};
	},
	'agent.selectModel': (value) => {
		const source = input(value, 'agent.selectModel');
		return {
			provider: text(source?.provider, 'Provider is required.', 128),
			model: text(source?.model, 'Model is required.', 512)
		};
	},
	'agent.removeProvider': (value) => {
		const source = input(value, 'agent.removeProvider');
		const endpoint = optionalBoolean(source?.endpoint, 'Endpoint selection must be true or false.');
		return {
			provider: text(source?.provider, 'Provider is required.', 128),
			...(endpoint === undefined ? {} : { endpoint })
		};
	},
	'agent.oauthStart': (value) => providerAuth(input(value, 'agent.oauthStart')),
	'agent.oauthFinish': (value) => {
		const source = input(value, 'agent.oauthFinish');
		const code = optionalText(source?.code, 'Invalid provider authorization code.', 10_000);
		return { ...providerAuth(source), ...(code === undefined ? {} : { code }) };
	},
	'agent.readiness': (value) => {
		if (value === undefined) return {};
		const source = input(value, 'agent.readiness')!;
		const provider = optionalText(source.provider, 'Invalid readiness provider.', 128);
		const model = optionalText(source.model, 'Invalid readiness model.', 512);
		if (model && !provider) throw new Error('Choose a service for this model test.');
		return {
			...(provider === undefined ? {} : { provider }),
			...(model === undefined ? {} : { model })
		};
	},
	'agent.remote': (value) => {
		const source = input(value, 'agent.remote');
		const action = source?.action;
		const tool = source?.tool;
		if (
			action !== 'connection' &&
			action !== 'enable' &&
			action !== 'disable' &&
			action !== 'input' &&
			action !== 'cancel' &&
			action !== 'progress'
		)
			throw new Error('Invalid native remote request.');
		if (tool !== 'claude' && tool !== 'codex') throw new Error('Invalid native remote request.');
		const trusted = optionalBoolean(source?.trusted, 'Remote trust must be true or false.');
		if (source?.restartConfirmed !== undefined)
			optionalBoolean(
				source.restartConfirmed,
				'Remote restart confirmation must be true or false.'
			);
		const sandbox = source?.sandbox;
		if (
			sandbox !== undefined &&
			sandbox !== 'read-only' &&
			sandbox !== 'workspace-write' &&
			sandbox !== 'danger-full-access'
		)
			throw new Error('Invalid Codex sandbox mode.');
		const answer = source?.input;
		if (
			answer !== undefined &&
			(typeof answer !== 'string' || answer.length > 16_384 || answer.includes('\0'))
		)
			throw new Error('A native prompt answer must be text.');
		return {
			action,
			tool,
			...(trusted === undefined ? {} : { trusted }),
			...(sandbox === undefined ? {} : { sandbox }),
			...(answer === undefined ? {} : { input: answer })
		};
	},
	'agent.codexRecall': (value) => {
		const source = input(value, 'agent.codexRecall');
		if (source?.action === 'review') return { action: 'review' };
		if (source?.action !== 'approve' && source?.action !== 'disable')
			throw new Error('Invalid recall request.');
		return {
			action: source.action,
			digest: text(source.digest, 'Review the current hooks first.', 128)
		};
	},
	'apps.credentials.create': (value) => {
		const source = input(value, 'apps.credentials.create');
		return {
			username: text(source?.username, 'Credential name is required.', 128),
			policy: policy(source?.policy)
		};
	},
	'apps.credentials.updatePolicy': (value) => {
		const source = input(value, 'apps.credentials.updatePolicy');
		return {
			username: text(source?.username, 'Credential name is required.', 128),
			policy: policy(source?.policy),
			previousPolicy: policy(source?.previousPolicy)
		};
	},
	'apps.credentials.rotate': (value) => ({
		username: text(
			typeof value === 'string' ? value : input(value, 'apps.credentials.rotate')?.username,
			'Credential name is required.',
			128
		)
	}),
	'apps.credentials.remove': (value) => ({
		username: text(
			typeof value === 'string' ? value : input(value, 'apps.credentials.remove')?.username,
			'Credential name is required.',
			128
		)
	}),
	'apps.credentials.revealKey': (value) => ({
		username: text(
			typeof value === 'string' ? value : input(value, 'apps.credentials.revealKey')?.username,
			'Credential name is required.',
			128
		)
	}),
	'apps.portal.mapUser': (value) => {
		const source = input(value, 'apps.portal.mapUser');
		const username = optionalText(source?.username, 'Invalid credential name.', 128);
		return {
			portal: portal(source),
			userId: text(source?.userId, 'Portal user ID is required.', 128),
			...(username === undefined ? {} : { username })
		};
	},
	'apps.portal.saveToken': (value) => {
		const source = input(value, 'apps.portal.saveToken');
		const botToken = optionalKey(source?.botToken, 'Invalid portal token.');
		const appToken = optionalKey(source?.appToken, 'Invalid portal token.');
		return {
			portal: portal(source),
			...(botToken === undefined ? {} : { botToken }),
			...(appToken === undefined ? {} : { appToken })
		};
	},
	'data.backup': (value) => {
		const source = input(value, 'data.backup');
		const full = optionalBoolean(source?.full, 'Invalid full.');
		const includeProviderAuth = optionalBoolean(
			source?.includeProviderAuth,
			'Invalid includeProviderAuth.'
		);
		const includeUserEnv = optionalBoolean(source?.includeUserEnv, 'Invalid includeUserEnv.');
		const includePortalMaps = optionalBoolean(
			source?.includePortalMaps,
			'Invalid includePortalMaps.'
		);
		const includeOAuth = optionalBoolean(source?.includeOAuth, 'Invalid includeOAuth.');
		return {
			destination: text(source?.destination, 'A destination is required.', 4_096),
			...(full === undefined ? {} : { full }),
			...(includeProviderAuth === undefined ? {} : { includeProviderAuth }),
			...(includeUserEnv === undefined ? {} : { includeUserEnv }),
			...(includePortalMaps === undefined ? {} : { includePortalMaps }),
			...(includeOAuth === undefined ? {} : { includeOAuth })
		};
	},
	'data.restoreData': (value) => {
		const source = input(value, 'data.restoreData');
		const apply = optionalBoolean(source?.apply, 'Invalid apply.');
		const acknowledgeUnrestored = optionalBoolean(
			source?.acknowledgeUnrestored,
			'Invalid acknowledgeUnrestored.'
		);
		const includeProviderAuth = optionalBoolean(
			source?.includeProviderAuth,
			'Invalid includeProviderAuth.'
		);
		const includeUserEnv = optionalBoolean(source?.includeUserEnv, 'Invalid includeUserEnv.');
		const includePortalMaps = optionalBoolean(
			source?.includePortalMaps,
			'Invalid includePortalMaps.'
		);
		const includeOAuth = optionalBoolean(source?.includeOAuth, 'Invalid includeOAuth.');
		const previewDigest = optionalText(source?.previewDigest, 'Invalid restore preview.', 128);
		return {
			sourceHome: text(source?.sourceHome, 'A sourceHome is required.', 4_096),
			...(apply === undefined ? {} : { apply }),
			...(acknowledgeUnrestored === undefined ? {} : { acknowledgeUnrestored }),
			...(includeProviderAuth === undefined ? {} : { includeProviderAuth }),
			...(includeUserEnv === undefined ? {} : { includeUserEnv }),
			...(includePortalMaps === undefined ? {} : { includePortalMaps }),
			...(includeOAuth === undefined ? {} : { includeOAuth }),
			...(previewDigest === undefined ? {} : { previewDigest })
		};
	},
	'data.restoreInstance': (value) => {
		const source = input(value, 'data.restoreInstance');
		const apply = optionalBoolean(source?.apply, 'Invalid apply.');
		const previewDigest = optionalText(source?.previewDigest, 'Invalid restore preview.', 128);
		return {
			sourceHome: text(source?.sourceHome, 'A sourceHome is required.', 4_096),
			...(apply === undefined ? {} : { apply }),
			...(previewDigest === undefined ? {} : { previewDigest })
		};
	},
	'data.recovery.status': (value) => {
		if (value !== undefined) throw new Error('Invalid data.recovery.status request.');
		return undefined;
	},
	'data.recovery.inspect': (value) => {
		if (value !== undefined) throw new Error('Invalid data.recovery.inspect request.');
		return undefined;
	},
	'data.recovery.initialize': (value) => {
		if (value !== undefined) throw new Error('Invalid data.recovery.initialize request.');
		return undefined;
	},
	'data.recovery.restore': (value) => {
		if (value !== undefined) throw new Error('Invalid data.recovery.restore request.');
		return undefined;
	},
	'data.recovery.save': (value) => {
		const source = input(value, 'data.recovery.save');
		return {
			baselineDigest: text(source?.baselineDigest, 'Refresh recovery settings before saving.', 128),
			settings: parseRecoverySettings(source?.settings, 'recovery'),
			selection: normalizeSelection(source?.selection)
		};
	},
	'data.recovery.setCredential': (value) => ({
		connectionString: text(
			input(value, 'data.recovery.setCredential')?.connectionString,
			'Invalid recovery credential.'
		)
	}),
	'docker.install': (value) => {
		const source = input(value, 'docker.install');
		const parsed = parseStackConfig(source?.config);
		if (!parsed.ok) throw new Error(parsed.error);
		const automaticPorts = optionalBoolean(
			source?.automaticPorts,
			'Invalid connection port selection.'
		);
		return { config: parsed.config, ...(automaticPorts === undefined ? {} : { automaticPorts }) };
	},
	'docker.saveConfig': (value) => {
		const source = input(value, 'docker.saveConfig');
		const config = parseStackConfig(source?.config);
		if (!config.ok) throw new Error(config.error);
		const baseConfig = parseStackConfig(source?.baseConfig);
		if (!baseConfig.ok)
			throw new Error('Refresh settings before saving; a valid baseline is required.');
		return { config: config.config, baseConfig: baseConfig.config };
	},
	'docker.update': (value) => {
		const pull = optionalBoolean(
			input(value, 'docker.update')?.pull,
			'Update pull selection must be true or false.'
		);
		return pull === undefined ? {} : { pull };
	},
	'docker.directory': (value) => {
		if (value === undefined) return {};
		const path = optionalText(
			input(value, 'docker.directory')!.path,
			'Invalid directory path.',
			4_096
		);
		return path === undefined ? {} : { path };
	}
};

export function parseOperationInput<N extends OperationInputName>(
	name: N,
	value: unknown
): OperationInputMap[N] {
	return parsers[name](value);
}

/** Shared retained wire/Admin credential action envelope parser. */
export function parseLegacyCredentialOperation(value: unknown): LegacyCredentialOperation {
	const source = record(value, 'Choose a credential action.');
	switch (source.action) {
		case 'create':
			return {
				name: 'apps.credentials.create',
				input: parseOperationInput('apps.credentials.create', source)
			};
		case 'policy':
			return {
				name: 'apps.credentials.updatePolicy',
				input: parseOperationInput('apps.credentials.updatePolicy', source)
			};
		case 'rotate':
			return {
				name: 'apps.credentials.rotate',
				input: parseOperationInput('apps.credentials.rotate', source)
			};
		case 'remove':
			return {
				name: 'apps.credentials.remove',
				input: parseOperationInput('apps.credentials.remove', source)
			};
		default:
			throw new Error('Choose a credential action.');
	}
}

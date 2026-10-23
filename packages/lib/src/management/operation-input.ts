import { parseStackConfig, type GuardianPolicy } from '../control-plane/stack-config.js';
import { parseRecoverySettings } from '../control-plane/recovery-config.js';
import { normalizeSelection } from '../../../../containers/assistant/recovery/selection.mjs';
import type {
	AgentOperations,
	AppOperations,
	RemoteSetupRequest,
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

export function parseOperationInput<N extends OperationInputName>(
	name: N,
	value: unknown
): OperationInputMap[N] {
	const input = value === undefined ? undefined : record(value, `Invalid ${name} request.`);
	switch (name) {
		case 'host.logs': {
			if (!input) return undefined as OperationInputMap[N];
			const type = input.type;
			if (type !== undefined && type !== 'system' && type !== 'console')
				throw new Error('Log type must be system or console.');
			const tail = input.tail;
			if (
				tail !== undefined &&
				(typeof tail !== 'number' || !Number.isSafeInteger(tail) || tail < 0 || tail > 10_000)
			)
				throw new Error('Log tail must be a whole number from 0 to 10000.');
			return {
				...(type === undefined ? {} : { type }),
				...(tail === undefined ? {} : { tail }),
				...(optionalText(input.revision, 'Invalid revision.', 256)
					? { revision: optionalText(input.revision, 'Invalid revision.', 256) }
					: {}),
				...(optionalText(input.replica, 'Invalid replica.', 256)
					? { replica: optionalText(input.replica, 'Invalid replica.', 256) }
					: {}),
				...(optionalText(input.container, 'Invalid container.', 256)
					? { container: optionalText(input.container, 'Invalid container.', 256) }
					: {})
			} as OperationInputMap[N];
		}
		case 'host.restart':
		case 'host.console': {
			if (!input) return undefined as OperationInputMap[N];
			const revision = optionalText(input.revision, 'Invalid revision.', 256);
			const replica = optionalText(input.replica, 'Invalid replica.', 256);
			const container = optionalText(input.container, 'Invalid container.', 256);
			return {
				...(revision ? { revision } : {}),
				...(replica ? { replica } : {}),
				...(container ? { container } : {})
			} as OperationInputMap[N];
		}
		case 'agent.connect': {
			if (!input) return {} as OperationInputMap[N];
			const password = optionalText(input.password, 'Invalid native agent password.');
			return (password === undefined ? {} : { password }) as OperationInputMap[N];
		}
		case 'agent.setKey':
			return {
				provider: text(input?.provider, 'Provider is required.', 128),
				key: text(input?.key, 'Provider key is required.')
			} as OperationInputMap[N];
		case 'agent.saveEndpoint': {
			return {
				provider: text(input?.provider, 'Provider is required.', 128),
				name: text(input?.name, 'Service name is required.', 128),
				url: text(input?.url, 'Service URL is required.', 4_096),
				model: text(input?.model, 'Model is required.', 512),
				...(optionalKey(input?.key, 'Invalid provider key.') === undefined
					? {}
					: { key: optionalKey(input?.key, 'Invalid provider key.') })
			} as OperationInputMap[N];
		}
		case 'agent.discoverModels': {
			const key = optionalKey(input?.key, 'Invalid provider key.');
			return {
				url: text(input?.url, 'Server URL is required.', 4_096),
				...(key === undefined ? {} : { key })
			} as OperationInputMap[N];
		}
		case 'agent.selectModel':
			return {
				provider: text(input?.provider, 'Provider is required.', 128),
				model: text(input?.model, 'Model is required.', 512)
			} as OperationInputMap[N];
		case 'agent.removeProvider': {
			const endpoint = optionalBoolean(
				input?.endpoint,
				'Endpoint selection must be true or false.'
			);
			return {
				provider: text(input?.provider, 'Provider is required.', 128),
				...(endpoint === undefined ? {} : { endpoint })
			} as OperationInputMap[N];
		}
		case 'agent.oauthStart':
		case 'agent.oauthFinish': {
			const method = input?.method;
			if (
				typeof method !== 'number' ||
				!Number.isSafeInteger(method) ||
				method < 0 ||
				method > 1_024
			)
				throw new Error('Invalid provider authentication method.');
			const inputs = optionalStringMap(input?.inputs, 'Invalid provider sign-in fields.');
			const base = {
				provider: text(input?.provider, 'Provider is required.', 128),
				method,
				...(inputs ? { inputs } : {})
			};
			if (name === 'agent.oauthStart') return base as OperationInputMap[N];
			const code = optionalText(input?.code, 'Invalid provider authorization code.', 10_000);
			return { ...base, ...(code === undefined ? {} : { code }) } as OperationInputMap[N];
		}
		case 'agent.readiness': {
			if (!input) return {} as OperationInputMap[N];
			const provider = optionalText(input.provider, 'Invalid readiness provider.', 128);
			const model = optionalText(input.model, 'Invalid readiness model.', 512);
			if (model && !provider) throw new Error('Choose a service for this model test.');
			return {
				...(provider ? { provider } : {}),
				...(model ? { model } : {})
			} as OperationInputMap[N];
		}
		case 'agent.remote': {
			const action = input?.action;
			const tool = input?.tool;
			if (
				typeof action !== 'string' ||
				typeof tool !== 'string' ||
				!['connection', 'enable', 'disable', 'input', 'cancel', 'progress'].includes(action) ||
				!['claude', 'codex'].includes(tool)
			)
				throw new Error('Invalid native remote request.');
			const trusted = optionalBoolean(input?.trusted, 'Remote trust must be true or false.');
			// `confirmed` lives in RequestContext. Keep validating the published
			// legacy wire property, but do not leak it into a domain request.
			if (input?.restartConfirmed !== undefined)
				optionalBoolean(
					input.restartConfirmed,
					'Remote restart confirmation must be true or false.'
				);
			const sandbox = input?.sandbox;
			if (
				sandbox !== undefined &&
				(typeof sandbox !== 'string' ||
					!['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox))
			)
				throw new Error('Invalid Codex sandbox mode.');
			// An empty line is a legitimate native CLI answer (press Enter).
			const answer = input?.input;
			if (
				answer !== undefined &&
				(typeof answer !== 'string' || answer.length > 16_384 || answer.includes('\0'))
			)
				throw new Error('A native prompt answer must be text.');
			return {
				action: action as RemoteSetupRequest['action'],
				tool: tool as RemoteSetupRequest['tool'],
				...(trusted === undefined ? {} : { trusted }),
				...(sandbox === undefined ? {} : { sandbox: sandbox as RemoteSetupRequest['sandbox'] }),
				...(answer === undefined ? {} : { input: answer })
			} as OperationInputMap[N];
		}
		case 'agent.codexRecall': {
			if (input?.action === 'review') return { action: 'review' } as OperationInputMap[N];
			if (input?.action !== 'approve' && input?.action !== 'disable')
				throw new Error('Invalid recall request.');
			const digest = text(input.digest, 'Review the current hooks first.', 128);
			return { action: input.action, digest } as OperationInputMap[N];
		}
		case 'apps.credentials.create':
			return {
				username: text(input?.username, 'Credential name is required.', 128),
				policy: policy(input?.policy)
			} as OperationInputMap[N];
		case 'apps.credentials.updatePolicy':
			return {
				username: text(input?.username, 'Credential name is required.', 128),
				policy: policy(input?.policy),
				previousPolicy: policy(input?.previousPolicy)
			} as OperationInputMap[N];
		case 'apps.credentials.rotate':
		case 'apps.credentials.remove':
		case 'apps.credentials.revealKey':
			return {
				username: text(
					typeof value === 'string' ? value : input?.username,
					'Credential name is required.',
					128
				)
			} as OperationInputMap[N];
		case 'apps.portal.mapUser': {
			const portal = input?.portal;
			if (portal !== 'discord' && portal !== 'slack')
				throw new Error('Portal must be discord or slack.');
			const username = optionalText(input?.username, 'Invalid credential name.', 128);
			return {
				portal,
				userId: text(input?.userId, 'Portal user ID is required.', 128),
				...(username === undefined ? {} : { username })
			} as OperationInputMap[N];
		}
		case 'apps.portal.saveToken': {
			const portal = input?.portal;
			if (portal !== 'discord' && portal !== 'slack')
				throw new Error('Portal must be discord or slack.');
			// Blank token fields leave existing private tokens unchanged.
			const botToken = optionalKey(input?.botToken, 'Invalid portal token.');
			const appToken = optionalKey(input?.appToken, 'Invalid portal token.');
			return {
				portal,
				...(botToken === undefined ? {} : { botToken }),
				...(appToken === undefined ? {} : { appToken })
			} as OperationInputMap[N];
		}
		case 'data.backup':
		case 'data.restoreData':
		case 'data.restoreInstance': {
			const source = name === 'data.backup' ? 'destination' : 'sourceHome';
			const base = { [source]: text(input?.[source], `A ${source} is required.`, 4_096) };
			for (const field of [
				'full',
				'apply',
				'acknowledgeUnrestored',
				'includeProviderAuth',
				'includeUserEnv',
				'includePortalMaps',
				'includeOAuth'
			] as const) {
				const selected = optionalBoolean(input?.[field], `Invalid ${field}.`);
				if (selected !== undefined) Object.assign(base, { [field]: selected });
			}
			const previewDigest = optionalText(input?.previewDigest, 'Invalid restore preview.', 128);
			return {
				...base,
				...(previewDigest === undefined ? {} : { previewDigest })
			} as OperationInputMap[N];
		}
		case 'data.recovery.status':
		case 'data.recovery.inspect':
		case 'data.recovery.initialize':
		case 'data.recovery.restore':
			if (value !== undefined) throw new Error(`Invalid ${name} request.`);
			return undefined as OperationInputMap[N];
		case 'data.recovery.save':
			return {
				baselineDigest: text(
					input?.baselineDigest,
					'Refresh recovery settings before saving.',
					128
				),
				// The saved document includes an instance ID, so the parser only needs
				// a neutral fallback project name for complete validation.
				settings: parseRecoverySettings(input?.settings, 'recovery'),
				selection: normalizeSelection(input?.selection)
			} as OperationInputMap[N];
		case 'data.recovery.setCredential':
			return {
				connectionString: text(input?.connectionString, 'Invalid recovery credential.')
			} as OperationInputMap[N];
		case 'docker.install': {
			const parsed = parseStackConfig(input?.config);
			if (!parsed.ok) throw new Error(parsed.error);
			const automaticPorts = optionalBoolean(
				input?.automaticPorts,
				'Invalid connection port selection.'
			);
			return {
				config: parsed.config,
				...(automaticPorts === undefined ? {} : { automaticPorts })
			} as OperationInputMap[N];
		}
		case 'docker.saveConfig': {
			const config = parseStackConfig(input?.config);
			if (!config.ok) throw new Error(config.error);
			const baseConfig = parseStackConfig(input?.baseConfig);
			if (!baseConfig.ok)
				throw new Error('Refresh settings before saving; a valid baseline is required.');
			return { config: config.config, baseConfig: baseConfig.config } as OperationInputMap[N];
		}
		case 'docker.update': {
			const pull = optionalBoolean(input?.pull, 'Update pull selection must be true or false.');
			return (pull === undefined ? {} : { pull }) as OperationInputMap[N];
		}
		case 'docker.directory': {
			if (!input) return {} as OperationInputMap[N];
			const path = optionalText(input.path, 'Invalid directory path.', 4_096);
			return (path === undefined ? {} : { path }) as OperationInputMap[N];
		}
	}
}

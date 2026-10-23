import {
	beginRemoteEnable,
	remoteTool,
	remoteBrowserUrls,
	remoteConnection,
	type CodexSandbox,
	type RemoteEnableSession
} from '../control-plane/remote.js';
import { classifyInstall, requireInstall } from '../control-plane/state.js';
import { connectionDetails } from '../control-plane/connection.js';
import { createFholdState, stackConfigFile } from '../control-plane/foundation.js';
import {
	defaultStackConfig,
	isCodexSandbox,
	parseStackConfig,
	readStackConfig,
	isInstanceName,
	isCredentialUsername
} from '../control-plane/stack-config.js';
import { ensureDockerReady, assertProjectOwnership } from '../control-plane/docker.js';
import { isPortalName } from '../control-plane/portal-credential-store.js';
import { savePortalTokens } from '../control-plane/operations.js';
import { portalSecretConfigured } from '../control-plane/portal-settings.js';
import {
	recoverySnapshot,
	recoveryStatus,
	runRecoveryOperation,
	saveRecoverySettings,
	saveRecoveryCredential
} from '../control-plane/recovery.js';
import { reviewCodexRecall, changeCodexRecall } from '../control-plane/codex-recall.js';
import {
	adminPortalMappings,
	adminPortalTokens,
	backupFromAdmin,
	instanceRestoreFromAdmin,
	createAdminCredential,
	restoreFromAdmin,
	installFromAdmin,
	mapAdminPortalUser,
	removeAdminCredential,
	rotateAdminCredential,
	updateAdminCredentialPolicy,
	saveAdminConfig,
	confirmedAdminAction,
	completeInstanceSetup
} from './domain.js';
import type {
	ManagedSnapshot,
	ManagementMethod,
	InstanceManagement,
	StackAction,
	ManagementRequestArgs,
	ManagementRequestMap
} from './types.js';
import { MANAGEMENT_METHODS } from './types.js';
import { mkdtempSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { updateHome } from '../control-plane/update.js';
import { FH_RUNTIME_VERSION } from '../control-plane/release.js';
import { packTransfer, unpackTransfer } from './transfer.js';
import { publishedConnections } from './connections.js';
import { withAssistantEndpoint } from '../control-plane/opencode.js';
import type { LocalManagementHostPort } from './contracts.js';
import { LocalAgentServices } from './agent-services.js';
import { readCredentialKey } from '../control-plane/credential-store.js';
import { parseOperationInput, parseRequestContext } from './operation-input.js';

/** The same target-bound domain operations run locally or in the owning SSH host CLI. */
export function localInstanceManagement(
	homeDir: string,
	options: { setupName?: string; openUrl?: (url: string) => void; host: LocalManagementHostPort }
): InstanceManagement {
	let closed = false;
	const lifetime = new AbortController();
	let activeRemote: { homeDir: string; session: RemoteEnableSession } | undefined;
	let remoteStarting = false;
	type LegacyHandlerTable = {
		[M in ManagementMethod]: (
			...args: ManagementRequestArgs<M>
		) => ManagementRequestMap[M]['result'] | Promise<ManagementRequestMap[M]['result']>;
	};
	type RegisteredHandler<M extends ManagementMethod> = (
		event: undefined,
		...args: ManagementRequestArgs<M>
	) => ManagementRequestMap[M]['result'] | Promise<ManagementRequestMap[M]['result']>;
	const handlers: Partial<LegacyHandlerTable> = {};
	const managedState = () => createFholdState(homeDir);
	const agent = new LocalAgentServices(
		() => state(),
		options.openUrl,
		(readiness) => completeInstanceSetup(homeDir, readiness)
	);
	const transfers = new Set<string>();
	function handleAdmin<M extends ManagementMethod>(channel: M, handler: RegisteredHandler<M>) {
		// The mapped registration checks each method's resolved result. This is
		// the sole correlated-generic assignment at the JSON-line dispatch edge.
		handlers[channel] = ((...args: ManagementRequestArgs<M>) =>
			handler(undefined, ...args)) as LegacyHandlerTable[M];
	}
	function state() {
		const value = managedState();
		requireInstall(value.homeDir);
		return value;
	}

	function connectionSnapshot(homeDir: string): NonNullable<ManagedSnapshot['connectionDetails']> {
		return {
			opencode: connectionDetails(homeDir, 'opencode'),
			mcp: connectionDetails(homeDir, 'mcp'),
			claude: connectionDetails(homeDir, 'claude')
		};
	}

	async function adminSnapshot(): Promise<ManagedSnapshot> {
		const candidate = managedState();
		const installState = classifyInstall(candidate.homeDir);
		if (installState === 'not_installed') {
			const config = defaultStackConfig(candidate.homeDir);
			if (options.setupName) {
				config.deployment.projectName = options.setupName;
				config.recovery.instanceId = options.setupName;
			}
			return {
				installationReadiness: await ensureDockerReady(),
				phase: 'not_installed',
				homeDir: candidate.homeDir,
				configPath: stackConfigFile(candidate.homeDir),
				config,
				updateImageTag: FH_RUNTIME_VERSION,
				services: [],
				portalMappings: {},
				portalSecrets: {}
			};
		}
		if (installState === 'incompatible_home') {
			throw new Error(
				'The selected folder is incompatible with fhold. Choose an empty directory for installation.'
			);
		}
		const current = state();
		const config = readStackConfig(current.homeDir);
		if (!config.ok) throw new Error(config.error);
		const hosting = await options.host.inspect();
		const details = connectionSnapshot(current.homeDir);
		let connectionError: string | undefined;
		try {
			const endpoints = await publishedConnections(current.homeDir, hosting);
			details.opencode.url = endpoints.assistant ?? '';
			for (const app of ['mcp', 'claude'] as const)
				details[app].url = endpoints.guardian ? `${endpoints.guardian}/mcp` : '';
		} catch (error) {
			connectionError =
				error instanceof Error ? error.message : 'Browser connections could not be resolved.';
			for (const detail of Object.values(details)) detail.url = '';
		}
		const services = hosting.services;
		let recovery: ReturnType<typeof recoverySnapshot> | undefined;
		let recoveryError: string | undefined;
		try {
			recovery = recoverySnapshot(current.homeDir);
		} catch {
			recoveryError =
				'Recovery selection could not be read. Review config/recovery/include.json; no recovery settings were changed.';
		}
		return {
			phase: installState === 'installed' ? 'ready' : 'setup_incomplete',
			homeDir: current.homeDir,
			configPath: stackConfigFile(current.homeDir),
			config: config.config,
			updateImageTag: FH_RUNTIME_VERSION,
			services,
			pendingRestart: hosting.pendingRestart,
			recovery,
			recoveryError,
			...(hosting.warnings.length ? { dockerError: hosting.warnings.join(' ') } : {}),
			portalMappings: adminPortalMappings(current.homeDir),
			portalSecrets: {
				discord: portalSecretConfigured(current.homeDir, 'discord'),
				slack: portalSecretConfigured(current.homeDir, 'slack')
			},
			connectionDetails: details,
			connectionError
		};
	}

	async function runAdminAction(action: StackAction): Promise<ManagedSnapshot> {
		await options.host.operate(action);
		return adminSnapshot();
	}

	handleAdmin('codexRecall', async (_event, value: unknown) => {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new Error('Invalid recall request.');
		const input = value as Record<string, unknown>;
		const current = state();
		if (input.action === 'review') return reviewCodexRecall(current);
		if (input.action !== 'approve' && input.action !== 'disable')
			throw new Error('Unknown recall action.');
		if (typeof input.digest !== 'string') throw new Error('Review the current hooks first.');
		if (remoteStarting || activeRemote?.session.snapshot().running)
			throw new Error('Finish or cancel remote setup first.');
		return changeCodexRecall(current, input.action, input.digest, input.confirmed === true);
	});
	handleAdmin('remote', async (_event, value: unknown) => {
		if (!value || typeof value !== 'object') throw new Error('Invalid native remote request.');
		const input = value as Record<string, unknown>;
		const tool = remoteTool(input.tool);
		const current = state();
		if (input.action === 'connection') {
			const output = await remoteConnection(current, tool);
			if (closed) throw new Error('This instance session was closed.');
			for (const url of remoteBrowserUrls(output)) options.openUrl?.(url);
			return { tool, stage: 'connection', output, running: false, enabled: true };
		}
		if (input.action === 'enable') {
			if (input.restartConfirmed !== true)
				throw new Error('Confirm the possible container restarts before remote setup.');
			if (remoteStarting || activeRemote?.session.snapshot().running)
				throw new Error('Finish or cancel the current remote setup first.');
			if (input.sandbox !== undefined && !isCodexSandbox(input.sandbox))
				throw new Error('Invalid Codex sandbox mode.');
			remoteStarting = true;
			const opened = new Set<string>();
			try {
				const session = await beginRemoteEnable(current, tool, {
					trusted: input.trusted === true,
					sandbox: input.sandbox as CodexSandbox | undefined,
					signal: lifetime.signal,
					update(progress) {
						if (closed) return;
						for (const url of remoteBrowserUrls(progress.output)) {
							if (opened.has(url)) continue;
							opened.add(url);
							options.openUrl?.(url);
						}
					}
				});
				if (closed) {
					session.cancel();
					await session.done;
					throw new Error('This instance session was closed.');
				}
				activeRemote = { homeDir: current.homeDir, session };
				return session.snapshot();
			} finally {
				remoteStarting = false;
			}
		}
		if (input.action === 'disable') {
			const read = readStackConfig(current.homeDir);
			if (!read.ok) throw new Error(read.error);
			const config = structuredClone(read.config);
			config.assistant[tool === 'codex' ? 'codexRemote' : 'claudeRemote'] = false;
			saveAdminConfig(current.homeDir, config, read.config);
			return { tool, stage: 'saved', output: '', running: false, enabled: false };
		}
		if (
			!activeRemote ||
			activeRemote.homeDir !== current.homeDir ||
			activeRemote.session.snapshot().tool !== tool
		)
			throw new Error('Start remote setup for this installation first.');
		if (input.action === 'input') {
			if (typeof input.input !== 'string') throw new Error('A native prompt answer is required.');
			activeRemote.session.input(input.input);
		} else if (input.action === 'cancel') {
			activeRemote.session.cancel();
			return activeRemote.session.done;
		} else if (input.action !== 'progress') throw new Error('Unknown remote setup action.');
		return activeRemote.session.snapshot();
	});
	handleAdmin('snapshot', (_event) => {
		return adminSnapshot();
	});
	handleAdmin('install', async (_event, value: unknown, automaticPorts: unknown = true) => {
		if (typeof automaticPorts !== 'boolean') throw new Error('Invalid connection port selection.');
		const parsed = parseStackConfig(value);
		if (!parsed.ok) throw new Error(parsed.error);
		if (!isInstanceName(parsed.config.deployment.projectName))
			throw new Error(
				'Instance name must be 1–63 lowercase letters, numbers or hyphens, starting and ending with a letter or number.'
			);
		const docker = await ensureDockerReady();
		if (!docker.ok) throw new Error(docker.message);
		await assertProjectOwnership(parsed.config.deployment.projectName);
		await installFromAdmin(parsed.config, homeDir, automaticPorts);
		return runAdminAction('start');
	});
	handleAdmin('saveConfig', async (_event, value: unknown) => {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new Error('Invalid settings save request');
		const input = value as { config?: unknown; baseConfig?: unknown };
		const parsed = parseStackConfig(input.config);
		if (!parsed.ok) throw new Error(parsed.error);
		const baseline = parseStackConfig(input.baseConfig);
		if (!baseline.ok)
			throw new Error('Refresh settings before saving; a valid baseline is required.');
		const current = state();
		saveAdminConfig(current.homeDir, parsed.config, baseline.config);
		return adminSnapshot();
	});
	handleAdmin('action', (_event, input: unknown) => {
		return runAdminAction(confirmedAdminAction(input));
	});
	handleAdmin('logs', async (_event) => {
		return (await options.host.logs({ tail: 250 })).slice(-200_000);
	});
	handleAdmin('providers', () => agent.providers());
	handleAdmin('providerKey', (_event, value) => agent.setKey(value));
	handleAdmin('providerEndpoint', (_event, value) => agent.endpoint(value));
	handleAdmin('providerModels', (_event, value) => agent.models(value));
	handleAdmin('providerUse', (_event, value) => agent.use(value));
	handleAdmin('providerRemove', (_event, value) => agent.remove(value));
	handleAdmin('providerOAuthStart', (_event, value) => agent.oauthStart(value));
	handleAdmin('providerOAuthFinish', (_event, value) => agent.oauthFinish(value));
	handleAdmin('readiness', (_event, value) => agent.readiness(value));
	handleAdmin('assistantPassword', () => agent.password());
	handleAdmin('credential', async (_event, value: unknown) => {
		if (!value || typeof value !== 'object') throw new Error('Invalid credential operation');
		const input = value as {
			action?: unknown;
			username?: unknown;
			policy?: unknown;
			previousPolicy?: unknown;
		};
		const current = state();
		if (input.action === 'create') {
			createAdminCredential(current.homeDir, {
				username: input.username,
				policy: input.policy
			});
		} else if (input.action === 'policy') {
			if (
				typeof input.username !== 'string' ||
				typeof input.policy !== 'string' ||
				typeof input.previousPolicy !== 'string'
			)
				throw new Error('Invalid credential policy update.');
			updateAdminCredentialPolicy(current.homeDir, {
				username: input.username,
				policy: input.policy as import('../control-plane/stack-config.js').GuardianPolicy,
				previousPolicy:
					input.previousPolicy as import('../control-plane/stack-config.js').GuardianPolicy
			});
		} else if (input.action === 'rotate') rotateAdminCredential(current.homeDir, input.username);
		else if (input.action === 'remove') removeAdminCredential(current.homeDir, input.username);
		else throw new Error('Invalid credential operation');
		return adminSnapshot();
	});
	handleAdmin('credentialKey', (_event, value) => {
		if (!isCredentialUsername(value)) throw new Error('Invalid credential username.');
		const current = state();
		const config = readStackConfig(current.homeDir);
		if (!config.ok) throw new Error(config.error);
		if (!Object.hasOwn(config.config.credentials, value))
			throw new Error(`Unknown credential: ${value}`);
		return { username: value, key: readCredentialKey(current.homeDir, value) };
	});
	handleAdmin('mapPortalUser', async (_event, value: unknown) => {
		if (!value || typeof value !== 'object') throw new Error('Invalid portal mapping');
		const current = state();
		mapAdminPortalUser(current.homeDir, parseOperationInput('apps.portal.mapUser', value));
		return adminSnapshot();
	});
	handleAdmin('portalToken', async (_event, value: unknown) => {
		if (!value || typeof value !== 'object') throw new Error('Invalid portal token operation');
		const input = value as { portal?: unknown; botToken?: unknown; appToken?: unknown };
		if (!isPortalName(input.portal)) throw new Error('Portal must be discord or slack.');
		const current = state();
		const config = readStackConfig(current.homeDir);
		if (!config.ok) throw new Error(config.error);
		const configured = portalSecretConfigured(current.homeDir, input.portal);
		const { botToken, appToken } = adminPortalTokens(value, configured);
		savePortalTokens(current.homeDir, { portal: input.portal, botToken, appToken });
		return adminSnapshot();
	});
	handleAdmin('backup', (_event, value: unknown) => {
		if (!value || typeof value !== 'object') throw new Error('Invalid backup request');
		const current = state();
		return backupFromAdmin(current.homeDir, {
			...parseOperationInput('data.backup', value),
			...parseRequestContext(value)
		});
	});
	handleAdmin('recovery', async (_event, value: unknown) => {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new Error('Invalid recovery request.');
		const input = value as Record<string, unknown>;
		const home = state().homeDir;
		if (input.action === 'save') {
			if (typeof input.baselineDigest !== 'string')
				throw new Error('Refresh recovery settings before saving.');
			saveRecoverySettings(home, {
				settings: input.settings,
				selection: input.selection,
				baselineDigest: input.baselineDigest
			});
			return adminSnapshot();
		}
		if (input.action === 'credential') {
			saveRecoveryCredential(home, input.connectionString);
			return adminSnapshot();
		}
		if (input.action === 'status') return recoveryStatus(home);
		if (input.action === 'inspect' || input.action === 'init' || input.action === 'restore')
			return runRecoveryOperation(home, input.action, input.confirmed === true);
		throw new Error('Invalid recovery action.');
	});
	handleAdmin('restoreData', (_event, value: unknown) => {
		if (!value || typeof value !== 'object') throw new Error('Invalid restore request');
		const current = state();
		return restoreFromAdmin(current.homeDir, {
			...parseOperationInput('data.restoreData', value),
			...parseRequestContext(value)
		});
	});
	handleAdmin('restoreInstance', (_event, value: unknown) => {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new Error('Invalid full-instance import request.');
		return instanceRestoreFromAdmin(managedState().homeDir, {
			...parseOperationInput('data.restoreInstance', value),
			...parseRequestContext(value)
		});
	});
	handleAdmin('update', async (_event, value: unknown) => {
		const input = value as { confirmed?: unknown; pull?: unknown } | undefined;
		if (input?.confirmed !== true) throw Error('Confirm the instance update before continuing.');
		await updateHome({
			homeDir,
			start: true,
			pull: typeof input.pull === 'boolean' ? input.pull : undefined
		});
		return adminSnapshot();
	});
	handleAdmin('transferCreate', () => {
		const directory = mkdtempSync(join(tmpdir(), 'fhold-transfer-'));
		transfers.add(directory);
		return directory;
	});
	handleAdmin('directory', (_event, value: unknown) => {
		let path = typeof value === 'string' ? value : dirname(homeDir);
		if (!isAbsolute(path) || path.includes('\0'))
			throw Error('Choose an absolute directory on this computer.');
		while (!existsSync(path) && dirname(path) !== path) path = dirname(path);
		const directories = readdirSync(path, { withFileTypes: true })
			.filter((entry) => {
				if (entry.isDirectory()) return true;
				if (!entry.isSymbolicLink()) return false;
				try {
					return (
						statSync(join(path, entry.name), { throwIfNoEntry: false })?.isDirectory() === true
					);
				} catch {
					return false;
				}
			})
			.map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
			.sort((a, b) => a.name.localeCompare(b.name));
		return { path, parent: dirname(path), directories };
	});
	handleAdmin('transferRelease', (_event, value: unknown) => {
		if (typeof value !== 'string' || !transfers.has(value))
			throw Error('Unknown transfer workspace.');
		rmSync(value, { recursive: true, force: true });
		transfers.delete(value);
	});
	for (const method of ['transferPack', 'transferUnpack'] as const)
		handleAdmin(method, async (_event, value: unknown) => {
			if (typeof value !== 'string' || !transfers.has(value))
				throw Error('Unknown transfer workspace.');
			const archive = join(value, 'transfer.tgz');
			if (method === 'transferPack') await packTransfer(join(value, 'export'), archive);
			else await unpackTransfer(archive, join(value, 'unpacked'));
			return method === 'transferPack' ? archive : join(value, 'unpacked', 'payload');
		});
	if (!MANAGEMENT_METHODS.every((method) => handlers[method]))
		throw new Error('Internal management handler registration is incomplete.');
	return {
		async call<M extends ManagementMethod>(
			method: M,
			...args: ManagementRequestArgs<M>
		): Promise<ManagementRequestMap[M]['result']> {
			if (closed) throw new Error('This instance session is closed. Open it again.');
			const handler = handlers[method] as LegacyHandlerTable[M] | undefined;
			if (!handler) throw Error('Unsupported instance operation.');
			if (method.startsWith('provider') || method === 'readiness') {
				const current = state();
				const endpoint = (await publishedConnections(current.homeDir, await options.host.inspect()))
					.assistant;
				if (!endpoint) throw Error('Start this instance before managing its AI services.');
				return await withAssistantEndpoint(
					current.homeDir,
					endpoint,
					async () => await handler(...args)
				);
			}
			return await handler(...args);
		},
		busy: () => remoteStarting || !!activeRemote?.session.snapshot().running,
		async close() {
			if (closed) return;
			closed = true;
			lifetime.abort();
			agent.close();
			activeRemote?.session.cancel();
			await activeRemote?.session.done;
			for (const directory of transfers) rmSync(directory, { recursive: true, force: true });
			transfers.clear();
		}
	};
}

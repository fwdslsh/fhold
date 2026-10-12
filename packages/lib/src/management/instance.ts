import {
	beginRemoteEnable,
	remoteTool,
	remoteBrowserUrls,
	remoteConnection,
	type CodexSandbox,
	type RemoteEnableSession
} from '../control-plane/remote.js';
import {
	beginProviderOAuth,
	completeProviderOAuth,
	configureGuardianModeratorModel,
	setProviderApiKey,
	testAssistantReadiness,
	type AssistantReadiness
} from '../control-plane/opencode.js';
import { classifyInstall, markInstalled, requireInstall } from '../control-plane/state.js';
import { connectionDetails } from '../control-plane/connection.js';
import { createFholdState, stackConfigFile } from '../control-plane/foundation.js';
import {
	defaultStackConfig,
	isCodexSandbox,
	isCredentialUsername,
	parseStackConfig,
	readStackConfig,
	isInstanceName
} from '../control-plane/stack-config.js';
import { ensureDockerReady, assertProjectOwnership } from '../control-plane/docker.js';
import { isPortalName } from '../control-plane/portal-credential-store.js';
import {
	listProviderSettings,
	saveProviderEndpoint,
	discoverProviderModels,
	useProviderModel,
	removeProviderSetup
} from '../control-plane/provider-settings.js';
import { mutateStack, savePortalTokens } from '../control-plane/operations.js';
import { portalSecretConfigured } from '../control-plane/portal-settings.js';
import { readCredentialKey } from '../control-plane/credential-store.js';
import {
	inspectLocalInstance,
	operateLocalInstance,
	localInstanceLogs
} from '../hosting/local-docker.js';
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
	saveAdminConfig,
	confirmedAdminAction
} from './domain.js';
import type {
	ManagedSnapshot,
	ManagementMethod,
	InstanceManagement,
	StackAction
} from './types.js';
import { mkdtempSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { updateHome } from '../control-plane/update.js';
import { packTransfer, unpackTransfer } from './transfer.js';
import { publishedConnections } from './connections.js';
import { withAssistantEndpoint } from '../control-plane/opencode.js';

/** The same target-bound domain operations run locally or in the owning SSH host CLI. */
export function localInstanceManagement(
	homeDir: string,
	options: { setupName?: string; openUrl?: (url: string) => void } = {}
): InstanceManagement {
	let activeRemote: { homeDir: string; session: RemoteEnableSession } | undefined;
	let remoteStarting = false;
	let pendingOAuth:
		| { homeDir: string; provider: string; method: number; attemptID: string }
		| undefined;
	let verifiedModel:
		| { homeDir: string; readiness: Extract<AssistantReadiness, { ok: true }> }
		| undefined;
	const handlers = new Map<string, (value?: unknown, ...extra: unknown[]) => unknown>();
	const managedState = () => createFholdState(homeDir);
	const transfers = new Set<string>();
	function handleAdmin(
		channel: string,
		handler: (_event: undefined, value?: unknown, ...extra: never[]) => unknown
	) {
		handlers.set(channel, (value, ...extra) => handler(undefined, value, ...(extra as never[])));
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

	function oauthInput(value: unknown): {
		provider: string;
		method: number;
		inputs?: Record<string, string>;
	} {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('Invalid provider sign-in request.');
		}
		const input = value as { provider?: unknown; method?: unknown; inputs?: unknown };
		if (typeof input.provider !== 'string' || typeof input.method !== 'number') {
			throw new Error('Provider and sign-in method are required.');
		}
		if (
			input.inputs !== undefined &&
			(!input.inputs || typeof input.inputs !== 'object' || Array.isArray(input.inputs))
		) {
			throw new Error('Invalid provider sign-in fields.');
		}
		if (
			input.inputs &&
			Object.values(input.inputs as Record<string, unknown>).some(
				(item) => typeof item !== 'string'
			)
		) {
			throw new Error('Invalid provider sign-in fields.');
		}
		return {
			provider: input.provider,
			method: input.method,
			...(input.inputs ? { inputs: input.inputs as Record<string, string> } : {})
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
		const hosting = await inspectLocalInstance(current.homeDir);
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
		const current = state();
		await operateLocalInstance(current.homeDir, action);
		return adminSnapshot();
	}

	async function completeAdminReadiness(
		homeDir: string,
		readiness: AssistantReadiness
	): Promise<void> {
		if (!readiness.ok) return;
		mutateStack(homeDir, () => {
			configureGuardianModeratorModel(homeDir, readiness.provider, readiness.model);
			markInstalled(homeDir);
		});
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
					update(progress) {
						for (const url of remoteBrowserUrls(progress.output)) {
							if (opened.has(url)) continue;
							opened.add(url);
							options.openUrl?.(url);
						}
					}
				});
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
		const current = state();
		return (await localInstanceLogs(current.homeDir, { tail: 250 })).slice(-200_000);
	});
	handleAdmin('providers', (_event) => {
		const current = state();
		return listProviderSettings(current.homeDir);
	});
	handleAdmin('providerKey', async (_event, value: unknown) => {
		if (!value || typeof value !== 'object') throw new Error('Invalid provider settings');
		const input = value as { provider?: unknown; key?: unknown };
		if (typeof input.provider !== 'string' || typeof input.key !== 'string') {
			throw new Error('Provider and key are required.');
		}
		const current = state();
		verifiedModel = undefined;
		await setProviderApiKey(current.homeDir, input.provider, input.key);
	});
	handleAdmin('providerEndpoint', (_event, value: unknown) => {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new Error('Invalid AI service settings.');
		const input = value as {
			provider?: unknown;
			name?: unknown;
			url?: unknown;
			model?: unknown;
			key?: unknown;
		};
		if (
			typeof input.provider !== 'string' ||
			typeof input.name !== 'string' ||
			typeof input.url !== 'string' ||
			typeof input.model !== 'string' ||
			(input.key !== undefined && typeof input.key !== 'string')
		)
			throw new Error('Service, URL and model are required.');
		verifiedModel = undefined;
		return saveProviderEndpoint(state().homeDir, {
			provider: input.provider,
			name: input.name,
			url: input.url,
			model: input.model,
			...(typeof input.key === 'string' ? { key: input.key } : {})
		});
	});
	handleAdmin('providerModels', (_event, value: unknown) => {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new Error('Invalid server settings.');
		const input = value as { url?: unknown; key?: unknown };
		if (typeof input.url !== 'string' || (input.key !== undefined && typeof input.key !== 'string'))
			throw new Error('Server URL is required.');
		return discoverProviderModels(state().homeDir, {
			url: input.url,
			...(typeof input.key === 'string' ? { key: input.key } : {})
		});
	});
	handleAdmin('providerUse', async (_event, value: unknown) => {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new Error('Invalid model selection.');
		const input = value as { provider?: unknown; model?: unknown };
		if (typeof input.provider !== 'string' || typeof input.model !== 'string')
			throw new Error('Service and model are required.');
		const current = state();
		if (
			!verifiedModel ||
			verifiedModel.homeDir !== current.homeDir ||
			verifiedModel.readiness.provider !== input.provider ||
			verifiedModel.readiness.model !== input.model
		)
			throw new Error('Test this model before using it for your agent.');
		const settings = await useProviderModel(current.homeDir, input.provider, input.model);
		await completeAdminReadiness(current.homeDir, verifiedModel.readiness);
		return settings;
	});
	handleAdmin('providerRemove', (_event, value: unknown) => {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new Error('Invalid saved setup.');
		const input = value as { provider?: unknown; endpoint?: unknown };
		if (
			typeof input.provider !== 'string' ||
			(input.endpoint !== undefined && typeof input.endpoint !== 'boolean')
		)
			throw new Error('Service is required.');
		verifiedModel = undefined;
		return removeProviderSetup(state().homeDir, input.provider, {
			endpoint: input.endpoint === true
		});
	});
	handleAdmin('providerOAuthStart', async (_event, value: unknown) => {
		const input = oauthInput(value);
		const current = state();
		const authorization = await beginProviderOAuth(
			current.homeDir,
			input.provider,
			input.method,
			input.inputs
		);
		pendingOAuth = {
			homeDir: current.homeDir,
			provider: input.provider,
			method: input.method,
			attemptID: authorization.attemptID
		};
		options.openUrl?.(authorization.url);
		return authorization;
	});
	handleAdmin('providerOAuthFinish', async (_event, value: unknown) => {
		const input = oauthInput(value);
		const rawCode = (value as { code?: unknown }).code;
		if (rawCode !== undefined && typeof rawCode !== 'string') {
			throw new Error('Invalid provider authorization code.');
		}
		const current = state();
		if (
			!pendingOAuth ||
			pendingOAuth.homeDir !== current.homeDir ||
			pendingOAuth.provider !== input.provider ||
			pendingOAuth.method !== input.method
		)
			throw new Error('Start provider sign-in for this instance first.');
		await completeProviderOAuth(current.homeDir, input.provider, pendingOAuth.attemptID, rawCode);
		pendingOAuth = undefined;
		verifiedModel = undefined;
	});
	handleAdmin('readiness', (_event, value: unknown) => {
		if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
			throw new Error('Invalid provider readiness request.');
		}
		const rawProvider = (value as { provider?: unknown } | undefined)?.provider;
		const rawModel = (value as { model?: unknown } | undefined)?.model;
		if (rawProvider !== undefined && typeof rawProvider !== 'string') {
			throw new Error('Invalid readiness provider.');
		}
		if (rawModel !== undefined && (typeof rawModel !== 'string' || !rawProvider))
			throw new Error('Choose a service for this model test.');
		const current = state();
		return testAssistantReadiness(current.homeDir, {
			...(rawProvider ? { provider: rawProvider } : {}),
			...(typeof rawModel === 'string' ? { model: rawModel } : {})
		}).then(async (readiness) => {
			verifiedModel = readiness.ok ? { homeDir: current.homeDir, readiness } : undefined;
			// A successful candidate test is not a default-model choice. Complete
			// new setup after explicit Use; checking the existing default is enough.
			const settings = readiness.ok ? await listProviderSettings(current.homeDir) : undefined;
			if (
				!rawProvider ||
				(readiness.ok &&
					settings?.currentModel?.provider === readiness.provider &&
					settings?.currentModel?.model === readiness.model)
			) {
				await completeAdminReadiness(current.homeDir, readiness);
			}
			return readiness;
		});
	});
	handleAdmin('assistantPassword', (_event) => {
		const current = state();
		const details = connectionDetails(current.homeDir, 'opencode', {
			showAssistantPassword: true
		});
		if (!details.password) throw new Error('OpenCode password is unavailable.');
		return { password: details.password };
	});
	handleAdmin('credential', async (_event, value: unknown) => {
		if (!value || typeof value !== 'object') throw new Error('Invalid credential operation');
		const input = value as { action?: unknown; username?: unknown; policy?: unknown };
		const current = state();
		if (input.action === 'create') {
			createAdminCredential(current.homeDir, {
				username: input.username,
				policy: input.policy
			});
		} else if (input.action === 'rotate') rotateAdminCredential(current.homeDir, input.username);
		else if (input.action === 'remove') removeAdminCredential(current.homeDir, input.username);
		else throw new Error('Invalid credential operation');
		return adminSnapshot();
	});
	handleAdmin('credentialKey', (_event, value: unknown) => {
		if (!isCredentialUsername(value)) throw new Error('Invalid credential username.');
		const current = state();
		const config = readStackConfig(current.homeDir);
		if (!config.ok) throw new Error(config.error);
		if (!Object.hasOwn(config.config.credentials, value)) {
			throw new Error(`Unknown credential: ${value}`);
		}
		return { username: value, key: readCredentialKey(current.homeDir, value) };
	});
	handleAdmin('mapPortalUser', async (_event, value: unknown) => {
		if (!value || typeof value !== 'object') throw new Error('Invalid portal mapping');
		const current = state();
		mapAdminPortalUser(current.homeDir, value as never);
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
		return backupFromAdmin(current.homeDir, value as never);
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
		return restoreFromAdmin(current.homeDir, value as never);
	});
	handleAdmin('restoreInstance', (_event, value: unknown) => {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new Error('Invalid full-instance import request.');
		return instanceRestoreFromAdmin(managedState().homeDir, value as never);
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
	return {
		async call<T>(method: ManagementMethod, value?: unknown, ...extra: unknown[]): Promise<T> {
			const handler = handlers.get(method);
			if (!handler) throw Error('Unsupported instance operation.');
			if (method.startsWith('provider') || method === 'readiness') {
				const current = state();
				const endpoint = (
					await publishedConnections(current.homeDir, await inspectLocalInstance(current.homeDir))
				).assistant;
				if (!endpoint) throw Error('Start this instance before managing its AI services.');
				return await withAssistantEndpoint(
					current.homeDir,
					endpoint,
					async () => (await handler(value, ...extra)) as T
				);
			}
			return (await handler(value, ...extra)) as T;
		},
		busy: () => remoteStarting || !!activeRemote?.session.snapshot().running,
		async close() {
			activeRemote?.session.cancel();
			await activeRemote?.session.done;
			for (const directory of transfers) rmSync(directory, { recursive: true, force: true });
			transfers.clear();
		}
	};
}

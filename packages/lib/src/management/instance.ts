import {
	beginRemoteEnable,
	remoteBrowserUrls,
	remoteConnection,
	type RemoteEnableSession
} from '../control-plane/remote.js';
import { classifyInstall, requireInstall } from '../control-plane/state.js';
import { connectionDetails } from '../control-plane/connection.js';
import { createFholdState, stackConfigFile } from '../control-plane/foundation.js';
import {
	defaultStackConfig,
	readStackConfig,
	isCredentialUsername
} from '../control-plane/stack-config.js';
import { ensureDockerReady, assertProjectOwnership } from '../control-plane/docker.js';
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
import { assertInstallInstanceName } from '../control-plane/install.js';

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
	const managedState = () => createFholdState(homeDir);
	const agent = new LocalAgentServices(
		() => state(),
		options.openUrl,
		(readiness) => completeInstanceSetup(homeDir, readiness)
	);
	const transfers = new Set<string>();
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

	const handlers: LegacyHandlerTable = {
		codexRecall: async (value) => {
			const current = state();
			if (value.action === 'review') return reviewCodexRecall(current);
			if (remoteStarting || activeRemote?.session.snapshot().running)
				throw new Error('Finish or cancel remote setup first.');
			return changeCodexRecall(current, value.action, value.digest, value.confirmed === true);
		},
		remote: async (value) => {
			const tool = value.tool;
			const current = state();
			if (value.action === 'connection') {
				const output = await remoteConnection(current, tool);
				if (closed) throw new Error('This instance session was closed.');
				for (const url of remoteBrowserUrls(output)) options.openUrl?.(url);
				return { tool, stage: 'connection', output, running: false, enabled: true };
			}
			if (value.action === 'enable') {
				if (value.restartConfirmed !== true)
					throw new Error('Confirm the possible container restarts before remote setup.');
				if (remoteStarting || activeRemote?.session.snapshot().running)
					throw new Error('Finish or cancel the current remote setup first.');
				remoteStarting = true;
				const opened = new Set<string>();
				try {
					const session = await beginRemoteEnable(current, tool, {
						trusted: value.trusted === true,
						sandbox: value.sandbox,
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
			if (value.action === 'disable') {
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
			if (value.action === 'input') {
				if (value.input === undefined) throw new Error('A native prompt answer is required.');
				activeRemote.session.input(value.input);
			} else if (value.action === 'cancel') {
				activeRemote.session.cancel();
				return activeRemote.session.done;
			} else if (value.action !== 'progress') throw new Error('Unknown remote setup action.');
			return activeRemote.session.snapshot();
		},
		snapshot: () => {
			return adminSnapshot();
		},
		install: async (value, automaticPorts = true) => {
			assertInstallInstanceName(value.deployment.projectName);
			const docker = await ensureDockerReady();
			if (!docker.ok) throw new Error(docker.message);
			await assertProjectOwnership(value.deployment.projectName);
			await installFromAdmin(value, homeDir, automaticPorts);
			return runAdminAction('start');
		},
		saveConfig: async (value) => {
			const current = state();
			saveAdminConfig(current.homeDir, value.config, value.baseConfig);
			return adminSnapshot();
		},
		action: (input) => {
			if (!input.confirmed) throw Error('Confirm the instance lifecycle change before continuing.');
			return runAdminAction(input.action);
		},
		logs: async () => {
			return (await options.host.logs({ tail: 250 })).slice(-200_000);
		},
		providers: () => agent.providers(),
		providerKey: (value) => agent.setKey(value),
		providerEndpoint: (value) => agent.endpoint(value),
		providerModels: (value) => agent.models(value),
		providerUse: (value) => agent.use(value),
		providerRemove: (value) => agent.remove(value),
		providerOAuthStart: (value) => agent.oauthStart(value),
		providerOAuthFinish: (value) => agent.oauthFinish(value),
		readiness: (value) => agent.readiness(value),
		assistantPassword: () => agent.password(),
		credential: async (value) => {
			const current = state();
			if (value.action === 'create')
				createAdminCredential(current.homeDir, {
					username: value.username,
					policy: value.policy
				});
			else if (value.action === 'policy')
				updateAdminCredentialPolicy(current.homeDir, {
					username: value.username,
					policy: value.policy,
					previousPolicy: value.previousPolicy
				});
			else if (value.action === 'rotate') rotateAdminCredential(current.homeDir, value.username);
			else removeAdminCredential(current.homeDir, value.username);
			return adminSnapshot();
		},
		credentialKey: (value) => {
			if (!isCredentialUsername(value)) throw new Error('Invalid credential username.');
			const current = state();
			const config = readStackConfig(current.homeDir);
			if (!config.ok) throw new Error(config.error);
			if (!Object.hasOwn(config.config.credentials, value))
				throw new Error(`Unknown credential: ${value}`);
			return { username: value, key: readCredentialKey(current.homeDir, value) };
		},
		mapPortalUser: async (value) => {
			const current = state();
			mapAdminPortalUser(current.homeDir, value);
			return adminSnapshot();
		},
		portalToken: async (value) => {
			const current = state();
			const configured = portalSecretConfigured(current.homeDir, value.portal);
			const { botToken, appToken } = adminPortalTokens(value, configured);
			savePortalTokens(current.homeDir, { portal: value.portal, botToken, appToken });
			return adminSnapshot();
		},
		backup: (value) => {
			const current = state();
			return backupFromAdmin(current.homeDir, value);
		},
		recovery: async (value) => {
			const home = state().homeDir;
			if (value.action === 'save') {
				saveRecoverySettings(home, {
					baselineDigest: value.baselineDigest,
					settings: value.settings,
					selection: value.selection
				});
				return adminSnapshot();
			}
			if (value.action === 'credential') {
				saveRecoveryCredential(home, value.connectionString);
				return adminSnapshot();
			}
			if (value.action === 'status') return recoveryStatus(home);
			return runRecoveryOperation(home, value.action, value.confirmed === true);
		},
		restoreData: (value) => {
			const current = state();
			return restoreFromAdmin(current.homeDir, value);
		},
		restoreInstance: (value) => {
			return instanceRestoreFromAdmin(managedState().homeDir, value);
		},
		update: async (value) => {
			if (!value.confirmed) throw Error('Confirm the instance update before continuing.');
			await updateHome({
				homeDir,
				start: true,
				pull: value.pull
			});
			return adminSnapshot();
		},
		transferCreate: () => {
			const directory = mkdtempSync(join(tmpdir(), 'fhold-transfer-'));
			transfers.add(directory);
			return directory;
		},
		directory: (value) => {
			let path = value ?? dirname(homeDir);
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
		},
		transferRelease: (value) => {
			if (!transfers.has(value)) throw Error('Unknown transfer workspace.');
			rmSync(value, { recursive: true, force: true });
			transfers.delete(value);
		},
		transferPack: async (value) => {
			if (!transfers.has(value)) throw Error('Unknown transfer workspace.');
			const archive = join(value, 'transfer.tgz');
			await packTransfer(join(value, 'export'), archive);
			return archive;
		},
		transferUnpack: async (value) => {
			if (!transfers.has(value)) throw Error('Unknown transfer workspace.');
			const archive = join(value, 'transfer.tgz');
			await unpackTransfer(archive, join(value, 'unpacked'));
			return join(value, 'unpacked', 'payload');
		}
	};
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

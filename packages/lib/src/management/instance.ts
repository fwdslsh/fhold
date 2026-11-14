import {
	beginRemoteEnable,
	remoteBrowserUrls,
	remoteConnection,
	type RemoteEnableSession
} from '../control-plane/remote.js';
import { classifyInstall, requireInstall } from '../control-plane/state.js';
import {
	exportCheckpointPackage,
	previewCheckpointPackage,
	importCheckpointPackage
} from '../control-plane/checkpoint-packages.js';
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
	InstanceManagement,
	ManagementOperation,
	ManagementOperationMap
} from './types.js';
import { mkdtempSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { updateHome } from '../control-plane/update.js';
import { FH_RUNTIME_LABEL } from '../control-plane/release.js';
import { packTransfer, unpackTransfer } from './transfer.js';
import { publishedConnections } from './connections.js';
import { localAuthorization } from '../control-plane/opencode.js';
import { createNativeAgentService } from '../control-plane/native-agent.js';
import { localProviderSettings } from '../control-plane/provider-settings.js';
import type { LocalManagementHostPort, RequestContext } from './contracts.js';
import { AgentServices } from './agent-services.js';
import { readCredentialKey } from '../control-plane/credential-store.js';
import { assertInstallInstanceName } from '../control-plane/install.js';
import { KnowledgeUi } from './knowledge-ui.js';

/** The same target-bound domain operations run locally or in the owning SSH host CLI. */
export function localInstanceManagement(
	homeDir: string,
	options: { setupName?: string; openUrl?: (url: string) => void; host: LocalManagementHostPort }
): InstanceManagement {
	let closed = false;
	const lifetime = new AbortController();
	let activeRemote: { homeDir: string; session: RemoteEnableSession } | undefined;
	let remoteStarting = false;
	type HandlerTable = {
		[N in ManagementOperation]: (
			input: ManagementOperationMap[N]['input'],
			context: RequestContext
		) => ManagementOperationMap[N]['result'] | Promise<ManagementOperationMap[N]['result']>;
	};
	const managedState = () => createFholdState(homeDir);
	const agent = new AgentServices({
		async bind() {
			const current = state();
			const endpoint = (await publishedConnections(current.homeDir, await options.host.inspect()))
				.assistant;
			if (!endpoint) throw Error('Start this instance before managing its AI services.');
			return localProviderSettings(
				current.homeDir,
				createNativeAgentService({
					endpoint,
					authorization: () => localAuthorization(current.homeDir)
				})
			);
		},
		openUrl: options.openUrl,
		completeSetup: (readiness) => completeInstanceSetup(homeDir, readiness)
	});
	const transfers = new Set<string>();
	const knowledgeUi = new KnowledgeUi(homeDir);
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
				updateImageTag: FH_RUNTIME_LABEL,
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
			updateImageTag: FH_RUNTIME_LABEL,
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

	const handlers: HandlerTable = {
		snapshot: () => adminSnapshot(),
		'agent.providers': (_input, context) => agent.providers(context),
		'agent.setKey': (input, context) => agent.setKey(input, context),
		'agent.saveEndpoint': (input, context) => agent.endpoint(input, context),
		'agent.discoverModels': (input, context) => agent.models(input, context),
		'agent.selectModel': (input, context) => agent.use(input, context),
		'agent.removeProvider': (input, context) => agent.remove(input, context),
		'agent.oauthStart': (input, context) => agent.oauthStart(input, context),
		'agent.oauthFinish': (input, context) => agent.oauthFinish(input, context),
		'agent.readiness': (input, context) => agent.readiness(input, context),
		'agent.assistantPassword': () => {
			const details = connectionDetails(state().homeDir, 'opencode', {
				showAssistantPassword: true
			});
			if (!details.password) throw new Error('OpenCode password is unavailable.');
			return { password: details.password };
		},
		'agent.codexRecall': async (input, context) => {
			const current = state();
			if (input.action === 'review') return reviewCodexRecall(current);
			if (remoteStarting || activeRemote?.session.snapshot().running)
				throw new Error('Finish or cancel remote setup first.');
			return changeCodexRecall(current, input.action, input.digest, context.confirmed === true);
		},
		'agent.remote': async (value, context) => {
			const tool = value.tool;
			const current = state();
			if (value.action === 'connection') {
				const output = await remoteConnection(current, tool);
				if (closed) throw new Error('This instance session was closed.');
				for (const url of remoteBrowserUrls(output)) options.openUrl?.(url);
				return { tool, stage: 'connection', output, running: false, enabled: true };
			}
			if (value.action === 'enable') {
				if (context.confirmed !== true)
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
		'apps.credentials.create': (input) => {
			createAdminCredential(state().homeDir, input);
		},
		'apps.credentials.updatePolicy': (input) => {
			updateAdminCredentialPolicy(state().homeDir, input);
		},
		'apps.credentials.rotate': (input) => {
			rotateAdminCredential(state().homeDir, input.username);
		},
		'apps.credentials.remove': (input) => {
			removeAdminCredential(state().homeDir, input.username);
		},
		'apps.credentials.revealKey': ({ username }) => {
			if (!isCredentialUsername(username)) throw new Error('Invalid credential username.');
			const current = state();
			const config = readStackConfig(current.homeDir);
			if (!config.ok) throw new Error(config.error);
			if (!Object.hasOwn(config.config.credentials, username))
				throw new Error(`Unknown credential: ${username}`);
			return { username, key: readCredentialKey(current.homeDir, username) };
		},
		'apps.portal.mapUser': (input) => {
			mapAdminPortalUser(state().homeDir, input);
		},
		'apps.portal.saveToken': (input) => {
			const current = state();
			const configured = portalSecretConfigured(current.homeDir, input.portal);
			const { botToken, appToken } = adminPortalTokens(input, configured);
			savePortalTokens(current.homeDir, { portal: input.portal, botToken, appToken });
		},
		'data.knowledgeUi': (input) => knowledgeUi.open(input || undefined),
		'data.backup': (input, context) => backupFromAdmin(state().homeDir, { ...input, ...context }),
		'data.restoreData': (input, context) =>
			restoreFromAdmin(state().homeDir, { ...input, ...context }),
		'data.restoreInstance': (input, context) =>
			instanceRestoreFromAdmin(managedState().homeDir, { ...input, ...context }),
		'data.recovery.status': () => recoveryStatus(state().homeDir),
		'data.recovery.inspect': () => runRecoveryOperation(state().homeDir, 'inspect'),
		'data.recovery.initialize': (_input, context) =>
			runRecoveryOperation(state().homeDir, 'init', context.confirmed === true),
		'data.recovery.restore': (_input, context) =>
			runRecoveryOperation(state().homeDir, 'restore', context.confirmed === true),
		'data.recovery.save': (input) => {
			saveRecoverySettings(state().homeDir, input);
		},
		'data.recovery.setCredential': (input) => {
			saveRecoveryCredential(state().homeDir, input.connectionString);
		},
		'data.recovery.package': (input, context) => {
			const home = state().homeDir;
			if (input.operation === 'export') return exportCheckpointPackage(home, input.directory);
			if (input.operation === 'preview') return previewCheckpointPackage(home, input.directory);
			return importCheckpointPackage(home, input, context.confirmed === true);
		},
		'docker.install': async ({ config, automaticPorts }) => {
			assertInstallInstanceName(config.deployment.projectName);
			const docker = await ensureDockerReady();
			if (!docker.ok) throw new Error(docker.message);
			await assertProjectOwnership(config.deployment.projectName);
			await installFromAdmin(config, homeDir, automaticPorts ?? true);
			await options.host.operate('start');
		},
		'docker.saveConfig': (input) => {
			saveAdminConfig(state().homeDir, input.config, input.baseConfig);
		},
		'docker.update': async ({ pull }, context) => {
			if (!context.confirmed) throw Error('Confirm the instance update before continuing.');
			await updateHome({ homeDir, start: true, pull });
		},
		'docker.directory': ({ path: requested }) => {
			let path = requested ?? dirname(homeDir);
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
		'transfer.create': () => {
			const directory = mkdtempSync(join(tmpdir(), 'fhold-transfer-'));
			transfers.add(directory);
			return directory;
		},
		'transfer.release': (value) => {
			if (!transfers.has(value)) throw Error('Unknown transfer workspace.');
			rmSync(value, { recursive: true, force: true });
			transfers.delete(value);
		},
		'transfer.pack': async (value) => {
			if (!transfers.has(value)) throw Error('Unknown transfer workspace.');
			const archive = join(value, 'transfer.tgz');
			await packTransfer(join(value, 'export'), archive);
			return archive;
		},
		'transfer.unpack': async (value) => {
			if (!transfers.has(value)) throw Error('Unknown transfer workspace.');
			const archive = join(value, 'transfer.tgz');
			await unpackTransfer(archive, join(value, 'unpacked'));
			return join(value, 'unpacked', 'payload');
		}
	};
	return {
		async call<N extends ManagementOperation>(
			operation: N,
			input?: ManagementOperationMap[N]['input'],
			context: RequestContext = {}
		): Promise<ManagementOperationMap[N]['result']> {
			if (closed) throw new Error('This instance session is closed. Open it again.');
			const handler = handlers[operation] as HandlerTable[N];
			return await handler(input as ManagementOperationMap[N]['input'], context);
		},
		busy: () => remoteStarting || !!activeRemote?.session.snapshot().running,
		async close() {
			if (closed) return;
			closed = true;
			lifetime.abort();
			agent.close();
			await knowledgeUi.close();
			activeRemote?.session.cancel();
			await activeRemote?.session.done;
			for (const directory of transfers) rmSync(directory, { recursive: true, force: true });
			transfers.clear();
		}
	};
}

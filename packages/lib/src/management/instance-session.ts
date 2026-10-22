import type { HostingSnapshot, InstanceRef } from '../hosting/types.js';
import type { InstanceManagement, ManagedSnapshot, ManagementMethod } from './types.js';
import {
	operationDescription,
	supportedOperation,
	unsupportedOperation,
	type AgentObservations,
	type AgentOperations,
	type AppConnections,
	type AppObservations,
	type AppOperations,
	type ComposedInstanceSession,
	type DataObservations,
	type DataOperations,
	type DeploymentObservation,
	type HostOperations,
	type InstanceLifecycle,
	type InstanceSnapshot,
	type Observation,
	type Operation,
	type RequestContext
} from './contracts.js';

const NOT_INSPECTED_AGENT: AgentObservations = {
	access: { state: 'not-inspected', reason: 'Connect to inspect native agent access.' },
	account: { state: 'not-inspected', reason: 'Connect to inspect native account state.' },
	models: { state: 'not-inspected', reason: 'Connect to inspect native models.' },
	readiness: { state: 'not-inspected', reason: 'Run a requested readiness test.' }
};
const NOT_INSPECTED_DATA: DataObservations = {
	recovery: {
		state: 'not-inspected',
		reason: 'Recovery configuration is not configured for this instance.'
	}
};

export type InstanceSessionBindings = {
	ref: InstanceRef;
	host: HostOperations;
	inspectHost(): Promise<HostingSnapshot>;
	agent?: Partial<AgentOperations>;
	apps?: AppOperations;
	data?: DataOperations;
	inspectAgent?: () => Promise<Partial<AgentObservations>>;
	inspectApps?: () => Promise<AppObservations>;
	inspectData?: () => Promise<DataObservations>;
	/** One cache-only application observation read for passive inspection. */
	inspectManagement?: () => Promise<{
		agent: Partial<AgentObservations>;
		apps: AppObservations;
		data: DataObservations;
		lifecycle: Observation<InstanceLifecycle>;
		docker?: import('./contracts.js').DockerInstanceSubview;
	}>;
	inspectLifecycle?: () => Promise<Observation<InstanceLifecycle>>;
	inspectDocker?: () => Promise<import('./contracts.js').DockerInstanceSubview | undefined>;
	docker?: import('./contracts.js').DockerOperations;
	close?: () => Promise<void>;
};

function hostDeployment(snapshot: HostingSnapshot): DeploymentObservation {
	return {
		...(snapshot.platformState ? { state: snapshot.platformState } : {}),
		warnings: snapshot.warnings,
		...(snapshot.revisions ? { revisions: snapshot.revisions } : {}),
		...(snapshot.providerLabel ? { providerLabel: snapshot.providerLabel } : {}),
		...(snapshot.guidance ? { guidance: snapshot.guidance } : {}),
		...(snapshot.clientUrl ? { clientUrl: snapshot.clientUrl } : {}),
		...(snapshot.portalUrl ? { portalUrl: snapshot.portalUrl } : {}),
		...(snapshot.logSources ? { logSources: snapshot.logSources } : {}),
		...(snapshot.containers ? { containers: snapshot.containers } : {})
	};
}

function optionalObservation<T>(value: T | undefined, reason: string): Observation<T> {
	return value === undefined
		? { state: 'not-inspected', reason }
		: { state: 'known', value, observedAt: new Date().toISOString() };
}

/**
 * Composes existing host operations with independently optional app services.
 * Calling inspect never opens an agent route; explicit agent operations own that.
 */
export function composeInstanceSession(bindings: InstanceSessionBindings): ComposedInstanceSession {
	const agentUnavailable = 'Native agent access is not configured for this instance.';
	const agent: AgentOperations = {
		connect: bindings.agent?.connect ?? unsupportedOperation(agentUnavailable),
		providers: bindings.agent?.providers ?? unsupportedOperation(agentUnavailable),
		setKey: bindings.agent?.setKey ?? unsupportedOperation(agentUnavailable),
		saveEndpoint: bindings.agent?.saveEndpoint ?? unsupportedOperation(agentUnavailable),
		discoverModels: bindings.agent?.discoverModels ?? unsupportedOperation(agentUnavailable),
		selectModel: bindings.agent?.selectModel ?? unsupportedOperation(agentUnavailable),
		removeProvider: bindings.agent?.removeProvider ?? unsupportedOperation(agentUnavailable),
		oauthStart: bindings.agent?.oauthStart ?? unsupportedOperation(agentUnavailable),
		oauthFinish: bindings.agent?.oauthFinish ?? unsupportedOperation(agentUnavailable),
		readiness: bindings.agent?.readiness ?? unsupportedOperation(agentUnavailable),
		assistantPassword: bindings.agent?.assistantPassword ?? unsupportedOperation(agentUnavailable),
		remote:
			bindings.agent?.remote ??
			unsupportedOperation('Native worker setup is not configured for this instance.'),
		codexRecall:
			bindings.agent?.codexRecall ??
			unsupportedOperation('Codex recall is not configured for this instance.'),
		modelInventory: bindings.agent?.modelInventory ?? unsupportedOperation(agentUnavailable)
	};
	const apps: AppOperations = bindings.apps ?? {
		credentials: {
			create: unsupportedOperation('Credential management is not configured for this instance.'),
			updatePolicy: unsupportedOperation(
				'Credential permissions are not configured for this instance.'
			),
			rotate: unsupportedOperation('Credential management is not configured for this instance.'),
			remove: unsupportedOperation('Credential management is not configured for this instance.'),
			revealKey: unsupportedOperation('Credential management is not configured for this instance.')
		},
		portal: {
			mapUser: unsupportedOperation('Portal management is not configured for this instance.'),
			saveToken: unsupportedOperation('Portal management is not configured for this instance.')
		}
	};
	const data: DataOperations = bindings.data ?? {
		backup: unsupportedOperation('Data export is not configured for this instance.'),
		restoreData: unsupportedOperation('Data restore is not configured for this instance.'),
		restoreInstance: unsupportedOperation(
			'Whole-instance restore is not configured for this instance.'
		),
		recovery: unsupportedOperation('Recovery management is not configured for this instance.')
	};
	return {
		ref: bindings.ref,
		host: bindings.host,
		agent,
		apps,
		data,
		...(bindings.docker ? { docker: bindings.docker } : {}),
		async inspect(): Promise<InstanceSnapshot> {
			const observedAt = new Date().toISOString();
			const host = await bindings.inspectHost();
			const managed = bindings.inspectManagement
				? await Promise.allSettled([bindings.inspectManagement()])
				: undefined;
			const cached = managed?.[0]?.status === 'fulfilled' ? managed[0].value : undefined;
			// A management adapter can expose one deliberately passive snapshot. If
			// that single read fails, do not turn the failure into several retries:
			// SSH inspection must never acquire a browser forward merely to fill
			// independent UI panes.
			const managementFailure = managed?.[0]?.status === 'rejected' ? managed[0].reason : undefined;
			const unavailable = () => Promise.reject(managementFailure);
			const [agentResult, appsResult, dataResult, lifecycleResult, dockerResult] =
				await Promise.allSettled([
					cached
						? Promise.resolve(cached.agent)
						: managementFailure !== undefined
							? unavailable()
							: (bindings.inspectAgent?.() ?? Promise.resolve({})),
					cached
						? Promise.resolve(cached.apps)
						: managementFailure !== undefined
							? unavailable()
							: (bindings.inspectApps?.() ??
								Promise.resolve<AppObservations>({
									config: {
										state: 'not-inspected',
										reason: 'App configuration is not configured for this instance.'
									},
									connections: {
										state: 'not-inspected',
										reason: 'Connect to inspect reachable client links.'
									},
									status: {
										state: 'not-inspected',
										reason: 'App status is not configured for this instance.'
									}
								})),
					cached
						? Promise.resolve(cached.data)
						: managementFailure !== undefined
							? unavailable()
							: (bindings.inspectData?.() ?? Promise.resolve(NOT_INSPECTED_DATA)),
					cached
						? Promise.resolve(cached.lifecycle)
						: managementFailure !== undefined
							? unavailable()
							: (bindings.inspectLifecycle?.() ??
								Promise.resolve<Observation<InstanceLifecycle>>({
									state: 'known',
									value: 'externally-managed',
									observedAt
								})),
					cached
						? Promise.resolve(cached.docker)
						: managementFailure !== undefined
							? unavailable()
							: (bindings.inspectDocker?.() ?? Promise.resolve(undefined))
				]);
			const inspectedAgent = agentResult.status === 'fulfilled' ? agentResult.value : {};
			const inspectedApps =
				appsResult.status === 'fulfilled'
					? appsResult.value
					: {
							config: {
								state: 'unavailable' as const,
								reason: 'App configuration could not be inspected.'
							},
							connections: {
								state: 'unavailable' as const,
								reason: 'Client connection links could not be inspected.'
							},
							status: {
								state: 'unavailable' as const,
								reason: 'App status could not be inspected.'
							}
						};
			const inspectedData =
				dataResult.status === 'fulfilled'
					? dataResult.value
					: {
							recovery: {
								state: 'unavailable' as const,
								reason: 'Recovery configuration could not be inspected.'
							}
						};
			const lifecycle =
				lifecycleResult.status === 'fulfilled'
					? lifecycleResult.value
					: { state: 'unavailable' as const, reason: 'Installation state could not be inspected.' };
			const docker = dockerResult.status === 'fulfilled' ? dockerResult.value : undefined;
			return {
				identity: { ref: host.ref, name: host.name, location: host.location },
				lifecycle,
				deployment: { state: 'known', value: hostDeployment(host), observedAt },
				services: host.serviceError
					? { state: 'unavailable', reason: host.serviceError }
					: { state: 'known', value: host.services, observedAt },
				operations: {
					'host.inspect': operationDescription(bindings.host.inspect),
					'host.start': operationDescription(bindings.host.start),
					'host.stop': operationDescription(bindings.host.stop),
					'host.restart': operationDescription(bindings.host.restart),
					'host.logs': operationDescription(bindings.host.logs),
					'host.console': operationDescription(bindings.host.console),
					'agent.connect': operationDescription(agent.connect),
					'agent.providers': operationDescription(agent.providers),
					'agent.setKey': operationDescription(agent.setKey),
					'agent.saveEndpoint': operationDescription(agent.saveEndpoint),
					'agent.discoverModels': operationDescription(agent.discoverModels),
					'agent.selectModel': operationDescription(agent.selectModel),
					'agent.removeProvider': operationDescription(agent.removeProvider),
					'agent.oauthStart': operationDescription(agent.oauthStart),
					'agent.oauthFinish': operationDescription(agent.oauthFinish),
					'agent.readiness': operationDescription(agent.readiness),
					'agent.assistantPassword': operationDescription(agent.assistantPassword),
					'agent.remote': operationDescription(agent.remote),
					'agent.codexRecall': operationDescription(agent.codexRecall),
					'agent.modelInventory': operationDescription(agent.modelInventory),
					'apps.credentials.create': operationDescription(apps.credentials.create),
					'apps.credentials.updatePolicy': operationDescription(apps.credentials.updatePolicy),
					'apps.credentials.rotate': operationDescription(apps.credentials.rotate),
					'apps.credentials.remove': operationDescription(apps.credentials.remove),
					'apps.credentials.revealKey': operationDescription(apps.credentials.revealKey),
					'apps.portal.mapUser': operationDescription(apps.portal.mapUser),
					'apps.portal.saveToken': operationDescription(apps.portal.saveToken),
					'data.backup': operationDescription(data.backup),
					'data.restoreData': operationDescription(data.restoreData),
					'data.restoreInstance': operationDescription(data.restoreInstance),
					'data.recovery': operationDescription(data.recovery),
					...(bindings.docker
						? {
								'docker.install': operationDescription(bindings.docker.install),
								'docker.saveConfig': operationDescription(bindings.docker.saveConfig),
								'docker.update': operationDescription(bindings.docker.update),
								'docker.directory': operationDescription(bindings.docker.directory)
							}
						: {})
				},
				pendingChanges: optionalObservation(
					host.pendingRestart
						? {
								pending: host.pendingRestart.required,
								...(host.pendingRestart.error ? { detail: host.pendingRestart.error } : {})
							}
						: undefined,
					'No deployment-change observation is available for this provider.'
				),
				agent: { ...NOT_INSPECTED_AGENT, ...inspectedAgent },
				apps: inspectedApps,
				data: inspectedData,
				...(docker
					? { docker }
					: host.config && host.ref.kind === 'local-docker'
						? {
								docker: {
									homeDir: host.ref.homeDir,
									configPath: `${host.ref.homeDir}/state/stack.json`,
									config: host.config,
									...(host.pendingRestart ? { pendingRestart: host.pendingRestart } : {})
								}
							}
						: {})
			};
		},
		close: async () => bindings.close?.()
	};
}

/**
 * Compatibility adapter for the installed local/SSH command surface. It is
 * deliberately private to composition: UI and CLI consumers use named slots,
 * while the retained JSON-line protocol keeps its published method names.
 */
export function legacyManagementBindings(
	manager: InstanceManagement,
	options: {
		supports?: (method: ManagementMethod) => boolean;
		passiveSnapshot?: () => Promise<ManagedSnapshot>;
	} = {}
): Pick<
	InstanceSessionBindings,
	'agent' | 'apps' | 'data' | 'docker' | 'inspectManagement' | 'close'
> {
	const { supports } = options;
	let acquired: AppConnections | undefined;
	let sourceFingerprint: string | undefined;
	let observedFingerprint: string | undefined;
	function publicConnections(value: ManagedSnapshot): AppConnections {
		const result: AppConnections = {};
		for (const name of ['opencode', 'mcp', 'claude'] as const) {
			const details = value.connectionDetails?.[name];
			if (details)
				result[name] = {
					url: details.url,
					note: details.note,
					...(details.username ? { username: details.username } : {}),
					...(details.credential ? { credential: details.credential } : {}),
					...(details.extension ? { extension: details.extension } : {})
				};
		}
		if (value.connectionError) result.error = value.connectionError;
		return result;
	}
	function requireMethod(method: ManagementMethod) {
		if (supports && !supports(method))
			throw new Error(
				`The remote CLI does not advertise ${method}. Other supported host operations remain available; update its CLI to enable this operation.`
			);
	}
	function operation<I, O>(
		method: ManagementMethod,
		run: (input: I, context: RequestContext) => Promise<O>
	): Operation<I, O> {
		return supportedOperation(
			async (input, context) => {
				requireMethod(method);
				context.signal?.throwIfAborted();
				return run(input, context);
			},
			() =>
				!supports || supports(method)
					? { state: 'ready' }
					: {
							state: 'unavailable',
							reason: `The remote CLI does not advertise ${method}. Update its CLI to enable this operation.`
						}
		);
	}
	async function snapshot(): Promise<ManagedSnapshot> {
		requireMethod('snapshot');
		if (options.passiveSnapshot) return options.passiveSnapshot();
		return manager.call('snapshot');
	}
	const agent: AgentOperations = {
		connect: operation('snapshot', async () => {
			// This is the explicit route-acquisition action. SSH may now create a
			// loopback forward; passive inspection intentionally never does.
			const value = await manager.call('snapshot');
			const details = value.connectionDetails?.opencode;
			if (!details?.url)
				throw new Error(
					value.connectionError || 'Start this instance before connecting to OpenCode.'
				);
			acquired = publicConnections(value);
			sourceFingerprint = observedFingerprint;
			return { endpoint: details.url, ...(details.username ? { username: details.username } : {}) };
		}),
		providers: operation('providers', async () => manager.call('providers')),
		setKey: operation('providerKey', async (input) => manager.call('providerKey', input)),
		saveEndpoint: operation('providerEndpoint', async (input) =>
			manager.call('providerEndpoint', input)
		),
		discoverModels: operation('providerModels', async (input) =>
			manager.call('providerModels', input)
		),
		selectModel: operation('providerUse', async (input) => manager.call('providerUse', input)),
		removeProvider: operation('providerRemove', async (input) =>
			manager.call('providerRemove', input)
		),
		oauthStart: operation('providerOAuthStart', async (input) =>
			manager.call('providerOAuthStart', input)
		),
		oauthFinish: operation('providerOAuthFinish', async (input) =>
			manager.call('providerOAuthFinish', input)
		),
		readiness: operation('readiness', async (input) => manager.call('readiness', input)),
		assistantPassword: operation('assistantPassword', async () =>
			manager.call('assistantPassword')
		),
		remote: operation('remote', async (input) => manager.call('remote', input)),
		codexRecall: operation('codexRecall', async (input) => manager.call('codexRecall', input)),
		modelInventory: operation('providers', async () => {
			const value = await manager.call('providers');
			return value.providers;
		})
	};
	return {
		agent,
		apps: {
			credentials: {
				updatePolicy: operation('saveConfig', async (input) => {
					const value = await snapshot();
					const credential = value.config.credentials[input.username];
					if (!credential || credential.policy !== input.previousPolicy)
						throw new Error('These permissions changed. Refresh this app before saving again.');
					if (credential.policy === input.policy) return;
					const config = structuredClone(value.config);
					config.credentials[input.username].policy = input.policy;
					await manager.call('saveConfig', { config, baseConfig: value.config });
				}),
				create: operation('credential', async (input) => {
					await manager.call('credential', { action: 'create', ...input });
				}),
				rotate: operation('credential', async (input) => {
					await manager.call('credential', { action: 'rotate', ...input });
				}),
				remove: operation('credential', async (input) => {
					await manager.call('credential', { action: 'remove', ...input });
				}),
				revealKey: operation('credentialKey', async (input) =>
					manager.call('credentialKey', input.username)
				)
			},
			portal: {
				mapUser: operation('mapPortalUser', async (input) => {
					await manager.call('mapPortalUser', input);
				}),
				saveToken: operation('portalToken', async (input) => {
					await manager.call('portalToken', input);
				})
			}
		},
		data: {
			backup: operation('backup', async (input) => manager.call('backup', input)),
			restoreData: operation('restoreData', async (input) => manager.call('restoreData', input)),
			restoreInstance: operation('restoreInstance', async (input) =>
				manager.call('restoreInstance', input)
			),
			recovery: operation('recovery', async (input) => {
				const result = await manager.call('recovery', input);
				// Retain the old wire reply for older clients, but do not leak its
				// Docker snapshot as a second shared application snapshot shape.
				return input.action === 'save' || input.action === 'credential'
					? { state: 'saved' }
					: result;
			})
		},
		docker: {
			install: operation('install', async ({ config, automaticPorts }) => {
				await manager.call('install', config, automaticPorts);
			}),
			saveConfig: operation('saveConfig', async (input) => {
				await manager.call('saveConfig', input);
			}),
			update: operation('update', async ({ pull }, context) => {
				if (!context.confirmed) throw new Error('Confirm the instance update before continuing.');
				await manager.call('update', { confirmed: true, ...(pull === undefined ? {} : { pull }) });
			}),
			directory: operation('directory', async ({ path }) => manager.call('directory', path))
		},
		inspectManagement: async () => {
			const value = await snapshot();
			observedFingerprint = JSON.stringify(value.connectionDetails);
			if (sourceFingerprint !== undefined && sourceFingerprint !== observedFingerprint)
				acquired = undefined;
			const connections =
				acquired ?? (options.passiveSnapshot ? undefined : publicConnections(value));
			const observedAt = new Date().toISOString();
			const lifecycle: InstanceLifecycle =
				value.phase === 'not_installed'
					? 'not-installed'
					: value.phase === 'setup_incomplete'
						? 'setup-incomplete'
						: 'ready';
			return {
				agent: {
					access: acquired?.opencode?.url
						? {
								state: 'known',
								value: { endpoint: acquired.opencode.url, username: acquired.opencode.username },
								observedAt
							}
						: { state: 'not-inspected', reason: 'Connect to acquire a native agent route.' }
				},
				apps: {
					connections: connections
						? { state: 'known', value: connections, observedAt }
						: {
								state: 'not-inspected',
								reason: 'Connect to acquire client links on this computer.'
							},
					config: {
						state: 'known',
						value: {
							credentials: Object.fromEntries(
								Object.entries(value.config.credentials).map(([name, credential]) => [
									name,
									{ policy: credential.policy }
								])
							),
							portalMappings: value.portalMappings,
							portalSecrets: value.portalSecrets
						},
						observedAt
					},
					status: {
						state: 'not-inspected',
						reason: 'App runtime status is provided by service inventory.'
					}
				},
				data: {
					recovery: value.recovery
						? { state: 'known', value: value.recovery, observedAt }
						: value.recoveryError
							? { state: 'unavailable', reason: value.recoveryError }
							: {
									state: 'not-inspected',
									reason: 'Recovery configuration is unavailable until the instance is initialized.'
								}
				},
				lifecycle: { state: 'known', value: lifecycle, observedAt },
				docker: {
					homeDir: value.homeDir,
					configPath: value.configPath,
					config: value.config,
					...(value.pendingRestart ? { pendingRestart: value.pendingRestart } : {}),
					...(value.updateImageTag ? { updateImageTag: value.updateImageTag } : {}),
					...(value.installationReadiness
						? { installationReadiness: value.installationReadiness }
						: {})
				}
			};
		},
		close: () => {
			acquired = undefined;
			return manager.close();
		}
	};
}

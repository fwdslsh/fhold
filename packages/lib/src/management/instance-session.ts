import type { HostingSnapshot } from '../hosting/types.js';
import type { InstanceManagement, ManagedSnapshot, ManagementMethod } from './types.js';
import {
	operationDescription,
	supportedOperation,
	unsupportedOperation,
	type AgentObservations,
	type AgentOperations,
	type ApplicationObservations,
	type AppConnections,
	type AppObservations,
	type AppOperations,
	type ComposedInstanceSession,
	type DataObservations,
	type DataOperations,
	type DeploymentObservation,
	type InstanceLifecycle,
	type InstanceSessionBindings,
	type InstanceSnapshot,
	type Observation,
	type Operation,
	type OperationInputMetadata,
	type RequestContext
} from './contracts.js';
export type { ApplicationObservations, InstanceSessionBindings } from './contracts.js';

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

const NOT_INSPECTED_APPS: AppObservations = {
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
};

function unavailableAgent(): Partial<AgentObservations> {
	return {
		access: { state: 'unavailable', reason: 'Native agent access could not be inspected.' },
		account: { state: 'unavailable', reason: 'Native account state could not be inspected.' },
		models: { state: 'unavailable', reason: 'Native models could not be inspected.' },
		readiness: { state: 'unavailable', reason: 'Native readiness could not be inspected.' }
	};
}
function unavailableApps(): AppObservations {
	return {
		config: { state: 'unavailable', reason: 'App configuration could not be inspected.' },
		connections: {
			state: 'unavailable',
			reason: 'Client connection links could not be inspected.'
		},
		status: { state: 'unavailable', reason: 'App status could not be inspected.' }
	};
}
function unavailableData(): DataObservations {
	return {
		recovery: { state: 'unavailable', reason: 'Recovery configuration could not be inspected.' }
	};
}
function unavailableLifecycle(): Observation<InstanceLifecycle> {
	return { state: 'unavailable', reason: 'Installation state could not be inspected.' };
}

function isOperation(value: unknown): value is Operation<unknown, unknown> {
	return (
		value !== null &&
		typeof value === 'object' &&
		'support' in value &&
		typeof value.support === 'string'
	);
}

/** Derive the renderer catalog from the operation tree so slots cannot drift. */
export function describeOperations(
	tree: Record<string, unknown>,
	prefix = ''
): Record<string, import('./contracts.js').OperationDescription> {
	const descriptions: Record<string, import('./contracts.js').OperationDescription> = {};
	for (const [name, value] of Object.entries(tree)) {
		const key = prefix ? `${prefix}.${name}` : name;
		if (isOperation(value)) descriptions[key] = operationDescription(value);
		else if (value !== null && typeof value === 'object')
			Object.assign(descriptions, describeOperations(value as Record<string, unknown>, key));
	}
	return descriptions;
}

function hostDeployment(snapshot: HostingSnapshot): DeploymentObservation {
	const lifecycleCapabilities = Object.fromEntries(
		(['start', 'stop', 'restart'] as const).map((action) => {
			const capability = snapshot.capabilities[action];
			return [
				action,
				capability.supported
					? { state: 'ready' as const }
					: {
							state: 'unavailable' as const,
							reason:
								capability.reason ??
								'This lifecycle operation is unavailable for this target.'
						}
			];
		})
	) as NonNullable<DeploymentObservation['lifecycleCapabilities']>;
	return {
		...(snapshot.platformState ? { state: snapshot.platformState } : {}),
		warnings: snapshot.warnings,
		lifecycleCapabilities,
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
		recovery: {
			status: unsupportedOperation('Recovery management is not configured for this instance.'),
			inspect: unsupportedOperation('Recovery management is not configured for this instance.'),
			initialize: unsupportedOperation('Recovery management is not configured for this instance.'),
			restore: unsupportedOperation('Recovery management is not configured for this instance.'),
			save: unsupportedOperation('Recovery management is not configured for this instance.'),
			setCredential: unsupportedOperation(
				'Recovery management is not configured for this instance.'
			)
		}
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
			let application: Partial<ApplicationObservations> = {};
			let applicationFailure: unknown;
			try {
				await bindings.initialize?.();
			} catch {
				// Capability discovery is advisory; do not turn a readable target
				// into an unavailable application snapshot for an old remote CLI.
			}
			try {
				application = (await bindings.inspectApplication?.()) ?? {};
			} catch (error) {
				applicationFailure = error;
			}
			const unavailable = applicationFailure !== undefined;
			const inspectedAgent = unavailable ? unavailableAgent() : (application.agent ?? {});
			const inspectedApps = unavailable
				? unavailableApps()
				: (application.apps ?? NOT_INSPECTED_APPS);
			const inspectedData = unavailable
				? unavailableData()
				: (application.data ?? NOT_INSPECTED_DATA);
			const lifecycle = unavailable
				? unavailableLifecycle()
				: (application.lifecycle ?? {
						state: 'known' as const,
						value: 'externally-managed' as const,
						observedAt
					});
			const docker = unavailable ? undefined : application.docker;
			return {
				identity: { ref: host.ref, name: host.name, location: host.location },
				lifecycle,
				deployment: { state: 'known', value: hostDeployment(host), observedAt },
				services: host.serviceError
					? { state: 'unavailable', reason: host.serviceError }
					: { state: 'known', value: host.services, observedAt },
				operations: describeOperations({
					host: bindings.host,
					agent,
					apps,
					data,
					...(bindings.docker ? { docker: bindings.docker } : {})
				}),
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
				...(docker ? { docker } : {})
			};
		},
		busy: () => bindings.busy?.() === true,
		close: async () => bindings.close?.()
	};
}

/**
 * Compatibility adapter for the installed local/SSH RPC command surface. It is
 * deliberately private to composition: UI and CLI consumers use named slots,
 * while the retained JSON-line protocol keeps its published method names.
 */
export function rpcManagementBindings(
	manager: InstanceManagement,
	options: {
		initialize?: () => Promise<void>;
		supports?: (method: ManagementMethod) => boolean | undefined;
		passiveSnapshot?: () => Promise<ManagedSnapshot>;
		acquireSnapshot?: () => Promise<ManagedSnapshot>;
		credentialPolicy?: () => boolean | undefined;
	} = {}
): Pick<
	InstanceSessionBindings,
	'agent' | 'apps' | 'data' | 'docker' | 'initialize' | 'inspectApplication' | 'busy' | 'close'
> {
	const { supports } = options;
	const credentialPolicyReason =
		'This installed CLI cannot atomically update credential permissions. Update the host CLI before changing this policy.';
	let acquired: AppConnections | undefined;
	// An acquired route belongs to the source addresses from which it was
	// created. If a later passive observation changes them, drop the route.
	let acquiredSource: string | undefined;
	function sourceFingerprint(value: ManagedSnapshot): string {
		return JSON.stringify(
			(['opencode', 'mcp', 'claude'] as const).map((name) => {
				const details = value.connectionDetails?.[name];
				return details
					? [name, details.url, details.username, details.credential, details.extension]
					: [name];
			})
		);
	}
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
	async function initialize(): Promise<void> {
		await options.initialize?.();
	}
	function requireMethod(method: ManagementMethod) {
		if (supports?.(method) === false)
			throw new Error(
				`The management helper does not advertise ${method}. Other supported host operations remain available; check the local tooling distribution.`
			);
	}
	function operation<I, O>(
		method: ManagementMethod,
		run: (input: I, context: RequestContext) => Promise<O>,
		operationOptions: {
			supported?: () => boolean | undefined;
			reason?: string;
			input?: OperationInputMetadata;
		} = {}
	): Operation<I, O> {
		const { supported: extraSupported, reason: extraReason, input } = operationOptions;
		return supportedOperation(
			async (input, context) => {
				await initialize();
				requireMethod(method);
				if (extraSupported?.() === false)
					throw new Error(extraReason ?? 'This operation is not available on the selected host.');
				context.signal?.throwIfAborted();
				return run(input, context);
			},
			() =>
				supports?.(method) !== false && extraSupported?.() !== false
					? { state: 'ready' }
					: {
							state: 'unavailable',
							reason:
								supports?.(method) === false
									? `The management helper does not advertise ${method}. Check the local tooling distribution.`
									: (extraReason ?? 'This operation is not available on the selected host.')
						},
			input
		);
	}
	async function snapshot(): Promise<ManagedSnapshot> {
		await initialize();
		requireMethod('snapshot');
		if (options.passiveSnapshot) return options.passiveSnapshot();
		return manager.call('snapshot');
	}
	const agent: AgentOperations = {
		connect: operation(
			'snapshot',
			async () => {
				// This is the explicit route-acquisition action. SSH may now create a
				// loopback forward; passive inspection intentionally never does.
				const source = await snapshot();
				const value = await (options.acquireSnapshot?.() ?? Promise.resolve(source));
				const details = value.connectionDetails?.opencode;
				if (!details?.url)
					throw new Error(
						value.connectionError || 'Start this instance before connecting to OpenCode.'
					);
				acquired = publicConnections(value);
				acquiredSource = sourceFingerprint(source);
				return {
					endpoint: details.url,
					...(details.username ? { username: details.username } : {}),
					...(options.acquireSnapshot ? { sessionBound: true as const } : {})
				};
			},
			options.acquireSnapshot
				? { input: { acquireClients: ['opencode', 'mcp', 'claude'] } }
				: undefined
		),
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
		remote: operation('remote', async (input, context) => {
			if (input.action === 'enable' && !context.confirmed)
				throw new Error('Confirm the possible container restarts before remote setup.');
			return manager.call('remote', {
				...input,
				...(input.action === 'enable' ? { restartConfirmed: true } : {})
			});
		}),
		codexRecall: operation('codexRecall', async (input, context) =>
			manager.call('codexRecall', {
				...input,
				...(context.confirmed === undefined ? {} : { confirmed: context.confirmed })
			})
		),
		modelInventory: operation('providers', async () => {
			const value = await manager.call('providers');
			return value.providers;
		})
	};
	return {
		initialize,
		agent,
		apps: {
			credentials: {
				updatePolicy: options.credentialPolicy
					? operation(
							'credential',
							async (input) => {
								await manager.call('credential', { action: 'policy', ...input });
							},
							{
								supported: options.credentialPolicy,
								reason: credentialPolicyReason
							}
						)
					: unsupportedOperation(credentialPolicyReason),
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
			backup: operation('backup', async (input, context) =>
				manager.call('backup', {
					...input,
					...(context.confirmed === undefined ? {} : { confirmed: context.confirmed })
				})
			),
			restoreData: operation('restoreData', async (input, context) =>
				manager.call('restoreData', {
					...input,
					...(context.confirmed === undefined ? {} : { confirmed: context.confirmed })
				})
			),
			restoreInstance: operation('restoreInstance', async (input, context) =>
				manager.call('restoreInstance', {
					...input,
					...(context.confirmed === undefined ? {} : { confirmed: context.confirmed })
				})
			),
			recovery: {
				status: operation('recovery', async () => {
					const result = await manager.call('recovery', { action: 'status' });
					if (!result || typeof result !== 'object' || Array.isArray(result))
						throw new Error(
							'Remote recovery status was invalid. Refresh the instance before retrying.'
						);
					return result;
				}),
				inspect: operation('recovery', async () => {
					const result = await manager.call('recovery', { action: 'inspect' });
					if (typeof result !== 'string')
						throw new Error('Remote recovery inspection returned an invalid result.');
					return result;
				}),
				initialize: operation('recovery', async (_input, context) => {
					if (!context.confirmed)
						throw new Error('Confirm recovery initialization before continuing.');
					const result = await manager.call('recovery', { action: 'init', confirmed: true });
					if (typeof result !== 'string')
						throw new Error('Remote recovery initialization returned an invalid result.');
					return result;
				}),
				restore: operation('recovery', async (_input, context) => {
					if (!context.confirmed) throw new Error('Confirm recovery restore before continuing.');
					const result = await manager.call('recovery', { action: 'restore', confirmed: true });
					if (typeof result !== 'string')
						throw new Error('Remote recovery restore returned an invalid result.');
					return result;
				}),
				save: operation('recovery', async (input) => {
					await manager.call('recovery', { action: 'save', ...input });
				}),
				setCredential: operation('recovery', async (input) => {
					await manager.call('recovery', { action: 'credential', ...input });
				})
			}
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
		inspectApplication: async () => {
			const value = await snapshot();
			// Describe whether the acquired route still matches; a query never
			// disposes or changes connection resources owned by connect/close.
			const currentRoute = acquiredSource === sourceFingerprint(value) ? acquired : undefined;
			const connections =
				currentRoute ?? (options.passiveSnapshot ? undefined : publicConnections(value));
			const observedAt = new Date().toISOString();
			const lifecycle: InstanceLifecycle =
				value.phase === 'not_installed'
					? 'not-installed'
					: value.phase === 'setup_incomplete'
						? 'setup-incomplete'
						: 'ready';
			return {
				agent: {
					access: currentRoute?.opencode?.url
						? {
								state: 'known',
								value: {
									endpoint: currentRoute.opencode.url,
									username: currentRoute.opencode.username
								},
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
		busy: () => manager.busy(),
		close: () => {
			acquired = undefined;
			acquiredSource = undefined;
			return manager.close();
		}
	};
}

import { parseInstanceRef } from './preferences.js';
import {
	runHostingProcess,
	runHostingTerminal,
	type HostingProcess,
	type HostingTerminal
} from '../control-plane/process.js';
import { azureClient, azureManagement, type AzureManagement } from './azure-client.js';
import {
	azureDeploymentOperations,
	azureObject,
	azureEnvironment,
	selectedAzureContainer
} from './azure-deployment.js';
import { azureProvisioning } from './azure-provisioning.js';
import { HostingPreferencesStore } from './preferences.js';
import { AZURE_ASSISTANT_IMAGE } from './azure-template.js';
import { azureRecovery } from './azure-recovery.js';
import { httpsAgentBindings } from '../management/https-agent-session.js';
import { RECOVERY_INSPECTION_ENVIRONMENT } from '../control-plane/native-management.js';
import {
	capabilities,
	selectListedInstance,
	type HostingConnection,
	type HostingProvider,
	type HostingSnapshot,
	type InstanceRef
} from './types.js';

type AzureApp = {
	id: string;
	name: string;
	tags?: { fhold?: string };
	properties: {
		runningStatus?: string;
		provisioningState?: string;
		configuration?: { ingress?: { external?: boolean; fqdn?: string } };
		template?: { containers?: Array<{ name: string; image: string }> };
	};
};
type AzureRevision = {
	name: string;
	properties: {
		active?: boolean;
		replicas?: number;
		healthState?: string;
		runningState?: string;
		template?: { containers?: Array<{ name: string; image: string }> };
	};
};

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Azure returned an invalid resource document.');
	return value as Record<string, unknown>;
}
function appDocument(value: unknown): AzureApp {
	const doc = object(value),
		properties = object(doc.properties);
	if (typeof doc.id !== 'string' || typeof doc.name !== 'string')
		throw new Error('Azure returned an invalid app identity.');
	const tags = doc.tags ? object(doc.tags) : {};
	const template = properties.template ? object(properties.template) : {};
	const configuration = properties.configuration ? object(properties.configuration) : {};
	const ingress = configuration.ingress ? object(configuration.ingress) : {};
	const containers = Array.isArray(template.containers)
		? template.containers.map((item: unknown) => {
				const container = object(item);
				if (typeof container.name !== 'string' || typeof container.image !== 'string')
					throw new Error('Azure returned an invalid container identity.');
				return { name: container.name, image: container.image };
			})
		: [];
	return {
		id: doc.id,
		name: doc.name,
		tags: { fhold: typeof tags.fhold === 'string' ? tags.fhold : undefined },
		properties: {
			runningStatus:
				typeof properties.runningStatus === 'string' ? properties.runningStatus : undefined,
			provisioningState:
				typeof properties.provisioningState === 'string' ? properties.provisioningState : undefined,
			template: { containers },
			configuration: {
				ingress: {
					external: ingress.external === true,
					fqdn:
						typeof ingress.fqdn === 'string' && /^[a-z\d.-]+$/i.test(ingress.fqdn)
							? ingress.fqdn
							: undefined
				}
			}
		}
	};
}
function revisionDocuments(value: unknown): AzureRevision[] {
	if (!Array.isArray(value)) throw new Error('Azure did not return a revision list.');
	return value.map((item: unknown) => {
		const doc = object(item),
			props = object(doc.properties);
		if (typeof doc.name !== 'string' || !/^[\w.-]+$/.test(doc.name))
			throw new Error('Azure returned an invalid revision name.');
		return {
			name: doc.name,
			properties: {
				template:
					props.template && typeof props.template === 'object'
						? (props.template as AzureRevision['properties']['template'])
						: undefined,
				active: props.active === true,
				replicas:
					typeof props.replicas === 'number' &&
					Number.isInteger(props.replicas) &&
					props.replicas >= 0
						? props.replicas
						: undefined,
				healthState: typeof props.healthState === 'string' ? props.healthState : undefined,
				runningState: typeof props.runningState === 'string' ? props.runningState : undefined
			}
		};
	});
}
function systemLogText(raw: string): string {
	return raw
		.split('\n')
		.map((line) => {
			try {
				const event = object(JSON.parse(line));
				if (typeof event.Msg === 'string')
					return `${typeof event.TimeStamp === 'string' ? `${event.TimeStamp} ` : ''}${event.Msg}`;
			} catch {
				/* Preserve unknown native output rather than discarding logs. */
			}
			return line;
		})
		.join('\n');
}

export function azureRecoveryInspectionEnvironment(document: Record<string, unknown>) {
	const environment = azureEnvironment(selectedAzureContainer(document));
	return Object.fromEntries(
		RECOVERY_INSPECTION_ENVIRONMENT.filter((key) => environment[key] !== undefined).map(
			(key) => [key, environment[key]!]
		)
	);
}

export function azureContainerAppsProvider(
	connection: Extract<HostingConnection, { kind: 'azure-container-apps' }>,
	run: HostingProcess = runHostingProcess,
	terminal: HostingTerminal = runHostingTerminal,
	options: { management?: AzureManagement; preferences?: HostingPreferencesStore } = {}
): HostingProvider {
	const client = azureClient(run);
	const preferences = options.preferences ?? new HostingPreferencesStore();
	let sdkPromise: Promise<AzureManagement> | undefined;
	const management = () =>
		(sdkPromise ??= options.management
			? Promise.resolve(options.management)
			: azureManagement(connection));
	const scope = [
		'--subscription',
		connection.subscriptionId,
		'--resource-group',
		connection.resourceGroup
	];
	const az = client.json;
	function recognized(app: AzureApp): boolean {
		return (
			app.tags?.fhold === 'assistant' ||
			!!app.properties.template?.containers?.some(({ image }) =>
				/(?:^|\/)fhold-assistant(?::[^/]+|@sha256:[a-f\d]+)?$/.test(image)
			)
		);
	}
	function appRef(app: AzureApp): InstanceRef {
		const ref = parseInstanceRef({
			kind: connection.kind,
			connectionId: connection.id,
			resourceId: app.id
		});
		assertScope(ref);
		return ref;
	}
	function assertScope(
		ref: InstanceRef
	): asserts ref is Extract<InstanceRef, { kind: 'azure-container-apps' }> {
		const prefix =
			`/subscriptions/${connection.subscriptionId}/resourceGroups/${connection.resourceGroup}/providers/Microsoft.App/containerApps/`.toLowerCase();
		if (
			ref.kind !== connection.kind ||
			ref.connectionId !== connection.id ||
			!ref.resourceId.toLowerCase().startsWith(prefix) ||
			ref.resourceId.slice(prefix.length).includes('/')
		)
			throw new Error(
				'Choose a Container App within this connection’s subscription and resource group.'
			);
	}
	const provider: HostingProvider = {
		provisioning: azureProvisioning(connection, management, client, preferences),
		emptyHint:
			'No recognized fhold images found. Install an assistant or select an exact existing Container App resource ID. Tags are discovery hints, not management permission.',
		async check() {
			const result: import('./types.js').ConnectionCheck = {
				ok: false,
				checks: [],
				instances: []
			};
			let stage = 'Azure CLI';
			try {
				const version = await az(['version', '--query', '"azure-cli"']);
				result.checks.push({
					name: stage,
					ok: true,
					detail: `Azure CLI ${typeof version === 'string' ? version : 'available'}.`
				});
				stage = 'Azure sign-in';
				const account = object(
					await az([
						'account',
						'show',
						'--subscription',
						connection.subscriptionId,
						'--query',
						'{id:id,state:state}'
					])
				);
				if (
					typeof account.id !== 'string' ||
					account.id.toLowerCase() !== connection.subscriptionId.toLowerCase() ||
					account.state !== 'Enabled'
				)
					throw new Error(
						'The selected Azure subscription is unavailable or disabled. Sign in with an account that can access it.'
					);
				result.checks.push({
					name: stage,
					ok: true,
					detail: 'Native account can access the selected subscription.'
				});
				stage = 'Resource group';
				await az(['group', 'show', ...scope, '--query', '{name:name}']);
				result.checks.push({ name: stage, ok: true, detail: connection.resourceGroup });
				stage = 'Discovery';
				result.instances = await provider.listInstances();
				result.checks.push({
					name: stage,
					ok: true,
					detail: result.instances.length
						? `Found ${result.instances.length} instance(s).`
						: provider.emptyHint!
				});
				result.ok = true;
			} catch (error) {
				result.checks.push({
					name: stage,
					ok: false,
					detail: error instanceof Error ? error.message : 'Azure connection failed.'
				});
			}
			return result;
		},
		async listInstances() {
			// Deployment owners mark custom assistant images with fhold=assistant.
			// A dedicated fhold image also identifies the app without guessing names.
			const apps = await az([
				'containerapp',
				'list',
				...scope,
				'--query',
				'[].{id:id,name:name,tags:{fhold:tags.fhold},properties:{template:{containers:properties.template.containers[].{name:name,image:image}}}}'
			]);
			if (!Array.isArray(apps)) throw new Error('Azure did not return an instance list.');
			return apps
				.map(appDocument)
				.filter(recognized)
				.map((app) => ({
					ref: appRef(app),
					name: app.name,
					location: app.id
				}));
		},
		async selectInstance(selector) {
			if (selector.startsWith('/')) {
				const ref = parseInstanceRef({
					kind: connection.kind,
					connectionId: connection.id,
					resourceId: selector
				});
				assertScope(ref);
				return ref;
			}
			return selectListedInstance(provider, selector);
		},
		open(ref) {
			assertScope(ref);
			const selectedResourceId = ref.resourceId;
			const name = ref.resourceId.split('/').at(-1) || '';
			const deployment = azureDeploymentOperations(ref, management, preferences);
			async function inspect(): Promise<HostingSnapshot> {
				// Native projections avoid returning secrets, environment and storage config.
				const app = appDocument(
					await az([
						'containerapp',
						'show',
						...scope,
						'--name',
						name,
						'--query',
						'{id:id,name:name,tags:{fhold:tags.fhold},properties:{runningStatus:properties.runningStatus,provisioningState:properties.provisioningState,configuration:{ingress:properties.configuration.ingress},template:{containers:properties.template.containers[].{name:name,image:image}}}}'
					])
				);
				appRef(app);
				if (app.id.toLowerCase() !== selectedResourceId.toLowerCase())
					throw new Error(
						'Azure returned a different app than the selected resource. No operation was applied.'
					);
				let revisions: AzureRevision[] = [];
				const warnings: string[] = [];
				const lifecycle = { supported: true };
				try {
					const observed = await az([
						'containerapp',
						'revision',
						'list',
						...scope,
						'--name',
						name,
						'--query',
						'[].{name:name,properties:{active:properties.active,replicas:properties.replicas,healthState:properties.healthState,runningState:properties.runningState,template:{containers:properties.template.containers[].{name:name,image:image}}}}'
					]);
					if (!Array.isArray(observed)) throw new Error('Revision list unavailable.');
					revisions = revisionDocuments(observed);
				} catch {
					warnings.push(
						'Revision status is unavailable. App status remains available; check Azure read permissions.'
					);
				}
				const stopped = app.properties.runningStatus?.toLowerCase() === 'stopped';
				const active = revisions.filter((item) => item.properties.active);
				const replicas = active.reduce((sum, item) => sum + (item.properties.replicas ?? 0), 0);
				const countKnown =
					active.length > 0 && active.every((item) => item.properties.replicas !== undefined);
				const scaledToZero =
					active.length > 0 &&
					active.every((item) =>
						['scaledto0', 'scaledtozero'].includes(
							item.properties.runningState?.toLowerCase() || ''
						)
					);
				if (replicas > 1)
					warnings.push(
						'Multiple replicas are reported. Confirm writer drain with deployment tooling before replacing an ephemeral instance.'
					);
				const platformState = stopped
					? 'Stopped'
					: scaledToZero
						? 'Scaled to zero'
						: `${app.properties.runningStatus || 'Unknown'}${active.length ? (countKnown ? ` · ${replicas} replica(s)` : ' · replica count unavailable') : ''}`;
				const ingress = app.properties.configuration?.ingress;
				return {
					ref,
					providerLabel: 'Azure Container Apps · experimental',
					guidance: {
						access:
							'Open OpenCode to configure AI accounts and use your agent. The Azure portal’s Console provides a terminal for native Claude/Codex sign-in, plugins and diagnostics.',
						client:
							'Status checks do not wake an idle agent. Opening OpenCode may wake a scaled-to-zero app; a platform-stopped app needs Start first.',
						restart:
							'Restart waits for native Stop completion before Start. Agent readiness and recovery durability remain separate observations.'
					},
					name: app.name,
					location: app.id,
					capabilities: {
						...capabilities(['start', 'stop']),
						start: lifecycle,
						stop: lifecycle,
						restart:
							!stopped || !!preferences.deployment(ref).restartPhase
								? { supported: true }
								: {
										supported: false,
										reason: 'Start the stopped app before restarting.'
									},
						settings: {
							supported: true,
							reason: 'Native settings and selected deployment edits are managed independently.'
						},
						transfer: {
							supported: false,
							reason:
								'Use the deployed recovery backend or deployment tooling; a Container App has no local instance folder.'
						}
					},
					platformState,
					warnings,
					services: (app.properties.template?.containers ?? []).map((container) => ({
						name: container.name,
						imageProvenance: {
							configuredReference: container.image,
							observedReferences: [
								...new Set(
									active
										.filter((revision) => (revision.properties.replicas ?? 0) > 0)
										.flatMap(
											(revision) =>
												revision.properties.template?.containers
													?.filter((item) => item.name === container.name)
													.map((item) => item.image) ?? []
										)
								)
							],
							...(/^fwdslsh\/fhold-assistant:/.test(container.image)
								? {
										updateCandidate: {
											reference: AZURE_ASSISTANT_IMAGE,
											source: 'managing tool bundled runtime cohort'
										}
									}
								: {})
						},
						state: platformState,
						health: app.properties.provisioningState || 'Unknown'
					})),
					revisions: revisions.map((item) => ({
						name: item.name,
						active: !!item.properties.active,
						replicas: item.properties.replicas,
						health: item.properties.healthState || item.properties.runningState || 'Unknown'
					})),
					containers: app.properties.template?.containers ?? [],
					logSources: [
						{ type: 'system', label: 'Platform' },
						{ type: 'console', label: 'Agent console' }
					],
					portalUrl: `https://portal.azure.com/#resource${encodeURI(app.id)}`,
					...(ingress?.fqdn ? { clientUrl: `https://${ingress.fqdn}` } : {}),
					pendingRestart: { required: !!preferences.deployment(ref).draft }
				};
			}
			return {
				ref,
				deployment: deployment.operations,
				actionEffects: {
					start: 'request-platform-state',
					stop: 'request-platform-state',
					restart: 'restart-runtime'
				},
				inspect,
				applicationBindings() {
					const native = httpsAgentBindings({
						inspectHost: inspect,
						readinessTimeoutMs: 600_000,
						recoveryEnvironment: async () =>
							azureRecoveryInspectionEnvironment(await (await management()).get(ref.resourceId)),
						async resolveAccess() {
							const sdk = await management(),
								document = await sdk.get(ref.resourceId),
								properties = azureObject(document.properties);
							const container = selectedAzureContainer(document),
								env = azureEnvironment(container);
							const ingress = azureObject(azureObject(properties.configuration).ingress);
							if (typeof ingress.fqdn !== 'string' || !/^[a-z\d.-]+$/i.test(ingress.fqdn))
								throw new Error(
									'Configure a reachable native HTTPS endpoint; fhold will not publish private ingress.'
								);
							const passwordEnvironment = (Array.isArray(container.env) ? container.env : [])
								.map(azureObject)
								.find((item) => item.name === 'OPENCODE_SERVER_PASSWORD');
							let secretName =
								typeof passwordEnvironment?.secretRef === 'string'
									? passwordEnvironment.secretRef
									: undefined;
							const passwordPath = env.OPENCODE_SERVER_PASSWORD_FILE;
							if (passwordPath && Array.isArray(container.volumeMounts))
								for (const raw of container.volumeMounts) {
									const mount = azureObject(raw);
									if (
										typeof mount.mountPath !== 'string' ||
										!passwordPath.startsWith(`${mount.mountPath}/`)
									)
										continue;
									const template = azureObject(properties.template);
									const volume = (Array.isArray(template.volumes) ? template.volumes : [])
										.map(azureObject)
										.find(
											(item) => item.name === mount.volumeName && item.storageType === 'Secret'
										);
									const secret = (Array.isArray(volume?.secrets) ? volume.secrets : [])
										.map(azureObject)
										.find(
											(item) => item.path === passwordPath.slice(String(mount.mountPath).length + 1)
										);
									if (typeof secret?.secretRef === 'string') secretName = secret.secretRef;
								}
							let password: string | undefined;
							if (secretName)
								try {
									password = await sdk.secret(name, secretName);
								} catch {
									/* Native credential entry remains available when ARM secret access is denied. */
								}
							return {
								endpoint: `https://${ingress.fqdn}`,
								username: env.OPENCODE_SERVER_USERNAME ?? 'opencode',
								password
							};
						}
					});
					const recovery = azureRecovery(
						ref,
						management,
						deployment.operations,
						native,
						preferences
					);
					return {
						...native,
						data: recovery.data,
						async inspectApplication() {
							const observed = await native.inspectApplication!();
							return { ...observed, data: { recovery: recovery.observation() } };
						}
					};
				},
				async logs(options = {}) {
					const args = [
						'containerapp',
						'logs',
						'show',
						...scope,
						'--name',
						name,
						'--type',
						options.type ?? 'system',
						'--tail',
						String(options.tail ?? 100),
						'--follow',
						'false'
					];
					if (
						!Number.isInteger(options.tail ?? 100) ||
						(options.tail ?? 100) < 0 ||
						(options.tail ?? 100) > 300
					)
						throw new Error('Choose a log tail between 0 and 300 lines.');
					if (options.type && !['system', 'console'].includes(options.type))
						throw new Error('Choose system or console logs.');
					for (const key of ['revision', 'replica', 'container'] as const)
						if (options[key]) {
							if (!/^[\w.-]+$/.test(options[key]!)) throw new Error(`Invalid ${key} name.`);
							args.push(`--${key}`, options[key]!);
						}
					// Azure supports only JSONL for system events, unlike console logs.
					const output = await client.text([
						...args,
						'--format',
						options.type === 'console' ? 'text' : 'json'
					]);
					return options.type === 'console' ? output : systemLogText(output);
				},
				async console(options = {}) {
					const args = ['containerapp', 'exec', ...scope, '--name', name, '--command', '/bin/bash'];
					for (const key of ['revision', 'replica', 'container'] as const)
						if (options[key]) {
							if (!/^[\w.-]+$/.test(options[key]!)) throw new Error(`Invalid ${key} name.`);
							args.push(`--${key}`, options[key]!);
						}
					await terminal('az', [...args, '--only-show-errors']);
				},
				async operate(action, confirmed, options = {}) {
					if (!confirmed)
						throw new Error('Confirm this lifecycle operation before changing the Container App.');
					const before = await inspect();
					if (!before.capabilities[action].supported)
						throw new Error(before.capabilities[action].reason);
					if (
						options.revision &&
						!before.revisions?.some((item) => item.active && item.name === options.revision)
					)
						throw new Error(
							'The selected revision is no longer active. Refresh before restarting.'
						);
					const operation =
						action === 'restart' ? await deployment.restart() : await deployment.lifecycle(action);
					let snapshot: HostingSnapshot;
					try {
						snapshot = await inspect();
					} catch {
						snapshot = {
							...before,
							services: [],
							revisions: [],
							platformState: 'Status unavailable',
							warnings: [
								...before.warnings,
								'Azure accepted the request, but follow-up status is unavailable. Check status before proceeding; do not repeat the operation just to refresh it.'
							]
						};
					}
					return {
						snapshot,
						pending: operation.state !== 'completed',
						operation,
						message:
							operation.message ??
							`Azure completed ${action}. Native readiness and final-checkpoint durability are separate observations; no recovery ownership was cleared.`
					};
				}
			};
		}
	};
	return provider;
}

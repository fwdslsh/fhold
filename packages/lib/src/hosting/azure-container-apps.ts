import { parseInstanceRef } from './preferences.js';
import { runHostingProcess, type HostingProcess } from './process.js';
import {
	capabilities,
	selectListedInstance,
	type HostingConnection,
	type HostingProvider,
	type HostingSnapshot,
	type InstanceRef
} from './types.js';

const API_VERSION = '2026-07-01';
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
	properties: { active?: boolean; replicas?: number; healthState?: string; runningState?: string };
};

export function azureContainerAppsProvider(
	connection: Extract<HostingConnection, { kind: 'azure-container-apps' }>,
	run: HostingProcess = runHostingProcess
): HostingProvider {
	const scope = [
		'--subscription',
		connection.subscriptionId,
		'--resource-group',
		connection.resourceGroup
	];
	async function az(args: string[]): Promise<unknown> {
		const output = await run('az', [...args, '--only-show-errors', '--output', 'json']);
		return output.trim() ? (JSON.parse(output) as unknown) : undefined;
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
		async listInstances() {
			// Deployment owners mark custom assistant images with fhold=assistant.
			// A dedicated fhold image also identifies the app without guessing names.
			const apps = await az([
				'containerapp',
				'list',
				...scope,
				'--query',
				"[?tags.fhold=='assistant' || contains(join(',', properties.template.containers[].image), 'fhold-assistant')].{id:id,name:name,properties:{}}"
			]);
			if (!Array.isArray(apps)) throw new Error('Azure did not return an instance list.');
			return (apps as AzureApp[]).map((app) => ({
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
			const name = ref.resourceId.split('/').at(-1) || '';
			async function inspect(): Promise<HostingSnapshot> {
				// Native projections avoid returning secrets, environment and storage config.
				const app = (await az([
					'containerapp',
					'show',
					...scope,
					'--name',
					name,
					'--query',
					'{id:id,name:name,tags:{fhold:tags.fhold},properties:{runningStatus:properties.runningStatus,provisioningState:properties.provisioningState,configuration:{ingress:properties.configuration.ingress},template:{containers:properties.template.containers[].{name:name,image:image}}}}'
				])) as AzureApp;
				let revisions: AzureRevision[] = [];
				const warnings: string[] = [];
				const recognized =
					app.tags?.fhold === 'assistant' ||
					app.properties.template?.containers?.some((container) =>
						container.image.includes('fhold-assistant')
					);
				const recognitionReason =
					'This app is inspect-only. Its deployment must declare fhold=assistant or use a fhold-assistant image before lifecycle management.';
				const lifecycle = {
					supported: !!recognized,
					...(!recognized ? { reason: recognitionReason } : {})
				};
				if (!recognized) warnings.push(recognitionReason);
				try {
					const observed = await az([
						'containerapp',
						'revision',
						'list',
						...scope,
						'--name',
						name,
						'--query',
						'[].{name:name,properties:{active:properties.active,replicas:properties.replicas,healthState:properties.healthState,runningState:properties.runningState}}'
					]);
					if (!Array.isArray(observed)) throw new Error('Revision list unavailable.');
					revisions = observed as AzureRevision[];
				} catch {
					warnings.push(
						'Revision status is unavailable. App status remains available; check Azure read permissions.'
					);
				}
				const stopped = app.properties.runningStatus?.toLowerCase() === 'stopped';
				const active = revisions.filter((item) => item.properties.active);
				const replicas = active.reduce((sum, item) => sum + (item.properties.replicas ?? 0), 0);
				const scaledToZero =
					active.length > 0 &&
					active.every((item) => item.properties.runningState?.toLowerCase() === 'scaledto0');
				if (replicas > 1)
					warnings.push(
						'Multiple replicas are reported. Confirm writer drain with deployment tooling before replacing an ephemeral instance.'
					);
				const platformState = stopped
					? 'Stopped'
					: scaledToZero
						? 'Scaled to zero'
						: `${app.properties.runningStatus || 'Unknown'}${active.length ? ` · ${replicas} replica(s)` : ''}`;
				const ingress = app.properties.configuration?.ingress;
				return {
					ref,
					name: app.name,
					location: app.id,
					capabilities: {
						...capabilities(false),
						start: lifecycle,
						stop: lifecycle,
						settings: {
							supported: false,
							reason:
								'Deployment settings are owned by your Azure deployment tooling. Use the agent’s native interface for assistant settings.'
						},
						transfer: {
							supported: false,
							reason:
								'Use the deployed recovery backend or deployment tooling; a Container App has no local instance folder.'
						}
					},
					platformState,
					warnings,
					services: [
						{
							name: 'assistant',
							state: platformState,
							health: app.properties.provisioningState || 'Unknown'
						}
					],
					revisions: revisions.map((item) => ({
						name: item.name,
						active: !!item.properties.active,
						replicas: item.properties.replicas ?? 0,
						health: item.properties.healthState || item.properties.runningState || 'Unknown'
					})),
					...(ingress?.external && ingress.fqdn ? { clientUrl: `https://${ingress.fqdn}` } : {})
				};
			}
			return {
				ref,
				inspect,
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
					for (const key of ['revision', 'replica', 'container'] as const)
						if (options[key]) args.push(`--${key}`, options[key]);
					return run('az', [...args, '--format', 'text', '--only-show-errors']);
				},
				async operate(action, confirmed) {
					if (!confirmed)
						throw new Error('Confirm this lifecycle operation before changing the Container App.');
					if (action === 'restart')
						throw new Error(
							'ACA restart is not supported: use your deployment tooling for ordered stop/drain/replacement.'
						);
					const before = await inspect();
					if (!before.capabilities[action].supported)
						throw new Error(before.capabilities[action].reason);
					// Native ARM Start/Stop, not revision deactivate or maxReplicas=0.
					// Do not repeat this POST after an uncertain transport failure.
					await run('az', [
						'rest',
						'--method',
						'post',
						'--url',
						`${ref.resourceId}/${action}?api-version=${API_VERSION}`,
						'--subscription',
						connection.subscriptionId,
						'--only-show-errors',
						'--output',
						'none'
					]);
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
						pending: true,
						message: `Azure accepted ${action}. Platform status is shown separately; acceptance does not prove replica drain or agent readiness. Refresh status before proceeding with replacement.`
					};
				}
			};
		}
	};
	return provider;
}

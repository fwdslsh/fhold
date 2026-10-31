import { runHostingProcess, type HostingProcess } from '../control-plane/process.js';
import type { ConnectionSetup, HostingChoice } from './types.js';
import type { HostingConnection } from './types.js';

export const AZURE_APP_API_VERSION = '2026-07-01';
/** SDK-owned LRO, not an ARM polling implementation. */
export interface AzurePoller {
	readonly operationState?: { status?: string };
	serialize(): Promise<string>;
	pollUntilDone(options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}
export interface AzureManagement {
	get(resourceId: string, apiVersion?: string): Promise<Record<string, unknown>>;
	lifecycle(name: string, action: 'start' | 'stop', saved?: string): AzurePoller;
	patch(resourceId: string, properties: Record<string, unknown>, saved?: string): AzurePoller;
	deploy(
		name: string,
		template: Record<string, unknown>,
		parameters?: Record<string, { value: unknown }>
	): AzurePoller;
	deployment(name: string): Promise<Record<string, unknown>>;
	startJob(name: string): AzurePoller;
	jobExecutions(name: string): Promise<Array<{ name?: string; status?: string }>>;
	deleteJob(name: string): AzurePoller;
	secret(name: string, secretName: string): Promise<string | undefined>;
	secrets(
		name: string
	): Promise<Array<{ name?: string; value?: string; identity?: string; keyVaultUrl?: string }>>;
}
export async function azureManagement(
	connection: Extract<HostingConnection, { kind: 'azure-container-apps' }>
): Promise<AzureManagement> {
	const [{ AzureCliCredential }, appsSdk, resourcesSdk, deploymentsSdk] = await Promise.all([
		import('@azure/identity'),
		import('@azure/arm-appcontainers'),
		import('@azure/arm-resources'),
		import('@azure/arm-resourcesdeployments')
	]);
	const credential = new AzureCliCredential({ subscription: connection.subscriptionId });
	// No mutating-request retry: a lost response must be reconciled, not replayed.
	const options = { retryOptions: { maxRetries: 0 } };
	const apps = new appsSdk.ContainerAppsAPIClient(credential, connection.subscriptionId, options);
	const resources = new resourcesSdk.ResourceManagementClient(
		credential,
		connection.subscriptionId,
		options
	);
	const deployments = new deploymentsSdk.DeploymentsClient(
		credential,
		connection.subscriptionId,
		options
	);
	const group = connection.resourceGroup;
	return {
		get: async (id, version = AZURE_APP_API_VERSION) =>
			(await resources.resources.getById(id, version)) as Record<string, unknown>,
		lifecycle(name, action, saved) {
			return saved
				? appsSdk.restorePoller(apps, saved, apps.containerApps[action])
				: apps.containerApps[action](group, name);
		},
		patch(id, properties, saved) {
			return saved
				? resourcesSdk.restorePoller(resources, saved, resources.resources.updateById)
				: resources.resources.updateById(id, AZURE_APP_API_VERSION, { properties });
		},
		deploy: (name, template, parameters = {}) =>
			deployments.deployments.createOrUpdate(group, name, {
				properties: { mode: 'Incremental', template, parameters }
			}),
		deployment: async (name) =>
			(await deployments.deployments.get(group, name)) as Record<string, unknown>,
		startJob: (name) => apps.jobs.start(group, name),
		async jobExecutions(name) {
			const results: Array<{ name?: string; status?: string }> = [];
			for await (const item of apps.jobsExecutions.list(group, name))
				results.push({ name: item.name, status: item.status });
			return results;
		},
		deleteJob: (name) => apps.jobs.delete(group, name),
		async secret(name, secretName) {
			// ARM returns a collection. Keep it private and return only the configured reference.
			const collection = await apps.containerApps.listSecrets(group, name);
			return collection.value?.find((item) => item.name === secretName)?.value;
		},
		async secrets(name) {
			return (await apps.containerApps.listSecrets(group, name)).value ?? [];
		}
	};
}

/** Persist only SDK continuation configuration; resource bodies may contain private settings. */
export async function azureContinuation(poller: AzurePoller): Promise<string> {
	const value = JSON.parse(await poller.serialize()) as {
		state?: { config?: unknown; status?: string };
	};
	if (!value.state?.config) throw new Error('Azure did not provide an operation continuation.');
	const source = value.state.config as Record<string, unknown>;
	const config = Object.fromEntries(
		['operationLocation', 'resourceLocation', 'initialRequestUrl', 'requestMethod']
			.filter((key) => typeof source[key] === 'string')
			.map((key) => [key, source[key]])
	);
	const metadata = source.metadata as Record<string, unknown> | undefined;
	if (metadata)
		config.metadata = {
			...(['OperationLocation', 'ResourceLocation', 'Body'].includes(String(metadata.mode))
				? { mode: metadata.mode }
				: {}),
			...(typeof metadata.resourceLocationConfig === 'string'
				? { resourceLocationConfig: metadata.resourceLocationConfig }
				: {})
		};
	return JSON.stringify({ state: { config, status: value.state.status } });
}

/** Native Azure authentication and per-command scope; never change the global account. */
export function azureClient(run: HostingProcess = runHostingProcess) {
	const environment = { AZURE_EXTENSION_USE_DYNAMIC_INSTALL: 'no' };
	async function text(args: string[], timeoutMs = 45_000): Promise<string> {
		return run('az', [...args, '--only-show-errors'], { timeoutMs, env: environment });
	}
	async function json(args: string[]): Promise<unknown> {
		const output = await text([...args, '--output', 'json']);
		try {
			return output.trim() ? JSON.parse(output) : undefined;
		} catch {
			throw new Error('Azure CLI returned invalid JSON. Update the CLI and check this connection.');
		}
	}
	function choices(value: unknown): HostingChoice[] {
		if (!Array.isArray(value)) throw new Error('Azure did not return a list of available choices.');
		return value.map((item: unknown) => {
			if (
				!item ||
				typeof item !== 'object' ||
				!('value' in item) ||
				typeof item.value !== 'string' ||
				!('label' in item) ||
				typeof item.label !== 'string'
			)
				throw new Error('Azure returned an invalid subscription or resource group.');
			return { value: item.value, label: item.label };
		});
	}
	const setup: ConnectionSetup = {
		async signIn() {
			// az opens the browser and owns the complete vendor flow and token cache.
			await text(['login', '--output', 'none'], 180_000);
		},
		async choices(field, values = {}) {
			if (field === 'subscriptionId')
				return choices(
					await json(['account', 'list', '--query', "[?state=='Enabled'].{value:id,label:name}"])
				);
			if (field !== 'resourceGroup') throw new Error('Unknown Azure connection field.');
			const subscriptionId = values.subscriptionId ?? '';
			if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(subscriptionId))
				throw new Error('Choose a subscription before listing resource groups.');
			return choices(
				await json([
					'group',
					'list',
					'--subscription',
					subscriptionId,
					'--query',
					'[].{value:name,label:name}'
				])
			);
		}
	};
	return { text, json, setup };
}

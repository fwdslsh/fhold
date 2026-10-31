import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
	supportedOperation,
	type ProvisioningOperations,
	type ProvisioningPreview,
	type ProvisioningRequest,
	type ProvisioningResult
} from '../management/contracts.js';
import type { HostingConnection, InstanceRef } from './types.js';
import { azureClient, type AzureManagement } from './azure-client.js';
import { HostingPreferencesStore } from './preferences.js';
import { parseProvisioningRequest } from './provisioning.js';
import {
	AZURE_ASSISTANT_IMAGE,
	azureApplicationTemplate,
	azureInfrastructureTemplate,
	azureInstallNames,
	type AzureInstallRequest
} from './azure-template.js';
import { azureObject } from './azure-deployment.js';

export function azureProvisioning(
	connection: Extract<HostingConnection, { kind: 'azure-container-apps' }>,
	management: () => Promise<AzureManagement>,
	client: ReturnType<typeof azureClient>,
	store = new HostingPreferencesStore(),
	timing: { executionWaitMs?: number; pollIntervalMs?: number } = {}
): ProvisioningOperations {
	const scope = [
		'--subscription',
		connection.subscriptionId,
		'--resource-group',
		connection.resourceGroup
	];
	function request(value: ProvisioningRequest): AzureInstallRequest {
		const parsed = parseProvisioningRequest(value);
		if (parsed.kind !== 'azure-container-apps') throw new Error('Choose Azure placement settings.');
		return parsed;
	}
	function ref(input: AzureInstallRequest): InstanceRef {
		return {
			kind: 'azure-container-apps',
			connectionId: connection.id,
			resourceId: azureInstallNames(connection, input).app
		};
	}
	async function exists(id: string, apiVersion?: string): Promise<boolean> {
		try {
			await (await management()).get(id, apiVersion);
			return true;
		} catch (error) {
			if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 404)
				return false;
			throw error;
		}
	}
	async function preview(value: ProvisioningRequest): Promise<ProvisioningPreview> {
		const input = request(value),
			names = azureInstallNames(connection, input);
		if (await exists(names.app))
			throw new Error(
				'This Container App already exists. Open it to manage or update it; fresh installation does not replace an existing app.'
			);
		for (const [id, version] of [
			[names.identity, '2023-01-31'],
			[names.app.replace(/containerApps\/[^/]+$/, `jobs/${names.job}`), '2026-07-01'],
			[`${names.storage}/blobServices/default/containers/${names.container}`, '2025-06-01']
		])
			if (await exists(id!, version))
				throw new Error(
					`A resource required for fresh installation already exists: ${id}. Choose a different instance name; existing resources were not replaced.`
				);
		for (const [selection, id, version] of [
			[input.environment, names.environment, '2026-07-01'],
			[input.storage, names.storage, '2025-06-01']
		] as const) {
			const found = await exists(id, version);
			if (found === selection.create)
				throw new Error(
					found
						? `${selection.name} already exists. Choose reuse to preserve it.`
						: `${selection.name} does not exist. Choose create or an existing resource.`
				);
		}
		return {
			ref: ref(input),
			image: input.image ?? AZURE_ASSISTANT_IMAGE,
			summary: `Install ${input.name} in ${connection.resourceGroup}, ${input.location}. Azure compute and storage charges apply.`,
			resources: [
				{ name: input.name, type: 'Container App', action: 'create' },
				{
					name: input.environment.name,
					type: 'Container Apps environment',
					action: input.environment.create ? 'create' : 'reuse'
				},
				{
					name: input.storage.name,
					type: 'Storage account',
					action: input.storage.create ? 'create' : 'reuse'
				},
				{ name: names.container, type: 'Private Blob container', action: 'create' },
				{
					name: `${input.name}-identity`,
					type: 'User-assigned managed identity and container-scoped Blob role',
					action: 'create'
				},
				{ name: names.job, type: 'Temporary recovery initialization job', action: 'create' },
				...(input.mounts ?? []).map((item) => ({
					name: item.storageName,
					type: `Existing environment Files mount at ${item.mountPath}`,
					action: 'reuse' as const
				}))
			],
			warnings: [
				'Recovery checkpoints cover selected native state, not the full Azure deployment or independent Files mounts. Forced termination may lose changes since the last accepted checkpoint.',
				'Live Azure storage, identity and native account qualification is separate from template validation.',
				...(input.availability === 'on-demand'
					? [
							'On demand disables user scheduling for this fresh instance. Outbound Claude/Codex connections cannot wake a zero-replica app.'
						]
					: ['Always running keeps one replica available and incurs continuous compute charges.'])
			]
		};
	}
	function save(result: ProvisioningResult) {
		store.saveInstallation(result);
		return result;
	}
	async function advance(
		saved: ProvisioningResult,
		signal?: AbortSignal,
		retryFailedStep = false
	): Promise<ProvisioningResult> {
		const reference = saved.reference!;
		const sdk = await management();
		let deployment: Record<string, unknown>;
		try {
			deployment = await sdk.deployment(reference);
		} catch {
			return save({
				...saved,
				state: 'unknown',
				message:
					'Infrastructure submission cannot be confirmed. Inspect the named Azure deployment; do not reinstall or initialize again.'
			});
		}
		const properties = azureObject(deployment.properties);
		if (
			retryFailedStep &&
			(saved.state !== 'failed' ||
				!['infrastructure', 'initialization', 'application'].includes(saved.step))
		)
			throw new Error('Only a confirmed failed installation step can be deliberately retried.');
		if (retryFailedStep && (saved.step === 'infrastructure' || saved.step === 'application')) {
			const input = request(saved.request as ProvisioningRequest);
			if (
				saved.ref.kind !== 'azure-container-apps' ||
				saved.ref.resourceId.toLowerCase() !==
					azureInstallNames(connection, input).app.toLowerCase()
			)
				throw new Error('The recorded installation request does not match this target.');
			const native =
				saved.step === 'infrastructure'
					? properties
					: azureObject((await sdk.deployment(`${reference}-app`)).properties);
			if (!['Failed', 'Canceled'].includes(String(native.provisioningState)))
				throw new Error('Azure does not confirm this step failed. No deployment was replayed.');
			signal?.throwIfAborted();
			saved = save({
				...saved,
				state: 'submitted',
				message:
					'Retrying the recorded failed incremental deployment with its original placement. This reapplies the installation template; coordinate any concurrent changes in other tools.'
			});
			try {
				await sdk
					.deploy(
						saved.step === 'infrastructure' ? reference : `${reference}-app`,
						saved.step === 'infrastructure'
							? azureInfrastructureTemplate(connection, input)
							: azureApplicationTemplate(connection, input),
						saved.step === 'application'
							? { password: { value: randomBytes(32).toString('base64url') } }
							: undefined
					)
					.pollUntilDone({ abortSignal: AbortSignal.timeout(20 * 60_000) });
			} catch {
				return save({
					...saved,
					state: 'unknown',
					message:
						'Retry completion is unconfirmed. Resume observes the recorded deployment without another submission.'
				});
			}
			return advance(saved, signal);
		}
		if (properties.provisioningState !== 'Succeeded')
			return save({
				...saved,
				state: ['Failed', 'Canceled'].includes(String(properties.provisioningState))
					? 'failed'
					: 'in-progress',
				step: 'infrastructure',
				message: `Azure deployment ${reference}: ${String(properties.provisioningState)}. No application writers have been started.`
			});
		const input = request(
				saved.request ??
					(azureObject(azureObject(properties.outputs).request).value as ProvisioningRequest)
			),
			names = azureInstallNames(connection, input);
		if (
			saved.ref.kind !== 'azure-container-apps' ||
			saved.ref.resourceId.toLowerCase() !== names.app.toLowerCase()
		)
			throw new Error('The deployment continuation does not match this selected instance.');
		if (retryFailedStep && saved.step === 'initialization') {
			const executions = await sdk.jobExecutions(names.job);
			if (
				!executions.length ||
				executions.some((item) => !item.name || !['Failed', 'Canceled'].includes(item.status ?? ''))
			)
				throw new Error(
					'Native executions do not confirm failure. Inspect existing executions; no retry was submitted.'
				);
			saved = {
				...saved,
				step: 'infrastructure',
				previousInitializationExecutions: executions.map((item) => item.name!)
			};
		}
		if (saved.step === 'infrastructure') {
			signal?.throwIfAborted();
			// Record intent before sending. A lost start response is reconciled from executions, never replayed.
			saved = save({ ...saved, state: 'submitted', step: 'initialization' });
			try {
				await sdk.startJob(names.job).pollUntilDone({ abortSignal: AbortSignal.timeout(120_000) });
			} catch {
				return save({
					...saved,
					state: 'unknown',
					message:
						'Initialization submission is unconfirmed. Resume inspects the existing job executions without starting another.'
				});
			}
		}
		if (saved.step === 'initialization') {
			const deadline = Date.now() + (timing.executionWaitMs ?? 20 * 60_000);
			let executions: Awaited<ReturnType<AzureManagement['jobExecutions']>>;
			try {
				do {
					executions = (await sdk.jobExecutions(names.job)).filter(
						(item) => !saved.previousInitializationExecutions?.includes(item.name ?? '')
					);
					if (
						executions.length > 1 ||
						['Succeeded', 'Failed', 'Canceled'].includes(executions[0]?.status ?? '')
					)
						break;
					await delay(
						Math.min(timing.pollIntervalMs ?? 3000, Math.max(0, deadline - Date.now())),
						undefined,
						{ signal }
					);
				} while (Date.now() < deadline);
			} catch {
				return save({
					...saved,
					state: 'unknown',
					message:
						'Initialization observation ended. Resume inspects the existing execution; it does not start another.'
				});
			}
			if (executions.length !== 1)
				return save({
					...saved,
					state: 'unknown',
					message:
						'Expected one new initialization execution. Inspect the native job; initialization is never replayed automatically.'
				});
			const status = executions[0]?.status;
			if (status !== 'Succeeded')
				return save({
					...saved,
					state: status === 'Failed' || status === 'Canceled' ? 'failed' : 'in-progress',
					message: `Recovery initialization is ${status ?? 'unknown'}. Failed jobs are retained for diagnostics; correct identity/mount access before explicit Retry failed step. ARM role assignment completion does not prove Blob permissions have propagated.`
				});
			if (await exists(names.app))
				return save({
					...saved,
					state: 'unknown',
					message:
						'An app appeared before fresh deployment. Open it for management; the install template was not applied.'
				});
			saved = save({ ...saved, state: 'submitted', step: 'application' });
			try {
				await sdk
					.deploy(`${reference}-app`, azureApplicationTemplate(connection, input), {
						password: { value: randomBytes(32).toString('base64url') }
					})
					.pollUntilDone({ abortSignal: AbortSignal.timeout(20 * 60_000) });
			} catch {
				return save({
					...saved,
					state: 'unknown',
					message:
						'Application deployment completion is unconfirmed. Resume inspects the named deployment; no new password or deployment is submitted.'
				});
			}
		}
		if (saved.step === 'application') {
			let deployed: Record<string, unknown>;
			try {
				deployed = await sdk.deployment(`${reference}-app`);
			} catch {
				return save({
					...saved,
					state: 'unknown',
					message:
						'Application submission is unconfirmed. Inspect the named Azure deployment before further action.'
				});
			}
			const status = azureObject(deployed.properties).provisioningState;
			if (status !== 'Succeeded')
				return save({
					...saved,
					state: status === 'Failed' || status === 'Canceled' ? 'failed' : 'in-progress',
					message: `Application deployment is ${String(status)}.`
				});
			// This exact generated job was shown in preview. Data/identity/infrastructure are retained.
			try {
				await sdk.deleteJob(names.job).pollUntilDone({ abortSignal: AbortSignal.timeout(120_000) });
			} catch {
				return save({
					...saved,
					state: 'completed',
					step: 'deployed',
					message: `Assistant deployed. Temporary job ${names.job} remains; review its cleanup in Azure. Connect explicitly to verify native readiness.`
				});
			}
			return save({
				...saved,
				state: 'completed',
				step: 'deployed',
				message:
					'Assistant deployed. Connect explicitly for native account setup and readiness; deployment success does not prove provider or worker sign-in.'
			});
		}
		return saved;
	}
	return {
		options: supportedOperation(async () => {
			const [group, environments, storage] = await Promise.all([
				client.json(['group', 'show', ...scope, '--query', '{location:location}']),
				client.json([
					'containerapp',
					'env',
					'list',
					...scope,
					'--query',
					'[].{value:name,label:name}'
				]),
				client.json([
					'storage',
					'account',
					'list',
					...scope,
					'--query',
					"[?kind=='StorageV2'].{value:name,label:name}"
				])
			]);
			function choices(value: unknown) {
				if (!Array.isArray(value)) throw new Error('Azure choices are unavailable.');
				return value.map((entry) => {
					const item = azureObject(entry);
					return { value: String(item.value), label: String(item.label) };
				});
			}
			return {
				kind: 'azure-container-apps',
				location: String(azureObject(group).location),
				image: AZURE_ASSISTANT_IMAGE,
				timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				environments: choices(environments),
				storageAccounts: choices(storage),
				continuations: store.installations(connection.id)
			};
		}),
		preview: supportedOperation(preview),
		install: supportedOperation(async (value, context) => {
			if (!context.confirmed)
				throw new Error('Confirm the previewed Azure resources and charges before installation.');
			context.signal?.throwIfAborted();
			const input = request(value);
			input.image ??= AZURE_ASSISTANT_IMAGE;
			const pending = store
				.installations(connection.id)
				.find(
					(item) =>
						item.ref.kind === 'azure-container-apps' &&
						item.ref.resourceId === azureInstallNames(connection, input).app
				);
			if (pending) return pending;
			await preview(input);
			const reference = `fhold-${input.name}-${randomBytes(4).toString('hex')}`;
			const result: ProvisioningResult = {
				ref: ref(input),
				reference,
				state: 'submitted',
				step: 'infrastructure',
				request: input
			};
			save(result);
			try {
				await (await management())
					.deploy(reference, azureInfrastructureTemplate(connection, input))
					.pollUntilDone({ abortSignal: AbortSignal.timeout(20 * 60_000) });
			} catch {
				return save({
					...result,
					state: 'unknown',
					message:
						'Infrastructure submission/completion is unconfirmed. Resume the recorded deployment; closing this app does not cancel Azure resources.'
				});
			}
			return advance(result, context.signal);
		}),
		resume: supportedOperation(async ({ reference, retryFailedStep }, context) => {
			if (!context.confirmed) throw new Error('Confirm continuation of this installation.');
			const saved = store.installations(connection.id).find((item) => item.reference === reference);
			if (!saved) throw new Error('Choose this connection’s recorded installation continuation.');
			return advance(saved, context.signal, retryFailedStep);
		})
	};
}

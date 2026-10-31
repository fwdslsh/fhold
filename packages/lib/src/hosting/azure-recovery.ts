import { createHash, randomBytes } from 'node:crypto';
import {
	invokeOperation,
	supportedOperation,
	unsupportedOperation,
	type DataOperations,
	type Operation,
	type RecoverySnapshot
} from '../management/contracts.js';
import {
	defaultRecoverySettings,
	parseRecoverySettings
} from '../control-plane/recovery-config.js';
import { normalizeSelection } from '../../../../containers/assistant/recovery/selection.mjs';
import { azureEnvironment, azureObject, selectedAzureContainer } from './azure-deployment.js';
import type { AzureManagement } from './azure-client.js';
import type { InstanceRef } from './types.js';
import type { DeploymentOperations } from '../management/contracts.js';
import { HostingPreferencesStore } from './preferences.js';

/** Reuse only identities explicitly required by this job's selected native inputs. */
async function initializationIdentity(
	sdk: AzureManagement,
	identities: Record<string, unknown>,
	recoveryClientId: string | undefined,
	dependencyIdentities: Array<string | undefined>
) {
	const selected = new Set<string>();
	for (const required of dependencyIdentities) {
		if (!required)
			throw new Error(
				'A selected registry or Key Vault secret has no identity reference. Inspect that native dependency before initializing; no job was submitted.'
			);
		if (required.toLowerCase() === 'system')
			throw new Error(
				'A selected registry or Key Vault secret requires the app’s system-assigned identity. That principal cannot be reused by an initialization job. Configure an existing user-assigned identity for this dependency before initializing.'
			);
		const id = Object.keys(identities).find((key) => key.toLowerCase() === required.toLowerCase());
		if (!id)
			throw new Error(
				'A selected registry or Key Vault identity is not an attached user-assigned app identity. Inspect that native identity reference before initializing; no job was submitted.'
			);
		selected.add(id);
	}
	if (recoveryClientId) {
		let matched: string | undefined;
		const unresolved: string[] = [];
		for (const [id, value] of Object.entries(identities)) {
			const clientId =
				value && typeof value === 'object' && 'clientId' in value ? value.clientId : undefined;
			if (
				typeof clientId === 'string' &&
				clientId.toLowerCase() === recoveryClientId.toLowerCase()
			) {
				matched = id;
				break;
			}
			if (typeof clientId !== 'string') unresolved.push(id);
		}
		if (!matched)
			for (const id of unresolved) {
				try {
					const identity = await sdk.get(id, '2023-01-31');
					const clientId = azureObject(identity.properties).clientId;
					if (
						typeof clientId === 'string' &&
						clientId.toLowerCase() === recoveryClientId.toLowerCase()
					) {
						matched = id;
						break;
					}
				} catch {
					/* An unrelated unreadable identity does not block a later exact match. */
				}
			}
		if (!matched)
			throw new Error(
				'Could not identify the app’s user-assigned identity selected by recovery AZURE_CLIENT_ID. Verify that client ID and native identity read access before initializing; no job was submitted.'
			);
		selected.add(matched);
	}
	return selected.size
		? {
				type: 'UserAssigned',
				userAssignedIdentities: Object.fromEntries([...selected].map((id) => [id, {}]))
			}
		: undefined;
}

/** The host only supplies native deployment inputs. The image remains the sole recovery engine. */
export function azureRecovery(
	ref: Extract<InstanceRef, { kind: 'azure-container-apps' }>,
	management: () => Promise<AzureManagement>,
	deployment: DeploymentOperations,
	native: {
		recoveryStatus: Operation<void, Record<string, unknown>>;
		recoveryInspect: Operation<void, string>;
	},
	store = new HostingPreferencesStore()
) {
	const name = ref.resourceId.split('/').at(-1)!;
	let snapshot: RecoverySnapshot | undefined;
	async function environment() {
		return azureEnvironment(selectedAzureContainer(await (await management()).get(ref.resourceId)));
	}
	async function inspect(context: Parameters<typeof invokeOperation>[2]): Promise<string> {
		const result = await invokeOperation(native.recoveryInspect, undefined, context);
		const observed = azureObject(JSON.parse(result)),
			env = await environment();
		const settings = parseRecoverySettings(
			{
				...defaultRecoverySettings(name),
				enabled: !!env.FH_RECOVERY_URL,
				destination: env.FH_RECOVERY_URL ?? '',
				instanceId: env.FH_INSTANCE_ID ?? name,
				intervalSeconds: Number(env.FH_RECOVERY_INTERVAL_SECONDS ?? 60),
				maxUnsavedSeconds: Number(env.FH_RECOVERY_MAX_UNSAVED_SECONDS ?? 300),
				operationTimeoutSeconds: Number(env.FH_RECOVERY_OPERATION_TIMEOUT_SECONDS ?? 120),
				akmIndexCapture: env.FH_RECOVERY_AKM_INDEX_CAPTURE === '1',
				akmIndexRestore: env.FH_RECOVERY_AKM_INDEX_RESTORE === '1',
				authentication: env.FH_RECOVERY_CREDENTIAL_FILE ? 'connection-string' : 'managed-identity',
				clientId: env.AZURE_CLIENT_ID ?? ''
			},
			name
		);
		const selection = normalizeSelection(observed.selection);
		snapshot = {
			settings,
			selection,
			digest: createHash('sha256').update(JSON.stringify({ settings, selection })).digest('hex'),
			credentialConfigured:
				!!env.FH_RECOVERY_CREDENTIAL_FILE || settings.authentication === 'managed-identity',
			policyPath: env.FH_RECOVERY_INCLUDE_FILE ?? '(native default catalog)'
		};
		return result;
	}
	async function initialize(): Promise<string> {
		const sdk = await management(),
			document = await sdk.get(ref.resourceId),
			props = azureObject(document.properties);
		if (String(props.runningStatus).toLowerCase() !== 'stopped')
			throw new Error(
				'Stop the selected app and wait for native Stop completion before offline recovery.'
			);
		const saved = store.deployment(ref);
		if (saved.draft)
			throw new Error('Apply or discard the saved deployment draft before offline recovery.');
		const expectedStep = 'recovery-init';
		let reference =
			saved.operation?.step.startsWith(expectedStep) &&
			!['completed', 'failed'].includes(saved.operation.state)
				? saved.operation.reference
				: undefined;
		if (!reference) {
			if (
				saved.operation &&
				['submitted', 'in-progress', 'unknown'].includes(saved.operation.state)
			)
				throw new Error('Complete the outstanding Azure operation first.');
			reference = `fhold-recovery-${randomBytes(6).toString('hex')}`;
			const assistant = selectedAzureContainer(document),
				env = azureEnvironment(assistant);
			const identity = document.identity ? azureObject(document.identity) : {},
				identities = identity.userAssignedIdentities
					? azureObject(identity.userAssignedIdentities)
					: {};
			if (
				!env.FH_RECOVERY_CREDENTIAL_FILE &&
				(!env.AZURE_CLIENT_ID || !Object.keys(identities).length)
			)
				throw new Error(
					'Offline initialization requires an existing reusable user-assigned identity or native storage credential file. A system-assigned app identity cannot be reused by a job; it was not changed.'
				);
			const allVolumes = (
				Array.isArray(azureObject(props.template).volumes)
					? (azureObject(props.template).volumes as unknown[])
					: []
			).map(azureObject);
			const mounts = (Array.isArray(assistant.volumeMounts) ? assistant.volumeMounts : [])
				.map(azureObject)
				.filter(
					(mount) =>
						allVolumes.some(
							(volume) =>
								volume.name === mount.volumeName &&
								(volume.storageType === 'AzureFile' || volume.storageType === 'NfsAzureFile')
						) ||
						[env.FH_RECOVERY_CREDENTIAL_FILE, env.FH_RECOVERY_INCLUDE_FILE].some((path) =>
							path?.startsWith(`${mount.mountPath}/`)
						)
				);
			const volumes = allVolumes
				.filter((volume) => mounts.some((mount) => mount.volumeName === volume.name))
				.map((volume) =>
					volume.storageType !== 'Secret'
						? volume
						: {
								...volume,
								secrets: (Array.isArray(volume.secrets) ? volume.secrets : [])
									.map(azureObject)
									.filter((secret) =>
										mounts.some(
											(mount) =>
												mount.volumeName === volume.name &&
												[env.FH_RECOVERY_INCLUDE_FILE, env.FH_RECOVERY_CREDENTIAL_FILE].includes(
													`${mount.mountPath}/${secret.path}`
												)
										)
									)
							}
				);
			const selected = {
				name: assistant.name,
				image: assistant.image,
				resources: assistant.resources,
				command: ['/usr/local/bin/fhold-recovery'],
				args: ['init', '--confirm-new-instance'],
				env: (Array.isArray(assistant.env) ? assistant.env : [])
					.map(azureObject)
					.filter((item) =>
						/^(?:FH_RECOVERY_|FH_INSTANCE_ID$|AZURE_CLIENT_ID$)/.test(String(item.name))
					),
				volumeMounts: mounts
			};
			const neededSecrets = new Set(
				[
					...selected.env.map((item) => item.secretRef),
					...volumes.flatMap((volume) =>
						(Array.isArray(volume.secrets) ? volume.secrets : [])
							.map(azureObject)
							.map((item) => item.secretRef)
					)
				].filter((item): item is string => typeof item === 'string')
			);
			const config = props.configuration ? azureObject(props.configuration) : {};
			const registries = (Array.isArray(config.registries) ? config.registries : [])
				.map(azureObject)
				.filter((registry) => String(assistant.image).startsWith(`${registry.server}/`));
			for (const registry of registries)
				if (typeof registry.passwordSecretRef === 'string')
					neededSecrets.add(registry.passwordSecretRef);
			const parameters: Record<string, { value: unknown }> = {},
				definitions: Record<string, { type: string }> = {};
			const selectedSecrets = (await sdk.secrets(name)).filter((secret) =>
				neededSecrets.has(secret.name ?? '')
			);
			const jobIdentity = await initializationIdentity(
				sdk,
				identities,
				env.FH_RECOVERY_CREDENTIAL_FILE ? undefined : env.AZURE_CLIENT_ID,
				[
					...registries
						.filter((registry) => registry.identity !== undefined)
						.map((registry) =>
							typeof registry.identity === 'string' ? registry.identity : undefined
						),
					...selectedSecrets
						.filter((secret) => !!secret.keyVaultUrl)
						.map((secret) => secret.identity)
				]
			);
			const secrets = selectedSecrets.map((secret, index) => {
				if (secret.keyVaultUrl)
					return { name: secret.name, keyVaultUrl: secret.keyVaultUrl, identity: secret.identity };
				if (secret.value === undefined) return secret;
				const key = `secret${index}`;
				parameters[key] = { value: secret.value };
				definitions[key] = { type: 'secureString' };
				return { ...secret, value: `[parameters('${key}')]` };
			});
			const template = {
				$schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
				contentVersion: '1.0.0.0',
				parameters: definitions,
				resources: [
					{
						type: 'Microsoft.App/jobs',
						apiVersion: '2026-07-01',
						name: reference,
						location: document.location,
						...(jobIdentity ? { identity: jobIdentity } : {}),
						properties: {
							environmentId: props.environmentId ?? props.managedEnvironmentId,
							...(props.workloadProfileName
								? { workloadProfileName: props.workloadProfileName }
								: {}),
							configuration: {
								triggerType: 'Manual',
								replicaTimeout: 3600,
								replicaRetryLimit: 0,
								manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 },
								secrets,
								registries
							},
							template: { containers: [selected], volumes }
						}
					}
				]
			};
			store.saveDeployment(ref, {
				operation: { state: 'submitted', step: expectedStep, reference }
			});
			try {
				await sdk
					.deploy(reference, template, parameters)
					.pollUntilDone({ abortSignal: AbortSignal.timeout(20 * 60_000) });
			} catch {
				store.saveDeployment(ref, {
					operation: { state: 'unknown', step: expectedStep, reference }
				});
				throw new Error(
					`Offline job submission is unconfirmed. Retry inspects deployment ${reference}; it does not replay initialization.`
				);
			}
		}
		const current = store.deployment(ref).operation!;
		const observed = azureObject((await sdk.deployment(reference)).properties);
		if (observed.provisioningState !== 'Succeeded') {
			if (['Failed', 'Canceled'].includes(String(observed.provisioningState)))
				store.saveDeployment(ref, {
					operation: { state: 'failed', step: expectedStep, reference }
				});
			throw new Error(
				`Offline recovery deployment ${reference} is ${String(observed.provisioningState)}. Inspect its native operation.`
			);
		}
		if (current.step === expectedStep) {
			store.saveDeployment(ref, {
				operation: { state: 'submitted', step: `${expectedStep}-running`, reference }
			});
			try {
				await sdk.startJob(reference).pollUntilDone({ abortSignal: AbortSignal.timeout(120_000) });
			} catch {
				throw new Error(
					`Job execution submission is unconfirmed. Retry inspects ${reference} without replay.`
				);
			}
		}
		const executions = await sdk.jobExecutions(reference);
		if (executions.length !== 1 || executions[0]?.status !== 'Succeeded') {
			if (executions.length === 1 && ['Failed', 'Canceled'].includes(executions[0]?.status ?? ''))
				store.saveDeployment(ref, {
					operation: { state: 'failed', step: `${expectedStep}-running`, reference }
				});
			throw new Error(
				`Offline recovery ${reference}: ${executions[0]?.status ?? 'unknown execution'}. The job is retained for diagnostics; no ownership was cleared and no application was started.`
			);
		}
		store.saveDeployment(ref, {
			operation: { state: 'completed', step: `${expectedStep}-complete`, reference }
		});
		try {
			await sdk.deleteJob(reference).pollUntilDone({ abortSignal: AbortSignal.timeout(120_000) });
		} catch {
			return `Native recovery initialization completed. The app remains stopped. Temporary job ${reference} remains for cleanup; initialization is not a checkpoint.`;
		}
		return 'Native recovery initialization completed. The app remains stopped; initialization is not a checkpoint.';
	}
	const data: DataOperations = {
		knowledgeUi: unsupportedOperation(
			'The native knowledge UI is not published through this hosting binding.'
		),
		backup: unsupportedOperation(
			'Full cloud archives are not implemented. Recovery checkpoints are not portable exports.'
		),
		restoreData: unsupportedOperation('Cloud portable restore is not implemented.'),
		restoreInstance: unsupportedOperation('Full cloud import is not implemented.'),
		recovery: {
			status: native.recoveryStatus,
			inspect: supportedOperation((_input, context) => inspect(context)),
			initialize: supportedOperation(async (_input, context) => {
				if (!context.confirmed)
					throw new Error('Confirm a genuinely new recovery destination and stopped writers.');
				return initialize();
			}),
			restore: unsupportedOperation(
				'Start the app to restore its accepted checkpoint automatically before writers start. A separate offline job cannot restore the selected app’s ephemeral filesystem.'
			),
			save: supportedOperation(async (input, context) => {
				await inspect(context);
				if (input.baselineDigest !== snapshot?.digest)
					throw new Error('Recovery settings changed. Inspect current coverage before saving.');
				const settings = parseRecoverySettings(input.settings, name);
				if (settings.destination.startsWith('file:'))
					throw new Error(
						'Choose the existing cloud Blob recovery destination; local host directories are not Container App storage.'
					);
				const env = await environment();
				if (settings.authentication === 'connection-string' && !env.FH_RECOVERY_CREDENTIAL_FILE)
					throw new Error(
						'Configure a native ACA secret file mount for the connection string, or choose managed identity.'
					);
				await invokeOperation(
					deployment.prepare,
					{ recovery: { settings, selection: normalizeSelection(input.selection) } },
					context
				);
			}),
			setCredential: unsupportedOperation(
				'Storage secret values are not persisted in management preferences. Configure the exact native ACA secret file or use managed identity; existing secrets are preserved.'
			)
		}
	};
	return {
		data,
		environment,
		observation: () =>
			snapshot
				? { state: 'known' as const, value: snapshot, observedAt: new Date().toISOString() }
				: {
						state: 'not-inspected' as const,
						reason:
							'Connect and inspect recovery coverage to read the native selection and saved settings.'
					}
	};
}

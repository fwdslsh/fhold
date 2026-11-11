import type { ProvisioningRequest } from '../dto/hosting.js';
import { createHash } from 'node:crypto';
import { FH_RUNTIME_VERSION } from '../control-plane/release.js';
import type { HostingConnection } from './types.js';

export type AzureInstallRequest = Extract<ProvisioningRequest, { kind: 'azure-container-apps' }>;
export const AZURE_ASSISTANT_IMAGE = `fwdslsh/fhold-assistant:${FH_RUNTIME_VERSION}`;
const schema = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#';
export function azureInstallNames(
	connection: Extract<HostingConnection, { kind: 'azure-container-apps' }>,
	request: AzureInstallRequest
) {
	const scope = `/subscriptions/${connection.subscriptionId}/resourceGroups/${connection.resourceGroup}`;
	return {
		app: `${scope}/providers/Microsoft.App/containerApps/${request.name}`,
		environment: `${scope}/providers/Microsoft.App/managedEnvironments/${request.environment.name}`,
		storage: `${scope}/providers/Microsoft.Storage/storageAccounts/${request.storage.name}`,
		identity: `${scope}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${request.name}-identity`,
		container: `fhold-${request.name}`,
		share: `fhold-${request.name}`,
		backupStorage: `${scope}/providers/Microsoft.App/managedEnvironments/${request.environment.name}/storages/fhold-${request.name}-backup`,
		job: `${request.name.slice(0, 20)}-${createHash('sha256').update(request.name).digest('hex').slice(0, 6)}-init`
	};
}
function runtime(
	connection: Extract<HostingConnection, { kind: 'azure-container-apps' }>,
	request: AzureInstallRequest
) {
	const names = azureInstallNames(connection, request);
	const mounts = request.mounts ?? [];
	const blob = request.recovery === 'azblob';
	const environment = [
		{ name: 'FH_INSTANCE_ID', value: request.name },
		{
			name: 'FH_RECOVERY_URL',
			value: blob
				? `azblob://${request.storage.name}/${names.container}`
				: `file:///recovery/${request.name}`
		},
		...(blob
			? [
					{
						name: 'AZURE_CLIENT_ID',
						value: `[reference('${names.identity}', '2023-01-31').clientId]`
					}
				]
			: []),
		{ name: 'TZ', value: request.timezone },
		{ name: 'FH_SCHEDULER_ENABLED', value: request.availability === 'always' ? '1' : '0' },
		{ name: 'FH_RECOVERY_INTERVAL_SECONDS', value: '60' },
		{ name: 'FH_RECOVERY_OPERATION_TIMEOUT_SECONDS', value: '120' },
		{ name: 'FH_RECOVERY_INCLUDE_FILE', value: '/run/fhold-recovery-policy/include.json' },
		{ name: 'OPENCODE_SERVER_PASSWORD_FILE', value: '/run/secrets/opencode-password' }
	];
	const volumes: Array<Record<string, unknown>> = [
		...(!blob
			? [
					{
						name: 'recovery-backup',
						storageType: 'AzureFile',
						storageName: `fhold-${request.name}-backup`,
						mountOptions: 'uid=1000,gid=1000,file_mode=0600,dir_mode=0700'
					}
				]
			: []),
		{
			name: 'recovery-policy',
			storageType: 'Secret',
			secrets: [{ secretRef: 'recovery-policy', path: 'include.json' }]
		},
		{
			name: 'native-auth',
			storageType: 'Secret',
			secrets: [{ secretRef: 'opencode-password', path: 'opencode-password' }]
		},
		...mounts.map((mount, index) => ({
			name: `files-${index}`,
			storageType: 'AzureFile',
			storageName: mount.storageName
		}))
	];
	const volumeMounts = [
		...(!blob ? [{ volumeName: 'recovery-backup', mountPath: '/recovery' }] : []),
		{ volumeName: 'recovery-policy', mountPath: '/run/fhold-recovery-policy' },
		{ volumeName: 'native-auth', mountPath: '/run/secrets' },
		...mounts.map((mount, index) => ({ volumeName: `files-${index}`, mountPath: mount.mountPath }))
	];
	const secrets = [
		{
			name: 'recovery-policy',
			value: JSON.stringify({
				version: 1,
				paths: [],
				sqlite: [],
				externalMounts: mounts.map((item) => item.mountPath)
			})
		},
		{ name: 'opencode-password', value: "[parameters('password')]" }
	];
	const identity = blob
		? { type: 'UserAssigned', userAssignedIdentities: { [names.identity]: {} } }
		: undefined;
	const container = {
		name: 'assistant',
		image: request.image ?? AZURE_ASSISTANT_IMAGE,
		env: environment,
		volumeMounts,
		resources: { cpu: request.cpu ?? 2, memory: request.memory ?? '4Gi' }
	};
	return { names, volumes, secrets, identity, container };
}

/** Embedded standard ARM templates are bundled with CLI/Admin; no source path or compiler needed. */
export function azureInfrastructureTemplate(
	connection: Extract<HostingConnection, { kind: 'azure-container-apps' }>,
	request: AzureInstallRequest
): Record<string, unknown> {
	const { names, volumes, secrets, identity, container } = runtime(connection, request);
	const containerId = `${names.storage}/blobServices/default/containers/${names.container}`;
	const role = `[guid('${containerId}', '${names.identity}', 'blob-data-contributor')]`;
	const blob = request.recovery === 'azblob';
	const resources: Array<Record<string, unknown>> = [];
	if (request.environment.create)
		resources.push({
			type: 'Microsoft.App/managedEnvironments',
			apiVersion: '2026-07-01',
			name: request.environment.name,
			location: request.location,
			properties: {
				// Omitting log routing disables export; Azure rejects the CLI spelling "none" here.
				workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
			}
		});
	if (request.storage.create)
		resources.push({
			type: 'Microsoft.Storage/storageAccounts',
			apiVersion: '2025-06-01',
			name: request.storage.name,
			location: request.location,
			kind: 'StorageV2',
			sku: { name: 'Standard_LRS' },
			properties: {
				minimumTlsVersion: 'TLS1_2',
				allowBlobPublicAccess: false,
				supportsHttpsTrafficOnly: true
			}
		});
	if (!blob)
		resources.push(
			{
				type: 'Microsoft.Storage/storageAccounts/fileServices/shares',
				apiVersion: '2025-06-01',
				name: `${request.storage.name}/default/${names.share}`,
				dependsOn: request.storage.create ? [names.storage] : [],
				properties: { enabledProtocols: 'SMB' }
			},
			{
				type: 'Microsoft.App/managedEnvironments/storages',
				apiVersion: '2026-07-01',
				name: `${request.environment.name}/fhold-${request.name}-backup`,
				dependsOn: [
					`${names.storage}/fileServices/default/shares/${names.share}`,
					...(request.environment.create ? [names.environment] : [])
				],
				properties: {
					azureFile: {
						accessMode: 'ReadWrite',
						accountName: request.storage.name,
						shareName: names.share,
						accountKey: `[listKeys('${names.storage}', '2025-06-01').keys[0].value]`
					}
				}
			}
		);
	if (blob)
		resources.push(
			{
				type: 'Microsoft.Storage/storageAccounts/blobServices/containers',
				apiVersion: '2025-06-01',
				name: `${request.storage.name}/default/${names.container}`,
				dependsOn: request.storage.create ? [names.storage] : [],
				properties: { publicAccess: 'None' }
			},
			{
				type: 'Microsoft.ManagedIdentity/userAssignedIdentities',
				apiVersion: '2023-01-31',
				name: `${request.name}-identity`,
				location: request.location
			},
			{
				type: 'Microsoft.Authorization/roleAssignments',
				apiVersion: '2022-04-01',
				name: role,
				scope: containerId,
				dependsOn: [containerId, names.identity],
				properties: {
					roleDefinitionId: `[subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')]`,
					principalId: `[reference('${names.identity}', '2023-01-31').principalId]`,
					principalType: 'ServicePrincipal'
				}
			}
		);
	resources.push({
		type: 'Microsoft.App/jobs',
		apiVersion: '2026-07-01',
		name: names.job,
		location: request.location,
		identity,
		dependsOn: [
			blob ? names.identity : names.backupStorage,
			...(request.environment.create ? [names.environment] : [])
		],
		properties: {
			environmentId: names.environment,
			configuration: {
				triggerType: 'Manual',
				replicaTimeout: 600,
				replicaRetryLimit: 0,
				manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 },
				secrets: secrets.filter((secret) => secret.name === 'recovery-policy')
			},
			template: {
				containers: [
					{
						...container,
						env: container.env.filter((item) => item.name !== 'OPENCODE_SERVER_PASSWORD_FILE'),
						volumeMounts: container.volumeMounts.filter(
							(mount) => mount.volumeName !== 'native-auth'
						),
						command: ['/usr/local/bin/fhold-recovery'],
						args: ['init', '--confirm-new-instance']
					}
				],
				volumes: volumes.filter((volume) => volume.name !== 'native-auth')
			}
		}
	});
	return {
		$schema: schema,
		contentVersion: '1.0.0.0',
		parameters: {},
		resources,
		outputs: { request: { type: 'object', value: request } }
	};
}
export function azureApplicationTemplate(
	connection: Extract<HostingConnection, { kind: 'azure-container-apps' }>,
	request: AzureInstallRequest
): Record<string, unknown> {
	const { names, volumes, secrets, identity, container } = runtime(connection, request);
	return {
		$schema: schema,
		contentVersion: '1.0.0.0',
		parameters: { password: { type: 'secureString' } },
		resources: [
			{
				type: 'Microsoft.App/containerApps',
				apiVersion: '2026-07-01',
				name: request.name,
				location: request.location,
				identity,
				properties: {
					environmentId: names.environment,
					// Reused environments may be legacy consumption-only (no named profiles).
					...(request.environment.create ? { workloadProfileName: 'Consumption' } : {}),
					configuration: {
						activeRevisionsMode: 'Single',
						ingress: { external: true, targetPort: 4096, transport: 'http', allowInsecure: false },
						secrets
					},
					template: {
						terminationGracePeriodSeconds: 360,
						scale: { minReplicas: request.availability === 'always' ? 1 : 0, maxReplicas: 1 },
						volumes,
						containers: [
							{
								...container,
								env: [...container.env, { name: 'FH_RECOVERY_PROBE_PORT', value: '4097' }],
								probes: [
									{
										type: 'Startup',
										httpGet: { path: '/ready', port: 4097 },
										periodSeconds: 10,
										timeoutSeconds: 3,
										failureThreshold: 120
									},
									{
										type: 'Readiness',
										tcpSocket: { port: 4096 },
										periodSeconds: 10,
										failureThreshold: 3
									},
									{
										type: 'Liveness',
										tcpSocket: { port: 4096 },
										periodSeconds: 30,
										failureThreshold: 3
									}
								]
							}
						]
					}
				}
			}
		]
	};
}

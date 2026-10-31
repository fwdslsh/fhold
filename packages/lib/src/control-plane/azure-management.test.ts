import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { azureClient, type AzureManagement, type AzurePoller } from '../hosting/azure-client.js';
import {
	azureDeploymentOperations,
	azureDeploymentPatch,
	azureObject
} from '../hosting/azure-deployment.js';
import { azureProvisioning } from '../hosting/azure-provisioning.js';
import { azureRecovery } from '../hosting/azure-recovery.js';
import {
	azureApplicationTemplate,
	azureInfrastructureTemplate,
	azureInstallNames,
	type AzureInstallRequest
} from '../hosting/azure-template.js';
import { HostingPreferencesStore } from '../hosting/preferences.js';
import { invokeOperation, supportedOperation } from '../management/contracts.js';
import { defaultRecoverySettings } from './recovery-config.js';
import { parseProvisioningRequest } from './provisioning-input.js';

const connection = {
	kind: 'azure-container-apps' as const,
	id: 'cloud',
	label: 'Cloud',
	subscriptionId: '00000000-1111-2222-3333-444444444444',
	resourceGroup: 'test'
};
const input: AzureInstallRequest = {
	kind: 'azure-container-apps',
	name: 'example',
	location: 'eastus',
	environment: { name: 'environment', create: true },
	storage: { name: 'storage123', create: true },
	availability: 'always',
	timezone: 'America/Chicago'
};
const ref = {
	kind: 'azure-container-apps' as const,
	connectionId: connection.id,
	resourceId: azureInstallNames(connection, input).app
};
function preferences() {
	const store = new HostingPreferencesStore(
		join(mkdtempSync(join(tmpdir(), 'fhold-cloud-test-')), 'hosting.json')
	);
	store.saveConnection(connection);
	return store;
}
function poller(step: string, complete: () => unknown = () => ({}), status?: string): AzurePoller {
	return {
		operationState: { status },
		serialize: async () =>
			JSON.stringify({
				state: {
					status: 'running',
					config: {
						initialRequestUrl: `https://management.azure.com${ref.resourceId}${step === 'update' ? '' : `/${step}`}`,
						requestMethod: step === 'update' ? 'PATCH' : 'POST',
						metadata: { mode: 'OperationLocation' }
					}
				}
			}),
		pollUntilDone: async () => complete()
	};
}
function document(runningStatus = 'Running') {
	return {
		location: 'eastus',
		tags: { owner: 'another-tool' },
		identity: { type: 'SystemAssigned', principalId: 'existing' },
		properties: {
			runningStatus,
			unknownProperty: { keep: true },
			configuration: {
				ingress: { external: false },
				secrets: [{ name: 'other', value: 'private' }]
			},
			template: {
				unknownTemplate: true,
				scale: { minReplicas: 1, maxReplicas: 9, rules: [{ name: 'custom' }] },
				containers: [
					{
						name: 'assistant',
						image: 'custom/image:one',
						resources: { cpu: 2, memory: '4Gi', custom: true },
						env: [
							{ name: 'KEEP', value: 'yes' },
							{ name: 'PASSWORD', secretRef: 'other' }
						],
						volumeMounts: [{ volumeName: 'work', mountPath: '/custom' }]
					},
					{ name: 'other', image: 'custom/other:two', env: [{ name: 'OTHER', secretRef: 'other' }] }
				],
				volumes: [{ name: 'work', storageType: 'AzureFile', storageName: 'independent' }]
			}
		}
	};
}
function fixture(state = 'Running') {
	const store = preferences(),
		calls: string[] = [];
	let current: Record<string, unknown> = document(state);
	const sdk: AzureManagement = {
		get: async () => structuredClone(current),
		lifecycle: (_name, action, saved) => {
			calls.push(saved ? `resume-${action}` : action);
			return poller(action, () => {
				azureObject(current.properties).runningStatus = action === 'start' ? 'Running' : 'Stopped';
			});
		},
		patch: (_id, properties, saved) => {
			calls.push(saved ? 'resume-update' : 'update');
			return poller('update', () => {
				current = { ...current, properties: { ...azureObject(current.properties), ...properties } };
			});
		},
		deploy: () => {
			throw new Error('Unexpected deployment');
		},
		deployment: async () => {
			throw new Error('Unexpected deployment read');
		},
		startJob: () => {
			throw new Error('Unexpected job');
		},
		jobExecutions: async () => [],
		deleteJob: () => {
			throw new Error('Unexpected delete');
		},
		secret: async () => undefined,
		secrets: async () => [{ name: 'other', value: 'private' }]
	};
	const deployment = azureDeploymentOperations(ref, async () => sdk, store);
	return { store, calls, sdk, deployment, current: () => current };
}
const confirm = { confirmed: true };

test('narrow updates preserve full native fields, containers, secret refs and custom tags without ownership gates', async () => {
	const f = fixture();
	const original = f.current();
	const prepared = await invokeOperation(f.deployment.operations.prepare, {
		image: 'custom/image:two',
		environment: { FH_TIMEZONE: 'UTC' }
	});
	expect(prepared.pending?.image).toBe('custom/image:two');
	expect(f.calls).toEqual([]);
	expect(await invokeOperation(f.deployment.operations.apply, undefined, confirm)).toMatchObject({
		state: 'completed',
		step: 'started'
	});
	expect(f.calls).toEqual(['stop', 'update', 'start']);
	const next = f.current() as ReturnType<typeof document>;
	expect(next.tags).toEqual(original.tags);
	expect(next.identity).toEqual(original.identity);
	expect(next.properties.unknownProperty).toEqual({ keep: true });
	expect(next.properties.template.unknownTemplate).toBe(true);
	expect(next.properties.template.scale.maxReplicas).toBe(9);
	expect(next.properties.template.containers[1]).toEqual(
		(original as ReturnType<typeof document>).properties.template.containers[1]
	);
	expect(next.properties.template.containers[0]?.env).toContainEqual({
		name: 'PASSWORD',
		secretRef: 'other'
	});
	expect(next.properties.template.containers[0]?.env).toContainEqual({ name: 'TZ', value: 'UTC' });
	expect((await f.deployment.inspect()).environment).toEqual({ FH_TIMEZONE: 'UTC' });
	expect(next.properties.template.volumes).toEqual(
		(original as ReturnType<typeof document>).properties.template.volumes
	);
	expect(f.store.deployment(ref).draft).toBeUndefined();
});
test('ordinary Start or Restart after staging never consumes an unapplied deployment draft', async () => {
	for (const restart of [false, true]) {
		const f = fixture();
		await invokeOperation(f.deployment.operations.prepare, { image: 'custom/image:two' });
		if (restart) await f.deployment.lifecycle('stop');
		await f.deployment.lifecycle('start');
		f.calls.length = 0;
		await invokeOperation(f.deployment.operations.apply, undefined, confirm);
		expect(f.calls).toEqual(['stop', 'update', 'start']);
	}
});
test('Restart resumes its pending Start without issuing another Stop or losing a saved draft', async () => {
	const f = fixture();
	await invokeOperation(f.deployment.operations.prepare, { image: 'custom/pending:two' });
	f.sdk.lifecycle = (_name, action, saved) => {
		f.calls.push(saved ? `resume-${action}` : action);
		return poller(action, () => {
			if (action === 'start' && !saved) throw new Error('lost start completion');
		});
	};
	expect((await f.deployment.restart()).state).toBe('unknown');
	expect((await f.deployment.restart()).state).toBe('completed');
	expect(f.calls).toEqual(['stop', 'start', 'resume-start']);
	expect(f.store.deployment(ref).draft?.image).toBe('custom/pending:two');
	expect(f.store.deployment(ref).restartPhase).toBeUndefined();
});
test('updating an intentionally stopped app finishes with native Stop; discard and Later never mutate Azure', async () => {
	const f = fixture('Stopped');
	await invokeOperation(f.deployment.operations.prepare, { image: 'custom/image:two' });
	expect(f.calls).toEqual([]);
	await invokeOperation(f.deployment.operations.discard, undefined);
	expect(f.calls).toEqual([]);
	await invokeOperation(f.deployment.operations.update, { image: 'custom/image:two' }, confirm);
	expect(f.calls).toEqual(['update', 'stop']);
});

test('lost final Stop resumes that native operation without repeating the already applied PATCH', async () => {
	const f = fixture('Stopped');
	let stops = 0;
	f.sdk.lifecycle = (_name, action, saved) => {
		f.calls.push(saved ? 'resume-stop' : 'stop');
		stops++;
		return poller(action, () => {
			if (stops === 1) throw new Error('lost completion');
		});
	};
	await invokeOperation(f.deployment.operations.prepare, { image: 'custom/image:two' });
	expect((await invokeOperation(f.deployment.operations.apply, undefined, confirm)).state).toBe(
		'unknown'
	);
	expect((await invokeOperation(f.deployment.operations.apply, undefined, confirm)).state).toBe(
		'completed'
	);
	expect(f.calls).toEqual(['update', 'stop', 'resume-stop']);
});
test('known native rejection and Failed/Canceled permit corrected drafts, while ambiguous results resume without mutation replay', async () => {
	for (const failure of [
		{ status: 'failed' },
		{ status: 'canceled' },
		{ http: 400 },
		{ http: 403 }
	]) {
		const f = fixture();
		f.sdk.lifecycle = (_name, action) =>
			poller(
				action,
				() => {
					throw Object.assign(new Error('private resource body'), { statusCode: failure.http });
				},
				failure.status
			);
		const result = await f.deployment.lifecycle('stop');
		expect(result.state).toBe('failed');
		expect(JSON.stringify(result)).not.toContain('private resource');
		await invokeOperation(f.deployment.operations.prepare, { image: 'custom/image:corrected' });
	}
	const f = fixture();
	let submissions = 0,
		resumes = 0;
	f.sdk.lifecycle = (_name, action, saved) => {
		if (saved) resumes++;
		else submissions++;
		return poller(action, () => {
			if (!saved) throw new Error('connection lost');
		});
	};
	expect((await f.deployment.lifecycle('stop')).state).toBe('unknown');
	expect((await f.deployment.lifecycle('stop')).state).toBe('completed');
	expect(submissions).toBe(1);
	expect(resumes).toBe(1);
	expect(readFileSync(f.store.path, 'utf8')).not.toContain('connection lost');
});
test('correcting a failed apply preserves the original running intent across process reopening', async () => {
	for (const failedStep of ['update', 'start'] as const) {
		const f = fixture();
		const patch = f.sdk.patch,
			lifecycle = f.sdk.lifecycle;
		if (failedStep === 'update')
			f.sdk.patch = () =>
				poller(
					'update',
					() => {
						throw new Error('rejected');
					},
					'failed'
				);
		else
			f.sdk.lifecycle = (name, action, saved) =>
				action === 'start'
					? poller(
							'start',
							() => {
								throw new Error('rejected');
							},
							'failed'
						)
					: lifecycle(name, action, saved);
		await invokeOperation(f.deployment.operations.prepare, { image: 'custom/image:bad' });
		expect((await invokeOperation(f.deployment.operations.apply, undefined, confirm)).state).toBe(
			'failed'
		);
		expect(azureObject(f.current().properties).runningStatus).toBe('Stopped');
		f.sdk.patch = patch;
		f.sdk.lifecycle = lifecycle;
		const reopened = azureDeploymentOperations(
			ref,
			async () => f.sdk,
			new HostingPreferencesStore(f.store.path)
		);
		await invokeOperation(reopened.operations.prepare, { image: 'custom/image:corrected' });
		expect(f.store.deployment(ref).resumeAfterUpdate).toBe(true);
		expect((await invokeOperation(reopened.operations.apply, undefined, confirm)).state).toBe(
			'completed'
		);
		expect(azureObject(f.current().properties).runningStatus).toBe('Running');
	}
});
test('discard after a failed apply preserves an actionable stopped-state explanation without restarting', async () => {
	const f = fixture();
	f.sdk.patch = () =>
		poller(
			'update',
			() => {
				throw new Error('rejected');
			},
			'failed'
		);
	await invokeOperation(f.deployment.operations.prepare, { image: 'custom/image:bad' });
	await invokeOperation(f.deployment.operations.apply, undefined, confirm);
	await invokeOperation(f.deployment.operations.discard, undefined);
	expect(f.calls).toEqual(['stop']);
	expect(f.store.deployment(ref).draft).toBeUndefined();
	expect((await f.deployment.inspect()).operation?.message).toContain('use Start');
});
test('Update cannot silently apply an unrelated draft instead of the requested image', async () => {
	const f = fixture();
	await invokeOperation(f.deployment.operations.prepare, { environment: { FH_TIMEZONE: 'UTC' } });
	await expect(
		invokeOperation(f.deployment.operations.update, { image: 'custom/image:new' }, confirm)
	).rejects.toThrow('Apply or discard');
	expect(f.calls).toEqual([]);
	expect(f.store.deployment(ref).draft).toEqual({ environment: { FH_TIMEZONE: 'UTC' } });
});
test('image selection never redirects Assistant preferences or recovery to a sidecar', () => {
	const current = document();
	const settings = {
		...defaultRecoverySettings('example'),
		enabled: true,
		destination: 'azblob://storage123/fhold-example'
	};
	const patch = azureDeploymentPatch(
		current,
		{
			container: 'other',
			image: 'custom/sidecar:new',
			environment: { FH_TIMEZONE: 'Asia/Tokyo' },
			recovery: { settings, selection: { paths: [], sqlite: [] } }
		},
		[]
	);
	const containers = azureObject(patch.template).containers as Record<string, unknown>[];
	expect(containers[0]!.image).toBe('custom/image:one');
	expect(containers[0]!.env).toContainEqual({ name: 'TZ', value: 'Asia/Tokyo' });
	expect(containers[0]!.env).toContainEqual({
		name: 'FH_RECOVERY_URL',
		value: settings.destination
	});
	expect(containers[1]!.image).toBe('custom/sidecar:new');
	expect(containers[1]!.env).toEqual(current.properties.template.containers[1]!.env);
});
test('ambiguous Assistant settings are disabled and rejected before Stop while explicit image edits still work', async () => {
	const f = fixture();
	const template = azureObject(azureObject(f.current().properties).template);
	azureObject((template.containers as unknown[])[0]).name = 'custom-agent';
	expect((await f.deployment.inspect()).unavailable?.FH_TIMEZONE).toContain('ambiguous');
	await invokeOperation(f.deployment.operations.prepare, { environment: { FH_TIMEZONE: 'UTC' } });
	await expect(invokeOperation(f.deployment.operations.apply, undefined, confirm)).rejects.toThrow(
		'exact assistant'
	);
	expect(f.calls).toEqual([]);
	await invokeOperation(f.deployment.operations.discard, undefined);
	await invokeOperation(f.deployment.operations.prepare, {
		container: 'other',
		image: 'custom/sidecar:new'
	});
	expect((await invokeOperation(f.deployment.operations.apply, undefined, confirm)).state).toBe(
		'completed'
	);
});
test('official historical prereleases normalize to bundled image; custom or digest pins need explicit choice', async () => {
	for (const image of [
		'fwdslsh/fhold-assistant:0.4.1-beta.1',
		'docker.io/fwdslsh/fhold-assistant:0.4.1-alpha.2'
	]) {
		const f = fixture('Stopped');
		azureObject(
			(azureObject(azureObject(f.current().properties).template).containers as unknown[])[0]
		).image = image;
		expect((await invokeOperation(f.deployment.operations.update, {}, confirm)).state).toBe(
			'completed'
		);
	}
	for (const image of ['fwdslsh/fhold-assistant@sha256:123', 'private/assistant:pin']) {
		const f = fixture();
		azureObject(
			(azureObject(azureObject(f.current().properties).template).containers as unknown[])[0]
		).image = image;
		await expect(invokeOperation(f.deployment.operations.update, {}, confirm)).rejects.toThrow(
			'custom image pin'
		);
		expect(f.calls).toEqual([]);
	}
});
test('recovery policy update preserves unrelated colliding secrets and volumes', () => {
	const current = document();
	current.properties.template.volumes.push({
		name: 'fhold-recovery-policy',
		storageType: 'AzureFile',
		storageName: 'keep'
	});
	const patch = azureDeploymentPatch(
		current,
		{
			recovery: {
				settings: {
					...defaultRecoverySettings('example'),
					enabled: true,
					destination: 'azblob://storage123/fhold-example',
					authentication: 'managed-identity'
				},
				selection: { version: 1, paths: [], sqlite: [], externalMounts: [] }
			}
		},
		[
			{ name: 'fhold-recovery-policy', value: 'unrelated-secret' },
			{ name: 'other', value: 'private' }
		]
	);
	expect(azureObject(patch.configuration).secrets as unknown[]).toContainEqual({
		name: 'fhold-recovery-policy',
		value: 'unrelated-secret'
	});
	expect(azureObject(patch.template).volumes).toContainEqual({
		name: 'fhold-recovery-policy',
		storageType: 'AzureFile',
		storageName: 'keep'
	});
	expect(JSON.stringify(patch)).toContain('fhold-recovery-policy-1');
});
test('continuations bind exact target and connection scope and optional corruption stays isolated', () => {
	const store = preferences();
	store.saveDeployment(ref, { draft: { image: 'custom/new:tag' } });
	store.saveInstallation({
		ref,
		reference: 'fhold-example-12345678',
		state: 'unknown',
		step: 'initialization'
	});
	store.updateConnection(connection.id, { ...connection, resourceGroup: 'new' });
	expect(store.deployment(ref)).toEqual({});
	expect(store.installations(connection.id)).toEqual([]);
	const next = preferences();
	next.saveDeployment(ref, {
		operation: { state: 'unknown', step: 'start' },
		continuation: JSON.stringify({
			state: {
				config: {
					initialRequestUrl: `https://management.azure.com${ref.resourceId}-other/start`,
					requestMethod: 'POST'
				},
				status: 'running'
			}
		})
	});
	expect(() => next.deployment(ref)).toThrow('invalid');
	expect(next.connection(connection.id)).toEqual(connection);
	const raw = JSON.parse(readFileSync(next.path, 'utf8'));
	raw.installations = [{ ref: 'bad' }];
	raw.deployment = 'broken optional field';
	writeFileSync(next.path, JSON.stringify(raw));
	expect(next.connection(connection.id)).toEqual(connection);
	expect(next.installations(connection.id)).toEqual([]);
});
test('accepts exactly one legacy extra leading slash on the same ARM continuation target', () => {
	const store = preferences();
	function continuation(path: string) {
		return JSON.stringify({
			state: {
				config: {
					initialRequestUrl: `https://management.azure.com${path}`,
					requestMethod: 'PATCH'
				},
				status: 'running'
			}
		});
	}
	const legacy = continuation(`/${ref.resourceId}`);
	store.saveDeployment(ref, {
		operation: { state: 'in-progress', step: 'update' },
		continuation: legacy
	});
	expect(store.deployment(ref).continuation).toBe(legacy);
	for (const invalid of [`//${ref.resourceId}`, `/${ref.resourceId}-other`]) {
		store.saveDeployment(ref, {
			operation: { state: 'in-progress', step: 'update' },
			continuation: continuation(invalid)
		});
		expect(() => store.deployment(ref)).toThrow('invalid');
	}
});
test('templates use published runtime contract, secure parameters, private probe and writable image roots', () => {
	const app = azureApplicationTemplate(connection, input),
		infrastructure = azureInfrastructureTemplate(connection, input);
	const environment = (infrastructure.resources as Record<string, unknown>[]).find(
		(item) => item.type === 'Microsoft.App/managedEnvironments'
	)!;
	expect(azureObject(environment.properties).appLogsConfiguration).toBeUndefined();
	const resource = (app.resources as Record<string, unknown>[])[0]!,
		props = azureObject(resource.properties),
		template = azureObject(props.template),
		container = (template.containers as Record<string, unknown>[])[0]!;
	expect(container.env).toContainEqual({ name: 'TZ', value: 'America/Chicago' });
	expect(JSON.stringify(app)).not.toContain('FH_TIMEZONE');
	expect(template.scale).toEqual({ minReplicas: 1, maxReplicas: 1 });
	expect(template.terminationGracePeriodSeconds).toBe(360);
	expect(app.parameters).toEqual({ password: { type: 'secureString' } });
	expect(JSON.stringify(app)).not.toContain('EmptyDir');
	expect(JSON.stringify(infrastructure)).toContain('/usr/local/bin/fhold-recovery');
	expect(azureObject(azureObject(props.configuration).ingress).targetPort).toBe(4096);
	expect(JSON.stringify(container.probes)).toContain('4097');
	expect(
		azureInstallNames(connection, { ...input, name: 'same-long-app-prefix-abcdefghij' }).job
	).not.toBe(
		azureInstallNames(connection, { ...input, name: 'same-long-app-prefix-abcdefghik' }).job
	);
	expect(
		parseProvisioningRequest({
			...input,
			cpu: 33,
			mounts: [{ storageName: 'assets', mountPath: '/custom/assets' }]
		})
	).toMatchObject({ cpu: 33, mounts: [{ mountPath: '/custom/assets' }] });
});
test('fresh initialization job includes the Files mounts required by its recovery policy, but no native auth', () => {
	const request = { ...input, mounts: [{ storageName: 'assets', mountPath: '/work/assets' }] };
	const infrastructure = azureInfrastructureTemplate(connection, request);
	const job = (infrastructure.resources as Record<string, unknown>[]).find(
		(r) => r.type === 'Microsoft.App/jobs'
	)!;
	const template = azureObject(azureObject(job.properties).template);
	expect(template.volumes).toContainEqual({
		name: 'files-0',
		storageType: 'AzureFile',
		storageName: 'assets'
	});
	expect(azureObject((template.containers as unknown[])[0]).volumeMounts).toContainEqual({
		volumeName: 'files-0',
		mountPath: '/work/assets'
	});
	expect(JSON.stringify(job)).not.toContain('native-auth');
	expect(JSON.stringify(job)).not.toContain('opencode-password');
	const reused = azureApplicationTemplate(connection, {
		...input,
		environment: { ...input.environment, create: false }
	});
	expect(
		azureObject((reused.resources as Record<string, unknown>[])[0]!.properties).workloadProfileName
	).toBeUndefined();
});

function provisioningFixture() {
	const f = fixture(),
		submissions: string[] = [],
		names = azureInstallNames(connection, input);
	let reads = 0,
		attempts = 0,
		failed = false,
		collision = false;
	f.sdk.get = async (id) => {
		if (collision && id.endsWith(`/jobs/${names.job}`)) return {};
		throw Object.assign(new Error('missing'), { statusCode: 404 });
	};
	f.sdk.deploy = (name) => {
		submissions.push(`deploy:${name}`);
		return poller('update');
	};
	f.sdk.deployment = async () => ({
		properties: { provisioningState: 'Succeeded', outputs: { request: { value: input } } }
	});
	f.sdk.startJob = () => {
		attempts++;
		submissions.push('start-job');
		return poller('start');
	};
	f.sdk.jobExecutions = async () => {
		reads++;
		return [
			...(attempts > 1 ? [{ name: 'attempt-1', status: 'Failed' }] : []),
			{
				name: `attempt-${attempts}`,
				status: failed ? 'Failed' : reads < 3 ? 'Running' : 'Succeeded'
			}
		];
	};
	f.sdk.deleteJob = () => {
		submissions.push('delete-job');
		return poller('stop');
	};
	const operations = azureProvisioning(
		connection,
		async () => f.sdk,
		azureClient(async () => '{}'),
		f.store,
		{ executionWaitMs: 30, pollIntervalMs: 1 }
	);
	return {
		...f,
		operations,
		submissions,
		fail: (value: boolean) => {
			failed = value;
		},
		collide: () => {
			collision = true;
		},
		reads: () => reads
	};
}
test('install observes delayed native job completion automatically before app deployment', async () => {
	const f = provisioningFixture();
	const preview = await invokeOperation(f.operations.preview, input);
	expect(preview.warnings).toContain(
		'Experimental Azure support. Use a test assistant first and keep an independent backup of important work.'
	);
	expect(f.submissions).toEqual([]);
	const result = await invokeOperation(f.operations.install, input, confirm);
	expect(result.state).toBe('completed');
	expect(f.reads()).toBe(3);
	expect(f.submissions.map((item) => (item.startsWith('deploy:') ? 'deploy' : item))).toEqual([
		'deploy',
		'start-job',
		'deploy',
		'delete-job'
	]);
});
test('fresh install refuses an existing unselected init job without mutation', async () => {
	const f = provisioningFixture();
	f.collide();
	await expect(invokeOperation(f.operations.preview, input)).rejects.toThrow('already exists');
	expect(f.submissions).toEqual([]);
});
test('known failed initialization is inspectable and requires explicit retry; prior failed execution is retained', async () => {
	const f = provisioningFixture();
	f.fail(true);
	const failed = await invokeOperation(f.operations.install, input, confirm);
	expect(failed.state).toBe('failed');
	expect(failed.step).toBe('initialization');
	expect(
		(await invokeOperation(f.operations.resume, { reference: failed.reference! }, confirm)).state
	).toBe('failed');
	expect(f.submissions.filter((item) => item === 'start-job')).toHaveLength(1);
	// Native prior execution must still show Failed when retry is authorized.
	const native = f.sdk.jobExecutions;
	let inspect = true;
	f.sdk.jobExecutions = async () => {
		if (inspect) {
			inspect = false;
			return [{ name: 'attempt-1', status: 'Failed' }];
		}
		return native('job');
	};
	f.fail(false);
	expect(
		(
			await invokeOperation(
				f.operations.resume,
				{ reference: failed.reference!, retryFailedStep: true },
				confirm
			)
		).state
	).toBe('completed');
	expect(f.submissions.filter((item) => item === 'start-job')).toHaveLength(2);
});
test('unknown job submission is never started again by resume or retry', async () => {
	const f = provisioningFixture();
	f.sdk.startJob = () => {
		f.submissions.push('lost-start');
		throw new Error('lost response');
	};
	f.sdk.jobExecutions = async () => [];
	const result = await invokeOperation(f.operations.install, input, confirm);
	expect(result.state).toBe('unknown');
	await invokeOperation(f.operations.resume, { reference: result.reference! }, confirm);
	await expect(
		invokeOperation(
			f.operations.resume,
			{ reference: result.reference!, retryFailedStep: true },
			confirm
		)
	).rejects.toThrow('confirmed failed');
	expect(f.submissions.filter((item) => item === 'lost-start')).toHaveLength(1);
});
test('an initial rejected deployment is persisted and only explicitly retried; uncertain submission is not', async () => {
	for (const status of [400, 408, 500]) {
		const f = provisioningFixture();
		let attempts = 0;
		f.sdk.deployment = async () => {
			throw Object.assign(new Error('missing'), { statusCode: 404 });
		};
		f.sdk.deploy = (_name, _template, _parameters, response) => {
			attempts++;
			expect(f.store.installations(connection.id)[0]?.initialRejected).toBeUndefined();
			return {
				serialize: async () => '{}',
				pollUntilDone: async () => {
					response?.({ status, code: 'InvalidTemplateDeployment' });
					throw new Error('raw secret must not appear');
				}
			};
		};
		const result = await invokeOperation(f.operations.install, input, confirm);
		expect(result.state).toBe(status === 400 ? 'failed' : 'unknown');
		expect(result.message).not.toContain('raw secret');
		expect(f.store.installations(connection.id)[0]?.initialRejected).toBe(
			status === 400 ? true : undefined
		);
		await invokeOperation(f.operations.resume, { reference: result.reference! }, confirm);
		expect(attempts).toBe(1);
		if (status === 400) {
			const retried = await invokeOperation(
				f.operations.resume,
				{ reference: result.reference!, retryFailedStep: true },
				confirm
			);
			expect(retried.state).toBe('failed');
			expect(retried.message).toContain('HTTP 400');
			expect(attempts).toBe(2);
		} else {
			await invokeOperation(
				f.operations.resume,
				{ reference: result.reference!, retryFailedStep: true },
				confirm
			);
			expect(attempts).toBe(1);
		}
	}
});
test('accepted ARM deployments report terminal poller failure without treating uncertain transport as failed', async () => {
	for (const [http, status, expected] of [
		[202, 'failed', 'failed'],
		[202, 'canceled', 'failed'],
		[202, 'running', 'unknown'],
		[500, 'failed', 'unknown'],
		[undefined, 'failed', 'unknown']
	] as const) {
		const f = provisioningFixture();
		f.sdk.deploy = (_name, _template, _parameters, response) => ({
			operationState: { status },
			serialize: async () => '{}',
			pollUntilDone: async () => {
				if (http) response?.({ status: http });
				throw new Error('private response body');
			}
		});
		const result = await invokeOperation(f.operations.install, input, confirm);
		expect(result.state).toBe(expected);
		expect(result.initialRejected).toBeUndefined();
		expect(result.message).not.toContain('private response body');
		if (expected === 'failed') expect(result.message).toContain('activity log');
	}
});
test('rejected initial deployment retry rechecks resource collisions', async () => {
	const f = provisioningFixture();
	const reference = 'fhold-example-12345678';
	f.store.saveInstallation({
		ref,
		reference,
		request: input,
		state: 'failed',
		step: 'infrastructure',
		initialRejected: true
	});
	f.sdk.deployment = async () => {
		throw Object.assign(new Error('missing'), { statusCode: 404 });
	};
	f.collide();
	await expect(
		invokeOperation(f.operations.resume, { reference, retryFailedStep: true }, confirm)
	).rejects.toThrow('already exists');
	expect(f.submissions).toEqual([]);
});
test('inspecting a rejected initial app deployment preserves its explicit retry after ARM 404', async () => {
	const f = provisioningFixture();
	const reference = 'fhold-example-12345678';
	f.store.saveInstallation({
		ref,
		reference,
		request: input,
		state: 'failed',
		step: 'application',
		initialRejected: true,
		message: 'Azure rejected request.'
	});
	f.sdk.deployment = async (name) => {
		if (name.endsWith('-app')) throw Object.assign(new Error('missing'), { statusCode: 404 });
		return { properties: { provisioningState: 'Succeeded' } };
	};
	const inspected = await invokeOperation(f.operations.resume, { reference }, confirm);
	expect(inspected.state).toBe('failed');
	expect(inspected.message).toBe('Azure rejected request.');
	expect(f.submissions).toEqual([]);
	f.sdk.deploy = (_name, _template, _parameters, response) => ({
		serialize: async () => '{}',
		pollUntilDone: async () => {
			response?.({ status: 400 });
			throw new Error('failure');
		}
	});
	const retried = await invokeOperation(
		f.operations.resume,
		{ reference, retryFailedStep: true },
		confirm
	);
	expect(retried.state).toBe('failed');
	expect(retried.message).toContain('activity log');
});
test('confirmed initial rejection survives transient inspection failure and remains explicitly retryable', async () => {
	for (const step of ['infrastructure', 'application'] as const) {
		const f = provisioningFixture();
		const reference = 'fhold-example-12345678';
		const message =
			'Azure rejected the initial deployment request (HTTP 400, InvalidTemplateDeployment). Inspect the Azure activity log.';
		f.store.saveInstallation({
			ref,
			reference,
			request: input,
			state: 'failed',
			step,
			initialRejected: true,
			message
		});
		let status = 503;
		f.sdk.deployment = async (name) => {
			if (step === 'application' && !name.endsWith('-app'))
				return { properties: { provisioningState: 'Succeeded' } };
			throw Object.assign(new Error('synthetic'), { statusCode: status });
		};
		const observed = await invokeOperation(f.operations.resume, { reference }, confirm);
		expect(observed.state).toBe('failed');
		expect(observed.message).toBe(message);
		expect(f.store.installations(connection.id)[0]?.message).toBe(message);
		expect(f.submissions).toEqual([]);
		await expect(
			invokeOperation(f.operations.resume, { reference, retryFailedStep: true }, confirm)
		).rejects.toThrow('No retry was submitted');
		expect(f.store.installations(connection.id)[0]?.message).toBe(message);
		status = 404;
		expect((await invokeOperation(f.operations.resume, { reference }, confirm)).state).toBe(
			'failed'
		);
		let submissions = 0;
		f.sdk.deploy = (_name, _template, _parameters, response) => ({
			serialize: async () => '{}',
			pollUntilDone: async () => {
				submissions++;
				response?.({ status: 400 });
				throw new Error('synthetic');
			}
		});
		expect(
			(await invokeOperation(f.operations.resume, { reference, retryFailedStep: true }, confirm))
				.state
		).toBe('failed');
		expect(submissions).toBe(1);
	}
});
test('confirmed failed infrastructure and app steps can retry the original incremental template without relying on ARM outputs', async () => {
	for (const step of ['infrastructure', 'application'] as const) {
		const f = provisioningFixture(),
			reference = 'fhold-example-12345678';
		f.store.saveInstallation({
			ref,
			reference,
			request: { ...input, image: 'custom/original:pin' },
			state: 'failed',
			step
		});
		let retried = false;
		const submitted: Array<{ name: string; template: Record<string, unknown> }> = [];
		f.sdk.deployment = async (name) => ({
			properties: {
				provisioningState:
					!retried && (step === 'infrastructure' ? name === reference : name.endsWith('-app'))
						? 'Failed'
						: 'Succeeded'
			}
		});
		f.sdk.deploy = (name, template) => {
			submitted.push({ name, template });
			retried = true;
			return poller('update');
		};
		expect((await invokeOperation(f.operations.resume, { reference }, confirm)).state).toBe(
			'failed'
		);
		expect(submitted).toEqual([]);
		expect(
			(await invokeOperation(f.operations.resume, { reference, retryFailedStep: true }, confirm))
				.state
		).toBe('completed');
		expect(submitted[0]?.name).toBe(step === 'infrastructure' ? reference : `${reference}-app`);
		expect(JSON.stringify(submitted[0]?.template)).toContain('custom/original:pin');
		if (step === 'application') expect(f.submissions).not.toContain('start-job');
	}
});
test('failed receipt cannot authorize retry while native ARM outcome is still unknown or running', async () => {
	const f = provisioningFixture(),
		reference = 'fhold-example-12345678';
	f.store.saveInstallation({
		ref,
		reference,
		request: input,
		state: 'failed',
		step: 'infrastructure'
	});
	f.sdk.deployment = async () => ({ properties: { provisioningState: 'Running' } });
	await expect(
		invokeOperation(f.operations.resume, { reference, retryFailedStep: true }, confirm)
	).rejects.toThrow('does not confirm');
	expect(f.submissions).toEqual([]);
});
test('cloud offline restore is unavailable and system-assigned-only init never creates a different principal', async () => {
	const f = fixture('Stopped'),
		native = {
			recoveryStatus: supportedOperation(async () => ({})),
			recoveryInspect: supportedOperation(async () => '{}')
		};
	const recovery = azureRecovery(ref, async () => f.sdk, f.deployment.operations, native, f.store);
	expect(recovery.data.recovery.restore.support).toBe('unsupported');
	await expect(
		invokeOperation(recovery.data.recovery.initialize, undefined, confirm)
	).rejects.toThrow('system-assigned');
	expect(f.calls).toEqual([]);
});
test('offline initialization propagates only required recovery inputs, not unrelated mounted secrets or sidecars', async () => {
	const f = fixture('Stopped'),
		current = f.current(),
		props = azureObject(current.properties),
		template = azureObject(props.template),
		selected = azureObject((template.containers as unknown[])[0]);
	props.workloadProfileName = 'existing-profile';
	current.identity = {
		type: 'SystemAssigned, UserAssigned',
		userAssignedIdentities: {
			'/identity/reusable': { clientId: connection.subscriptionId },
			'/identity/unrelated': { clientId: 'unrelated' }
		}
	};
	selected.env = [
		{ name: 'FH_RECOVERY_URL', value: 'azblob://storage123/fhold-example' },
		{ name: 'AZURE_CLIENT_ID', value: connection.subscriptionId },
		{ name: 'FH_RECOVERY_INCLUDE_FILE', value: '/run/shared/include.json' },
		{ name: 'PASSWORD', secretRef: 'other' }
	];
	selected.volumeMounts = [
		{ volumeName: 'shared', mountPath: '/run/shared' },
		{ volumeName: 'independent', mountPath: '/data' },
		{ volumeName: 'nfs', mountPath: '/work/nfs' }
	];
	template.volumes = [
		{
			name: 'shared',
			storageType: 'Secret',
			secrets: [
				{ secretRef: 'policy', path: 'include.json' },
				{ secretRef: 'other', path: 'password' }
			]
		},
		{ name: 'independent', storageType: 'AzureFile', storageName: 'user-files' },
		{ name: 'nfs', storageType: 'NfsAzureFile', storageName: 'nfs-files' }
	];
	f.sdk.secrets = async () => [
		{ name: 'policy', value: 'private-policy' },
		{ name: 'other', value: 'other-service-secret' }
	];
	let deployed: Record<string, unknown> = {},
		parameters: Record<string, unknown> = {};
	f.sdk.deploy = (_name, value, params) => {
		deployed = value;
		parameters = params ?? {};
		return poller('update');
	};
	f.sdk.deployment = async () => ({ properties: { provisioningState: 'Succeeded' } });
	f.sdk.startJob = () => poller('start');
	f.sdk.jobExecutions = async () => [{ name: 'one', status: 'Succeeded' }];
	f.sdk.deleteJob = () => poller('stop');
	const recovery = azureRecovery(
		ref,
		async () => f.sdk,
		f.deployment.operations,
		{
			recoveryStatus: supportedOperation(async () => ({})),
			recoveryInspect: supportedOperation(async () => '{}')
		},
		f.store
	);
	expect(await invokeOperation(recovery.data.recovery.initialize, undefined, confirm)).toContain(
		'completed'
	);
	expect(JSON.stringify(deployed)).not.toContain('other-service-secret');
	expect(JSON.stringify(deployed)).not.toContain('password');
	const jobProps = azureObject((deployed.resources as Record<string, unknown>[])[0]!.properties);
	expect(jobProps.workloadProfileName).toBe('existing-profile');
	const jobTemplate = azureObject(jobProps.template);
	expect(jobTemplate.volumes).toContainEqual({
		name: 'independent',
		storageType: 'AzureFile',
		storageName: 'user-files'
	});
	expect(jobTemplate.volumes).toContainEqual({
		name: 'nfs',
		storageType: 'NfsAzureFile',
		storageName: 'nfs-files'
	});
	expect(azureObject((jobTemplate.containers as unknown[])[0]).volumeMounts).toEqual(
		selected.volumeMounts
	);
	expect(JSON.stringify(deployed)).not.toContain('private-policy');
	expect(parameters).toEqual({ secret0: { value: 'private-policy' } });
	expect(deployed.parameters).toEqual({ secret0: { type: 'secureString' } });
	expect(JSON.stringify(deployed)).not.toContain('SystemAssigned');
	expect((deployed.resources as Record<string, unknown>[])[0]?.identity).toEqual({
		type: 'UserAssigned',
		userAssignedIdentities: { '/identity/reusable': {} }
	});
	expect(readFileSync(f.store.path, 'utf8')).not.toContain('private-policy');
});

function identityJobFixture(credential = false) {
	const f = fixture('Stopped'),
		current = f.current(),
		props = azureObject(current.properties),
		template = azureObject(props.template),
		selected = azureObject((template.containers as unknown[])[0]);
	const identityPrefix = `/subscriptions/${connection.subscriptionId}/resourceGroups/test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/`;
	const ids = {
		recovery: `${identityPrefix}recovery`,
		registry: `${identityPrefix}registry`,
		vault: `${identityPrefix}vault`,
		unrelated: `${identityPrefix}unrelated`
	};
	current.identity = {
		type: 'SystemAssigned, UserAssigned',
		userAssignedIdentities: Object.fromEntries(
			Object.entries(ids).map(([key, id]) => [
				id,
				{ clientId: key === 'recovery' ? connection.subscriptionId : key }
			])
		)
	};
	selected.image = 'selected.azurecr.io/assistant:pin';
	selected.env = [
		{ name: 'FH_RECOVERY_URL', value: 'azblob://storage123/fhold-example' },
		{ name: 'AZURE_CLIENT_ID', value: connection.subscriptionId },
		...(credential
			? [{ name: 'FH_RECOVERY_CREDENTIAL_FILE', value: '/run/recovery/connection' }]
			: [])
	];
	selected.volumeMounts = credential
		? [{ volumeName: 'credential', mountPath: '/run/recovery' }]
		: [];
	template.volumes = credential
		? [
				{
					name: 'credential',
					storageType: 'Secret',
					secrets: [{ secretRef: 'storage', path: 'connection' }]
				}
			]
		: [];
	f.sdk.secrets = async () => [{ name: 'storage', value: 'private-connection' }];
	let deployed: Record<string, unknown> | undefined;
	f.sdk.deploy = (_name, value) => {
		deployed = value;
		return poller('update');
	};
	f.sdk.deployment = async () => ({ properties: { provisioningState: 'Succeeded' } });
	f.sdk.startJob = () => poller('start');
	f.sdk.jobExecutions = async () => [{ name: 'one', status: 'Succeeded' }];
	f.sdk.deleteJob = () => poller('stop');
	const recovery = azureRecovery(
		ref,
		async () => f.sdk,
		f.deployment.operations,
		{
			recoveryStatus: supportedOperation(async () => ({})),
			recoveryInspect: supportedOperation(async () => '{}')
		},
		f.store
	);
	return {
		...f,
		ids,
		current,
		props,
		initialize: () => invokeOperation(recovery.data.recovery.initialize, undefined, confirm),
		job: () => (deployed?.resources as Record<string, unknown>[] | undefined)?.[0]
	};
}

test('recovery job resolves an omitted UAMI client ID through native identity read and excludes every unrelated identity', async () => {
	const f = identityJobFixture(),
		reads: string[] = [];
	azureObject(azureObject(f.current.identity).userAssignedIdentities)[f.ids.recovery] = {};
	f.sdk.get = async (id, version) => {
		reads.push(id);
		if (id === ref.resourceId) return structuredClone(f.current);
		expect(version).toBe('2023-01-31');
		expect(id).toBe(f.ids.recovery);
		return { properties: { clientId: connection.subscriptionId } };
	};
	await f.initialize();
	expect(reads).toEqual([ref.resourceId, f.ids.recovery]);
	expect(f.job()?.identity).toEqual({
		type: 'UserAssigned',
		userAssignedIdentities: { [f.ids.recovery]: {} }
	});
});

test('connection-string recovery gives its job no app identities when no selected dependency requires one', async () => {
	const f = identityJobFixture(true);
	await f.initialize();
	expect(f.job()?.identity).toBeUndefined();
});

test('connection-string recovery attaches only selected registry and Key Vault identities, preserving the Key Vault reference', async () => {
	const f = identityJobFixture(true);
	f.props.configuration = {
		registries: [
			{ server: 'selected.azurecr.io', identity: f.ids.registry },
			{ server: 'unrelated.azurecr.io', identity: f.ids.unrelated }
		]
	};
	f.sdk.secrets = async () => [
		{
			name: 'storage',
			keyVaultUrl: 'https://vault.vault.azure.net/secrets/storage',
			identity: f.ids.vault,
			value: 'resolved-value-must-not-be-copied'
		},
		{
			name: 'other',
			keyVaultUrl: 'https://vault.vault.azure.net/secrets/other',
			identity: f.ids.unrelated
		}
	];
	await f.initialize();
	expect(f.job()?.identity).toEqual({
		type: 'UserAssigned',
		userAssignedIdentities: { [f.ids.registry]: {}, [f.ids.vault]: {} }
	});
	expect(azureObject(azureObject(f.job()?.properties).configuration).secrets).toEqual([
		{
			name: 'storage',
			keyVaultUrl: 'https://vault.vault.azure.net/secrets/storage',
			identity: f.ids.vault
		}
	]);
	expect(JSON.stringify(f.job())).not.toContain('resolved-value');
});

test('missing or system identities and unresolved recovery client IDs fail before submitting a job', async () => {
	for (const dependency of ['registry', 'vault', 'missing-vault', 'recovery']) {
		const f = identityJobFixture(dependency !== 'recovery');
		if (dependency === 'registry')
			f.props.configuration = {
				registries: [{ server: 'selected.azurecr.io', identity: 'system' }]
			};
		if (dependency === 'vault' || dependency === 'missing-vault')
			f.sdk.secrets = async () => [
				{
					name: 'storage',
					keyVaultUrl: 'https://vault.vault.azure.net/secrets/storage',
					...(dependency === 'vault' ? { identity: 'System' } : {})
				}
			];
		if (dependency === 'recovery')
			azureObject(azureObject(f.current.identity).userAssignedIdentities)[f.ids.recovery] = {
				clientId: 'not-selected'
			};
		await expect(f.initialize()).rejects.toThrow(
			dependency === 'recovery'
				? 'AZURE_CLIENT_ID'
				: dependency === 'missing-vault'
					? 'no identity reference'
					: 'system-assigned'
		);
		expect(f.job()).toBeUndefined();
	}
});

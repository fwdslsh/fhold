import { azureContinuation, type AzureManagement, type AzurePoller } from './azure-client.js';
import { HostingPreferencesStore } from './preferences.js';
import { DEPLOYMENT_ENVIRONMENT, parseDeploymentPatch } from './provisioning.js';
import {
	supportedOperation,
	type DeploymentOperations,
	type DeploymentOutcome,
	type DeploymentPatch,
	type DeploymentSettings
} from '../management/contracts.js';
import type { InstanceRef } from './types.js';
import { FH_RUNTIME_VERSION } from '../control-plane/release.js';
import { recoveryEnvironment, recoveryStopGrace } from '../control-plane/recovery-config.js';

export function azureObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Azure returned an invalid resource document.');
	return value as Record<string, unknown>;
}
export function azureContainers(document: Record<string, unknown>): Record<string, unknown>[] {
	const template = azureObject(azureObject(document.properties).template);
	if (!Array.isArray(template.containers)) throw new Error('This app has no container template.');
	return template.containers.map(azureObject);
}
export function selectedAzureContainer(
	document: Record<string, unknown>,
	name?: string
): Record<string, unknown> {
	const containers = azureContainers(document);
	const matching = name
		? containers.filter((item) => item.name === name)
		: containers.filter(
				(item) =>
					item.name === 'assistant' ||
					(typeof item.image === 'string' && /(?:^|\/)fhold-assistant(?::|@)/.test(item.image))
			);
	const selected =
		matching.length === 1
			? matching[0]
			: containers.length === 1 && !name
				? containers[0]
				: undefined;
	if (!selected) throw new Error('Choose the exact assistant container to change.');
	return selected;
}
export function azureEnvironment(container: Record<string, unknown>): Record<string, string> {
	return Object.fromEntries(
		(Array.isArray(container.env) ? container.env : [])
			.map(azureObject)
			.filter((item) => typeof item.name === 'string' && typeof item.value === 'string')
			.map((item) => [item.name, item.value])
	);
}
/** Build a merge patch from the freshly read complete native properties, not inventory DTOs. */
export function azureDeploymentPatch(
	document: Record<string, unknown>,
	input: DeploymentPatch,
	secrets?: Awaited<ReturnType<AzureManagement['secrets']>>
): Record<string, unknown> {
	const patch = parseDeploymentPatch(input),
		properties = azureObject(document.properties);
	const template = structuredClone(azureObject(properties.template));
	const selected = selectedAzureContainer({ properties: { template } }, patch.container);
	let configuration: Record<string, unknown> | undefined;
	if (patch.recovery) {
		if (!secrets)
			throw new Error('Resolve current native secrets before changing the recovery policy mount.');
		const settings = patch.recovery.settings,
			env = recoveryEnvironment(settings);
		delete env.FH_RECOVERY_STATE_DIR; // Preserve the native receipt placement, not a Docker-host path.
		if (settings.authentication === 'connection-string') delete env.FH_RECOVERY_CREDENTIAL_FILE;
		const volumes = (Array.isArray(template.volumes) ? template.volumes : []).map(azureObject);
		const mounts = (Array.isArray(selected.volumeMounts) ? selected.volumeMounts : []).map(
			azureObject
		);
		const oldPath = azureEnvironment(selected).FH_RECOVERY_INCLUDE_FILE;
		const oldMount = mounts.find((item) => oldPath?.startsWith(`${item.mountPath}/`));
		const oldVolume = volumes.find(
			(item) => item.name === oldMount?.volumeName && item.storageType === 'Secret'
		);
		const oldSecret = (Array.isArray(oldVolume?.secrets) ? oldVolume.secrets : [])
			.map(azureObject)
			.find((item) => oldPath === `${oldMount?.mountPath}/${item.path}`);
		const others = azureContainers({ properties: { template } }).filter(
			(item) => item.name !== selected.name
		);
		const shared =
			others.some((item) =>
				(Array.isArray(item.volumeMounts) ? item.volumeMounts : [])
					.map(azureObject)
					.some((mount) => mount.volumeName === oldVolume?.name)
			) ||
			volumes.some(
				(volume) =>
					volume !== oldVolume &&
					(Array.isArray(volume.secrets) ? volume.secrets : [])
						.map(azureObject)
						.some((secret) => secret.secretRef === oldSecret?.secretRef)
			) ||
			azureContainers({ properties: { template } }).some((item) =>
				(Array.isArray(item.env) ? item.env : [])
					.map(azureObject)
					.some(
						(entry) => entry.secretRef === oldSecret?.secretRef && entry.secretRef !== undefined
					)
			);
		const reusable = oldMount && oldVolume && oldSecret && !shared;
		let identifier = 'fhold-recovery-policy',
			suffix = 1;
		while (
			volumes.some((item) => item.name === identifier) ||
			secrets.some((item) => item.name === identifier) ||
			mounts.some((item) => item.mountPath === `/run/${identifier}`)
		)
			identifier = `fhold-recovery-policy-${suffix++}`;
		const volumeName = reusable ? oldVolume.name : identifier,
			secretName = reusable ? oldSecret.secretRef : identifier;
		const mountPath = reusable ? oldMount.mountPath : `/run/${identifier}`,
			policyFile = reusable ? oldSecret.path : 'include.json';
		env.FH_RECOVERY_INCLUDE_FILE = `${mountPath}/${policyFile}`;
		patch.environment = { ...patch.environment, ...env };
		template.terminationGracePeriodSeconds = Math.max(
			Number(template.terminationGracePeriodSeconds) || 0,
			recoveryStopGrace(settings) + 30
		);
		template.volumes = reusable
			? volumes
			: [
					...volumes,
					{
						name: volumeName,
						storageType: 'Secret',
						secrets: [{ secretRef: secretName, path: policyFile }]
					}
				];
		selected.volumeMounts = reusable ? mounts : [...mounts, { volumeName, mountPath }];
		configuration = {
			secrets: [
				...secrets.filter((item) => item.name !== secretName),
				{ name: secretName, value: JSON.stringify(patch.recovery.selection) }
			]
		};
	}
	if (patch.image) selected.image = patch.image;
	if (patch.cpu !== undefined || patch.memory !== undefined)
		selected.resources = {
			...(selected.resources ? azureObject(selected.resources) : {}),
			...(patch.cpu !== undefined ? { cpu: patch.cpu } : {}),
			...(patch.memory ? { memory: patch.memory } : {})
		};
	if (patch.environment) {
		// FH_TIMEZONE is the shared preference name; the image consumes the standard TZ input.
		const environment = Object.fromEntries(
			Object.entries(patch.environment).map(([key, value]) => [
				key === 'FH_TIMEZONE' ? 'TZ' : key,
				value
			])
		);
		const entries = (Array.isArray(selected.env) ? selected.env : []).map(azureObject);
		selected.env = [
			...entries.filter((item) => !Object.hasOwn(environment, String(item.name))),
			...Object.entries(environment)
				.filter(([, value]) => value !== null)
				.map(([name, value]) => ({ name, value }))
		];
	}
	if (patch.availability)
		template.scale = {
			...(template.scale ? azureObject(template.scale) : {}),
			minReplicas: patch.availability === 'always' ? 1 : 0,
			maxReplicas: 1
		};
	// Properties omitted from this PATCH (configuration, secrets, identity, tags) remain untouched.
	return { template, ...(configuration ? { configuration } : {}) };
}

export function azureDeploymentOperations(
	ref: Extract<InstanceRef, { kind: 'azure-container-apps' }>,
	management: () => Promise<AzureManagement>,
	store = new HostingPreferencesStore()
) {
	const name = ref.resourceId.split('/').at(-1)!;
	async function inspect(): Promise<DeploymentSettings> {
		const document = await (await management()).get(ref.resourceId),
			properties = azureObject(document.properties);
		const template = azureObject(properties.template),
			scale = template.scale ? azureObject(template.scale) : {};
		let environment: Record<string, string> = {};
		try {
			environment = Object.fromEntries(
				Object.entries(azureEnvironment(selectedAzureContainer(document)))
					.map(([key, value]) => [key === 'TZ' ? 'FH_TIMEZONE' : key, value])
					.filter(([key]) => DEPLOYMENT_ENVIRONMENT.has(key!))
			);
		} catch {
			/* Explicit container selection is available for multi-container apps. */
		}
		const saved = store.deployment(ref);
		return {
			containers: azureContainers(document).map((item) => ({
				name: String(item.name),
				image: String(item.image)
			})),
			environment,
			...(typeof scale.minReplicas === 'number'
				? { availability: scale.minReplicas === 0 ? ('on-demand' as const) : ('always' as const) }
				: {}),
			pending: saved.draft,
			operation: saved.operation
		};
	}
	async function run(
		step: string,
		create: (saved?: string) => AzurePoller
	): Promise<DeploymentOutcome> {
		const previous = store.deployment(ref);
		const incomplete =
			previous.operation &&
			['submitted', 'in-progress', 'unknown'].includes(previous.operation.state);
		if (incomplete && (previous.operation!.step !== step || !previous.continuation))
			return {
				state: 'unknown',
				step: previous.operation!.step,
				message:
					'A previous Azure request has an unknown outcome. Inspect its native operation before submitting another mutation.'
			};
		store.saveDeployment(ref, { ...previous, operation: { state: 'submitted', step } });
		let poller: AzurePoller | undefined;
		try {
			poller = create(incomplete ? previous.continuation : undefined);
			const continuation = await azureContinuation(poller);
			store.saveDeployment(ref, {
				...store.deployment(ref),
				continuation,
				operation: { state: 'in-progress', step }
			});
			await poller.pollUntilDone({ abortSignal: AbortSignal.timeout(20 * 60_000) });
			const outcome: DeploymentOutcome = { state: 'completed', step };
			store.saveDeployment(ref, {
				...store.deployment(ref),
				continuation: undefined,
				operation: outcome
			});
			return outcome;
		} catch (error) {
			const status = poller?.operationState?.status;
			const http =
				error && typeof error === 'object' && 'statusCode' in error
					? Number(error.statusCode)
					: undefined;
			const failed =
				status === 'failed' ||
				status === 'canceled' ||
				(http !== undefined && http >= 400 && http < 500 && http !== 408);
			const outcome: DeploymentOutcome = failed
				? {
						state: 'failed',
						step,
						message: `Azure rejected or failed ${step}${http ? ` (HTTP ${http})` : ''}. Review the native operation, correct the draft and apply again; instance data has not been cleared.`
					}
				: {
						state: 'unknown',
						step,
						message:
							'Azure operation completion could not be confirmed. The submitted operation was not canceled or replayed. Continue to inspect the same native operation.'
					};
			store.saveDeployment(ref, {
				...store.deployment(ref),
				...(failed ? { continuation: undefined } : {}),
				operation: outcome
			});
			return outcome;
		}
	}
	async function lifecycle(action: 'start' | 'stop') {
		const sdk = await management();
		return run(action, (saved) => sdk.lifecycle(name, action, saved));
	}
	async function restart(): Promise<DeploymentOutcome> {
		let saved = store.deployment(ref);
		if (!saved.restartPhase) {
			if (
				saved.operation &&
				['submitted', 'in-progress', 'unknown'].includes(saved.operation.state)
			)
				return {
					state: 'unknown',
					step: saved.operation.step,
					message: 'Continue the outstanding native operation before starting a new restart.'
				};
			store.saveDeployment(ref, {
				...saved,
				operation: undefined,
				continuation: undefined,
				restartPhase: 'stop'
			});
			saved = store.deployment(ref);
		}
		if (saved.restartPhase === 'stop') {
			if (!(saved.operation?.step === 'stop' && saved.operation.state === 'completed')) {
				const stopped = await lifecycle('stop');
				if (stopped.state !== 'completed') return stopped;
			}
			store.saveDeployment(ref, { ...store.deployment(ref), restartPhase: 'start' });
		}
		const current = store.deployment(ref);
		const started =
			current.operation?.step === 'start' && current.operation.state === 'completed'
				? current.operation
				: await lifecycle('start');
		if (started.state === 'completed')
			store.saveDeployment(ref, { ...store.deployment(ref), restartPhase: undefined });
		return started;
	}
	async function apply(): Promise<DeploymentOutcome> {
		let saved = store.deployment(ref);
		if (!saved.draft) return { state: 'completed', step: 'no-pending-changes' };
		const sdk = await management();
		const current = await sdk.get(ref.resourceId);
		if (saved.resumeAfterUpdate === undefined) {
			if (
				saved.operation &&
				['submitted', 'in-progress', 'unknown'].includes(saved.operation.state)
			)
				return {
					state: 'unknown',
					step: saved.operation.step,
					message:
						'Continue the outstanding lifecycle operation before applying a deployment draft.'
				};
			const wasRunning =
				String(azureObject(current.properties).runningStatus).toLowerCase() !== 'stopped';
			store.saveDeployment(ref, {
				...saved,
				operation: undefined,
				continuation: undefined,
				resumeAfterUpdate: wasRunning
			});
			saved = store.deployment(ref);
		}
		const priorStep = saved.operation?.step;
		const finishing = priorStep === 'start' || priorStep === 'stop-updated';
		if (saved.resumeAfterUpdate && priorStep !== 'update' && !finishing) {
			const stopped = await lifecycle('stop');
			if (stopped.state !== 'completed') return stopped;
		}
		if (!finishing && !(priorStep === 'update' && saved.operation?.state === 'completed')) {
			// Re-read after completed Stop. Preserve all unrelated current fields and containers.
			const properties = azureDeploymentPatch(
				await sdk.get(ref.resourceId),
				saved.draft!,
				saved.draft?.recovery ? await sdk.secrets(name) : undefined
			);
			const updated = await run('update', (continuation) =>
				sdk.patch(ref.resourceId, properties, continuation)
			);
			if (updated.state !== 'completed') return updated;
		}
		if (saved.resumeAfterUpdate) {
			const started = await lifecycle('start');
			if (started.state !== 'completed') return started;
		} else {
			// PATCH may activate a revision. Preserve the user's final stopped intent
			// with the native Stop operation, without claiming no transient activation.
			const stopped = await run('stop-updated', (continuation) =>
				sdk.lifecycle(name, 'stop', continuation)
			);
			if (stopped.state !== 'completed') return stopped;
		}
		const outcome: DeploymentOutcome = {
			state: 'completed',
			step: saved.resumeAfterUpdate ? 'started' : 'updated-stopped',
			message:
				'Azure completed the deployment operation. Native readiness and checkpoint durability are separate observations.'
		};
		store.saveDeployment(ref, { operation: outcome });
		return outcome;
	}
	const operations: DeploymentOperations = {
		inspect: supportedOperation(inspect),
		prepare: supportedOperation(async (input) => {
			const patch = parseDeploymentPatch(input);
			const saved = store.deployment(ref);
			if (
				saved.operation &&
				['submitted', 'in-progress', 'unknown'].includes(saved.operation.state)
			)
				throw new Error('Continue the outstanding native operation before editing this draft.');
			store.saveDeployment(ref, {
				draft: {
					...saved.draft,
					...patch,
					...(patch.environment
						? { environment: { ...saved.draft?.environment, ...patch.environment } }
						: {})
				}
			});
			return inspect();
		}),
		discard: supportedOperation(async () => {
			const saved = store.deployment(ref);
			if (
				saved.operation &&
				['submitted', 'in-progress', 'unknown'].includes(saved.operation.state)
			)
				throw new Error('A submitted Azure operation cannot be discarded as a local draft.');
			store.saveDeployment(ref, {});
		}),
		apply: supportedOperation(async (_input, context) => {
			if (!context.confirmed)
				throw new Error('Confirm applying deployment changes and interruption.');
			return apply();
		}),
		update: supportedOperation(async (input, context) => {
			if (!context.confirmed) throw new Error('Confirm image update and interruption.');
			const saved = store.deployment(ref);
			if (!saved.draft) {
				const document = await (await management()).get(ref.resourceId),
					selected = selectedAzureContainer(document, input.container);
				const existing = String(selected.image);
				if (
					!input.image &&
					!/^(?:docker\.io\/)?fwdslsh\/fhold-assistant:\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)(?:\.\d+)?)?$/.test(
						existing
					)
				)
					throw new Error('This is a custom image pin. Choose its new image reference explicitly.');
				store.saveDeployment(ref, {
					draft: parseDeploymentPatch({
						container: String(selected.name),
						image: input.image ?? `fwdslsh/fhold-assistant:${FH_RUNTIME_VERSION}`
					})
				});
			}
			return apply();
		})
	};
	return { operations, lifecycle, restart, inspect };
}

import { parseStackConfig, type StackConfig } from '../control-plane/stack-config.js';
import { parseDeploymentPatch } from '../control-plane/provisioning-input.js';
import {
	invokeOperation,
	supportedOperation,
	type DeploymentOperations,
	type DeploymentPatch,
	type DeploymentSettings,
	type DockerOperations,
	type HostOperations
} from '../management/contracts.js';
import { HostingPreferencesStore } from './preferences.js';
import type { HostingSnapshot, InstanceRef } from './types.js';

const environmentFields = {
	FH_TIMEZONE: 'timezone',
	FH_CLAUDE_REMOTE: 'claudeRemote',
	FH_CODEX_REMOTE: 'codexRemote',
	FH_CODEX_SANDBOX: 'codexSandbox'
} as const;

/** Translate the common editor into existing Docker intent, not another Compose file. */
function changedConfig(base: StackConfig, input: DeploymentPatch): StackConfig {
	const patch = parseDeploymentPatch(input);
	if (patch.availability || patch.cpu !== undefined || patch.memory || patch.recovery)
		throw new Error('Use the existing Docker configuration controls for these settings.');
	const config = structuredClone(base);
	if (patch.image) {
		const name = patch.container || 'assistant';
		if (name !== 'assistant' && name !== 'guardian' && name !== 'portal')
			throw new Error('Choose Assistant, Guardian or Portal.');
		const prefix = `${config.deployment.imageNamespace}/fhold-${name}:`;
		if (!patch.image.startsWith(prefix))
			throw new Error(
				`Use an image reference beginning with ${prefix}. Custom repositories belong in custom Compose.`
			);
		config.deployment.images[name] = patch.image.slice(prefix.length);
	}
	for (const [key, value] of Object.entries(patch.environment || {})) {
		if (!Object.hasOwn(environmentFields, key) || value === null)
			throw new Error(
				`This Docker editor cannot change ${key}. Use explicit instance configuration.`
			);
		const field = environmentFields[key as keyof typeof environmentFields];
		if (field === 'claudeRemote' || field === 'codexRemote') {
			if (value !== '0' && value !== '1') throw new Error('Choose Enabled or Disabled.');
			config.assistant[field] = value === '1';
		} else if (field === 'timezone') config.assistant.timezone = value;
		else config.assistant.codexSandbox = value as StackConfig['assistant']['codexSandbox'];
	}
	const parsed = parseStackConfig(config);
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.config;
}

/** Local and SSH use the same typed operations; only their existing RPC transport differs. */
export function dockerDeploymentOperations(
	ref: InstanceRef,
	docker: DockerOperations,
	host: HostOperations,
	inspectHost: () => Promise<HostingSnapshot>,
	readConfig: () => Promise<StackConfig | undefined>,
	store = new HostingPreferencesStore()
): { operations: DeploymentOperations; inspectHost(): Promise<HostingSnapshot> } {
	async function current() {
		const config = await readConfig();
		if (!config) throw new Error('Install this instance before editing deployment settings.');
		return config;
	}
	async function inspect(): Promise<DeploymentSettings> {
		const config = await current();
		return {
			containers: Object.entries(config.deployment.images).map(([name, tag]) => ({
				name,
				image: `${config.deployment.imageNamespace}/fhold-${name}:${tag}`
			})),
			environment: {
				FH_TIMEZONE: config.assistant.timezone,
				FH_CLAUDE_REMOTE: config.assistant.claudeRemote ? '1' : '0',
				FH_CODEX_REMOTE: config.assistant.codexRemote ? '1' : '0',
				FH_CODEX_SANDBOX: config.assistant.codexSandbox
			},
			unavailable: {
				availability: 'Automatic scale-to-zero is not available on this host. Use Start and Stop.',
				FH_SCHEDULER_ENABLED:
					'Scheduling overrides are configured in this instance’s custom Compose file.'
			},
			imageHelp:
				'Use the current repository with a new tag. Portal is shared by Discord and Slack; custom Compose overrides remain unchanged.',
			pending: store.deployment(ref).draft
		};
	}
	const operations: DeploymentOperations = {
		inspect: supportedOperation(inspect),
		prepare: supportedOperation(async (input) => {
			const patch = parseDeploymentPatch(input);
			const previous = store.deployment(ref).draft;
			const draft = {
				...previous,
				...patch,
				...(patch.environment
					? { environment: { ...previous?.environment, ...patch.environment } }
					: {})
			};
			changedConfig(await current(), draft); // Validate without touching the instance or runtime.
			store.saveDeployment(ref, { draft });
			return inspect();
		}),
		discard: supportedOperation(async () => {
			store.saveDeployment(ref, {});
		}),
		apply: {
			...supportedOperation(async (_input: void, context) => {
				if (!context.confirmed) throw new Error('Confirm applying saved changes and interruption.');
				const draft = store.deployment(ref).draft;
				if (draft) {
					const baseConfig = await current();
					await invokeOperation(
						docker.saveConfig,
						{ baseConfig, config: changedConfig(baseConfig, draft) },
						context
					);
				}
				const outcome = await invokeOperation(host.restart, undefined, context);
				if (outcome.state !== 'completed')
					return {
						state: outcome.state === 'accepted' ? ('in-progress' as const) : outcome.state,
						step: 'apply',
						message: 'Settings remain pending until activation completes.'
					};
				store.saveDeployment(ref, {});
				return {
					state: 'completed' as const,
					step: 'applied',
					message: 'Saved settings applied. Containers started or restarted.'
				};
			}),
			effect: 'reconcile-deployment'
		},
		update: supportedOperation(async (input, context) => {
			if (input.container || input.image)
				throw new Error('Save explicit image changes in Deployment settings, then Apply changes.');
			if (store.deployment(ref).draft)
				throw new Error('Apply or discard the deployment draft before updating the instance.');
			await invokeOperation(docker.update, { pull: input.pull }, context);
			return { state: 'completed', step: 'updated' };
		})
	};
	return {
		operations,
		async inspectHost() {
			const snapshot = await inspectHost();
			try {
				if (store.deployment(ref).draft)
					snapshot.pendingRestart = {
						required: true,
						error:
							'Saved deployment changes are pending. Applying them starts or restarts the containers.'
					};
			} catch {
				snapshot.warnings.push(
					'The saved deployment draft could not be read. Review the private hosting preferences. Other instance controls remain available.'
				);
			}
			return snapshot;
		}
	};
}

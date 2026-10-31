import { isAbsolute } from 'node:path';
import { isInstanceName, parseStackConfig, validTimezone } from './stack-config.js';
import type { ProvisioningRequest, DeploymentPatch } from '../dto/hosting.js';
import { parseRecoverySettings } from './recovery-config.js';
import { normalizeSelection } from '../../../../containers/assistant/recovery/selection.mjs';

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Expected installation settings.');
	return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value))
		throw new Error(`Provide ${label}.`);
	return value;
}
export const DEPLOYMENT_ENVIRONMENT = new Set([
	'FH_TIMEZONE',
	'FH_SCHEDULER_ENABLED',
	'FH_CODEX_REMOTE',
	'FH_CLAUDE_REMOTE',
	'FH_CODEX_SANDBOX',
	'FH_RECOVERY_URL',
	'FH_INSTANCE_ID',
	'FH_RECOVERY_INTERVAL_SECONDS',
	'FH_RECOVERY_MAX_UNSAVED_SECONDS',
	'FH_RECOVERY_OPERATION_TIMEOUT_SECONDS',
	'FH_RECOVERY_AKM_INDEX_CAPTURE',
	'FH_RECOVERY_AKM_INDEX_RESTORE',
	'AZURE_CLIENT_ID'
]);
export function parseDeploymentPatch(value: unknown): DeploymentPatch {
	const input = record(value);
	if (
		Object.keys(input).some(
			(key) =>
				![
					'container',
					'image',
					'availability',
					'environment',
					'cpu',
					'memory',
					'recovery'
				].includes(key)
		)
	)
		throw new Error('Unknown deployment setting.');
	const result: DeploymentPatch = {};
	if (input.recovery !== undefined) {
		const recovery = record(input.recovery);
		result.recovery = {
			settings: parseRecoverySettings(recovery.settings, 'recovery'),
			selection: normalizeSelection(recovery.selection)
		};
	}
	if (input.container !== undefined) {
		result.container = text(input.container, 'a container name');
		if (!/^[a-zA-Z0-9_.-]+$/.test(result.container)) throw new Error('Invalid container name.');
	}
	if (input.image !== undefined) {
		result.image = text(input.image, 'an image reference');
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]*$/.test(result.image))
			throw new Error('Invalid image reference.');
	}
	if (input.availability !== undefined) {
		if (input.availability !== 'always' && input.availability !== 'on-demand')
			throw new Error('Choose Always running or On demand.');
		result.availability = input.availability;
	}
	if (input.cpu !== undefined) {
		if (typeof input.cpu !== 'number' || input.cpu <= 0 || !Number.isFinite(input.cpu))
			throw new Error(
				'CPU must be a positive number. Azure validates the selected workload profile.'
			);
		result.cpu = input.cpu;
	}
	if (input.memory !== undefined) {
		result.memory = text(input.memory, 'memory');
		if (!/^\d+(?:\.\d+)?Gi$/.test(result.memory))
			throw new Error('Use memory in Gi, for example 4Gi.');
	}
	if (input.environment !== undefined) {
		result.environment = {};
		for (const [key, value] of Object.entries(record(input.environment))) {
			if (
				!DEPLOYMENT_ENVIRONMENT.has(key) ||
				(value !== null && (typeof value !== 'string' || /[\0\r\n]/.test(value)))
			)
				throw new Error('Only non-secret native deployment preferences can be saved here.');
			if (key === 'FH_TIMEZONE' && value !== null && !validTimezone(value as string))
				throw new Error('Choose a valid timezone.');
			result.environment[key] = value as string | null;
		}
	}
	return result;
}
export function parseProvisioningRequest(value: unknown): ProvisioningRequest {
	const input = record(value);
	const name = text(input.name, 'an instance name');
	if (!isInstanceName(name)) throw new Error('Use a lowercase DNS-safe instance name.');
	if (input.kind === 'directory') {
		const directory = text(input.directory, 'an absolute instance directory');
		if (!isAbsolute(directory)) throw new Error('Choose an absolute instance directory.');
		const parsed = parseStackConfig(input.config);
		if (!parsed.ok) throw new Error('Invalid installation configuration.');
		const config = parsed.config;
		if (config.deployment.projectName !== name)
			throw new Error('The instance name must match the selected installation settings.');
		if (input.automaticPorts !== undefined && typeof input.automaticPorts !== 'boolean')
			throw new Error('Invalid automatic port choice.');
		return {
			kind: 'directory',
			name,
			directory,
			config,
			automaticPorts: input.automaticPorts as boolean | undefined
		};
	}
	if (input.kind !== 'azure-container-apps') throw new Error('Choose an installation provider.');
	if (!/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(name) || name.includes('--'))
		throw new Error('Azure app names need 2–32 lowercase letters, digits or single hyphens.');
	const location = text(input.location, 'an Azure region');
	if (!/^[a-z0-9]+$/.test(location)) throw new Error('Use the Azure region identifier.');
	const environment = record(input.environment),
		storage = record(input.storage);
	const environmentName = text(environment.name, 'an environment name'),
		storageName = text(storage.name, 'a storage account name');
	if (
		!/^[a-zA-Z][a-zA-Z0-9-]{1,59}$/.test(environmentName) ||
		!/^[a-z0-9]{3,24}$/.test(storageName) ||
		typeof environment.create !== 'boolean' ||
		typeof storage.create !== 'boolean'
	)
		throw new Error('Choose or name the environment and storage account.');
	const timezone = text(input.timezone, 'a timezone');
	if (!validTimezone(timezone)) throw new Error('Choose a valid timezone.');
	const settings = parseDeploymentPatch({
		availability: input.availability,
		cpu: input.cpu,
		memory: input.memory,
		image: input.image
	});
	if (!settings.availability) throw new Error('Choose availability.');
	const mounts = input.mounts === undefined ? [] : input.mounts;
	if (!Array.isArray(mounts)) throw new Error('Provide independent mounts as a list.');
	return {
		kind: input.kind,
		name,
		location,
		environment: { name: environmentName, create: environment.create },
		storage: { name: storageName, create: storage.create },
		timezone,
		availability: settings.availability,
		cpu: settings.cpu,
		memory: settings.memory,
		image: settings.image,
		mounts: mounts.map((value) => {
			const item = record(value),
				storageName = text(item.storageName, 'an environment storage name'),
				mountPath = text(item.mountPath, 'a mount path');
			if (
				!/^[\w-]+$/.test(storageName) ||
				!mountPath.startsWith('/') ||
				mountPath === '/' ||
				mountPath.endsWith('/') ||
				mountPath.split('/').some((part) => part === '..' || part === '.')
			)
				throw new Error('Use a named environment storage and an absolute container directory.');
			return { storageName, mountPath };
		})
	};
}

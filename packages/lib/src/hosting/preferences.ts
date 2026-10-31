import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { writeFileAtomic } from '../control-plane/foundation.js';
import {
	LOCAL_CONNECTION,
	instanceKey,
	type HostingConnection,
	type InstanceRef
} from './types.js';
import type { DeploymentOutcome, DeploymentPatch, ProvisioningResult } from '../dto/hosting.js';
import { parseDeploymentPatch, parseProvisioningRequest } from './provisioning.js';

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid hosting metadata.');
	return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value))
		throw new Error(`Provide ${label}.`);
	return value;
}
function directory(value: unknown): string {
	const path = text(value, 'an absolute instance directory');
	if (!isAbsolute(path))
		throw new Error('Instance directories must be absolute paths on their host.');
	return path;
}
export function parseHostingConnection(value: unknown): HostingConnection {
	const input = record(value);
	if (input.kind === 'local-docker' && input.id === 'local') return LOCAL_CONNECTION;
	const id = text(input.id, 'a connection name');
	if (id === 'local' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(id))
		throw new Error('Use a short lowercase connection name; local is reserved.');
	const label = input.label === undefined ? id : text(input.label, 'a connection label');
	if (input.kind === 'ssh-docker') {
		const host = text(input.host, 'an SSH host or config alias');
		if (!/^(?:[\w.-]+@)?[\w.:-]+$/.test(host) || host.startsWith('-'))
			throw new Error('Use an SSH hostname or native SSH config alias, optionally user@host.');
		const port = input.port;
		if (port !== undefined && (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535))
			throw new Error('SSH port must be 1–65535.');
		if (!Array.isArray(input.roots))
			throw new Error('Provide the remote instance root directories.');
		return {
			kind: input.kind,
			id,
			label,
			host,
			...(port === undefined ? {} : { port: Number(port) }),
			roots: input.roots.map(directory)
		};
	}
	if (input.kind === 'azure-container-apps') {
		const subscriptionId = text(input.subscriptionId, 'the Azure subscription ID');
		if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(subscriptionId))
			throw new Error('Provide the Azure subscription UUID.');
		const resourceGroup = text(input.resourceGroup, 'the Azure resource group');
		if (!/^[\w.()-]{1,90}$/.test(resourceGroup))
			throw new Error('Invalid Azure resource group name.');
		return { kind: input.kind, id, label, subscriptionId, resourceGroup };
	}
	throw new Error('Unknown hosting provider.');
}
export function parseInstanceRef(value: unknown): InstanceRef {
	const input = record(value);
	if (input.kind === 'local-docker' && input.connectionId === 'local')
		return { kind: input.kind, connectionId: 'local', homeDir: directory(input.homeDir) };
	const connectionId = text(input.connectionId, 'a connection name');
	if (input.kind === 'ssh-docker')
		return { kind: input.kind, connectionId, remoteHome: directory(input.remoteHome) };
	if (input.kind === 'azure-container-apps') {
		const resourceId = text(input.resourceId, 'a Container App resource ID');
		if (
			!/^\/subscriptions\/[\da-f-]+\/resourceGroups\/[\w.()-]+\/providers\/Microsoft\.App\/containerApps\/[\w.-]+$/i.test(
				resourceId
			)
		)
			throw new Error('Choose a Container App resource ID, not a job or arbitrary Azure resource.');
		return { kind: input.kind, connectionId, resourceId };
	}
	throw new Error('Invalid hosting instance selection.');
}

export type HostingPreferences = {
	version: 1;
	connections: HostingConnection[];
	recent: InstanceRef[];
	deployment?: Record<
		string,
		{
			draft?: DeploymentPatch;
			operation?: DeploymentOutcome;
			continuation?: string;
			resumeAfterUpdate?: boolean;
			restartPhase?: 'stop' | 'start';
		}
	>;
	installations?: ProvisioningResult[];
};
export function hostingPreferencesFile(): string {
	return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'fhold', 'hosting.json');
}
export class HostingPreferencesStore {
	constructor(readonly path = hostingPreferencesFile()) {}
	read(): HostingPreferences {
		if (!existsSync(this.path)) return { version: 1, connections: [], recent: [] };
		const input = record(JSON.parse(readFileSync(this.path, 'utf8')));
		if (input.version !== 1 || !Array.isArray(input.connections) || !Array.isArray(input.recent))
			throw new Error(
				'Could not load hosting.json. Review this host preference file; instance data was not changed.'
			);
		const connections = input.connections.map(parseHostingConnection);
		if (new Set(connections.map((item) => item.id)).size !== connections.length)
			throw new Error('Hosting connection names must be unique.');
		return {
			version: 1,
			connections,
			recent: input.recent.map(parseInstanceRef).slice(0, 20),
			...(input.deployment &&
			typeof input.deployment === 'object' &&
			!Array.isArray(input.deployment)
				? { deployment: input.deployment as HostingPreferences['deployment'] }
				: {}),
			...(Array.isArray(input.installations)
				? { installations: input.installations as ProvisioningResult[] }
				: {})
		};
	}
	connection(id: string): HostingConnection {
		if (id === 'local') return LOCAL_CONNECTION;
		const connection = this.read().connections.find((item) => item.id === id);
		if (!connection)
			throw new Error(
				`Unknown hosting connection: ${id}. Use fhold hosting list or add a connection.`
			);
		return connection;
	}
	saveConnection(value: unknown): HostingConnection {
		const connection = parseHostingConnection(value);
		const data = this.read();
		const previous = data.connections.find((item) => item.id === connection.id);
		if (previous && JSON.stringify(previous) !== JSON.stringify(connection))
			throw new Error(
				'That connection name is already used. Choose another name to avoid retargeting saved instances.'
			);
		data.connections = [
			...data.connections.filter((item) => item.id !== connection.id),
			connection
		];
		this.write(data);
		return connection;
	}
	updateConnection(id: string, value: unknown): HostingConnection {
		const previous = this.connection(id);
		const connection = parseHostingConnection(value);
		if (id === 'local' || connection.id !== id)
			throw new Error('Connection identity cannot change; edit its display name instead.');
		const data = this.read();
		data.connections = data.connections.map((item) => (item.id === id ? connection : item));
		if (connectionEndpoint(previous) !== connectionEndpoint(connection))
			this.forgetConnectionTargets(data, id);
		this.write(data);
		return connection;
	}
	removeConnection(id: string): void {
		if (id === 'local') throw new Error('This computer is always available.');
		this.connection(id);
		const data = this.read();
		data.connections = data.connections.filter((item) => item.id !== id);
		data.recent = data.recent.filter((item) => item.connectionId !== id);
		this.forgetConnectionTargets(data, id);
		this.write(data);
	}
	remember(ref: InstanceRef, imported: InstanceRef[] = []): void {
		const data = this.read();
		data.recent = [ref, ...data.recent, ...imported]
			.filter(
				(item, index, list) =>
					list.findIndex((other) => instanceKey(other) === instanceKey(item)) === index
			)
			.slice(0, 20);
		this.write(data);
	}
	deployment(ref: InstanceRef): NonNullable<HostingPreferences['deployment']>[string] {
		const entry = this.read().deployment?.[instanceKey(ref)];
		if (!entry) return {};
		try {
			const raw = record(entry),
				operation = raw.operation === undefined ? undefined : parseOutcome(raw.operation);
			if (ref.kind === 'azure-container-apps') {
				const connection = this.connection(ref.connectionId);
				if (
					connection.kind !== ref.kind ||
					!ref.resourceId
						.toLowerCase()
						.startsWith(
							`/subscriptions/${connection.subscriptionId}/resourceGroups/${connection.resourceGroup}/providers/Microsoft.App/containerApps/`.toLowerCase()
						)
				)
					throw new Error('Saved target scope changed.');
			}
			let continuation: string | undefined;
			if (raw.continuation !== undefined) {
				if (typeof raw.continuation !== 'string' || ref.kind !== 'azure-container-apps')
					throw new Error('Invalid continuation.');
				const state = record(record(JSON.parse(raw.continuation)).state),
					config = record(state.config);
				const url = new URL(String(config.initialRequestUrl));
				if (
					url.origin !== 'https://management.azure.com' ||
					![
						ref.resourceId.toLowerCase(),
						`${ref.resourceId}/start`.toLowerCase(),
						`${ref.resourceId}/stop`.toLowerCase()
					].includes(url.pathname.toLowerCase())
				)
					throw new Error('Continuation target mismatch.');
				for (const key of ['operationLocation', 'resourceLocation'])
					if (config[key]) {
						const location = new URL(String(config[key]));
						if (
							location.origin !== url.origin ||
							!location.pathname
								.toLowerCase()
								.startsWith(`/subscriptions/${ref.resourceId.split('/')[2]}/`.toLowerCase())
						)
							throw new Error('Continuation scope mismatch.');
					}
				if (
					Object.keys(state).some((key) => !['config', 'status'].includes(key)) ||
					Object.keys(config).some(
						(key) =>
							![
								'initialRequestUrl',
								'requestMethod',
								'operationLocation',
								'resourceLocation',
								'metadata'
							].includes(key)
					)
				)
					throw new Error('Invalid continuation fields.');
				if (config.metadata !== undefined) {
					const metadata = record(config.metadata);
					if (
						Object.keys(metadata).some(
							(key) => !['mode', 'resourceLocationConfig'].includes(key)
						) ||
						(metadata.mode !== undefined &&
							!['OperationLocation', 'ResourceLocation', 'Body'].includes(String(metadata.mode)))
					)
						throw new Error('Invalid continuation metadata.');
				}
				if (!['POST', 'PATCH'].includes(String(config.requestMethod).toUpperCase()))
					throw new Error('Invalid continuation method.');
				continuation = raw.continuation;
			}
			return {
				...(raw.draft ? { draft: parseDeploymentPatch(raw.draft) } : {}),
				operation,
				continuation,
				resumeAfterUpdate:
					typeof raw.resumeAfterUpdate === 'boolean' ? raw.resumeAfterUpdate : undefined,
				restartPhase:
					raw.restartPhase === 'stop' || raw.restartPhase === 'start' ? raw.restartPhase : undefined
			};
		} catch {
			throw new Error(
				'This target’s saved deployment draft/continuation is invalid. Review its private hosting preferences; no deployment action was submitted.'
			);
		}
	}
	saveDeployment(
		ref: InstanceRef,
		value: NonNullable<HostingPreferences['deployment']>[string]
	): void {
		const data = this.read();
		data.deployment = { ...data.deployment, [instanceKey(ref)]: value };
		this.write(data);
	}
	installations(connectionId: string): ProvisioningResult[] {
		const connection = this.connection(connectionId);
		return (this.read().installations ?? []).flatMap((value) => {
			try {
				const item = record(value),
					ref = parseInstanceRef(item.ref),
					operation = parseOutcome(item);
				if (
					ref.connectionId !== connectionId ||
					ref.kind !== connection.kind ||
					operation.state === 'completed' ||
					!operation.reference ||
					!/^fhold-[a-z0-9-]+-[a-f0-9]{8}$/.test(operation.reference)
				)
					return [];
				if (
					ref.kind === 'azure-container-apps' &&
					connection.kind === 'azure-container-apps' &&
					!ref.resourceId
						.toLowerCase()
						.startsWith(
							`/subscriptions/${connection.subscriptionId}/resourceGroups/${connection.resourceGroup}/providers/Microsoft.App/containerApps/`.toLowerCase()
						)
				)
					return [];
				const previous = item.previousInitializationExecutions;
				const request =
					item.request === undefined ? undefined : parseProvisioningRequest(item.request);
				if (
					request &&
					(request.kind !== 'azure-container-apps' ||
						ref.kind !== 'azure-container-apps' ||
						ref.resourceId.split('/').at(-1)?.toLowerCase() !== request.name.toLowerCase())
				)
					return [];
				if (
					previous !== undefined &&
					(!Array.isArray(previous) ||
						previous.some((entry) => typeof entry !== 'string' || !/^[a-z0-9-]+$/i.test(entry)))
				)
					return [];
				return [
					{
						...operation,
						ref,
						...(previous ? { previousInitializationExecutions: previous as string[] } : {}),
						...(request?.kind === 'azure-container-apps' ? { request } : {})
					}
				];
			} catch {
				return [];
			} // One damaged optional record must not hide other connections.
		});
	}
	saveInstallation(value: ProvisioningResult): void {
		const data = this.read();
		data.installations = [
			...(data.installations ?? []).filter((item) => item?.reference !== value.reference),
			value
		];
		this.write(data);
	}
	private write(data: HostingPreferences): void {
		writeFileAtomic(this.path, `${JSON.stringify(data, null, 2)}\n`);
	}
	private forgetConnectionTargets(data: HostingPreferences, id: string): void {
		data.recent = data.recent.filter((item) => item.connectionId !== id);
		data.installations = (data.installations ?? []).filter(
			(item) => item?.ref?.connectionId !== id
		);
		data.deployment = Object.fromEntries(
			Object.entries(data.deployment ?? {}).filter(([key]) => {
				try {
					return JSON.parse(key)[1] !== id;
				} catch {
					return false;
				}
			})
		);
	}
}

function parseOutcome(value: unknown): DeploymentOutcome {
	const input = record(value);
	if (
		!['submitted', 'in-progress', 'completed', 'failed', 'unknown'].includes(String(input.state)) ||
		typeof input.step !== 'string' ||
		!/^[a-z-]+$/.test(input.step) ||
		(input.reference !== undefined && typeof input.reference !== 'string') ||
		(input.message !== undefined && typeof input.message !== 'string')
	)
		throw new Error('Invalid operation outcome.');
	return {
		state: input.state as DeploymentOutcome['state'],
		step: input.step,
		...(input.reference ? { reference: input.reference as string } : {}),
		...(input.message ? { message: input.message as string } : {})
	};
}

export function connectionEndpoint(connection: HostingConnection): string {
	return JSON.stringify(
		connection.kind === 'ssh-docker'
			? [connection.kind, connection.host, connection.port ?? null]
			: connection.kind === 'azure-container-apps'
				? [connection.kind, connection.subscriptionId, connection.resourceGroup]
				: [connection.kind]
	);
}

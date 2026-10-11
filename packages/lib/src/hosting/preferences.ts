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
		return { version: 1, connections, recent: input.recent.map(parseInstanceRef).slice(0, 20) };
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
	private write(data: HostingPreferences): void {
		writeFileAtomic(this.path, `${JSON.stringify(data, null, 2)}\n`);
	}
}

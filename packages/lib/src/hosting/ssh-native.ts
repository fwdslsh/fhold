import type { HostingConnection } from './types.js';

// Native transport primitives do not depend on the hosting adapter or its domain.
export const HOSTING_WIRE_VERSION = 1;
export const SSH_RPC_COMMAND = 'PATH="$HOME/.local/bin:$PATH" exec fhold hosting rpc';
export function sshArgs(connection: Extract<HostingConnection, { kind: 'ssh-docker' }>): string[] {
	return [
		'-o',
		'BatchMode=yes',
		'-o',
		'ConnectTimeout=10',
		...(connection.port ? ['-p', String(connection.port)] : []),
		connection.host
	];
}
export type MachineRequest = {
	version: 1;
	action: 'hello' | 'list' | 'diagnose' | 'inspect' | 'logs' | 'start' | 'stop' | 'restart';
	homeDir?: string;
	roots?: string[];
	tail?: number;
	confirmed?: boolean;
};
export type MachineResponse =
	| { version: 1; ok: true; value: unknown }
	| { version: 1; ok: false; error: string };

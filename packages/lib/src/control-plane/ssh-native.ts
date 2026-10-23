/**
 * Native SSH transport primitives shared by hosting discovery and the retained
 * management RPC. They deliberately do not import either adapter layer.
 */
export const HOSTING_WIRE_VERSION = 1;
export const SSH_RPC_COMMAND = 'PATH="$HOME/.local/bin:$PATH" exec fhold hosting rpc';

export type SshTransportConnection = { host: string; port?: number };

export function sshArgs(connection: SshTransportConnection): string[] {
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

import { execFile, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';

export type HostingProcess = (
	binary: string,
	args: string[],
	options?: { input?: string; inputFile?: string; timeoutMs?: number; env?: Record<string, string> }
) => Promise<string>;

export type HostingTerminal = (binary: string, args: string[]) => Promise<void>;
/** An explicit user action, not a background RPC or a captured login transcript. */
export const runHostingTerminal: HostingTerminal = (binary, args) =>
	new Promise((resolve, reject) => {
		const child = spawn(binary, args, {
			stdio: 'inherit',
			env: { ...process.env, AZURE_EXTENSION_USE_DYNAMIC_INSTALL: 'no' }
		});
		child.once('error', (error: NodeJS.ErrnoException) =>
			reject(new Error(hostingFailure(binary, error.code, '', '')))
		);
		child.once('exit', (code, signal) => {
			if (code === 0) resolve();
			else
				reject(
					new Error(`${binary} console exited (${signal || code}). The instance was not stopped.`)
				);
		});
	});

export function hostingFailure(
	binary: string,
	code: unknown,
	_stdout: string,
	stderr: string
): string {
	if (code === 'ENOENT')
		return `${binary} is not installed on this computer. Install it using its native setup instructions.`;
	if (binary === 'ssh') {
		if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr))
			return 'SSH host trust needs review. Run ssh <host> in a terminal and verify the host key before reconnecting.';
		if (/Permission denied|Authentication failed/i.test(stderr))
			return 'SSH sign-in failed. Verify this host with ssh <host> in a terminal; fhold uses your native SSH keys and configuration.';
	}
	if (binary === 'az') {
		if (/az login|AADSTS|expired|AuthenticationFailed|InvalidAuthenticationToken/i.test(stderr))
			return 'Azure sign-in needs attention. Sign in again from Host connections, or run az login on this computer.';
		if (/AuthorizationFailed|Forbidden|does not have authorization/i.test(stderr))
			return 'Your Azure account does not have permission for this operation in the selected subscription/resource group.';
		if (/ResourceGroupNotFound|ResourceNotFound/i.test(stderr))
			return 'The selected Azure resource was not found. Check the subscription and resource group in this connection.';
		if (/extension|unrecognized arguments|not in the.*command group/i.test(stderr))
			return 'Your Azure CLI does not support this Container Apps command. Update Azure CLI and its containerapp extension using the native installer.';
	}
	return `${binary} could not complete the hosting request. Check native sign-in, connectivity and permissions; no automatic retry or credential change was made.`;
}

/** Native host credentials stay with ssh/az. Never log their raw output on failure. */
export const runHostingProcess: HostingProcess = (binary, args, options = {}) =>
	new Promise((resolve, reject) => {
		const child = execFile(
			binary,
			args,
			{
				timeout: options.timeoutMs ?? 30_000,
				maxBuffer: 4 * 1024 * 1024,
				env: options.env ? { ...process.env, ...options.env } : process.env
			},
			(error, stdout, stderr) => {
				if (error)
					reject(new Error(hostingFailure(binary, error.code, String(stdout), String(stderr))));
				else resolve(String(stdout));
			}
		);
		child.stdin?.on('error', () => {
			/* process completion reports failure */
		});
		if (options.inputFile && child.stdin) {
			const stream = createReadStream(options.inputFile);
			child.once('close', () => stream.destroy());
			stream.on('error', (error) => {
				child.kill();
				reject(error);
			});
			stream.pipe(child.stdin);
		} else child.stdin?.end(options.input);
	});

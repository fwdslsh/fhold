import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';

export type HostingProcess = (
	binary: string,
	args: string[],
	options?: { input?: string; inputFile?: string; timeoutMs?: number }
) => Promise<string>;

export function hostingFailure(
	binary: string,
	code: unknown,
	stdout: string,
	stderr: string
): string {
	if (code === 'ENOENT')
		return `${binary} is not installed on this computer. Install it using its native setup instructions.`;
	if (binary === 'ssh') {
		if (
			/Unknown command: hosting|(?:exec:|sh:|bash:).*fhold.*not found/i.test(`${stderr}\n${stdout}`)
		)
			return 'The remote fhold CLI is missing or too old. Use Check connection, then Repair remote CLI (or fhold hosting repair <connection> --confirm).';
		if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr))
			return 'SSH host trust needs review. Run ssh <host> in a terminal and verify the host key before reconnecting.';
		if (/Permission denied|Authentication failed/i.test(stderr))
			return 'SSH sign-in failed. Verify this host with ssh <host> in a terminal; fhold uses your native SSH keys and configuration.';
	}
	return `${binary} could not complete the hosting request. Check native sign-in, connectivity and permissions; no automatic retry or credential change was made.`;
}

/** Native host credentials stay with ssh/az. Never log their raw output on failure. */
export const runHostingProcess: HostingProcess = (binary, args, options = {}) =>
	new Promise((resolve, reject) => {
		const child = execFile(
			binary,
			args,
			{ timeout: options.timeoutMs ?? 30_000, maxBuffer: 4 * 1024 * 1024 },
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

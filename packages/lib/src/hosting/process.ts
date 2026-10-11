import { execFile } from 'node:child_process';

export type HostingProcess = (
	binary: string,
	args: string[],
	options?: { input?: string; timeoutMs?: number }
) => Promise<string>;

/** Native host credentials stay with ssh/az. Never log their raw output on failure. */
export const runHostingProcess: HostingProcess = (binary, args, options = {}) =>
	new Promise((resolve, reject) => {
		const child = execFile(
			binary,
			args,
			{ timeout: options.timeoutMs ?? 30_000, maxBuffer: 4 * 1024 * 1024 },
			(error, stdout) => {
				if (error)
					reject(
						new Error(
							error.code === 'ENOENT'
								? `${binary} is not installed on this computer. Install it using its native setup instructions.`
								: `${binary} could not complete the hosting request. Check native sign-in, connectivity and permissions; no automatic retry or credential change was made.`
						)
					);
				else resolve(String(stdout));
			}
		);
		child.stdin?.on('error', () => {
			/* process completion reports failure */
		});
		child.stdin?.end(options.input);
	});

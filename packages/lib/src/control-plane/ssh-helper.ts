import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sshArgs, type SshTransportConnection } from './ssh-native.js';
import { runHostingProcess, type HostingProcess } from './process.js';

export type HelperArchitecture = 'x64' | 'arm64';
let resource: ((arch: HelperArchitecture) => Promise<Uint8Array>) | undefined;
const loaded = new Map<HelperArchitecture, Promise<{ bytes: Uint8Array; digest: string }>>();

/** Set only by the distribution entrypoint; never by remote connection metadata. */
export function configureSshHelperResources(
	read: (arch: HelperArchitecture) => Promise<Uint8Array>
): void {
	resource = read;
	loaded.clear();
}

export function configureSshHelperDirectory(directory: string): void {
	configureSshHelperResources(async (arch) => readFileSync(join(directory, `fhold-linux-${arch}`)));
}

/** Only fixed source and SHA-256 hex enter the remote shell; paths remain quoted. */
export async function resolveSshHelper(
	connection: SshTransportConnection,
	run: HostingProcess = runHostingProcess
): Promise<string> {
	if (!resource)
		throw new Error(
			'SSH management resources are unavailable. Build or reinstall this CLI/Admin distribution; no remote command was run.'
		);
	const platform = (await run('ssh', [...sshArgs(connection), 'uname -sm'])).trim();
	const arch =
		platform === 'Linux x86_64'
			? 'x64'
			: /^Linux (?:aarch64|arm64)$/.test(platform)
				? 'arm64'
				: undefined;
	if (!arch) throw new Error('SSH management supports Linux x64 and arm64 hosts only.');
	let artifact = loaded.get(arch);
	if (!artifact) {
		artifact = resource(arch).then((bytes) => ({
			bytes,
			digest: createHash('sha256').update(bytes).digest('hex')
		}));
		loaded.set(arch, artifact);
		artifact.catch(() => loaded.delete(arch));
	}
	const { bytes, digest } = await artifact.catch(() => {
		throw new Error(
			'This distribution’s SSH management resource could not be read. Rebuild with build:helpers or reinstall CLI/Admin. No instance operation was submitted.'
		);
	});
	const root = `"\${XDG_CACHE_HOME:-$HOME/.cache}/fhold/management/${digest}"`;
	const executable = `${root}/fhold`;
	const verify = `test -f ${executable} && test -x ${executable} && actual=$(sha256sum -- ${executable}) && test "\${actual%% *}" = '${digest}' && ${executable} --version >/dev/null`;
	const hit = await run('ssh', [...sshArgs(connection), `if ${verify}; then printf ready; fi`]);
	if (hit !== 'ready') {
		const work = mkdtempSync(join(tmpdir(), 'fhold-management-'));
		try {
			const artifact = join(work, 'helper');
			writeFileSync(artifact, bytes, { mode: 0o600, flag: 'wx' });
			try {
				await run(
					'ssh',
					[
						...sshArgs(connection),
						`set -eu; umask 077; mkdir -p ${root}; stage=$(mktemp ${root}/.transfer.XXXXXX); trap 'rm -f -- "$stage"' EXIT HUP INT TERM; cat > "$stage"; actual=$(sha256sum -- "$stage"); test "\${actual%% *}" = '${digest}'; chmod 700 "$stage"; "$stage" --version >/dev/null; mv -f -- "$stage" ${executable}`
					],
					{ inputFile: artifact, timeoutMs: 180_000 }
				);
			} catch (error) {
				throw new Error(
					`SSH management helper preparation failed. Check native SSH connectivity and permission to write and execute files in the remote cache. No instance operation was submitted. ${error instanceof Error ? error.message : ''}`
				);
			}
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}
	return executable;
}

export async function sshHelperCommand(
	connection: SshTransportConnection,
	mode: 'rpc' | 'session' | 'command',
	run?: HostingProcess
): Promise<string> {
	return `exec ${await resolveSshHelper(connection, run)} hosting ${mode}`;
}

export type SshHelperResolver = (mode: 'rpc' | 'session' | 'command') => Promise<string>;

/** One adapter owns one preparation, not a global cache of remote connections. */
export function createSshHelperResolver(
	connection: SshTransportConnection,
	run?: HostingProcess
): SshHelperResolver {
	let prepared: Promise<string> | undefined;
	return async (mode) => {
		prepared ??= resolveSshHelper(connection, run).catch((error) => {
			prepared = undefined;
			throw error;
		});
		return `exec ${await prepared} hosting ${mode}`;
	};
}

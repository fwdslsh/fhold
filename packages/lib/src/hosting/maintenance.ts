import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FH_RELEASE_VERSION } from '../control-plane/release.js';
import { localDockerProvider } from './local-docker.js';
import { azureContainerAppsProvider } from './azure-container-apps.js';
import { runHostingProcess, type HostingProcess } from './process.js';
import { sshArgs, SSH_RPC_COMMAND, HOSTING_WIRE_VERSION, sshDockerProvider } from './ssh-docker.js';
import type { HostingConnection, InstanceSummary } from './types.js';

export type ConnectionCheck = {
	ok: boolean;
	repairable: boolean;
	checks: Array<{ name: string; ok: boolean; detail: string }>;
	instances: InstanceSummary[];
};
export async function checkHostingConnection(
	connection: HostingConnection,
	run: HostingProcess = runHostingProcess
): Promise<ConnectionCheck> {
	const result: ConnectionCheck = { ok: false, repairable: false, checks: [], instances: [] };
	const parseResponse = (raw: string): unknown => {
		try {
			return JSON.parse(raw);
		} catch {
			throw new Error(
				'The remote CLI returned unexpected output. Repair the CLI, and keep shell startup messages off stdout.'
			);
		}
	};
	try {
		if (connection.kind === 'ssh-docker') {
			const platform = (await run('ssh', [...sshArgs(connection), 'uname -sm'])).trim();
			result.checks.push({
				name: 'SSH',
				ok: true,
				detail: `Connected to ${connection.host} (${platform}).`
			});
			result.repairable = /^Linux (?:x86_64|aarch64|arm64)$/.test(platform);
			const raw = await run('ssh', [...sshArgs(connection), SSH_RPC_COMMAND], {
				input: JSON.stringify({ version: HOSTING_WIRE_VERSION, action: 'hello' })
			});
			const hello = parseResponse(raw) as {
				version?: number;
				ok?: boolean;
				value?: { actions?: string[]; release?: string; management?: string[] };
			};
			if (
				hello.version !== HOSTING_WIRE_VERSION ||
				hello.ok !== true ||
				!Array.isArray(hello.value?.actions) ||
				!hello.value.actions.includes('list')
			)
				throw new Error(
					'Remote CLI lacks compatible hosting support. Repair remote CLI to update it.'
				);
			result.checks.push({
				name: 'Remote CLI',
				ok: true,
				detail: hello.value.release || 'Compatible hosting protocol.'
			});
			const management = hello.value.management?.includes('snapshot') === true;
			result.checks.push({
				name: 'Instance management',
				ok: management,
				detail: management
					? 'Settings, apps, updates and import/export are available.'
					: 'Update the remote fhold CLI to enable full management. Discovery and supported lifecycle commands remain available.'
			});
			if (hello.value.actions.includes('diagnose')) {
				const response = parseResponse(
					await run('ssh', [...sshArgs(connection), SSH_RPC_COMMAND], {
						input: JSON.stringify({
							version: 1,
							action: 'diagnose',
							roots: connection.roots.length ? connection.roots : undefined
						})
					})
				) as { ok?: boolean; value?: { docker?: { ok: boolean; message?: string } } };
				if (response.ok && response.value?.docker)
					result.checks.push({
						name: 'Docker',
						ok: response.value.docker.ok,
						detail: response.value.docker.message || 'Docker and Compose are ready.'
					});
			}
		}
		result.instances = await (connection.kind === 'ssh-docker'
			? sshDockerProvider(connection, run)
			: connection.kind === 'azure-container-apps'
				? azureContainerAppsProvider(connection, run)
				: localDockerProvider
		).listInstances();
		result.checks.push({
			name: 'Discovery',
			ok: true,
			detail: result.instances.length
				? `Found ${result.instances.length} instance(s).`
				: 'No instances found. Add the exact home or its parent to Instance roots; stopped installations are supported.'
		});
		result.ok = result.checks.every((item) => item.ok);
	} catch (error) {
		result.checks.push({
			name: result.checks.length ? 'Remote CLI / discovery' : 'Connection',
			ok: false,
			detail: error instanceof Error ? error.message : 'Connection check failed.'
		});
	}
	return result;
}

/** Explicit host-tool repair, not provisioning: no sudo, shell config, Docker or instance writes. */
export async function repairSshCli(
	connection: HostingConnection,
	options: { confirmed: boolean; cliFile?: string; run?: HostingProcess; fetch?: typeof fetch }
): Promise<string> {
	if (!options.confirmed)
		throw new Error(
			'Confirm remote CLI installation before continuing. Running instances will not be changed.'
		);
	if (connection.kind !== 'ssh-docker')
		throw new Error('Remote CLI repair is available for SSH Docker connections only.');
	const run = options.run ?? runHostingProcess;
	const platform = (await run('ssh', [...sshArgs(connection), 'uname -sm'])).trim();
	const arch = /^Linux x86_64$/.test(platform)
		? 'x64'
		: /^Linux (?:aarch64|arm64)$/.test(platform)
			? 'arm64'
			: undefined;
	if (!arch)
		throw new Error('Automatic remote CLI installation currently supports Linux x64/arm64 only.');
	const work = mkdtempSync(join(tmpdir(), 'fhold-cli-repair-'));
	try {
		let artifact = options.cliFile;
		let expected: string | undefined;
		if (!artifact) {
			const request = options.fetch ?? fetch;
			const base = `https://github.com/fwdslsh/fhold/releases/download/${FH_RELEASE_VERSION}`;
			const filename = `fhold-cli-linux-${arch}`;
			const checksums = await request(`${base}/checksums-sha256.txt`, {
				signal: AbortSignal.timeout(30_000)
			});
			if (!checksums.ok)
				throw new Error(
					'This tooling release is not available for download. Publish it first, or use fhold hosting repair --cli-file with a trusted Linux CLI build.'
				);
			expected = (await checksums.text())
				.split('\n')
				.map((line) => /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line))
				.find((match) => match?.[2] === filename)?.[1];
			if (!expected) throw new Error('Published CLI checksum is missing.');
			const download = await request(`${base}/${filename}`, {
				signal: AbortSignal.timeout(180_000)
			});
			if (!download.ok || !download.body) throw new Error('Could not download the remote CLI.');
			artifact = join(work, filename);
			const reader = download.body.getReader();
			const chunks = async function* () {
				try {
					for (;;) {
						const next = await reader.read();
						if (next.done) return;
						yield next.value;
					}
				} finally {
					reader.releaseLock();
				}
			};
			await pipeline(
				Readable.from(chunks()),
				createWriteStream(artifact, { mode: 0o600, flags: 'wx' })
			);
		}
		const hash = createHash('sha256');
		for await (const chunk of createReadStream(artifact)) hash.update(chunk);
		const digest = hash.digest('hex');
		if (expected && digest !== expected)
			throw new Error('CLI download checksum mismatch; the remote binary was not changed.');
		// All interpolated values are fixed or SHA-256 hex. Host/paths never enter shell source.
		const command = `set -eu; mkdir -p "$HOME/.local/bin"; stage=$(mktemp "$HOME/.local/bin/.fhold.XXXXXX"); trap 'rm -f -- "$stage"' EXIT; cat > "$stage"; actual=$(sha256sum -- "$stage"); test "\${actual%% *}" = '${digest}'; chmod 755 "$stage"; "$stage" --version; "$stage" hosting --help >/dev/null; mv -f -- "$stage" "$HOME/.local/bin/fhold"`;
		const version = (
			await run('ssh', [...sshArgs(connection), command], {
				inputFile: artifact,
				timeoutMs: 180_000
			})
		).trim();
		return `Installed remote fhold CLI ${version} in ~/.local/bin/fhold. No containers or instance files were changed.`;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

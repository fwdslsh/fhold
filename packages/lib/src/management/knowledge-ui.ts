import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { get } from 'node:http';
import { isIP } from 'node:net';
import { buildComposeOptions } from '../control-plane/compose.js';
import {
	assertProjectOwnership,
	composePs,
	parseComposePsRows,
	runDocker,
	spawnDocker
} from '../control-plane/docker.js';
import { createFholdState } from '../control-plane/foundation.js';
import { readStackConfig } from '../control-plane/stack-config.js';
import { requireInstall } from '../control-plane/state.js';

// stdin is the management session's lifetime. EOF (including SSH disconnect)
// stops only this native UI child. No detached daemon, PID file or startup edit.
const UI_COMMAND =
	'command -v "$1" >/dev/null || exit 127; "$@" & pid=$!; trap \'kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null\' EXIT; read -r _';

/** Explicit, session-owned access to the selected Linux Docker Assistant's AKM. */
export class KnowledgeUi {
	private child?: ChildProcessWithoutNullStreams;
	private opening?: Promise<{ url: string }>;
	private closed = false;
	private url?: string;
	private origin?: string;
	constructor(private readonly homeDir: string) {}

	async open(input?: { loopbackPort: number }): Promise<{ url: string }> {
		if (this.closed) throw new Error('This instance session is closed. Open it again.');
		if (this.opening) return this.opening;
		this.opening = this.start(input);
		try {
			return await this.opening;
		} finally {
			this.opening = undefined;
		}
	}

	private async start(input?: { loopbackPort: number }): Promise<{ url: string }> {
		if (this.child && this.url) {
			try {
				await this.probe(new URL(this.url));
				return { url: this.url };
			} catch {
				await this.stop();
			}
		}
		requireInstall(this.homeDir);
		const config = readStackConfig(this.homeDir);
		if (!config.ok) throw new Error(config.error);
		const options = buildComposeOptions(createFholdState(this.homeDir));
		await assertProjectOwnership(config.config.deployment.projectName, options.projectDirectory);
		const result = await composePs(options);
		const assistants = result.ok
			? parseComposePsRows(result.stdout).filter(
					(row) => row.service === 'assistant' && row.state === 'running' && row.id
				)
			: [];
		if (assistants.length !== 1)
			throw new Error('Start this Assistant before opening its knowledge.');
		const id = assistants[0]!.id;
		const inspected = await runDocker([
			'inspect',
			'--format',
			'{{json .NetworkSettings.Networks}}',
			id
		]);
		let address: string | undefined;
		try {
			const networks = JSON.parse(inspected.stdout) as Record<
				string,
				{ IPAddress?: string; NetworkID?: string }
			>;
			for (const network of Object.values(networks)) {
				if (!network.IPAddress || isIP(network.IPAddress) !== 4 || !network.NetworkID) continue;
				const driver = await runDocker([
					'network',
					'inspect',
					'--format',
					'{{.Driver}}',
					network.NetworkID
				]);
				if (driver.ok && driver.stdout.trim() === 'bridge') {
					address = network.IPAddress;
					break;
				}
			}
		} catch {
			/* Report unsupported reachability without disclosing private Docker output. */
		}
		if (!inspected.ok || !address)
			throw new Error(
				'AKM UI requires a reachable Linux Docker bridge. Host-network and Docker Desktop instances are not supported.'
			);
		if (this.closed) throw new Error('This instance session is closed. Open it again.');
		const browserOrigin = input ? `http://127.0.0.1:${input.loopbackPort}` : undefined;
		const child = await spawnDocker([
			'exec',
			'-i',
			id,
			'sh',
			'-c',
			UI_COMMAND,
			'sh',
			'akm-web',
			'--host',
			address,
			...(input && browserOrigin
				? ['--port', String(input.loopbackPort), '--origin', browserOrigin]
				: [])
		]);
		this.child = child;
		child.stdin.on('error', () => {
			/* Exit/startup handles the failure. */
		});
		child.once('close', () => {
			if (this.child === child) {
				this.child = undefined;
				this.url = undefined;
			}
		});
		try {
			const native = await new Promise<URL>((resolve, reject) => {
				let output = '';
				const timer = setTimeout(
					() =>
						reject(
							new Error(
								'AKM UI did not start. Update the Assistant to an image containing akm-web.'
							)
						),
					15_000
				);
				const fail = () => {
					clearTimeout(timer);
					reject(
						new Error('AKM UI exited before it was ready. Check this Assistant’s AKM installation.')
					);
				};
				child.once('error', fail);
				child.once('close', fail);
				// Drain private native diagnostics without forwarding them to Admin.
				child.stderr.resume();
				child.stdout.on('data', (chunk) => {
					output = (output + String(chunk)).slice(-8192);
					const lines = output.split('\n');
					output = lines.pop() ?? '';
					for (const line of lines) {
						try {
							const ready = JSON.parse(line);
							if (ready.type !== 'ready') continue;
							const url = new URL(ready.url);
							if (
								url.protocol !== 'http:' ||
								url.hostname !== (input ? '127.0.0.1' : address) ||
								(input && url.origin !== browserOrigin) ||
								ready.origin !== url.origin ||
								!url.port ||
								url.pathname !== '/' ||
								!url.searchParams.get('desktop_session') ||
								url.username ||
								url.password
							)
								continue;
							clearTimeout(timer);
							this.origin = url.origin;
							resolve(url);
							return;
						} catch {
							/* Wait for complete native output. */
						}
					}
				});
			});
			native.hostname = address;
			// Preserve AKM's port, token, Host and Origin checks. Native Docker's
			// bridge is host-reachable; no container ports are published or changed.
			await this.probe(native);
			if (this.closed || this.child !== child) throw new Error('Closed');
			this.url = native.href;
			return { url: this.url };
		} catch {
			await this.stop();
			throw new Error(
				'Could not open this Assistant’s AKM UI. Update to an image containing akm-web and check the host-reachable Linux Docker bridge; Docker Desktop is not supported.'
			);
		}
	}

	private async probe(native: URL): Promise<void> {
		if (!this.origin) throw new Error('AKM UI is unavailable.');
		const host = new URL(this.origin).host;
		// Probe the native session bootstrap at its configured browser origin,
		// connecting directly to the bridge before the SSH forward is opened.
		await new Promise<void>((resolve, reject) => {
			const request = get(
				native,
				{
					headers: { Host: host },
					signal: AbortSignal.timeout(5_000)
				},
				(response) => {
					response.resume();
					if (response.statusCode !== 200 || !response.headers['set-cookie'] || this.closed)
						reject(new Error('AKM UI is unavailable.'));
					else resolve();
				}
			);
			request.once('error', reject);
		});
	}

	private async stop(): Promise<void> {
		const child = this.child;
		this.url = undefined;
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		await new Promise<void>((resolve) => {
			child.once('close', () => {
				clearTimeout(timer);
				resolve();
			});
			const timer = setTimeout(() => {
				child.kill('SIGTERM');
				resolve();
			}, 5_000);
			child.stdin.end();
		});
		if (this.child === child) this.child = undefined;
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.opening?.catch(() => {});
		await this.stop();
	}
}

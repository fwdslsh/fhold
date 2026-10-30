import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';

import { readEnvFile } from './foundation.js';

export type DockerResult = {
	ok: boolean;
	stdout: string;
	stderr: string;
	code: number;
};

export type ComposeOptions = {
	projectDirectory?: string;
	files: string[];
	envFiles: string[];
	profiles: string[];
};

export type ComposePsRow = {
	service: string;
	image?: string;
	state: string;
	health: string;
	id: string;
	exitCode: number | null;
};

function dockerBin(): string {
	return process.env.FH_DOCKER_BIN?.trim() || 'docker';
}

/** An attached native command, using the same verified Docker endpoint as bounded calls. */
export async function spawnDocker(args: string[]) {
	return spawn(dockerBin(), args, {
		env: await dockerEnvironment(process.env),
		stdio: 'pipe'
	});
}

const dockerOutput = new AsyncLocalStorage<'stderr'>();
/** Machine requests reserve stdout for their JSON response. */
export function withDockerMachineOutput<T>(operation: () => Promise<T>): Promise<T> {
	return dockerOutput.run('stderr', operation);
}

export function localDockerEndpoint(endpoint: string): string {
	if (!/^(unix:\/\/\/|npipe:\/\/)/.test(endpoint))
		throw new Error('This Docker endpoint is remote. Select an SSH hosting connection instead; local instance folders cannot be mounted by a remote Docker daemon.');
	return endpoint;
}

async function dockerEnvironment(parent: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
	// Explicit alternate binaries own their transport (including test fixtures).
	if (dockerBin() !== 'docker') return parent;
	let endpoint = parent.DOCKER_CONTEXT ? undefined : parent.DOCKER_HOST;
	if (!endpoint) endpoint = await new Promise<string>((resolve, reject) => {
		execFile('docker', ['context', 'inspect', ...(parent.DOCKER_CONTEXT ? [parent.DOCKER_CONTEXT] : []), '--format', '{{.Endpoints.docker.Host}}'], { env: parent, timeout: 10_000 }, (error, stdout) => {
			if (error) reject(new Error('Could not resolve the local Docker context. Check your native Docker installation and context.'));
			else resolve(stdout.trim());
		});
	});
	// Pin the verified endpoint for this process invocation, not a global context
	// switch. Docker Desktop and rootless Unix sockets remain supported.
	const environment: NodeJS.ProcessEnv = { ...parent, DOCKER_HOST: localDockerEndpoint(endpoint) };
	delete environment.DOCKER_CONTEXT;
	return environment;
}

function stackEnvOverrides(files: string[]): Record<string, string> {
	const values: Record<string, string> = {};
	for (const path of files) Object.assign(values, readEnvFile(path));
	const allowed: Record<string, string> = {};
	for (const [key, value] of Object.entries(values)) {
		if (/^(?:FH_|GUARDIAN_|DISCORD_|SLACK_)/.test(key)) allowed[key] = value;
	}
	return allowed;
}

/**
 * Keep Compose interpolation identical between preflight and activation while
 * refusing process-control variables (for example DOCKER_HOST or PATH) from
 * state/stack.env. Arbitrary custom variables still work through --env-file;
 * they simply cannot reconfigure the host process running Docker.
 */
export function composeProcessEnvironment(
	files: string[],
	parent: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
	return { ...parent, ...stackEnvOverrides(files) };
}

function friendlyError(stderr: string): string {
	const value = stderr.trim();
	if (/\bENOENT\b|spawn\s+docker\s+.*not found/i.test(value)) {
		return 'Docker is not installed or is not on PATH.';
	}
	if (/permission denied/i.test(value))
		return 'Docker access was denied. Check daemon permissions.';
	if (/cannot connect|daemon is not running|connection refused/i.test(value)) {
		return 'Docker is stopped or unreachable.';
	}
	if (/address already in use|port is already allocated/i.test(value)) {
		return 'A configured port is already in use.';
	}
	return value.split(/\r?\n/).find(Boolean) || 'Docker command failed.';
}

export async function runDocker(
	args: string[],
	options: {
		timeoutMs?: number;
		maxOutputBytes?: number;
		env?: NodeJS.ProcessEnv;
		input?: string;
	} = {}
): Promise<DockerResult> {
	let environment: NodeJS.ProcessEnv;
	try { environment = await dockerEnvironment({ ...process.env, ...options.env }); }
	catch (error) { return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error), code: 1 }; }
	return new Promise((resolve) => {
		const child = execFile(
			dockerBin(),
			args,
			{
				timeout: options.timeoutMs ?? 120_000,
				maxBuffer: options.maxOutputBytes ?? 1024 * 1024,
				env: environment
			},
			(error, stdout, stderr) => {
				const detail = stderr?.toString() || (error ? String(error) : '');
				resolve({
					ok: !error,
					stdout: stdout?.toString() ?? '',
					stderr: detail,
					code:
						typeof (error as NodeJS.ErrnoException | null)?.code === 'number'
							? Number((error as NodeJS.ErrnoException).code)
							: error
								? 1
								: 0
				});
			}
		);
		// Keep optional private input out of command arguments and process listings.
		child.stdin?.on('error', () => {
			/* exit is reported by execFile */
		});
		child.stdin?.end(options.input);
	});
}

export async function ensureDockerReady(): Promise<{ ok: true } | { ok: false; message: string }> {
	const daemon = await runDocker(['info', '--format', '{{json .ServerVersion}}'], {
		timeoutMs: 10_000
	});
	if (!daemon.ok) return { ok: false, message: friendlyError(daemon.stderr) };
	const compose = await runDocker(['compose', 'version'], { timeoutMs: 10_000 });
	return compose.ok ? { ok: true } : { ok: false, message: friendlyError(compose.stderr) };
}

/** An explicit name must never select containers belonging to a different home. */
export async function assertProjectOwnership(
	projectName: string,
	projectDirectory?: string
): Promise<void> {
	const existing = await runDocker(
		[
			'ps',
			'-a',
			'--filter',
			`label=com.docker.compose.project=${projectName}`,
			'--format',
			'{{.ID}}'
		],
		{ timeoutMs: 10_000 }
	);
	if (!existing.ok) throw new Error(friendlyError(existing.stderr));
	const ids = existing.stdout.trim().split(/\s+/).filter(Boolean);
	if (!ids.length) return;
	if (!projectDirectory)
		throw new Error(
			`Instance name "${projectName}" is already in use. Choose a different name; nothing was changed.`
		);
	const inspection = await runDocker(['inspect', '--format', '{{json .Config.Labels}}', ...ids], {
		timeoutMs: 10_000
	});
	if (!inspection.ok) throw new Error(friendlyError(inspection.stderr));
	const labels = inspection.stdout.trim().split(/\r?\n/);
	if (labels.length !== ids.length)
		throw new Error('Could not verify which folder owns these containers.');
	for (const row of labels) {
		let value: unknown;
		try {
			value = JSON.parse(row);
		} catch {
			throw new Error('Could not verify which folder owns these containers.');
		}
		if (
			!value ||
			typeof value !== 'object' ||
			Array.isArray(value) ||
			!('com.docker.compose.project.working_dir' in value) ||
			value['com.docker.compose.project.working_dir'] !== projectDirectory
		) {
			throw new Error(
				`Instance name "${projectName}" belongs to another folder. Choose a different name for this instance; its containers were not changed.`
			);
		}
	}
}

export function buildComposeArgs(options: ComposeOptions): string[] {
	const args = ['--project-name', composeProjectName(options)];
	if (options.projectDirectory) args.push('--project-directory', options.projectDirectory);
	for (const file of options.files) args.push('-f', file);
	for (const file of options.envFiles) {
		if (existsSync(file)) args.push('--env-file', file);
	}
	for (const profile of options.profiles) args.push('--profile', profile);
	return args;
}

export function composeProjectName(
	options: ComposeOptions,
	parent: NodeJS.ProcessEnv = process.env
): string {
	const env = stackEnvOverrides(options.envFiles);
	return env.FH_PROJECT_NAME || parent.FH_PROJECT_NAME || 'fhold';
}

export async function composePreflight(options: ComposeOptions): Promise<DockerResult> {
	return runDocker(['compose', ...buildComposeArgs(options), 'config', '--quiet'], {
		timeoutMs: 30_000,
		env: composeProcessEnvironment(options.envFiles)
	});
}

export async function composeConfigJson(
	options: ComposeOptions
): Promise<
	{ ok: true; config: unknown; stderr: '' } | { ok: false; config: null; stderr: string }
> {
	const result = await runDocker(
		['compose', ...buildComposeArgs(options), 'config', '--format', 'json'],
		{ timeoutMs: 30_000, env: composeProcessEnvironment(options.envFiles) }
	);
	if (!result.ok) return { ok: false, config: null, stderr: result.stderr };
	try {
		return { ok: true, config: JSON.parse(result.stdout) as unknown, stderr: '' };
	} catch (error) {
		return { ok: false, config: null, stderr: `Invalid Compose JSON: ${String(error)}` };
	}
}

export async function runComposeStreaming(
	args: string[],
	options: { envFiles?: string[] } = {}
): Promise<void> {
	const projectIndex = args.indexOf('--project-name');
	const directoryIndex = args.indexOf('--project-directory');
	if (projectIndex >= 0 && directoryIndex >= 0)
		await assertProjectOwnership(args[projectIndex + 1], args[directoryIndex + 1]);
	const environment = await dockerEnvironment(composeProcessEnvironment(options.envFiles ?? []));
	const output = dockerOutput.getStore() === 'stderr' ? process.stderr : process.stdout;
	return new Promise((resolve, reject) => {
		const child = spawn(dockerBin(), ['compose', ...args], {
			stdio: ['inherit', 'pipe', 'pipe'],
			env: environment
		});
		child.stdout.on('data', (chunk: Buffer) => output.write(chunk));
		let stderr = '';
		child.stderr.on('data', (chunk: Buffer) => {
			process.stderr.write(chunk);
			stderr = `${stderr}${chunk.toString('utf8')}`.slice(-32_000);
		});
		child.once('error', (error) => reject(new Error(friendlyError(String(error)))));
		child.once('close', (code) => {
			if (code === 0) resolve();
			else reject(new Error(friendlyError(stderr)));
		});
	});
}

export function parseComposePsRows(stdout: string): ComposePsRow[] {
	const rows: ComposePsRow[] = [];
	for (const line of stdout.trim().split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			const entries = Array.isArray(parsed) ? parsed : [parsed];
			for (const raw of entries) {
				if (!raw || typeof raw !== 'object') continue;
				const item = raw as Record<string, unknown>;
				const service = String(item.Service ?? item.Name ?? '');
				if (!service) continue;
				rows.push({
					service,
					...(typeof item.Image === 'string' ? { image: item.Image } : {}),
					state: String(item.State ?? ''),
					health: String(item.Health ?? ''),
					id: String(item.ID ?? ''),
					exitCode: typeof item.ExitCode === 'number' ? item.ExitCode : null
				});
			}
		} catch {
			// Ignore non-JSON progress emitted by older Compose releases.
		}
	}
	return rows;
}

export function composePs(options: ComposeOptions): Promise<DockerResult> {
	return runDocker(['compose', ...buildComposeArgs(options), 'ps', '-a', '--format', 'json'], {
		env: composeProcessEnvironment(options.envFiles)
	});
}

/** Compose may omit Image; inspect missing references, never unapplied intent.
 * A failed inspection must not turn a successful status read into a failure.
 */
export async function completeContainerImages(rows: ComposePsRow[]): Promise<ComposePsRow[]> {
	const missing = rows.filter((row) => !row.image?.trim() && row.id);
	if (!missing.length) return rows;
	const result = await runDocker(
		['inspect', '--format', '{"id":{{json .Id}},"image":{{json .Config.Image}}}', ...missing.map((row) => row.id)],
		{ timeoutMs: 5_000 }
	);
	const images = new Map<string, string>();
	// Docker may emit valid records before a concurrent removal causes failure.
	for (const line of result.stdout.split(/\r?\n/)) {
		try {
			const value: unknown = JSON.parse(line);
			if (!value || typeof value !== 'object' || !('id' in value) || !('image' in value) ||
				typeof value.id !== 'string' || typeof value.image !== 'string' || !value.image.trim()) continue;
			for (const row of missing)
				if (value.id.startsWith(row.id)) images.set(row.id, value.image);
		} catch { /* Optional metadata never blocks management. */ }
	}
	return rows.map((row) => images.has(row.id) ? { ...row, image: images.get(row.id) } : row);
}

/** Optional-feature diagnostics never turn a successful status read into a failure. */
export async function containerWarnings(id: string): Promise<string[]> {
	const result = await runDocker(['inspect', '--format', '{{json .State.Health.Log}}', id], {
		timeoutMs: 5_000
	});
	try {
		if (!result.ok) throw new Error('Unavailable');
		const log: unknown = JSON.parse(result.stdout);
		if (!Array.isArray(log)) throw new Error('Unavailable');
		const last = log.at(-1);
		const output = last && typeof last.Output === 'string' ? last.Output : '';
		return [
			...new Set<string>(
				output
					.split(/\r?\n/)
					.filter((line: string) => line.startsWith('fhold: degraded: '))
					.map((line: string) => line.slice('fhold: degraded: '.length))
			)
		];
	} catch {
		return [
			'Optional-feature status is unavailable. Check Docker diagnostics; this does not stop the agent.'
		];
	}
}

export function composeLogs(options: ComposeOptions, tail = 250): Promise<DockerResult> {
	return runDocker(['compose', ...buildComposeArgs(options), 'logs', '--tail', String(tail)], {
		env: composeProcessEnvironment(options.envFiles)
	});
}

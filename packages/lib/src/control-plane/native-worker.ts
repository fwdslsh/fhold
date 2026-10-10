import { runDocker } from './docker.js';

export type NativeWorkerContext = {
	snapshot(source: string, destination: string): void;
	open(dataDirectory: string): Promise<void>;
	close(): Promise<void>;
	api(path: string, body?: unknown, method?: string): Promise<unknown>;
};

/** Serialized into a disposable image process, never the running assistant.
 * Standard foreground serve does not resume suspended work (managed service
 * mode does). No operator plugins, project configuration or network is loaded.
 */
export async function nativeWorker(
	job: (context: NativeWorkerContext) => Promise<void>
): Promise<void> {
	const fs = await import('node:fs');
	const { spawn } = await import('node:child_process');
	const { randomUUID } = await import('node:crypto');
	const sqlite = 'bun:sqlite';
	const { Database } = await import(sqlite);
	let child: ReturnType<typeof spawn> | undefined;
	const password = randomUUID();
	const headers = {
		authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
		'content-type': 'application/json'
	};
	const api = async (
		path: string,
		body?: unknown,
		method = body === undefined ? 'GET' : 'POST'
	): Promise<unknown> => {
		const response = await fetch(`http://127.0.0.1:4097/api${path}`, {
			method,
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(60_000)
		});
		if (!response.ok)
			throw new Error(
				`Native transfer ${method} ${path.split('?')[0]} failed (HTTP ${response.status}); private originals retained.`
			);
		if (response.status === 204) return undefined;
		return response.json();
	};
	const close = async () => {
		if (!child || child.exitCode !== null || child.signalCode) {
			child = undefined;
			return;
		}
		const running = child;
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => running.kill('SIGKILL'), 10_000);
			running.once('exit', () => {
				clearTimeout(timeout);
				resolve();
			});
			running.kill('SIGTERM');
		});
		child = undefined;
	};
	try {
		await job({
			api,
			close,
			snapshot(source, destination) {
				const stat = fs.lstatSync(source);
				if (!stat.isFile() || stat.isSymbolicLink())
					throw new Error('Native database must be a regular file.');
				let opened = source;
				if (!fs.existsSync(`${source}-wal`)) {
					opened = `/tmp/cold-${randomUUID()}.sqlite`;
					fs.copyFileSync(source, opened);
					const after = fs.lstatSync(source);
					if (
						after.size !== stat.size ||
						after.mtimeMs !== stat.mtimeMs ||
						fs.existsSync(`${source}-wal`)
					)
						throw new Error('Source changed during cold snapshot; stop it and retry.');
				}
				const db = new Database(opened, { readonly: true });
				try {
					db.run(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
				} finally {
					db.close();
				}
				fs.chmodSync(destination, 0o600);
			},
			async open(dataDirectory) {
				await close();
				fs.mkdirSync('/tmp/native-config', { recursive: true, mode: 0o700 });
				fs.writeFileSync('/tmp/native-config/opencode.json', '{}', { mode: 0o600 });
				let launchError = false;
				child = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '4097'], {
					cwd: '/tmp',
					stdio: 'ignore',
					env: {
						...process.env,
						HOME: '/tmp/native-home',
						XDG_DATA_HOME: dataDirectory,
						XDG_CONFIG_HOME: '/tmp/native-config',
						XDG_CACHE_HOME: '/tmp/native-cache',
						XDG_STATE_HOME: '/tmp/native-state',
						OPENCODE_CONFIG_DIR: '/tmp/native-config',
						OPENCODE_CONFIG: '/tmp/native-config/opencode.json',
						OPENCODE_CONFIG_CONTENT: '{}',
						OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
						OPENCODE_DISABLE_CLAUDE_CODE: 'true',
						OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
						OPENCODE_DISABLE_MODELS_FETCH: 'true',
						OPENCODE_PASSWORD: password,
						OPENCODE_SERVER_PASSWORD: password,
						GIT_CONFIG_SYSTEM: '/dev/null',
						GIT_CONFIG_GLOBAL: '/dev/null',
						GIT_CONFIG_COUNT: '2',
						GIT_CONFIG_KEY_0: 'core.fsmonitor',
						GIT_CONFIG_VALUE_0: 'false',
						GIT_CONFIG_KEY_1: 'core.hooksPath',
						GIT_CONFIG_VALUE_1: '/dev/null'
					}
				});
				child.once('error', () => {
					launchError = true;
				});
				const deadline = Date.now() + 120_000;
				while (Date.now() < deadline) {
					if (launchError || child.exitCode !== null)
						throw new Error('Native OpenCode transfer server could not start.');
					let status: { status?: string } | undefined;
					try {
						status = (await api('/experimental/migration/v1')) as { status?: string };
					} catch {
						/* startup */
					}
					if (status?.status === 'completed') return;
					if (status?.status === 'error')
						throw new Error('Native OpenCode database migration failed; source unchanged.');
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				throw new Error('Native OpenCode migration did not finish; source unchanged.');
			}
		});
	} finally {
		await close();
	}
}

export async function runNativeWorker(
	image: string,
	mounts: string[],
	job: (context: NativeWorkerContext) => Promise<void>,
	env: string[] = []
): Promise<void> {
	const result = await runDocker(
		[
			'run',
			'--rm',
			'--pull',
			'never',
			'--network',
			'none',
			'--read-only',
			'--cap-drop',
			'ALL',
			'--security-opt',
			'no-new-privileges:true',
			'--user',
			`${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
			'--tmpfs',
			'/tmp:rw,mode=1777',
			...env.flatMap((value) => ['--env', value]),
			...mounts,
			'--entrypoint',
			'bun',
			image,
			'-e',
			`(${nativeWorker.toString()})(${job.toString()}).catch((error) => { console.error(error.message); process.exit(1); });`
		],
		{ timeoutMs: 30 * 60_000 }
	);
	if (!result.ok)
		throw new Error(
			`Native transfer failed; originals retained. ${result.stderr.trim().slice(0, 1024)}`
		);
}

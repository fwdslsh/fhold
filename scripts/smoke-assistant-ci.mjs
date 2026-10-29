#!/usr/bin/env node
// Run existing black-box suites against one built image, with at most two
// concurrent suites. Each suite owns its own disposable homes and containers.
import { execFileSync, spawn } from 'node:child_process';
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeFileSync,
	appendFileSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function runLanes(lanes, { directory, signal, env = process.env } = {}) {
	if (lanes.length !== 2) throw new Error('Assistant verification requires exactly two lanes');
	const expected = lanes.flat().map((suite) => suite.name);
	if (!expected.length || new Set(expected).size !== expected.length)
		throw new Error('Assistant suite names must be nonempty and unique');
	mkdirSync(directory, { recursive: true });
	const results = [];
	async function run(suite) {
		if (signal?.aborted) throw new Error('Assistant verification cancelled');
		const started = Date.now();
		const log = join(directory, `${suite.name}.log`);
		const fd = openSync(log, 'w', 0o600);
		console.log(`START ${suite.name}`);
		const result = await new Promise((finish) => {
			const child = spawn(suite.command[0], suite.command.slice(1), {
				env: { ...env, ...suite.env },
				stdio: ['ignore', fd, fd],
				detached: true
			});
			let failure;
			let stopping;
			const stop = () => {
				if (!child.pid || stopping) return;
				try {
					process.kill(-child.pid, 'SIGTERM');
				} catch {}
				// Wait for the group, even if its leader exits first. Never orphan
				// a test subprocess while reporting cancellation as complete.
				stopping = new Promise((done) =>
					setTimeout(() => {
						try {
							process.kill(-child.pid, 'SIGKILL');
						} catch {}
						done();
					}, 2000)
				);
			};
			signal?.addEventListener('abort', stop, { once: true });
			const timeout = setTimeout(() => {
				failure = 'timed out';
				stop();
			}, suite.timeoutMs ?? 900_000);
			child.once('error', (error) => {
				failure = error.message;
			});
			child.once('close', async (code, termination) => {
				clearTimeout(timeout);
				signal?.removeEventListener('abort', stop);
				await stopping;
				closeSync(fd);
				finish({
					name: suite.name,
					code,
					signal: termination,
					error: failure,
					seconds: (Date.now() - started) / 1000,
					log,
					passed: code === 0 && !failure && !signal?.aborted
				});
			});
			if (signal?.aborted) stop();
		});
		results.push(result);
		console.log(`${result.passed ? 'PASS' : 'FAIL'} ${suite.name} (${result.seconds}s)`);
		if (!result.passed) {
			console.error(readFileSync(log, 'utf8').slice(-12000));
			throw new Error(`${suite.name} failed: ${result.error ?? result.signal ?? result.code}`);
		}
	}
	const settled = await Promise.allSettled(
		lanes.map(async (lane) => {
			for (const suite of lane) await run(suite);
		})
	);
	const passed = results.length === expected.length && results.every((result) => result.passed);
	writeFileSync(
		join(directory, 'timings.json'),
		JSON.stringify({ passed, expected, results }, null, 2)
	);
	if (env.GITHUB_STEP_SUMMARY)
		appendFileSync(
			env.GITHUB_STEP_SUMMARY,
			`\n| Assistant suite | Result | Seconds |\n| --- | --- | --- |\n${results.map((r) => `| ${r.name} | ${r.passed ? 'PASS' : 'FAIL'} | ${r.seconds} |`).join('\n')}\n`
		);
	if (!passed)
		throw new AggregateError(
			settled.filter((r) => r.status === 'rejected').map((r) => r.reason),
			'Assistant verification failed or was cancelled'
		);
	return results;
}

export function assistantLanes(image, nativeImage) {
	const suite = (name, command, env) => ({ name, command, env });
	const recovery = { FH_RECOVERY_TEST_IMAGE: image };
	const source = 'fwdslsh/fhold-assistant:0.3.261006-beta';
	return [
		[
			suite('startup-security-native-harnesses', [
				'bash',
				'scripts/smoke-image.sh',
				image,
				'assistant'
			]),
			suite('workload', ['node', 'scripts/smoke-workload-environment.mjs', image]),
			suite('native-policy', ['node', 'scripts/smoke-managed-policy.mjs', image]),
			suite('history-v1-source', [
				'docker',
				'pull',
				'fwdslsh/fhold-assistant:0.1.2610081904-beta.2'
			]),
			suite('history-v2-source', ['docker', 'pull', source]),
			suite('history', ['bun', 'test', 'scripts/native-transfer.test.ts'], {
				FH_NATIVE_TEST_IMAGE: nativeImage,
				FH_HISTORY_SOURCE_IMAGE: 'fwdslsh/fhold-assistant:0.1.2610081904-beta.2',
				FH_HISTORY_V2_SOURCE_IMAGE: source
			}),
			suite(
				'providers-guardian-scheduler',
				['bun', 'test', 'scripts/provider-settings-native.test.ts'],
				{
					FH_NATIVE_PROVIDER_TESTS: '1',
					FH_NATIVE_PROVIDER_CLI: resolve('packages/cli/dist/fhold-cli'),
					FH_NATIVE_PROVIDER_IMAGE: nativeImage
				}
			),
			suite('blob-recovery', ['node', 'scripts/smoke-blob-recovery.mjs'], recovery)
		],
		[
			suite('keepalive', ['node', 'scripts/smoke-keepalive.mjs', image]),
			suite('directory-recovery', ['node', 'scripts/smoke-recovery.mjs'], recovery),
			suite('upgrade-source', ['docker', 'pull', source]),
			suite('upgrade-empty', ['node', 'scripts/smoke-recovery.mjs'], {
				...recovery,
				FH_RECOVERY_UPGRADE_FROM_IMAGE: source
			}),
			suite('upgrade-surviving', ['node', 'scripts/smoke-recovery.mjs'], {
				...recovery,
				FH_RECOVERY_UPGRADE_FROM_IMAGE: source,
				FH_RECOVERY_TEST_SURVIVING_HOME: '1'
			})
		]
	];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const image = process.argv[2];
	if (!image) throw new Error('Usage: smoke-assistant-ci.mjs IMAGE');
	const nativeImage = 'fhold/fhold-assistant:ci';
	execFileSync('docker', ['tag', image, nativeImage], { stdio: 'inherit' });
	execFileSync('bun', ['run', '--cwd', 'packages/cli', 'build'], { stdio: 'inherit' });
	const abort = new AbortController();
	for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
	await runLanes(assistantLanes(image, nativeImage), {
		directory: process.env.FH_CI_LOG_DIR || resolve('test-results/assistant-smokes'),
		signal: abort.signal
	});
}

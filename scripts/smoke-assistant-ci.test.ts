import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assistantLanes, runLanes } from './smoke-assistant-ci.mjs';

const fixture = () => mkdtempSync(join(tmpdir(), 'fhold-ci-lanes-'));
const suite = (name: string, script: string, timeoutMs = 5000) => ({
	name,
	command: [process.execPath, '-e', script],
	timeoutMs
});
test('both lanes finish and persist evidence for every successful suite', async () => {
	const directory = fixture();
	try {
		const result = await runLanes(
			[
				[
					suite('first', 'console.log("first evidence")'),
					suite('second', 'console.log("second evidence")')
				],
				[suite('parallel', 'setTimeout(() => console.log("parallel evidence"), 50)')]
			],
			{ directory }
		);
		expect(result).toHaveLength(3);
		expect(JSON.parse(readFileSync(join(directory, 'timings.json'), 'utf8')).passed).toBe(true);
		for (const name of ['first', 'second', 'parallel'])
			expect(readFileSync(join(directory, `${name}.log`), 'utf8')).toContain(`${name} evidence`);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
test('nonzero exit and spawn failure cannot pass or abandon the other lane cleanup', async () => {
	for (const failing of [
		suite('failure', 'process.exit(7)'),
		{ name: 'failure', command: ['/missing-fhold-ci-test-command'] }
	]) {
		const directory = fixture();
		try {
			await expect(
				runLanes(
					[
						[failing, suite('must-not-run', 'process.exit(0)')],
						[suite('other', 'setTimeout(() => console.log("cleanup finished"), 100)')]
					],
					{ directory }
				)
			).rejects.toThrow('Assistant verification failed');
			const report = JSON.parse(readFileSync(join(directory, 'timings.json'), 'utf8'));
			expect(report.passed).toBe(false);
			expect(report.expected).toHaveLength(3);
			expect(report.results).toHaveLength(2);
			expect(readFileSync(join(directory, 'other.log'), 'utf8')).toContain('cleanup finished');
			expect(existsSync(join(directory, 'must-not-run.log'))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
});
test('timeout and cancellation wait for process-group cleanup and cannot produce green evidence', async () => {
	for (const cancel of [false, true]) {
		const directory = fixture();
		const abort = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			if (cancel) timer = setTimeout(() => abort.abort(), 500);
			await expect(
				runLanes(
					[
						[
							suite(
								'waiting',
								'process.on("SIGTERM", () => { console.log("cleanup finished"); process.exit(0); }); console.log("ready"); setInterval(() => {}, 1000);',
								cancel ? 5000 : 500
							)
						],
						[suite('other', 'console.log("other finished")')]
					],
					{ directory, signal: abort.signal }
				)
			).rejects.toThrow('Assistant verification failed');
			expect(readFileSync(join(directory, 'waiting.log'), 'utf8')).toContain('cleanup finished');
			expect(JSON.parse(readFileSync(join(directory, 'timings.json'), 'utf8')).passed).toBe(false);
		} finally {
			clearTimeout(timer);
			rmSync(directory, { recursive: true, force: true });
		}
	}
}, 10000);
test('suite inventory retains every native acceptance family and runs the full startup smoke once', () => {
	const lanes = assistantLanes('fixture-image', 'native-image');
	expect(lanes).toHaveLength(2);
	const suites = lanes.flat();
	expect(
		suites
			.map((item) => item.name)
			.filter((name) => !name.endsWith('-source'))
			.sort()
	).toEqual([
		'blob-recovery',
		'directory-recovery',
		'history',
		'keepalive',
		'native-policy',
		'providers-guardian-scheduler',
		'startup-security-native-harnesses',
		'upgrade-empty',
		'upgrade-surviving',
		'workload'
	]);
	expect(suites.filter((item) => item.command.includes('scripts/smoke-image.sh'))).toHaveLength(1);
	expect(
		suites.find((item) => item.name === 'upgrade-surviving')?.env.FH_RECOVERY_TEST_SURVIVING_HOME
	).toBe('1');
	expect(suites.find((item) => item.name === 'history')?.env.FH_HISTORY_V2_SOURCE_IMAGE).toBe(
		'fwdslsh/fhold-assistant:0.3.261006-beta'
	);
	const smoke = readFileSync(new URL('./smoke-image.sh', import.meta.url), 'utf8');
	expect(smoke).toContain('for mode in 1 0');
	expect(smoke).toContain('verify_explicit_remote_modes');
});

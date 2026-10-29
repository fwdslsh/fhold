import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { pullRequestCandidate, qualifies, waitForCanonicalRuns } from './release-qualification.mjs';

test('only a same-repository release PR containing the current base can reuse exact head evidence', () => {
	const repo = { full_name: 'fwdslsh/fhold' };
	const head = { sha: 'a'.repeat(40), ref: 'release/beta', repo };
	const base = { sha: 'b'.repeat(40), ref: 'main', repo };
	const event = { action: 'opened', repository: repo, pull_request: { head, base } };
	const checked: string[][] = [];
	for (const action of ['opened', 'synchronize', 'reopened', 'ready_for_review'])
		expect(
			pullRequestCandidate({ ...event, action }, (ancestor: string, descendant: string) => {
				checked.push([ancestor, descendant]);
				return true;
			})
		).toBe(head.sha);
	expect(checked).toEqual(Array(4).fill([base.sha, head.sha]));
	for (const changed of [
		{ action: 'edited', changes: { base: {} } },
		{ action: 'edited', changes: { title: {} } },
		{ repository: { full_name: 'fork/fhold' } },
		{ pull_request: { head: { ...head, repo: { full_name: 'fork/fhold' } }, base } },
		{ pull_request: { head: { ...head, ref: 'feature' }, base } },
		{ pull_request: { head: { ...head, sha: '--unsafe' }, base } },
		{ pull_request: { head, base: { ...base, ref: 'other' } } },
		{ pull_request: { head, base: { ...base, sha: '' } } }
	])
		expect(pullRequestCandidate({ ...event, ...changed }, () => true)).toBeNull();
	expect(pullRequestCandidate(event, () => false)).toBeNull();
});

const now = Date.now();
const run = {
	repository: { full_name: 'fwdslsh/fhold' },
	head_repository: { full_name: 'fwdslsh/fhold' },
	path: '.github/workflows/ci.yml',
	event: 'push',
	head_sha: 'abc',
	status: 'completed',
	conclusion: 'success',
	head_branch: 'main',
	updated_at: new Date(now).toISOString()
};
const quality = {
	name: 'gates / stack quality',
	conclusion: 'success',
	steps: [{ name: 'Test active packages', conclusion: 'success' }]
};
const images = ['assistant', 'guardian', 'portal'].flatMap((image) =>
	['amd64', 'arm64'].map((arch) => ({
		name: `gates / Build ${image} (linux/${arch})`,
		conclusion: 'success'
	}))
);
const jobs = [quality, ...images];

test('an in-progress exact candidate is awaited; API failure and timeout cannot launch duplicate gates', async () => {
	let requests = 0;
	const waits: number[] = [];
	const result = await waitForCanonicalRuns(
		'abc',
		async () => ({
			workflow_runs: [
				{
					...run,
					head_branch: 'release/beta',
					id: 7,
					status: ++requests < 3 ? 'in_progress' : 'completed'
				}
			]
		}),
		async (ms: number) => {
			waits.push(ms);
		},
		() => now
	);
	expect(requests).toBe(3);
	expect(waits).toEqual([30000, 30000]);
	expect(result[0].status).toBe('completed');
	await expect(
		waitForCanonicalRuns('abc', async () => {
			throw new Error('API unavailable');
		})
	).rejects.toThrow('API unavailable');
	let clockReads = 0;
	await expect(
		waitForCanonicalRuns(
			'abc',
			async () => ({ workflow_runs: [{ ...run, head_branch: 'release/beta', status: 'queued' }] }),
			async () => {
				throw new Error('Must not wait after deadline');
			},
			() => (clockReads++ ? now + 2400001 : now)
		)
	).rejects.toThrow('still running');
	expect(await waitForCanonicalRuns('abc', async () => ({ workflow_runs: [] }))).toEqual([]);
	const mainRun = { ...run, status: 'in_progress' };
	expect(
		await waitForCanonicalRuns(
			'abc',
			async () => ({ workflow_runs: [mainRun] }),
			async () => {
				throw new Error('Ordinary main CI does not produce candidate artifacts');
			}
		)
	).toEqual([mainRun]);
});

test('reuse requires exact canonical push, recent full native qualification', () => {
	expect(qualifies(run, jobs, 'abc', 'full', now)).toBe(true);
	for (const override of [
		{ head_sha: 'other' },
		{ event: 'pull_request' },
		{ path: '.github/workflows/deploy-docs.yml' },
		{ repository: { full_name: 'fork/fhold' } },
		{ head_repository: { full_name: 'fork/fhold' } },
		{ head_branch: 'feature' },
		{ status: 'in_progress' },
		{ conclusion: 'failure' },
		{ updated_at: new Date(now - 86400001).toISOString() },
		{ updated_at: 'invalid' }
	])
		expect(qualifies({ ...run, ...override }, jobs, 'abc', 'full', now)).toBe(false);
	for (let index = 0; index < jobs.length; index++) {
		expect(
			qualifies(
				run,
				jobs.filter((_, i) => i !== index),
				'abc',
				'full',
				now
			)
		).toBe(false);
		expect(
			qualifies(
				run,
				jobs.map((job, i) => (i === index ? { ...job, conclusion: 'skipped' } : job)),
				'abc',
				'full',
				now
			)
		).toBe(false);
	}
});

test('tooling checks cannot qualify a full runtime release', () => {
	const tools = [
		{ ...quality, steps: [{ name: 'Check and test tooling', conclusion: 'success' }] }
	];
	expect(qualifies(run, tools, 'abc', 'tools', now)).toBe(true);
	expect(qualifies(run, tools, 'abc', 'full', now)).toBe(false);
	expect(qualifies(run, jobs, 'abc', 'unexpected', now)).toBe(false);
	// Docs/lock-only CI and a Portal-only native matrix never qualify a full release.
	expect(qualifies(run, [], 'abc', 'full', now)).toBe(false);
	expect(qualifies(run, [], 'abc', 'none', now)).toBe(false);
	expect(
		qualifies(
			run,
			[quality, ...images.filter((job) => job.name.includes('portal'))],
			'abc',
			'full',
			now
		)
	).toBe(false);
});

test('sparse reusable-job steps require the complete native full-scope evidence', () => {
	const sparse = [{ ...quality, steps: [] }, ...images];
	expect(qualifies(run, sparse, 'abc', 'full', now)).toBe(true);
	expect(qualifies(run, [{ ...quality, steps: [] }], 'abc', 'full', now)).toBe(false);
	expect(qualifies(run, sparse.slice(0, -1), 'abc', 'full', now)).toBe(false);
	expect(qualifies(run, sparse, 'abc', 'tools', now)).toBe(false);
	expect(
		qualifies(
			run,
			[{ ...quality, steps: [{ name: 'Test active packages', conclusion: 'failure' }] }, ...images],
			'abc',
			'full',
			now
		)
	).toBe(false);
});

test('native image success proves the same full-scope source-test condition', () => {
	const gates = Bun.YAML.parse(
		readFileSync(new URL('../.github/workflows/gates.yml', import.meta.url), 'utf8')
	) as {
		jobs: {
			quality: { steps: Array<{ name?: string; if?: string }> };
			images: { if: string; needs: string };
		};
	};
	expect(gates.jobs.images.needs).toBe('quality');
	expect(gates.jobs.images.if).toBe("inputs.scope != 'tools'");
	expect(gates.jobs.quality.steps.find((step) => step.name === 'Test active packages')?.if).toBe(
		gates.jobs.images.if
	);
});

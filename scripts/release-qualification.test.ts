import { expect, test } from 'bun:test';
import { qualifies } from './release-qualification.mjs';

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
});

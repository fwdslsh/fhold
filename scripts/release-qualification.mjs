import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { selectArtifacts } from './release-candidate.mjs';

const repository = 'fwdslsh/fhold';
export function pullRequestCandidate(event, isAncestor) {
	const pr = event.pull_request;
	if (
		!['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(event.action) ||
		event.repository?.full_name !== repository ||
		pr?.head?.repo?.full_name !== repository ||
		pr?.base?.repo?.full_name !== repository ||
		pr?.base?.ref !== 'main' ||
		!pr?.head?.ref?.startsWith('release/') ||
		!/^[a-f0-9]{40}$/.test(pr?.head?.sha) ||
		!/^[a-f0-9]{40}$/.test(pr?.base?.sha) ||
		!isAncestor(pr.base.sha, pr.head.sha)
	)
		return null;
	return pr.head.sha;
}

export function qualifies(run, jobs, sha, scope, now = Date.now()) {
	if (
		run.repository?.full_name !== repository ||
		run.head_repository?.full_name !== repository ||
		run.path !== '.github/workflows/ci.yml' ||
		run.event !== 'push' ||
		run.head_sha !== sha ||
		run.status !== 'completed' ||
		run.conclusion !== 'success' ||
		!(run.head_branch === 'main' || run.head_branch?.startsWith('release/'))
	)
		return false;
	const age = now - Date.parse(run.updated_at);
	if (!Number.isFinite(age) || age < 0 || age > 24 * 60 * 60 * 1000) return false;
	const quality = jobs.find((job) => job.name === 'gates / stack quality');
	if (quality?.conclusion !== 'success') return false;
	const step = scope === 'tools' ? 'Check and test tooling' : 'Test active packages';
	const tested = quality.steps?.some((item) => item.name === step && item.conclusion === 'success');
	if (quality.steps?.length && !tested) return false;
	if (scope === 'tools') return tested === true;
	if (scope !== 'full') return false;
	// GitHub can omit step metadata for successful reusable jobs. In this
	// workflow, all six images require quality and run under the same != tools
	// condition as the full source tests. Their success proves full scope.
	return ['assistant', 'guardian', 'portal'].every((image) =>
		['amd64', 'arm64'].every((arch) =>
			jobs.some(
				(job) =>
					job.name === `gates / Build ${image} (linux/${arch})` && job.conclusion === 'success'
			)
		)
	);
}

export function qualifiedCandidate(run, jobs, artifacts, sha, scope, now = Date.now()) {
	if (!run.head_branch?.startsWith('release/')) return false;
	// A root version stamp selects full CI even for tooling publication. Its
	// evidence covers tools only with the additional renderer check and the
	// complete full candidate, never a filtered or incomplete image run.
	const fullForTools =
		scope === 'tools' &&
		qualifies(run, jobs, sha, 'full', now) &&
		jobs
			.find((job) => job.name === 'gates / stack quality')
			?.steps?.some(
				(step) =>
					step.name === 'Qualify the Admin renderer in Chromium' && step.conclusion === 'success'
			);
	if (!qualifies(run, jobs, sha, scope, now) && !fullForTools) return false;
	for (const name of [
		'Build CLI fhold-cli-linux-x64',
		'Build CLI fhold-cli-linux-arm64',
		'Build optional admin for linux'
	])
		if (!jobs.some((job) => job.name === `gates / ${name}` && job.conclusion === 'success'))
			return false;
	try {
		selectArtifacts(artifacts, fullForTools ? 'full' : scope, run.run_attempt);
	} catch {
		return false;
	}
	return true;
}

async function api(path) {
	const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
		headers: {
			Authorization: `Bearer ${process.env.GH_TOKEN}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2026-03-10'
		},
		signal: AbortSignal.timeout(15000)
	});
	if (!response.ok) throw new Error(`CI lookup returned ${response.status}`);
	return response.json();
}

export async function waitForCanonicalRuns(
	sha,
	request = api,
	wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now = Date.now
) {
	const deadline = now() + 40 * 60 * 1000;
	while (true) {
		const { workflow_runs: runs } = await request(
			`actions/workflows/ci.yml/runs?head_sha=${encodeURIComponent(sha)}&event=push&per_page=5`
		);
		const pending = runs.find(
			(run) =>
				run.repository?.full_name === repository &&
				run.head_repository?.full_name === repository &&
				run.head_sha === sha &&
				run.head_branch?.startsWith('release/') &&
				run.status !== 'completed'
		);
		if (!pending) return runs;
		if (now() >= deadline)
			throw new Error('Exact-commit CI is still running; retry publication after it finishes');
		console.log(`Waiting for exact-commit CI ${pending.id}; no duplicate qualification started`);
		await wait(30000);
	}
}

if (import.meta.main) {
	if (process.argv.includes('--select-artifacts')) {
		const { artifacts } = await api(
			`actions/runs/${process.env.CANDIDATE_RUN_ID}/artifacts?per_page=100`
		);
		const selected = selectArtifacts(
			artifacts,
			process.env.SCOPE,
			Number(process.env.CANDIDATE_ATTEMPT)
		);
		const groups = { assets: selected.filter((item) => !item.kind.startsWith('image-')) };
		for (const image of ['assistant', 'guardian', 'portal'])
			groups[image] = selected.filter((item) => item.kind.startsWith(`image-${image}-`));
		for (const [name, items] of Object.entries(groups))
			appendFileSync(
				process.env.GITHUB_OUTPUT,
				`${name}_ids=${items.map((item) => item.id).join(',')}\n`
			);
		process.exit(0);
	}
	let sha = process.env.GITHUB_SHA;
	if (process.argv.includes('--pull-request')) {
		sha = pullRequestCandidate(
			JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
			(base, head) => spawnSync('git', ['merge-base', '--is-ancestor', base, head]).status === 0
		);
		if (!sha) {
			appendFileSync(process.env.GITHUB_OUTPUT, 'reused=false\n');
			process.exit(0);
		}
	}
	let reused = false;
	try {
		const runs = await waitForCanonicalRuns(sha);
		for (const run of runs) {
			if (run.conclusion !== 'success') continue;
			const { jobs } = await api(
				`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`
			);
			const { artifacts } = await api(`actions/runs/${run.id}/artifacts?per_page=100`);
			if (!qualifiedCandidate(run, jobs, artifacts, sha, process.env.SCOPE)) continue;
			console.log(`Reuse exact-commit native CI: ${run.html_url}`);
			appendFileSync(
				process.env.GITHUB_STEP_SUMMARY,
				`Qualified ${sha} with [successful canonical CI and retained final artifacts](${run.html_url}).\n`
			);
			reused = true;
			appendFileSync(process.env.GITHUB_OUTPUT, `run_id=${run.id}\nattempt=${run.run_attempt}\n`);
			break;
		}
	} catch (error) {
		// An unavailable lookup must not start another expensive qualification
		// while an exact candidate may still be running. Retry the lookup instead.
		throw new Error(`Candidate lookup failed; no duplicate gates started: ${error.message}`);
	}
	appendFileSync(process.env.GITHUB_OUTPUT, `reused=${reused}\n`);
}

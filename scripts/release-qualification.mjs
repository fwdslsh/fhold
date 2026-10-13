import { appendFileSync } from 'node:fs';

const repository = 'fwdslsh/fhold';
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
	if (!quality.steps?.some((item) => item.name === step && item.conclusion === 'success'))
		return false;
	if (scope === 'tools') return true;
	if (scope !== 'full') return false;
	return ['assistant', 'guardian', 'portal'].every((image) =>
		['amd64', 'arm64'].every((arch) =>
			jobs.some(
				(job) =>
					job.name === `gates / Build ${image} (linux/${arch})` && job.conclusion === 'success'
			)
		)
	);
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

if (import.meta.main) {
	let reused = false;
	try {
		const { workflow_runs: runs } = await api(
			`actions/workflows/ci.yml/runs?head_sha=${encodeURIComponent(process.env.GITHUB_SHA)}&event=push&status=completed&per_page=1`
		);
		for (const run of runs) {
			if (run.conclusion !== 'success') continue;
			const { jobs } = await api(
				`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`
			);
			if (!qualifies(run, jobs, process.env.GITHUB_SHA, process.env.SCOPE)) continue;
			console.log(`Reuse exact-commit native CI: ${run.html_url}`);
			appendFileSync(
				process.env.GITHUB_STEP_SUMMARY,
				`Qualified ${process.env.GITHUB_SHA} with [successful canonical CI](${run.html_url}).\n`
			);
			reused = true;
			break;
		}
	} catch (error) {
		console.log(`${error.message}; running release gates instead`);
	}
	appendFileSync(process.env.GITHUB_OUTPUT, `reused=${reused}\n`);
}

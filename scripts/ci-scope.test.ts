import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changeScope, validationPlan } from './ci-scope.mjs';

const all = ['assistant', 'guardian', 'portal'];
const plan = (files: string[]) =>
	validationPlan(
		files,
		() => '{}',
		() => '{}'
	);
test('CI validation and published runtime scope are independent', () => {
	for (const file of [
		'.github/workflows/ci.yml',
		'.github/workflows/gates.yml',
		'.github/workflows/release.yml',
		'scripts/ci-scope.mjs',
		'scripts/smoke-assistant-ci.mjs',
		'scripts/smoke-image.sh'
	]) {
		expect(
			changeScope(
				[file],
				() => '',
				() => ''
			)
		).toBe('tools');
		expect(plan([file]).images).toEqual(all);
	}
	expect(plan(['package.json']).images).toEqual(all);
	expect(plan(['packages/electron/admin/app.js'])).toEqual({
		scope: 'tools',
		images: [],
		admin: true
	});
});
test('docs and lock-only policy cannot suppress runtime Markdown or unknown input checks', () => {
	for (const files of [['docs/guide.md'], ['bun.lock'], ['bun.lock', 'website/index.html']])
		expect(plan(files)).toEqual({ scope: 'none', images: [], admin: false });
	for (const files of [
		[],
		['new-build-input'],
		['packages/skeleton/system/assistant/skills/example.md'],
		['plugins/fhold/prompts/example.md'],
		['bun.lock', 'containers/assistant/Dockerfile']
	])
		expect(plan(files).images).toEqual(all);
});
test('Admin qualification includes shared code, embedded Skeleton, helpers and install inputs', () => {
	for (const file of [
		'packages/lib/src/hosting/ssh.ts',
		'packages/cli/src/main.ts',
		'packages/skeleton/system/stack/stack.compose.yml',
		'package.json',
		'.github/workflows/admin-desktop-native.yml',
		'scripts/smoke-admin-artifact.mjs'
	])
		expect(plan([file]).admin).toBe(true);
	expect(plan(['bun.lock', 'packages/electron/package.json']).admin).toBe(true);
	expect(plan(['packages/portal/src/adapter.ts']).admin).toBe(false);
});
test('only isolated Portal source and Dockerfile select fewer runtime images', () => {
	expect(plan(['packages/portal/src/slack.ts', 'docs/portals/slack.md'])).toEqual({
		scope: 'full',
		images: ['portal'],
		admin: false
	});
	expect(plan(['containers/portal/Dockerfile']).images).toEqual(['portal']);
	for (const file of [
		'packages/portal/package.json',
		'bun.lock',
		'packages/guardian/src/server.ts',
		'.github/trivy-ignore.yaml',
		'scripts/smoke-image.sh',
		'unknown'
	])
		expect(plan(['packages/portal/src/slack.ts', file]).images).toEqual(all);
	// The ownership proof must be reconsidered if a new consumer imports Portal.
	for (const packageName of ['lib', 'cli', 'electron', 'guardian', 'claude-desktop']) {
		for (const file of new Bun.Glob('**/*.{ts,js,mjs,json}').scanSync({
			cwd: `packages/${packageName}`,
			onlyFiles: true
		})) {
			if (file.includes('node_modules/') || file.includes('dist/')) continue;
			expect(readFileSync(`packages/${packageName}/${file}`, 'utf8')).not.toMatch(
				/(?:from\s*|import\s*\(|require\s*\()\s*['"][^'"]*(?:@fhold\/portal|\/portal\/src)/
			);
		}
	}
	for (const image of ['assistant', 'guardian'])
		expect(readFileSync(`containers/${image}/Dockerfile`, 'utf8')).not.toMatch(
			/COPY[^\n]*(?:packages\/portal\/(?:src|\s|$)|containers\/portal)/
		);
});
test('invalid and shared reachable lock changes fail closed, including declaration-only changes', () => {
	const before = {
		lockfileVersion: 1,
		configVersion: 1,
		workspaces: {
			'packages/lib': { name: '@fhold/lib', dependencies: { first: '1' } },
			'packages/guardian': {
				name: '@fhold/guardian',
				dependencies: { '@fhold/lib': 'workspace:*' }
			}
		},
		packages: {
			'@fhold/lib': ['@fhold/lib@workspace:packages/lib'],
			first: ['first@1', '', {}, 'hash'],
			second: ['second@1', '', {}, 'hash']
		}
	};
	const after = structuredClone(before);
	after.workspaces['packages/lib'].dependencies = { second: '1' } as { first: string };
	expect(
		changeScope(
			['bun.lock'],
			() => JSON.stringify(before),
			() => JSON.stringify(after)
		)
	).toBe('full');
	for (const invalid of ['', '{}', JSON.stringify({ ...before, lockfileVersion: 99 })])
		expect(
			validationPlan(
				['bun.lock', 'packages/electron/package.json'],
				() => JSON.stringify(before),
				() => invalid
			).images
		).toEqual(all);
	expect(
		validationPlan(
			['bun.lock', 'packages/electron/package.json'],
			() => {
				throw Error('missing');
			},
			() => '{}'
		).images
	).toEqual(all);
});
test('PR merge-base, deletions, renames and missing bases select conservative real Git diffs', () => {
	const directory = mkdtempSync(join(tmpdir(), 'fhold-ci-scope-'));
	const script = new URL('./ci-scope.mjs', import.meta.url).pathname;
	const git = (...args: string[]) =>
		execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
	const commit = () => {
		git('add', '.');
		git(
			'-c',
			'user.name=fixture',
			'-c',
			'user.email=fixture@example.invalid',
			'commit',
			'-qm',
			'fixture'
		);
		return git('rev-parse', 'HEAD');
	};
	const inspect = (base: string, head: string, pr = false) =>
		JSON.parse(
			execFileSync(process.execPath, [script], {
				cwd: directory,
				encoding: 'utf8',
				env: {
					...process.env,
					BASE_SHA: base,
					HEAD_SHA: head,
					GITHUB_EVENT_NAME: pr ? 'pull_request' : 'push',
					GITHUB_OUTPUT: ''
				},
				stdio: ['ignore', 'pipe', 'pipe']
			})
		);
	try {
		git('init', '-q');
		mkdirSync(join(directory, 'packages/electron'), { recursive: true });
		writeFileSync(join(directory, 'packages/electron/app.js'), 'original');
		writeFileSync(join(directory, 'runtime-input'), 'runtime');
		const base = commit();
		git('checkout', '-qb', 'feature');
		writeFileSync(join(directory, 'packages/electron/app.js'), 'changed');
		const head = commit();
		git('checkout', '-qb', 'advanced-base', base);
		writeFileSync(join(directory, 'runtime-input'), 'new base runtime');
		const advanced = commit();
		expect(inspect(advanced, head, true).scope).toBe('tools');
		expect(inspect(advanced, head).images).toEqual(all);
		git('rm', 'runtime-input');
		const deleted = commit();
		expect(inspect(advanced, deleted).images).toEqual(all);
		git('mv', 'packages/electron/app.js', 'unknown-runtime');
		const renamed = commit();
		expect(inspect(deleted, renamed).images).toEqual(all);
		for (const missing of ['', '0'.repeat(40), 'missing-ref'])
			expect(inspect(missing, head)).toEqual({ scope: 'full', images: all, admin: true });
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

type Workflow = {
	on: Record<string, { types?: string[] }>;
	concurrency: { group: string };
	jobs: Record<
		string,
		{
			name?: string;
			if?: string;
			needs?: string;
			with?: Record<string, string>;
			strategy?: { matrix: { image: string; include: Array<Record<string, string>> } };
			steps?: Array<{
				name?: string;
				run?: string;
				if?: string;
				uses?: string;
				with?: Record<string, string>;
			}>;
		}
	>;
};
const workflow = (name: string) =>
	Bun.YAML.parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8')) as Workflow;
test('base retarget runs scope checks; title/body edits neither build nor cancel real checks', () => {
	for (const name of ['ci', 'pr-admin', 'admin-desktop-native']) {
		const yaml = workflow(name);
		expect(yaml.on.pull_request.types).toContain('edited');
		expect(yaml.jobs.scope.if).toBe(
			"github.event.action != 'edited' || github.event.changes.base != null"
		);
		expect(yaml.jobs.scope.name).toBe(
			"${{ github.event.action == 'edited' && !github.event.changes.base && 'Ignored text edit' || 'scope' }}"
		);
		expect(yaml.concurrency.group).toContain(
			"github.event.action == 'edited' && !github.event.changes.base && github.run_id"
		);
		expect(yaml.jobs.scope.steps?.some((step) => step.run === 'bun scripts/ci-scope.mjs')).toBe(
			true
		);
		expect(yaml.jobs.scope.steps?.some((step) => step.with?.['fetch-depth'] === 0)).toBe(true);
	}
	for (const [name, job] of [
		['pr-admin', 'appimage'],
		['admin-desktop-native', 'desktop']
	]) {
		expect(workflow(name).jobs[job].needs).toBe('scope');
		expect(workflow(name).jobs[job].if).toBe(
			name === 'pr-admin'
				? "needs.scope.outputs.admin == 'true' && needs.scope.outputs.reused != 'true'"
				: "needs.scope.outputs.admin == 'true'"
		);
		expect(workflow(name).jobs[job].name).toContain(
			"github.event.action == 'edited' && !github.event.changes.base && 'Ignored text edit"
		);
	}
	expect(workflow('pr-admin').jobs.appimage.name).toBe(
		"${{ github.event.action == 'edited' && !github.event.changes.base && 'Ignored text edit (AppImage)' || (needs.scope.outputs.reused == 'true' && 'Qualified candidate Admin reused' || 'Download Linux AppImage (x86_64)') }}"
	);
	expect(workflow('admin-desktop-native').jobs.desktop.name).toBe(
		"${{ github.event.action == 'edited' && !github.event.changes.base && 'Ignored text edit (desktop)' || format('{0} installer and desktop integration', matrix.platform) }}"
	);
});
test('filtered image matrix does not reintroduce omitted images through include entries', () => {
	const yaml = workflow('gates');
	expect(yaml.jobs.images.strategy?.matrix.image).toBe('${{ fromJSON(inputs.images) }}');
	expect(yaml.jobs.images.strategy?.matrix.include.every((entry) => !('image' in entry))).toBe(
		true
	);
	expect(workflow('ci').jobs.gates.with?.images).toBe('${{ needs.scope.outputs.images }}');
	// Release deliberately uses the default full matrix, never the PR filter.
	expect(workflow('release').jobs.gates.with?.images).toBeUndefined();
	const steps = yaml.jobs.images.steps ?? [];
	expect(steps.find((step) => step.run?.includes('smoke-assistant-ci.mjs'))?.if).toBe(
		"matrix.image == 'assistant'"
	);
	expect(steps.find((step) => step.name === 'Run image startup and security smoke')?.if).toBe(
		"matrix.image != 'assistant'"
	);
	expect(steps.find((step) => step.name === 'Retain Assistant suite logs and timings')?.if).toBe(
		"always() && matrix.image == 'assistant'"
	);
});

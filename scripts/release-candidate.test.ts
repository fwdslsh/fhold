import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	assertLoadedImage,
	candidateKinds,
	combinedIndex,
	inspectOCI,
	publicationAction,
	seal,
	selectArtifacts,
	verify
} from './release-candidate.mjs';
import { qualifiedCandidate } from './release-qualification.mjs';

const roots: string[] = [];
const temporary = () => {
	const root = mkdtempSync(join(tmpdir(), 'fhold-candidate-'));
	roots.push(root);
	return root;
};
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const identity = { sha: 'a'.repeat(40), version: '0.3.261010-beta', run: 123, attempt: 2 };
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function artifacts(scope = 'full') {
	return candidateKinds(scope).map((kind: string, index: number) => ({
		id: index + 1,
		name: `candidate-2-${kind}`,
		digest: hash(kind),
		expired: false
	}));
}

test('immutable image retry reuses identical bytes and rejects changed or unknown registry digests', () => {
	const digest = hash('verified index');
	expect(publicationAction(null, digest)).toBe('copy');
	expect(publicationAction({ digest }, digest)).toBe('reuse');
	for (const observed of [
		{ digest: hash('other index') },
		{},
		undefined,
		{ digest: '' },
		{ digest: 'SHA256:invalid' }
	])
		expect(() => publicationAction(observed, digest)).toThrow();
});

test('candidate selection is exact, complete, immutable and attempt-specific', () => {
	expect(selectArtifacts(artifacts(), 'full', 2)).toHaveLength(10);
	expect(selectArtifacts(artifacts(), 'tools', 2)).toHaveLength(3);
	for (const values of [
		artifacts().slice(1),
		[...artifacts(), artifacts()[0]],
		artifacts().map((item, index) => (index ? item : { ...item, expired: true })),
		artifacts().map((item, index) => (index ? item : { ...item, digest: '' }))
	])
		expect(() => selectArtifacts(values, 'full', 2)).toThrow();
	expect(() => selectArtifacts(artifacts(), 'full', 1)).toThrow();
	expect(() => selectArtifacts(artifacts('tools'), 'full', 2)).toThrow();
	expect(() => selectArtifacts(artifacts(), 'unknown', 2)).toThrow();
});

test('receipt rejects changed bytes, extra files, identity drift and symlinks', async () => {
	const directory = temporary();
	writeFileSync(join(directory, 'cli'), 'verified binary');
	await seal(directory, 'cli-x64', identity);
	await expect(verify(directory, 'cli-x64', identity)).resolves.toBeDefined();
	for (const changed of [
		{ sha: 'b'.repeat(40) },
		{ version: '0.3.261011-beta' },
		{ run: 124 },
		{ attempt: 3 }
	])
		await expect(verify(directory, 'cli-x64', { ...identity, ...changed })).rejects.toThrow();
	await expect(verify(directory, 'cli-arm64', identity)).rejects.toThrow();
	writeFileSync(join(directory, 'cli'), 'different binary');
	await expect(verify(directory, 'cli-x64', identity)).rejects.toThrow('digest mismatch');
	writeFileSync(join(directory, 'extra'), 'extra');
	await expect(verify(directory, 'cli-x64', identity)).rejects.toThrow('file set');
	const unsafe = temporary();
	symlinkSync(join(directory, 'cli'), join(unsafe, 'cli'));
	await expect(seal(unsafe, 'cli-x64', identity)).rejects.toThrow('regular files');
});

function ociFixture(
	options: { wrongSubject?: boolean; omitSbom?: boolean; corrupt?: boolean } = {}
) {
	const directory = temporary();
	const layout = join(directory, 'layout');
	mkdirSync(join(layout, 'blobs', 'sha256'), { recursive: true });
	const blob = (object: unknown) => {
		const bytes = JSON.stringify(object),
			digest = hash(bytes);
		writeFileSync(join(layout, 'blobs', 'sha256', digest.slice(7)), bytes);
		return {
			mediaType: 'application/vnd.oci.image.manifest.v1+json',
			digest,
			size: Buffer.byteLength(bytes)
		};
	};
	const config = blob({
		architecture: 'amd64',
		os: 'linux',
		config: {
			Labels: {
				'org.opencontainers.image.revision': identity.sha,
				'org.opencontainers.image.version': identity.version
			}
		},
		rootfs: { diff_ids: [hash('rootfs')] }
	});
	const image = {
		...blob({ config, layers: [] }),
		platform: { os: 'linux', architecture: 'amd64' }
	};
	const predicates = [
		'https://slsa.dev/provenance/v1',
		...(options.omitSbom ? [] : ['https://spdx.dev/Document'])
	];
	const attestation = {
		...blob({
			layers: predicates.map((predicateType) =>
				blob({
					predicateType,
					subject: [
						{ digest: { sha256: options.wrongSubject ? 'b'.repeat(64) : image.digest.slice(7) } }
					]
				})
			)
		}),
		annotations: {
			'vnd.docker.reference.type': 'attestation-manifest',
			'vnd.docker.reference.digest': image.digest
		},
		platform: { os: 'unknown', architecture: 'unknown' }
	};
	const index = blob({ manifests: [image, attestation] });
	writeFileSync(join(layout, 'index.json'), JSON.stringify({ manifests: [index] }));
	if (options.corrupt) writeFileSync(join(layout, 'blobs', 'sha256', config.digest.slice(7)), '{}');
	const archive = join(directory, 'image.tar');
	execFileSync('tar', ['-cf', archive, '-C', layout, 'index.json', 'blobs']);
	return archive;
}

test('OCI verification binds platform, config, rootfs, labels and both attestation subjects', () => {
	const archive = ociFixture();
	const info = inspectOCI(archive, 'linux/amd64', identity);
	for (const Id of [info.index, info.manifest, info.config])
		expect(() =>
			assertLoadedImage(info, {
				Id,
				Os: 'linux',
				Architecture: 'amd64',
				RootFS: { Layers: info.diffIDs }
			})
		).not.toThrow();
	for (const changed of [
		{ Id: hash('other') },
		{ Architecture: 'arm64' },
		{ RootFS: { Layers: [hash('changed')] } }
	])
		expect(() =>
			assertLoadedImage(info, {
				Id: info.config,
				Os: 'linux',
				Architecture: 'amd64',
				RootFS: { Layers: info.diffIDs },
				...changed
			})
		).toThrow();
	expect(() => inspectOCI(archive, 'linux/arm64', identity)).toThrow();
	expect(() => inspectOCI(archive, 'linux/amd64', { ...identity, sha: 'b'.repeat(40) })).toThrow();
	for (const options of [{ wrongSubject: true }, { omitSbom: true }, { corrupt: true }])
		expect(() => inspectOCI(ociFixture(options), 'linux/amd64', identity)).toThrow();
	expect(() => combinedIndex([info])).toThrow('Both native platforms');
	expect(combinedIndex([info, { ...info, platform: 'linux/arm64' }]).manifests).toHaveLength(4);
});

test('full native success alone cannot qualify missing, failed or preview final artifacts', () => {
	const now = Date.now();
	const run = {
		id: 123,
		run_attempt: 2,
		repository: { full_name: 'fwdslsh/fhold' },
		head_repository: { full_name: 'fwdslsh/fhold' },
		path: '.github/workflows/ci.yml',
		event: 'push',
		head_sha: identity.sha,
		status: 'completed',
		conclusion: 'success',
		head_branch: 'release/beta',
		updated_at: new Date(now).toISOString()
	};
	const names = [
		'stack quality',
		'Build CLI fhold-cli-linux-x64',
		'Build CLI fhold-cli-linux-arm64',
		'Build optional admin for linux',
		...['assistant', 'guardian', 'portal'].flatMap((image) =>
			['amd64', 'arm64'].map((arch) => `Build ${image} (linux/${arch})`)
		)
	];
	const jobs = names.map((name) => ({ name: `gates / ${name}`, conclusion: 'success' }));
	expect(qualifiedCandidate(run, jobs, artifacts(), identity.sha, 'full', now)).toBe(true);
	expect(qualifiedCandidate(run, jobs, artifacts(), identity.sha, 'tools', now)).toBe(false);
	const fullWithRenderer = jobs.map((job) =>
		job.name === 'gates / stack quality'
			? {
					...job,
					steps: [
						{ name: 'Test active packages', conclusion: 'success' },
						{ name: 'Qualify the Admin renderer in Chromium', conclusion: 'success' }
					]
				}
			: job
	);
	expect(qualifiedCandidate(run, fullWithRenderer, artifacts(), identity.sha, 'tools', now)).toBe(
		true
	);
	expect(
		qualifiedCandidate(run, fullWithRenderer, artifacts('tools'), identity.sha, 'tools', now)
	).toBe(false);
	expect(
		qualifiedCandidate(run, fullWithRenderer.slice(0, -1), artifacts(), identity.sha, 'tools', now)
	).toBe(false);
	for (let index = 0; index < jobs.length; index++)
		expect(
			qualifiedCandidate(
				run,
				jobs.map((job, i) => (i === index ? { ...job, conclusion: 'skipped' } : job)),
				artifacts(),
				identity.sha,
				'full',
				now
			)
		).toBe(false);
	for (const changed of [
		{ head_branch: 'main' },
		{ event: 'pull_request' },
		{ head_sha: 'b'.repeat(40) },
		{ head_repository: { full_name: 'fork/fhold' } },
		{ updated_at: new Date(now - 86400001).toISOString() }
	])
		expect(
			qualifiedCandidate({ ...run, ...changed }, jobs, artifacts(), identity.sha, 'full', now)
		).toBe(false);
	expect(qualifiedCandidate(run, jobs, artifacts().slice(1), identity.sha, 'full', now)).toBe(
		false
	);
	expect(
		qualifiedCandidate(
			run,
			jobs,
			[{ id: 1, name: 'fhold-admin-preview', digest: hash('preview'), expired: false }],
			identity.sha,
			'full',
			now
		)
	).toBe(false);
});

test('publication only promotes exact candidate IDs; ordinary PR gates do not export OCI or build final packages', () => {
	const read = (name: string) =>
		Bun.YAML.parse(
			readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8')
		);
	const ci = read('ci'),
		gates = read('gates'),
		release = read('release');
	expect(ci.jobs.gates.with.candidate).toContain("github.event_name == 'push'");
	expect(ci.jobs.gates.with.candidate).toContain("github.repository == 'fwdslsh/fhold'");
	expect(ci.jobs.gates.with.candidate).toContain("startsWith(github.ref, 'refs/heads/release/')");
	expect(ci.jobs.gates.if).toBe(
		"needs.scope.outputs.scope != 'none' && needs.scope.outputs.reused != 'true'"
	);
	for (const workflow of [ci, read('pr-admin')]) {
		expect(workflow.permissions.actions).toBe('read');
		expect(workflow.jobs.scope.outputs.reused).toBe('${{ steps.candidate.outputs.reused }}');
		const reuse = workflow.jobs.scope.steps.find(
			(step: { id?: string }) => step.id === 'candidate'
		);
		expect(reuse.run).toBe('bun scripts/release-qualification.mjs --pull-request');
		expect(reuse.env.SCOPE).toBe('${{ steps.scope.outputs.scope }}');
	}
	const versionStep = gates.jobs.quality.steps.find(
		(step: { id?: string }) => step.id === 'version'
	);
	const output = join(temporary(), 'github-output');
	execFileSync('bash', ['-eo', 'pipefail', '-c', versionStep.run], {
		cwd: new URL('..', import.meta.url),
		env: { ...process.env, GITHUB_OUTPUT: output }
	});
	expect(readFileSync(output, 'utf8')).toBe(
		`version=${JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}\n`
	);
	expect(gates.on.workflow_call.inputs.candidate.default).toBe(false);
	expect(gates.jobs.cli.if).toBe('inputs.candidate');
	expect(gates.jobs.admin.if).toBe('inputs.candidate');
	expect(gates.permissions).toEqual({ contents: 'read' });
	expect(
		gates.jobs.quality.steps.find(
			(step: { name?: string }) => step.name === 'Qualify the Admin renderer in Chromium'
		).if
	).toBe("inputs.candidate || inputs.scope == 'tools'");
	const store = gates.jobs.images.steps.find((step: { uses?: string }) =>
		step.uses?.startsWith('docker/setup-docker-action@')
	);
	expect(store.if).toBe('inputs.candidate');
	expect(JSON.parse(store.with['daemon-config']).features['containerd-snapshotter']).toBe(true);
	expect(gates.jobs.images.steps.indexOf(store)).toBeLessThan(
		gates.jobs.images.steps.findIndex((step: { uses?: string }) =>
			step.uses?.startsWith('docker/setup-buildx-action@')
		)
	);
	const build = gates.jobs.images.steps.find((step: { uses?: string }) =>
		step.uses?.startsWith('docker/build-push-action@')
	);
	expect(build.with.load).toBe(true);
	expect(build.with.push).toBe(false);
	expect(build.with.outputs).toContain("inputs.candidate && format('type=oci");
	expect(build.with.provenance).toContain("inputs.candidate && 'mode=max'");
	for (const job of Object.values(release.jobs) as Array<{
		steps?: Array<{ uses?: string; run?: string }>;
	}>)
		for (const step of job.steps ?? []) {
			expect(step.uses ?? '').not.toContain('build-push-action');
			expect(step.uses ?? '').not.toContain('setup-qemu-action');
			expect(step.run ?? '').not.toMatch(/bun install|bun run --cwd.*(?:build|pack|bundle)/);
		}
	expect(release.jobs.candidates.needs).toEqual(['validate', 'gates']);
	expect(release.jobs.images.needs).toEqual(['validate', 'candidates']);
	expect(release.jobs.gates.with.candidate).toBe(true);
	for (const name of ['images', 'release']) {
		const download = release.jobs[name].steps.find((step: { uses?: string }) =>
			step.uses?.startsWith('actions/download-artifact@')
		);
		expect(download.with['artifact-ids']).toContain('needs.candidates.outputs');
		expect(download.with['run-id']).toBe('${{ needs.candidates.outputs.run_id }}');
		expect(download.with['digest-mismatch']).toBe('error');
	}
});

test('publication continues after reused gates are skipped but refuses failed prerequisites', () => {
	const release = Bun.YAML.parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')) as any;
	const expression = release.jobs.images.if.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
	// GitHub implicitly adds success() unless an explicit status function exists.
	const canPublish = (validate: string, candidates: string, scope: string, cancelled = false) => {
		if (!/\b(?:always|cancelled|success|failure)\(/.test(expression)) return false; // skipped ancestor
		return Function('needs', 'cancelled', `return (${expression})`)(
			{ validate: { result: validate, outputs: { scope } }, candidates: { result: candidates } },
			() => cancelled
		);
	};
	expect(canPublish('success', 'success', 'full')).toBe(true);
	for (const result of ['failure', 'cancelled', 'skipped']) {
		expect(canPublish(result, 'success', 'full')).toBe(false);
		expect(canPublish('success', result, 'full')).toBe(false);
	}
	expect(canPublish('success', 'success', 'tools')).toBe(false);
	expect(canPublish('success', 'success', 'full', true)).toBe(false);
	const steps = release.jobs.validate.steps;
	const source = steps.find((step: any) => step.id === 'source');
	for (const selected of ['', 'b'.repeat(40)]) {
		const output = join(temporary(), 'source-output');
		execFileSync('bash', ['-e', '-c', source.run], { env: { ...process.env, CANDIDATE_SHA: selected, GITHUB_SHA: 'a'.repeat(40), GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(temporary(), 'summary') } });
		expect(readFileSync(output, 'utf8')).toBe(`sha=${selected || 'a'.repeat(40)}\n`);
	}
	for (const invalid of ['main', 'abc', 'a'.repeat(41), 'A'.repeat(40)])
		expect(() => execFileSync('bash', ['-e', '-c', source.run], { env: { ...process.env, CANDIDATE_SHA: invalid }, stdio: 'pipe' })).toThrow();
	const guard = steps.find((step: any) => step.name === 'Require retained qualification for an explicitly selected source');
	expect(guard.if).toBe("inputs.candidate_sha != '' && steps.qualification.outputs.reused != 'true'");
	expect(guard.run).toContain('exit 1');
	expect(release.jobs.validate.outputs.source_sha).toBe('${{ steps.source.outputs.sha }}');
	for (const name of ['candidates', 'images', 'release'])
		expect(release.jobs[name].steps[0].with.ref).toBe('${{ needs.validate.outputs.source_sha }}');
	for (const name of ['images', 'release']) {
		const command = release.jobs[name].steps.find((step: any) => step.run?.includes('scripts/release-candidate.mjs'));
		expect(command.run).toStartWith('GITHUB_SHA="$RELEASE_SOURCE_SHA" ');
		expect(command.env.RELEASE_SOURCE_SHA).toBe('${{ needs.validate.outputs.source_sha }}');
	}
	expect(release.jobs.release.steps.find((step: any) => step.name === 'Publish the verified GitHub release').env.RELEASE_SHA).toBe('${{ needs.validate.outputs.source_sha }}');
});

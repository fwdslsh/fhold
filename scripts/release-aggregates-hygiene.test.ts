import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	CLI_BINARIES,
	checksumFor,
	expectedAdminAssets,
	expectedClaudeExtensionAsset,
	readElectronProductName,
	requiredReleaseAssets,
	validateReleaseAssets,
	writeReleaseAssetManifest
} from './validate-release-assets.mjs';

const ROOT = join(import.meta.dir, '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');

type Manifest = {
	private?: boolean;
	license?: string;
	workspaces?: string[];
	scripts?: Record<string, string>;
};

function readJson(relPath: string): Manifest {
	return JSON.parse(readFileSync(join(ROOT, relPath), 'utf8')) as Manifest;
}

describe('product package boundary', () => {
	test('owned source, extension and image metadata use MIT consistently', () => {
		const root = readJson('package.json');
		const manifests = [
			'package.json',
			...(root.workspaces ?? []).map((workspace) => `${workspace}/package.json`),
			'packages/claude-desktop/manifest.json'
		];
		for (const manifest of manifests) expect(readJson(manifest).license, manifest).toBe('MIT');
		expect(readFileSync(join(ROOT, 'LICENSE'), 'utf8')).toStartWith('MIT License\n');
		for (const image of ['assistant', 'guardian', 'portal']) {
			expect(readFileSync(join(ROOT, 'containers', image, 'Dockerfile'), 'utf8')).toContain(
				'org.opencontainers.image.licenses="MIT"'
			);
		}
	});

	test('direct developer activation never pulls local-only images and preserves source builds', () => {
		const scripts = readJson('package.json').scripts ?? {};
		for (const name of ['dev:stack', 'dev:build'])
			expect(scripts[name]).toContain('up --pull never');
		expect(scripts['dev:build']).toContain('--build');
		expect(readFileSync(join(ROOT, 'compose.dev.yml'), 'utf8')).toContain(
			'up --pull never --build -d'
		);
	});

	test('the root check covers every active package', () => {
		const check = readJson('package.json').scripts?.check ?? '';
		for (const packageName of ['lib', 'guardian', 'portal', 'cli', 'electron', 'claude-desktop']) {
			expect(check).toContain(`packages/${packageName}`);
		}
	});

	for (const packagePath of [
		'packages/lib/package.json',
		'packages/cli/package.json',
		'packages/skeleton/package.json',
		'packages/guardian/package.json',
		'packages/portal/package.json',
		'packages/electron/package.json',
		'packages/claude-desktop/package.json'
	]) {
		test(`${packagePath} is source-only`, () => {
			expect(readJson(packagePath).private).toBe(true);
		});
	}
});

describe('release manifest', () => {
	const release = JSON.parse(readFileSync(join(ROOT, '.github/release-manifest.json'), 'utf8')) as {
		manifests: string[];
		compose: string[];
	};

	test('lists every versioned manifest once', () => {
		expect(new Set(release.manifests).size).toBe(release.manifests.length);
		expect(release.manifests).toContain('packages/electron/package.json');
		expect(release.manifests).toContain('packages/claude-desktop/manifest.json');
		expect(release.manifests).toContain('plugins/fhold/.claude-plugin/plugin.json');
		expect(release.manifests).toContain('plugins/fhold/.codex-plugin/plugin.json');
		expect(release.compose).toEqual(['packages/skeleton/system/stack/stack.compose.yml']);
	});

	test('every listed manifest exists on disk', () => {
		for (const manifest of release.manifests) {
			expect(existsSync(join(ROOT, manifest))).toBe(true);
		}
	});

	test('native fhold plugin caches track the product release', () => {
		const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
		for (const harness of ['claude', 'codex']) {
			const plugin = JSON.parse(
				readFileSync(join(ROOT, `plugins/fhold/.${harness}-plugin/plugin.json`), 'utf8')
			);
			expect(plugin.version).toBe(version);
		}
	});
});

describe('release workflows', () => {
	test('runtime exceptions stay limited to the approved npm bundle findings', () => {
		const ignored = Bun.YAML.parse(readFileSync(join(ROOT, '.github/trivy-ignore.yaml'), 'utf8')) as {
			vulnerabilities: Array<{ id: string; paths: string[]; purls: string[]; expired_at: string }>;
		};
		expect(ignored.vulnerabilities.map((entry) => entry.id).sort()).toEqual([
			'CVE-2026-102276', 'CVE-2026-102278', 'CVE-2026-19534'
		]);
		for (const entry of ignored.vulnerabilities) {
			const dependency = entry.id === 'CVE-2026-19534' ? 'undici' : 'brace-expansion';
			const version = dependency === 'undici' ? '6.28.0' : '5.0.9';
			expect(entry.paths).toEqual([`usr/local/lib/node_modules/npm/node_modules/${dependency}/package.json`]);
			expect(entry.purls).toEqual([`pkg:npm/${dependency}@${version}`]);
			expect(String(entry.expired_at)).toBe('2026-11-04');
		}
		const workflow = Bun.YAML.parse(readFileSync(join(WORKFLOWS, 'gates.yml'), 'utf8')) as {
			jobs: { images: { steps: Array<{ uses?: string; env?: Record<string, string>; with?: Record<string, unknown> }> } };
		};
		for (const step of workflow.jobs.images.steps.filter((step) => step.uses?.startsWith('aquasecurity/trivy-action@'))) {
			expect(step.env?.TRIVY_IGNOREFILE).toBe(step.with?.severity === 'HIGH' ? '.github/trivy-ignore.yaml' : undefined);
		}
	});

	test('unprivileged CI also runs for contributors in forks', () => {
		const ci = Bun.YAML.parse(readFileSync(join(WORKFLOWS, 'ci.yml'), 'utf8')) as {
			permissions: Record<string, string>;
			jobs: { gates: { if?: string; uses: string; secrets?: unknown } };
		};
		expect(ci.permissions).toEqual({ contents: 'read' });
		expect(ci.jobs.gates.if).toBeUndefined();
		expect(ci.jobs.gates.secrets).toBeUndefined();
		expect(ci.jobs.gates.uses).toBe('./.github/workflows/gates.yml');
	});

	test('all workflows parse as YAML', () => {
		for (const file of readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yml'))) {
			expect(() => Bun.YAML.parse(readFileSync(join(WORKFLOWS, file), 'utf8'))).not.toThrow();
		}
	});

	test('workflows use the reviewed stable Node 24 and composite action releases', () => {
		const actions = new Set<string>();
		for (const file of readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yml'))) {
			const workflow = Bun.YAML.parse(readFileSync(join(WORKFLOWS, file), 'utf8')) as {
				jobs: Record<string, { uses?: string; steps?: Array<{ uses?: string }> }>;
			};
			for (const job of Object.values(workflow.jobs)) {
				for (const action of [job.uses, ...(job.steps ?? []).map((step) => step.uses)]) {
					if (action && !action.startsWith('./')) actions.add(action);
				}
			}
		}
		expect([...actions].sort()).toEqual([
			'actions/checkout@v7.0.1',
			'actions/configure-pages@v6.0.0',
			'actions/deploy-pages@v5.0.1',
			'actions/download-artifact@v8.0.1',
			'actions/setup-node@v7.1.0',
			'actions/upload-artifact@v7.0.1',
			'actions/upload-pages-artifact@v5.0.0',
			'aquasecurity/trivy-action@v0.36.0',
			'docker/build-push-action@v7.4.0',
			'docker/login-action@v4.6.0',
			'docker/setup-buildx-action@v4.4.1',
			'docker/setup-qemu-action@v4.4.0',
			'oven-sh/setup-bun@v2.2.0',
			'sigstore/cosign-installer@v4.1.2'
		]);
	});

	test('every runtime image is built, scanned, and smoked on both supported architectures', () => {
		const workflow = Bun.YAML.parse(readFileSync(join(WORKFLOWS, 'gates.yml'), 'utf8')) as {
			jobs: {
				images: {
					'runs-on': string;
					strategy: {
						matrix: {
							platform: string[];
							image: string[];
							include: Array<{ image?: string; file?: string; platform?: string; runner?: string }>;
						};
					};
					steps: Array<{
						name?: string;
						uses?: string;
						with?: Record<string, unknown>;
						run?: string;
					}>;
				};
			};
		};
		const images = workflow.jobs.images;
		expect(images.strategy.matrix.platform).toEqual(['linux/amd64', 'linux/arm64']);
		expect(images.strategy.matrix.image).toEqual(['assistant', 'guardian', 'portal']);
		expect(
			images.strategy.matrix.include
				.map((entry) => entry.image)
				.filter(Boolean)
				.sort()
		).toEqual(['assistant', 'guardian', 'portal']);
		expect(images['runs-on']).toBe('${{ matrix.runner }}');
		expect(images.strategy.matrix.include).toContainEqual({
			platform: 'linux/arm64',
			runner: 'ubuntu-24.04-arm'
		});
		expect(images.strategy.matrix.include).toContainEqual({
			platform: 'linux/amd64',
			runner: 'ubuntu-latest'
		});
		expect(images.steps.some((step) => step.uses?.startsWith('docker/setup-qemu-action@'))).toBe(
			false
		);
		expect(
			images.steps.some((step) => step.name === 'Assert native architecture for runtime tests')
		).toBe(true);
		const build = images.steps.find((step) => step.uses?.startsWith('docker/build-push-action@'));
		expect(build?.with?.platforms).toBe('${{ matrix.platform }}');
		expect(
			images.steps.filter((step) => step.uses?.startsWith('aquasecurity/trivy-action@')).length
		).toBe(3);
		const scans = images.steps.filter((step) =>
			step.uses?.startsWith('aquasecurity/trivy-action@')
		);
		expect(scans.every((step) => step.with?.version === 'v0.75.0')).toBe(true);
		expect(
			scans.some(
				(step) =>
					step.with?.severity === 'CRITICAL' &&
					step.with?.['exit-code'] === '1' &&
					step.with?.['ignore-unfixed'] !== true
			)
		).toBe(true);
		expect(
			scans.some(
				(step) =>
					step.with?.severity === 'HIGH' &&
					step.with?.['exit-code'] === '1' &&
					step.with?.['ignore-unfixed'] === true
			)
		).toBe(true);
		expect(images.steps.some((step) => step.run?.includes('scripts/smoke-image.sh'))).toBe(true);
	});
});

describe('image tool pins', () => {
	test('Assistant upgrades pinned upstream npm at build time and smokes both launchers', () => {
		const dockerfile = readFileSync(join(ROOT, 'containers/assistant/Dockerfile'), 'utf8');
		const smoke = readFileSync(join(ROOT, 'scripts/smoke-image.sh'), 'utf8');
		expect(dockerfile).toMatch(/^ARG NPM_VERSION=\d+\.\d+\.\d+$/m);
		expect(dockerfile).toContain('npm install --global "npm@${NPM_VERSION}"');
		expect(dockerfile).toContain('test "$(npm --version)" = "${NPM_VERSION}"');
		expect(dockerfile).toContain(
			'COPY --from=node-runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm'
		);
		expect(smoke).toContain('test "$(docker exec "$container" npm --version)" = "$expected_npm"');
		expect(smoke).toContain('test "$(docker exec "$container" npx --version)" = "$expected_npm"');
	});

	// core-principles.md: the assistant and Guardian images install OpenCode
	// from their own tools manifests, and those two pins must stay in lockstep.
	test('assistant and guardian opencode-ai pins match', () => {
		const pin = (p: string) =>
			(readJson(p) as { dependencies?: Record<string, string> }).dependencies?.['opencode-ai'];
		const assistant = pin('containers/assistant/tools/package.json');
		expect(assistant).toBeTruthy();
		expect(pin('containers/guardian/tools/package.json')).toBe(assistant);
	});

	test('every active image installs from the audited root lock', () => {
		const root = readJson('package.json') as Manifest & { workspaces?: string[] };
		expect(root.workspaces).toContain('containers/assistant/tools');
		expect(root.workspaces).toContain('containers/guardian/tools');
		for (const dockerfile of [
			'containers/assistant/Dockerfile',
			'containers/guardian/Dockerfile',
			'containers/portal/Dockerfile'
		]) {
			const source = readFileSync(join(ROOT, dockerfile), 'utf8');
			expect(source).toContain('COPY package.json bun.lock ./');
			expect(source).toContain('--frozen-lockfile');
		}
	});
});

describe('portal image source boundary', () => {
	test('copies only the unified private portal package', () => {
		const dockerfile = readFileSync(join(ROOT, 'containers/portal/Dockerfile'), 'utf8');
		expect(dockerfile).toContain('COPY packages/portal/package.json');
		expect(dockerfile).toContain('COPY packages/portal/src');
		expect(dockerfile).not.toContain('containers/portal/tools/package.json');
	});
});

describe('release completeness gate', () => {
	const productName = readElectronProductName();

	test('the builder declares the optional Admin product', () => {
		expect(productName).toBe('fhold Admin');
	});

	test('Admin artifacts have explicit updater-free, dash-safe names', () => {
		const builder = readFileSync(join(ROOT, 'packages/electron/electron-builder.yml'), 'utf8');
		expect(builder).toContain('publish: null');
		expect(builder).toContain('artifactName: fhold-admin-${version}-${arch}-${os}.${ext}');
		expect(builder).not.toMatch(/^mac:|^win:/m);
	});

	test('the cli job matrix and CLI_BINARIES stay in lockstep', () => {
		const workflow = Bun.YAML.parse(readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8')) as {
			jobs: { cli: { strategy: { matrix: { include: Array<{ asset: string }> } } } };
		};
		const matrixAssets = workflow.jobs.cli.strategy.matrix.include.map((entry) => entry.asset);
		// The Actions matrix must stay static YAML, so this is the one
		// hand-maintained copy of the CLI asset list; every other consumer in
		// this repo's release tooling derives from CLI_BINARIES instead of
		// repeating it, and this test is what keeps the two matched.
		expect(matrixAssets.sort()).toEqual([...CLI_BINARIES].sort());
	});

	test('both CLI release artifacts are smoked on their native Linux runners', () => {
		const workflow = Bun.YAML.parse(readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8')) as {
			jobs: {
				cli: {
					strategy: { matrix: { include: Array<{ os: string; asset: string }> } };
					steps: Array<{ name?: string; run?: string }>;
				};
			};
		};
		const cli = workflow.jobs.cli;
		expect(cli.strategy.matrix.include).toContainEqual({
			os: 'ubuntu-latest',
			script: 'build:linux-x64',
			asset: 'fhold-cli-linux-x64'
		});
		expect(cli.strategy.matrix.include).toContainEqual({
			os: 'ubuntu-24.04-arm',
			script: 'build:linux-arm64',
			asset: 'fhold-cli-linux-arm64'
		});
		const smoke = cli.steps.find((step) => step.name === 'Smoke the fresh native CLI artifact');
		expect(smoke?.run).toContain('CLI artifact does not match its native runner');
		expect(smoke?.run).toContain('exit 1');
		expect(smoke?.run).toContain('"./packages/cli/dist/${ASSET}" --version');
		expect(smoke?.run).toContain('"./packages/cli/dist/${ASSET}" --help');
	});

	test('release assembly downloads every fhold artifact and creates checksums', () => {
		const release = readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8');
		expect(release).toContain('pattern: fhold-*');
		expect(release).toContain('sha256sum -- * > checksums-sha256.txt');
		expect(release).toContain('node scripts/validate-release-assets.mjs --write-manifest');
	});

	test('the MCPB job is a required release dependency', () => {
		const workflow = Bun.YAML.parse(readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8')) as {
			jobs: {
				'claude-extension': { steps: Array<{ run?: string }> };
				release: { needs: string[] };
			};
		};
		expect(workflow.jobs.release.needs).toContain('claude-extension');
		expect(
			workflow.jobs['claude-extension'].steps.some(
				(step) => step.run === 'bun run --cwd packages/claude-desktop pack'
			)
		).toBe(true);
	});

	test('release calls the shared gates workflow', () => {
		const release = Bun.YAML.parse(readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8')) as {
			jobs: { gates: { uses?: string } };
		};
		expect(release.jobs.gates.uses).toBe('./.github/workflows/gates.yml');
	});

	test('publishes only on GitHub with its built-in token and verifies uploads', () => {
		const source = readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8');
		const workflow = Bun.YAML.parse(source) as {
			jobs: { release: { steps: Array<{ run?: string; env?: Record<string, string> }> } };
		};
		const publish = workflow.jobs.release.steps.find((step) =>
			step.run?.includes('gh release download')
		);
		expect(publish?.env?.GH_TOKEN).toBe('${{ github.token }}');
		expect(publish?.run).toContain('--target "${RELEASE_SHA}"');
		expect(publish?.run).toContain('--prerelease --latest=false');
		expect(publish?.run).toContain('sha256sum --check --strict checksums-sha256.txt');
		expect(publish?.run).toContain('--draft=false');
		expect(publish?.env).toEqual({
			GH_TOKEN: '${{ github.token }}',
			RELEASE_SHA: '${{ github.sha }}',
			VERSION: '${{ needs.validate.outputs.version }}',
			PRERELEASE: '${{ needs.validate.outputs.prerelease }}'
		});
	});

	test('publication remains canonical-only and separately configured', () => {
		const workflow = Bun.YAML.parse(readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8')) as {
			jobs: {
				validate: { steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> };
				images: { steps: Array<{ uses?: string; if?: string; with?: Record<string, unknown> }> };
				release: { steps: Array<{ name?: string; if?: string }> };
			};
		};
		const validate = workflow.jobs.validate.steps.find(
			(step) => step.name === 'Validate the stamped release'
		);
		expect(validate?.env?.ACTIONS_ORIGIN).toBe('${{ github.server_url }}');
		expect(validate?.env?.ACTIONS_REPOSITORY).toBe('${{ github.repository }}');
		expect(validate?.env?.FH_PUBLICATION_CONFIGURED).toBe('${{ vars.FH_PUBLICATION_CONFIGURED }}');
		expect(validate?.run).toContain("process.env.ACTIONS_ORIGIN !== 'https://github.com'");
		expect(validate?.run).toContain("process.env.ACTIONS_REPOSITORY !== 'fwdslsh/fhold'");
		expect(validate?.run).toContain(
			"process.env.DRY_RUN !== 'true' && process.env.FH_PUBLICATION_CONFIGURED !== 'true'"
		);
		const login = workflow.jobs.images.steps.find((step) =>
			step.uses?.startsWith('docker/login-action@')
		);
		expect(login?.if).toBe('inputs.dry_run != true');
		expect(login?.with).toEqual({
			username: '${{ secrets.DOCKERHUB_USERNAME }}',
			password: '${{ secrets.DOCKERHUB_TOKEN }}'
		});
		const cosign = workflow.jobs.images.steps.find((step) =>
			step.uses?.startsWith('sigstore/cosign-installer@')
		);
		expect(cosign?.if).toBe('inputs.dry_run != true');
		expect(cosign?.with?.['cosign-release']).toBe('v3.1.3');
		expect(
			workflow.jobs.release.steps.find(
				(step) => step.name === 'Publish the verified GitHub release'
			)?.if
		).toBe('inputs.dry_run != true');
	});

	test('the shared gate validates all active packages and optional artifacts', () => {
		const gates = readFileSync(join(WORKFLOWS, 'gates.yml'), 'utf8');
		expect(gates).toContain('run: bun run check');
		expect(gates).toContain('run: bun run test');
		expect(gates).toContain('run: bun run lint');
		expect(gates).toContain('bun run --cwd packages/electron bundle');
		expect(gates).toContain('bun run --cwd packages/claude-desktop pack');
	});

	test('only Linux Admin targets are required with unambiguous architecture', () => {
		expect(expectedAdminAssets('0.1.2610020008-alpha.1', productName)).toEqual([
			'fhold-admin-0.1.2610020008-alpha.1-x86_64-linux.AppImage',
			'fhold-admin-0.1.2610020008-alpha.1-arm64-linux.AppImage'
		]);
	});

	test('required assets cover CLI, Admin, MCPB, and checksums without updater feeds', () => {
		const required = requiredReleaseAssets('0.1.2610020008-beta.1', productName);
		for (const binary of CLI_BINARIES) expect(required).toContain(binary);
		for (const asset of expectedAdminAssets('0.1.2610020008-beta.1', productName))
			expect(required).toContain(asset);
		expect(required).toContain(expectedClaudeExtensionAsset('0.1.2610020008-beta.1'));
		expect(required.some((name) => /mac\.zip|\.exe$/.test(name))).toBe(false);
		expect(required).toContain('checksums-sha256.txt');
		expect(required.some((name) => name.endsWith('.yml'))).toBe(false);
	});

	test('checksumFor treats the release filename as opaque, including spaces', () => {
		const hash = 'f'.repeat(64);
		const checksums = `${hash}  fhold Setup 0.1.2610020008-alpha.1.exe\n`;
		expect(checksumFor(checksums, 'fhold Setup 0.1.2610020008-alpha.1.exe')).toBe(hash);
	});

	function withDir(run: (dir: string) => void): void {
		const dir = mkdtempSync(join(tmpdir(), 'release-assets-'));
		try {
			run(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	function writeCompleteDist(dir: string, version: string): string[] {
		const required = requiredReleaseAssets(version, productName);
		const withoutChecksums = required.filter((name) => name !== 'checksums-sha256.txt');
		for (const name of withoutChecksums) writeFileSync(join(dir, name), `content-of-${name}`);

		const lines = withoutChecksums.map((name) => {
			const hash = createHash('sha256')
				.update(readFileSync(join(dir, name)))
				.digest('hex');
			return `${hash}  ${name}`;
		});
		writeFileSync(join(dir, 'checksums-sha256.txt'), `${lines.join('\n')}\n`);
		writeReleaseAssetManifest(dir, version, productName);
		return required;
	}

	test('validateReleaseAssets passes a complete, checksummed asset set', () => {
		withDir((dir) => {
			writeCompleteDist(dir, '0.1.2610020008-alpha.1');
			expect(validateReleaseAssets(dir, '0.1.2610020008-alpha.1', productName)).toEqual([]);
		});
	});

	test('daily-build releases share artifact naming, checksums and immutable retry validation', () => {
		withDir((dir) => {
			const version = '0.2.2610081-beta.1';
			const required = writeCompleteDist(dir, version);
			expect(required).toContain(`fhold-admin-${version}-x86_64-linux.AppImage`);
			expect(required).toContain(`fhold-claude-desktop-${version}.mcpb`);
			expect(validateReleaseAssets(dir, version, productName)).toEqual([]);
			expect(() => writeReleaseAssetManifest(dir, version, productName)).not.toThrow();
		});
		expect(() => requiredReleaseAssets('0.2.26100801-beta.1')).toThrow('Invalid');
	});

	test('release asset retries are immutable and version/calendar validation is shared', () => {
		withDir((dir) => {
			const version = '0.1.2610020008-alpha.1';
			writeCompleteDist(dir, version);
			expect(() => writeReleaseAssetManifest(dir, version, productName)).not.toThrow();
			writeFileSync(join(dir, CLI_BINARIES[0]), 'different retry bytes');
			expect(() => writeReleaseAssetManifest(dir, version, productName)).toThrow('Immutable');
		});
		expect(() => requiredReleaseAssets('0.1.2602300000')).toThrow('Invalid');
	});

	test('validateReleaseAssets fails closed when every Admin artifact is missing', () => {
		withDir((dir) => {
			writeCompleteDist(dir, '0.1.2610020008-alpha.1');
			const admin = expectedAdminAssets('0.1.2610020008-alpha.1', productName);
			for (const asset of admin) rmSync(join(dir, asset));
			const problems = validateReleaseAssets(dir, '0.1.2610020008-alpha.1', productName);
			for (const asset of admin) expect(problems).toContain(`Missing release asset: ${asset}`);
			expect(problems.length).toBeGreaterThanOrEqual(admin.length);
		});
	});

	test('validateReleaseAssets catches an Admin artifact corrupted in transit', () => {
		withDir((dir) => {
			writeCompleteDist(dir, '0.1.2610020008-alpha.1');
			writeFileSync(
				join(dir, 'fhold-admin-0.1.2610020008-alpha.1-arm64-linux.AppImage'),
				'corrupted-in-transit'
			);
			const problems = validateReleaseAssets(dir, '0.1.2610020008-alpha.1', productName);
			expect(problems).toContain(
				'Checksum mismatch for fhold-admin-0.1.2610020008-alpha.1-arm64-linux.AppImage'
			);
		});
	});

	test('validateReleaseAssets rejects undeclared release files in the manifest', () => {
		withDir((dir) => {
			writeCompleteDist(dir, '0.1.2610020008-alpha.1');
			const manifestPath = join(dir, 'release-assets-manifest.json');
			const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { assets: string[] };
			manifest.assets.push('undeclared-updater.yml');
			writeFileSync(manifestPath, JSON.stringify(manifest));
			const problems = validateReleaseAssets(dir, '0.1.2610020008-alpha.1', productName);
			expect(problems).toContain('Unexpected release asset in manifest: undeclared-updater.yml');
		});
	});
});

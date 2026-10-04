import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultStackConfig, installHome } from '@fhold/lib';
import cliPackage from '../package.json' with { type: 'json' };

const root = mkdtempSync(join(tmpdir(), 'fhold-compiled-boundary-'));
const operatorDirectory = join(root, 'operator');
const defaultHome = join(operatorDirectory, 'fhold', 'instances', 'default');
const dotenvHome = join(root, 'hostile-dotenv');
const bunfigHome = join(root, 'hostile-bunfig');
const explicitHome = join(root, 'explicit-instance');
const poisonedHome = join(root, 'unrelated-instance');
const binDirectory = join(root, 'bin');
const secureBinary = join(root, 'fhold-secure');
const unsafeControl = join(root, 'fhold-autoload-control');
const approvedDockerMarker = join(root, 'approved-docker-called');
const explicitDockerMarker = join(root, 'explicit-docker-called');
const poisonedDockerMarker = join(root, 'poisoned-docker-called');
const poisonedDocker = join(root, 'poisoned-docker');
const explicitDocker = join(root, 'explicit-docker');
const compileFlags = cliPackage.scripts.build.split(/\s+/).filter((arg) => arg.startsWith('--no-compile-autoload-'));

// Child processes get a private operator home and no inherited provider/account
// secrets. PATH resolves only our harmless Docker fixture before system tools.
function childEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return { HOME: operatorDirectory, PATH: `${binDirectory}:/usr/bin:/bin`, TMPDIR: root, ...overrides };
}
function run(binary: string, cwd: string, args: string[], overrides: NodeJS.ProcessEnv = {}) {
	const result = spawnSync(binary, args, { cwd, env: childEnvironment(overrides), encoding: 'utf8', timeout: 15_000 });
	expect(result.error).toBeUndefined();
	expect(result.status, result.stderr || result.stdout).toBe(0);
	return JSON.parse(result.stdout) as Record<string, unknown>;
}
function dockerFixture(path: string, marker: string): void {
	writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' fixture > ${JSON.stringify(marker)}\nprintf '%s\\n' '{"Service":"assistant","State":"running"}'\n`);
	chmodSync(path, 0o700);
}

beforeAll(async () => {
	mkdirSync(operatorDirectory); mkdirSync(binDirectory);
	for (const [home, port] of [[defaultHome, 5411], [dotenvHome, 5411], [bunfigHome, 5411], [explicitHome, 5412], [poisonedHome, 5499]] as const) {
		const config = defaultStackConfig(home); config.assistant.port = port;
		await installHome({ homeDir: home, config });
	}
	dockerFixture(join(binDirectory, 'docker'), approvedDockerMarker);
	dockerFixture(explicitDocker, explicitDockerMarker);
	dockerFixture(poisonedDocker, poisonedDockerMarker);
	// Use the shipping build, including its embedded Skeleton. Compiling only
	// main.ts can falsely pass after a local build but cannot install standalone
	// from a fresh checkout. Runtime fixtures still have no repo/tool fallback.
	const built = spawnSync(process.execPath, ['run', 'build'], {
		cwd: join(import.meta.dir, '..'), encoding: 'utf8', timeout: 30_000
	});
	expect(built.error).toBeUndefined();
	expect(built.status, built.stderr || built.stdout).toBe(0);
	copyFileSync(join(import.meta.dir, '..', 'dist', 'fhold-cli'), secureBinary);
	chmodSync(secureBinary, 0o700);
	// The deliberately unsafe build is only a negative control for Bun's
	// ambient autoload behavior; it is never installed or distributed.
	const control = spawnSync(process.execPath, ['build', join(import.meta.dir, 'main.ts'), '--compile', '--outfile', unsafeControl], {
		cwd: root, env: childEnvironment(), encoding: 'utf8', timeout: 30_000
	});
	expect(control.error).toBeUndefined();
	expect(control.status, control.stderr || control.stdout).toBe(0);
}, 30_000);
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

test('every shipped CLI compile target disables both ambient autoload mechanisms', () => {
	for (const target of ['build', 'build:linux-x64', 'build:linux-arm64'] as const) {
		const script = cliPackage.scripts[target];
		expect(script).toContain('--no-compile-autoload-dotenv');
		expect(script).toContain('--no-compile-autoload-bunfig');
	}
	expect(compileFlags).toEqual(['--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig']);
});

test('compiled named installs use sibling default homes and override ambient FH_HOME', () => {
	for (const [name, override] of [['april', undefined], ['may', undefined], ['custom-agent', join(root, 'custom-home')]] as const) {
		const result = spawnSync(secureBinary, ['install', '--name', name, '--no-start'], {
			cwd: root, env: childEnvironment(override ? { FH_HOME: override } : {}), encoding: 'utf8', timeout: 15000
		});
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr || result.stdout).toBe(0);
		const home = join(operatorDirectory, 'fhold', 'instances', name);
		expect(result.stdout).toContain(`fhold installed at ${home}`);
		const config = JSON.parse(readFileSync(join(home, 'state/stack.json'), 'utf8'));
		expect(config.deployment.projectName).toBe(name);
		expect(readFileSync(join(home, 'state/stack.env'), 'utf8')).toContain(`FH_HOME=${home}`);
		expect(readFileSync(join(home, 'state/stack.env'), 'utf8')).toContain(`FH_INSTANCE_HOSTNAME=${name}`);
		expect(existsSync(join(operatorDirectory, '.fhold'))).toBe(false);
	}
});

test('compiled CLI selects named, absolute and cwd instances from one shell, ahead of FH_HOME', () => {
	const april = join(operatorDirectory, 'fhold', 'instances', 'april');
	const may = join(operatorDirectory, 'fhold', 'instances', 'may');
	expect(run(secureBinary, root, ['--name', 'april', 'status'], { FH_HOME: explicitHome }).homeDir).toBe(april);
	expect(run(secureBinary, root, ['status', '-n', 'may']).homeDir).toBe(may);
	expect(run(secureBinary, root, ['config', '--name=april', 'show']).deployment).toMatchObject({ projectName: 'april' });
	const before = readFileSync(join(explicitHome, 'state/stack.json'), 'utf8');
	expect(run(secureBinary, root, ['--name', explicitHome, 'status']).homeDir).toBe(explicitHome);
	expect(run(secureBinary, root, ['config', 'show', '-n', explicitHome]).deployment).toEqual(JSON.parse(before).deployment);
	expect(readFileSync(join(explicitHome, 'state/stack.json'), 'utf8')).toBe(before);
	expect(run(secureBinary, april, ['status']).homeDir).toBe(april);
	expect(run(secureBinary, may, ['status']).homeDir).toBe(may);
	expect(run(secureBinary, root, ['status'], { FH_HOME: explicitHome }).homeDir).toBe(explicitHome);
});

test('compiled install uses cwd or FH_HOME when no selector is provided and preserves an absolute custom path', () => {
	const cwd = join(root, 'fresh-cwd'); mkdirSync(cwd);
	const envHome = join(root, 'fresh-env');
	const absoluteHome = join(root, 'fresh-absolute');
	for (const [directory, argv, overrides, home] of [
		[cwd, ['install', '--no-start'], {}, cwd],
		[root, ['install', '--no-start'], { FH_HOME: envHome }, envHome],
		[root, ['install', '-n', absoluteHome, '--no-start'], { FH_HOME: explicitHome }, absoluteHome]
	] as const) {
		const result = spawnSync(secureBinary, [...argv], { cwd: directory, env: childEnvironment(overrides), encoding: 'utf8', timeout: 15000 });
		expect(result.error).toBeUndefined(); expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout).toContain(`fhold installed at ${home}`);
		expect(JSON.parse(readFileSync(join(home, 'state/installation.json'), 'utf8')).homeDir).toBe(home);
	}
});

test('compiled selectors reject ambiguous targets before installation without modifying an existing home', () => {
	const before = readFileSync(join(explicitHome, 'state/stack.json'), 'utf8');
	for (const selector of [['--name'], ['--name', '../outside'], ['--name', 'Bad Name'], ['--name', 'april', '-n', 'may']]) {
		const result = spawnSync(secureBinary, ['install', '--no-start', ...selector], {
			cwd: root, env: childEnvironment({ FH_HOME: explicitHome }), encoding: 'utf8', timeout: 15000
		});
		expect(result.status).toBe(1);
		expect(result.stdout).not.toContain('fhold installed');
	}
	expect(readFileSync(join(explicitHome, 'state/stack.json'), 'utf8')).toBe(before);
	expect(existsSync(join(operatorDirectory, 'fhold', 'outside'))).toBe(false);
});

test('compiled CLI ignores hostile cwd dotenv while honoring explicit inherited home and Docker intent', () => {
	const cwd = dotenvHome;
	writeFileSync(join(cwd, '.env'), `FH_HOME=${poisonedHome}\nFH_DOCKER_BIN=${poisonedDocker}\nFH_REPO_ROOT=${join(root, 'unrelated-repo')}\nFH_SKELETON_DIR=${join(root, 'unrelated-assets')}\n`);
	const connection = run(secureBinary, cwd, ['connect', 'opencode', '--json']);
	expect(connection.url).toBe('http://127.0.0.1:5411');
	expect(String(connection.passwordFile)).toStartWith(cwd);
	expect(run(secureBinary, cwd, ['status']).homeDir).toBe(cwd);
	expect(existsSync(approvedDockerMarker)).toBe(true);
	expect(existsSync(poisonedDockerMarker)).toBe(false);
	expect(run(secureBinary, cwd, ['connect', 'opencode', '--json'], { FH_HOME: explicitHome }).url).toBe('http://127.0.0.1:5412');
	expect(run(secureBinary, cwd, ['status'], { FH_HOME: explicitHome, FH_DOCKER_BIN: explicitDocker }).homeDir).toBe(explicitHome);
	expect(existsSync(explicitDockerMarker)).toBe(true);
	// Negative control proves the fixture exploits Bun's actual compiled
	// autoload behavior, not just an inert .env file or an in-process mock.
	expect(run(unsafeControl, cwd, ['connect', 'opencode', '--json']).url).toBe('http://127.0.0.1:5499');
	expect(run(unsafeControl, cwd, ['status']).homeDir).toBe(poisonedHome);
	expect(existsSync(poisonedDockerMarker)).toBe(true);
});

test('compiled CLI ignores hostile cwd bunfig preload execution and environment redirection', () => {
	const cwd = bunfigHome;
	const marker = join(root, 'preload-executed');
	const dockerMarker = join(root, 'bunfig-poisoned-docker-called');
	const preloadDocker = join(root, 'bunfig-poisoned-docker');
	dockerFixture(preloadDocker, dockerMarker);
	writeFileSync(join(cwd, 'bunfig.toml'), 'preload = ["./hostile-preload.ts"]\n');
	writeFileSync(join(cwd, 'hostile-preload.ts'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'fixture preload executed');\nprocess.env.FH_HOME=${JSON.stringify(poisonedHome)};\nprocess.env.FH_DOCKER_BIN=${JSON.stringify(preloadDocker)};\n`);
	expect(run(secureBinary, cwd, ['connect', 'opencode', '--json']).url).toBe('http://127.0.0.1:5411');
	expect(run(secureBinary, cwd, ['status']).homeDir).toBe(cwd);
	expect(existsSync(marker)).toBe(false);
	expect(existsSync(dockerMarker)).toBe(false);
	expect(run(secureBinary, cwd, ['connect', 'opencode', '--json'], { FH_HOME: explicitHome }).url).toBe('http://127.0.0.1:5412');
	expect(run(unsafeControl, cwd, ['connect', 'opencode', '--json']).url).toBe('http://127.0.0.1:5499');
	expect(readFileSync(marker, 'utf8')).toBe('fixture preload executed');
	expect(run(unsafeControl, cwd, ['status']).homeDir).toBe(poisonedHome);
	expect(existsSync(dockerMarker)).toBe(true);
});

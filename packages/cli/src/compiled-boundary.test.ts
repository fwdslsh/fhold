import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultStackConfig, installHome } from '@fhold/lib';
import cliPackage from '../package.json' with { type: 'json' };

const root = mkdtempSync(join(tmpdir(), 'fhold-compiled-boundary-'));
const operatorDirectory = join(root, 'operator');
const defaultHome = join(operatorDirectory, '.fhold');
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
	expect(result.status).toBe(0);
	return JSON.parse(result.stdout) as Record<string, unknown>;
}
function dockerFixture(path: string, marker: string): void {
	writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' fixture > ${JSON.stringify(marker)}\nprintf '%s\\n' '{"Service":"assistant","State":"running"}'\n`);
	chmodSync(path, 0o700);
}

beforeAll(async () => {
	mkdirSync(operatorDirectory); mkdirSync(binDirectory);
	for (const [home, port] of [[defaultHome, 5411], [explicitHome, 5412], [poisonedHome, 5499]] as const) {
		const config = defaultStackConfig(home); config.assistant.port = port;
		await installHome({ homeDir: home, config });
	}
	dockerFixture(join(binDirectory, 'docker'), approvedDockerMarker);
	dockerFixture(explicitDocker, explicitDockerMarker);
	dockerFixture(poisonedDocker, poisonedDockerMarker);
	for (const [binary, flags] of [[secureBinary, compileFlags], [unsafeControl, []]] as const) {
		// Compile the actual CLI entry with process.execPath into a generated
		// temporary target. Never write build output to source production dirs.
		const result = spawnSync(process.execPath, ['build', join(import.meta.dir, 'main.ts'), '--compile', ...flags, '--outfile', binary], { cwd: root, env: childEnvironment(), encoding: 'utf8', timeout: 30_000 });
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
	}
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

test('compiled CLI ignores hostile cwd dotenv while honoring explicit inherited home and Docker intent', () => {
	const cwd = join(root, 'hostile-dotenv'); mkdirSync(cwd);
	writeFileSync(join(cwd, '.env'), `FH_HOME=${poisonedHome}\nFH_DOCKER_BIN=${poisonedDocker}\nFH_REPO_ROOT=${join(root, 'unrelated-repo')}\nFH_SKELETON_DIR=${join(root, 'unrelated-assets')}\n`);
	const connection = run(secureBinary, cwd, ['connect', 'opencode', '--json']);
	expect(connection.url).toBe('http://127.0.0.1:5411');
	expect(String(connection.passwordFile)).toStartWith(defaultHome);
	expect(run(secureBinary, cwd, ['status']).homeDir).toBe(defaultHome);
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
	const cwd = join(root, 'hostile-bunfig'); mkdirSync(cwd);
	const marker = join(root, 'preload-executed');
	const dockerMarker = join(root, 'bunfig-poisoned-docker-called');
	const preloadDocker = join(root, 'bunfig-poisoned-docker');
	dockerFixture(preloadDocker, dockerMarker);
	writeFileSync(join(cwd, 'bunfig.toml'), 'preload = ["./hostile-preload.ts"]\n');
	writeFileSync(join(cwd, 'hostile-preload.ts'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'fixture preload executed');\nprocess.env.FH_HOME=${JSON.stringify(poisonedHome)};\nprocess.env.FH_DOCKER_BIN=${JSON.stringify(preloadDocker)};\n`);
	expect(run(secureBinary, cwd, ['connect', 'opencode', '--json']).url).toBe('http://127.0.0.1:5411');
	expect(run(secureBinary, cwd, ['status']).homeDir).toBe(defaultHome);
	expect(existsSync(marker)).toBe(false);
	expect(existsSync(dockerMarker)).toBe(false);
	expect(run(secureBinary, cwd, ['connect', 'opencode', '--json'], { FH_HOME: explicitHome }).url).toBe('http://127.0.0.1:5412');
	expect(run(unsafeControl, cwd, ['connect', 'opencode', '--json']).url).toBe('http://127.0.0.1:5499');
	expect(readFileSync(marker, 'utf8')).toBe('fixture preload executed');
	expect(run(unsafeControl, cwd, ['status']).homeDir).toBe(poisonedHome);
	expect(existsSync(dockerMarker)).toBe(true);
});

import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { retainAdminE2eHome } from './admin-e2e-retention.mjs';

const packageDirectory = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(packageDirectory, '../..');
const generatedRoot = process.env.FH_ADMIN_E2E_HOME
	? null
	: mkdtempSync(join(tmpdir(), 'fhold-admin-e2e-'));
const homeDirectory = process.env.FH_ADMIN_E2E_HOME || join(generatedRoot, 'home');
const outputDirectory =
	process.env.FH_ADMIN_E2E_OUTPUT ||
	mkdtempSync(join(tmpdir(), 'fhold-admin-e2e-artifacts-'));
const projectName = `fhold-admin-e2e-${process.pid}`;
const keepRunning = process.env.FH_ADMIN_E2E_KEEP_RUNNING === 'true';
let keepHome = retainAdminE2eHome(process.env);

if (!isAbsolute(homeDirectory) || !isAbsolute(outputDirectory)) {
	throw new Error('Admin E2E home and output paths must be absolute.');
}
if (existsSync(homeDirectory) && readdirSync(homeDirectory).length > 0) {
	throw new Error(`Refusing non-empty Admin E2E home: ${homeDirectory}`);
}
if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
	throw new Error('Admin E2E needs DISPLAY or WAYLAND_DISPLAY. Run it from a desktop session.');
}

async function freePort() {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.unref();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close();
				reject(new Error('Could not allocate a local test port.'));
				return;
			}
			server.close((error) => (error ? reject(error) : resolvePort(address.port)));
		});
	});
}

function configuredPort(name) {
	const raw = process.env[name];
	if (!raw) return null;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1 || value > 65_535) {
		throw new Error(`${name} must be an integer from 1 through 65535.`);
	}
	return value;
}

function command(commandName, args, options = {}) {
	const result = spawnSync(commandName, args, {
		cwd: options.cwd || repositoryRoot,
		env: options.env || process.env,
		stdio: options.stdio || 'inherit',
		encoding: 'utf8'
	});
	if (result.error) throw result.error;
	return result;
}

function cleanupStack() {
	const managed = join(homeDirectory, 'system', 'stack', 'stack.compose.yml');
	const custom = join(homeDirectory, 'config', 'stack', 'custom.compose.yml');
	const environment = join(homeDirectory, 'state', 'stack.env');
	if (!existsSync(managed) || !existsSync(environment)) return;
	const args = ['compose', '--project-name', projectName, '-f', managed];
	if (existsSync(custom)) args.push('-f', custom);
	args.push('--env-file', environment, '--profile', 'gateway', 'down', '--remove-orphans');
	command('docker', args, { stdio: 'ignore' });
}

let exitCode = 1;
try {
	const assistantPort = configuredPort('FH_ADMIN_E2E_ASSISTANT_PORT') || (await freePort());
	let guardianPort = configuredPort('FH_ADMIN_E2E_GUARDIAN_PORT') || (await freePort());
	while (guardianPort === assistantPort) guardianPort = await freePort();

	const build = command('bun', ['run', 'bundle:e2e'], { cwd: packageDirectory });
	if (build.status !== 0)
		throw new Error(`Admin E2E bundle failed with exit code ${build.status}.`);

	const electronDirectory = realpathSync(join(packageDirectory, 'node_modules', 'electron'));
	// Current Electron exposes its supported installer explicitly rather than
	// downloading in package postinstall. Use that installer, not a custom fetcher.
	const prepared = command(process.execPath, [join(electronDirectory, 'install.js')]);
	if (prepared.status !== 0) throw new Error('Electron runtime preparation failed.');
	const electron = join(
		electronDirectory,
		'dist',
		readFileSync(join(electronDirectory, 'path.txt'), 'utf8').trim()
	);
	const environment = {
		...process.env,
		FH_HOME: homeDirectory,
		FH_PROJECT_NAME: projectName,
		FH_REPO_ROOT: repositoryRoot,
		FH_ADMIN_E2E_OUTPUT: outputDirectory,
		FH_ADMIN_E2E_KEEP_HOME: String(keepHome),
		FH_ADMIN_E2E_ASSISTANT_PORT: String(assistantPort),
		FH_ADMIN_E2E_GUARDIAN_PORT: String(guardianPort),
		ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
	};
	const args = ['--disable-gpu'];
	if (process.env.XDG_SESSION_TYPE === 'wayland' && process.env.WAYLAND_DISPLAY) {
		args.push('--ozone-platform=wayland');
	}
	if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
	args.push(join(packageDirectory, 'dist', 'admin-e2e.js'));
	const test = command(electron, args, { cwd: packageDirectory, env: environment });
	exitCode = test.status ?? 1;
	if (exitCode !== 0) throw new Error(`Admin E2E exited with code ${exitCode}.`);

	const reportPath = join(outputDirectory, 'report.json');
	if (!existsSync(reportPath)) throw new Error('Admin E2E did not write its report.');
	const report = JSON.parse(readFileSync(reportPath, 'utf8'));
	if (report.ok !== true) throw new Error('Admin E2E report did not indicate success.');
	// A renderer reload is not an app launch. Reuse only this disposable desktop
	// profile in a second native process to exercise the actual startup boundary.
	report.ok = false;
	writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
	const reopened = command(electron, [...args, '--verify-reopened-launch'], {
		cwd: packageDirectory, env: environment
	});
	exitCode = reopened.status ?? 1;
	if (exitCode !== 0) throw new Error(`Admin relaunch E2E exited with code ${exitCode}.`);
	const reopenReport = JSON.parse(readFileSync(join(outputDirectory, 'reopen-report.json'), 'utf8'));
	if (reopenReport.ok !== true) throw new Error('Admin relaunch E2E did not indicate success.');
	report.ok = true;
	report.instanceLaunchVerified = reopenReport.instanceLaunchVerified;
	report.screenshots.push(...reopenReport.screenshots);
	report.visualAudits.push(...reopenReport.visualAudits);
	writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
	process.stdout.write(`Admin E2E artifacts: ${outputDirectory}\n`);
	exitCode = 0;
} finally {
	keepHome ||= retainAdminE2eHome(process.env, homeDirectory);
	for (const name of ['report.json', 'failure.json']) {
		const path = join(outputDirectory, name);
		if (!existsSync(path)) continue;
		try {
			const report = JSON.parse(readFileSync(path, 'utf8'));
			report.homeRetained = keepHome;
			writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
		} catch {
			keepHome = true;
			exitCode = 1;
			process.stderr.write('Could not record E2E retention metadata; private home retained.\n');
		}
	}
	if (!keepRunning) {
		try {
			cleanupStack();
		} catch (error) {
			process.stderr.write(`Targeted E2E cleanup failed: ${String(error)}\n`);
			if (exitCode === 0) exitCode = 1;
		}
	}
	rmSync(join(outputDirectory, 'electron-profile'), { recursive: true, force: true });
	if (generatedRoot && !keepHome) rmSync(generatedRoot, { recursive: true, force: true });
	if (keepHome) process.stdout.write(`Admin E2E private home retained: ${homeDirectory}\n`);
}

process.exitCode = exitCode;

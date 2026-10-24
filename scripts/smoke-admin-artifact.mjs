#!/usr/bin/env node
/** Launch the freshly packaged native Admin without Docker or provider secrets. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expectedAdminAssets } from './validate-release-assets.mjs';
import { createHash } from 'node:crypto';

const version = process.env.VERSION;
if (!version) throw new Error('VERSION is required');
const packaged = resolve(process.env.ADMIN_SMOKE_DIRECTORY ?? 'packages/electron/dist/packages');
const generated = mkdtempSync(join(tmpdir(), 'fhold-packaged-smoke-'));
const report = join(generated, 'startup-report.json');

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: 'utf8',
		timeout: 120_000,
		cwd: generated,
		env: {
			...process.env,
			FH_HOME: join(generated, 'home'),
			// Model a native updater relaunch inheriting an obsolete AppImage mount.
			FH_REPO_ROOT: join(generated, 'obsolete-repo'),
			FH_SKELETON_DIR: join(generated, 'obsolete-mount/skeleton'),
			FH_ADMIN_SMOKE_VERSION: version,
			FH_ADMIN_SMOKE_REPORT: report
		},
		...options
	});
	if (result.error || result.status !== 0) {
		const detail = existsSync(report)
			? readFileSync(report, 'utf8')
			: 'No startup report was produced.';
		throw new Error(
			`Packaged Admin command failed: ${result.error?.message ?? ''}\n${detail}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`
		);
	}
	return result.stdout ?? '';
}

try {
	const platform =
		process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux';
	const arch = platform === 'linux' && process.arch === 'x64' ? 'x86_64' : process.arch;
	const asset =
		process.env.ADMIN_SMOKE_ARTIFACT ||
		expectedAdminAssets(version).find((name) =>
			platform === 'windows' ? name.endsWith('.exe') : name.includes(`-${arch}-${platform}.`)
		);
	if (!asset) throw new Error('No release artifact supports this runner');
	let command;
	let args = ['--fhold-release-smoke', '--disable-gpu'];
	if (platform === 'mac') {
		run('unzip', ['-q', join(packaged, asset), '-d', generated]);
		command = join(generated, 'fhold Admin.app', 'Contents', 'MacOS', 'fhold Admin');
		const contents = join(generated, 'fhold Admin.app/Contents');
		const id = run('/usr/libexec/PlistBuddy', [
			'-c',
			'Print :CFBundleIdentifier',
			join(contents, 'Info.plist')
		]).trim();
		const icon = run('/usr/libexec/PlistBuddy', [
			'-c',
			'Print :CFBundleIconFile',
			join(contents, 'Info.plist')
		]).trim();
		if (id !== 'dev.fwdslsh.fhold.admin' || !existsSync(join(contents, 'Resources', icon)))
			throw new Error('macOS bundle identity or Dock icon is missing');
	} else if (platform === 'windows') {
		const installation = join(generated, 'installed');
		run(join(packaged, asset), ['/S', `/D=${installation}`]);
		command = join(installation, 'fhold Admin.exe');
	} else {
		run(join(packaged, asset), ['--appimage-extract']);
		// This gate runs for release and PR previews before publication. Require
		// both actual resources, byte-identical to this build, not release URLs.
		for (const [helperArch, machine] of [
			['x64', 62],
			['arm64', 183]
		]) {
			const shipped = readFileSync(
				join(generated, 'squashfs-root/resources/management', `fhold-linux-${helperArch}`)
			);
			const built = readFileSync(resolve(`packages/cli/embedded/fhold-linux-${helperArch}`));
			const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
			if (shipped.readUInt16LE(18) !== machine || hash(shipped) !== hash(built))
				throw new Error(`Packaged Admin ${helperArch} management helper differs from this build`);
		}
		const executable = join(generated, 'squashfs-root', 'fhold-admin');
		const virtualDisplay = spawnSync('xvfb-run', ['--help'], { encoding: 'utf8' });
		if (!virtualDisplay.error) {
			command = 'xvfb-run';
			args = ['-a', executable, '--no-sandbox', ...args];
		} else {
			if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
				throw new Error('Packaged Admin requires Xvfb or an accessible display');
			command = executable;
			args = ['--no-sandbox', ...args];
			if (process.env.XDG_SESSION_TYPE === 'wayland' && process.env.WAYLAND_DISPLAY)
				args.push('--ozone-platform=wayland');
		}
	}
	run(command, args, {
		env: {
			...process.env,
			APPIMAGE: platform === 'linux' ? join(packaged, asset) : undefined,
			FH_HOME: join(generated, 'home'),
			FH_REPO_ROOT: join(generated, 'obsolete-repo'),
			FH_SKELETON_DIR: join(generated, 'obsolete-mount/skeleton'),
			FH_ADMIN_SMOKE_VERSION: version,
			FH_ADMIN_SMOKE_REPORT: report,
			FH_ADMIN_SMOKE_DESKTOP: '1'
		}
	});
	const result = existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : null;
	if (result?.ok !== true || result.version !== version)
		throw new Error('Packaged Admin did not confirm renderer and bridge readiness');
	console.log(JSON.stringify(result.progress));
	console.log(`Verified packaged Admin startup: ${asset}`);
} finally {
	console.log(`Packaged smoke fixtures retained at ${generated}`);
}

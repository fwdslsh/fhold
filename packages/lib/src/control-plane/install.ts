import { classifyInstall, ensureRuntime } from './state.js';
import {
	createFholdState,
	ensureHomeDirs,
	managedComposeFile,
	stackConfigFile,
	writeFileAtomic
} from './foundation.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FH_RELEASE_VERSION } from './release.js';
import { applyHomeSeed, preflightHomeSeed } from './seed.js';
import {
	defaultStackConfig,
	isInstanceName,
	parseStackConfig,
	writeStackConfig
} from './stack-config.js';
import { acquireStackLock, releaseStackLock } from './lock.js';
import { chooseInstallPorts } from './install-ports.js';

/** Shared initialization; frontends own Docker/provider prompts and asset resolution. */
export async function installHome(
	options: { homeDir?: string; config?: unknown; name?: string; automaticPorts?: boolean } = {}
): Promise<string> {
	if (options.name !== undefined && !isInstanceName(options.name)) {
		throw new Error(
			'Instance name must be 1–63 lowercase letters, numbers or hyphens, starting and ending with a letter or number.'
		);
	}
	const supplied = options.config === undefined ? undefined : parseStackConfig(options.config);
	if (supplied && !supplied.ok) throw new Error(supplied.error);
	const name =
		options.name ??
		(supplied?.ok ? supplied.config.deployment.projectName : process.env.FH_PROJECT_NAME?.trim() || undefined);
	const state = createFholdState(options.homeDir, name);
	if (classifyInstall(state.homeDir) !== 'not_installed') {
		throw new Error('fhold is already installed or the selected home is not empty.');
	}
	const parsed = supplied ?? parseStackConfig(defaultStackConfig(state.homeDir));
	if (!parsed.ok) throw new Error(parsed.error);
	// Ambient bootstrap values are captured once, never consulted by refresh.
	if (!options.config) {
		parsed.config.deployment.projectName =
			process.env.FH_PROJECT_NAME?.trim() || parsed.config.deployment.projectName;
		parsed.config.deployment.imageNamespace =
			process.env.FH_IMAGE_NAMESPACE?.trim() || parsed.config.deployment.imageNamespace;
		for (const component of ['assistant', 'guardian', 'portal'] as const) {
			parsed.config.deployment.images[component] =
				process.env[`FH_${component.toUpperCase()}_VERSION`]?.trim() ||
				parsed.config.deployment.images[component];
		}
	}
	if (options.name !== undefined) parsed.config.deployment.projectName = options.name;
	const check = parseStackConfig(parsed.config);
	if (!check.ok) throw new Error(check.error);
	const config = (options.automaticPorts ?? options.config === undefined)
		? await chooseInstallPorts(check.config)
		: check.config;
	preflightHomeSeed(state.homeDir);
	ensureHomeDirs(state.homeDir);
	const lock = acquireStackLock(state.dataDir);
	if (!lock) throw new Error('lifecycle_in_progress: Another stack operation is running.');
	try {
		// Another initializer may have won after the read-only classification.
		if (
			existsSync(stackConfigFile(state.homeDir)) ||
			existsSync(managedComposeFile(state.homeDir))
		) {
			throw new Error(
				'fhold was initialized by another operation; refresh the selected installation.'
			);
		}
		// Identity is persisted before reconciliation, which uses final intent once.
		writeStackConfig(state.homeDir, config);
		await applyHomeSeed(state.homeDir);
		ensureRuntime(state);
		writeFileAtomic(
			join(state.homeDir, 'state', 'installation.json'),
			`${JSON.stringify({ product: 'fhold', homeDir: state.homeDir, release: FH_RELEASE_VERSION, managedImages: Object.fromEntries(Object.entries(config.deployment.images).filter(([, tag]) => tag === FH_RELEASE_VERSION)) }, null, 2)}\n`
		);
	} finally {
		releaseStackLock(lock);
	}
	return state.homeDir;
}

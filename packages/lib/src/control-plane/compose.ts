import { existsSync } from 'node:fs';

import { buildComposeArgs, type ComposeOptions } from './docker.js';
import {
	customComposeFile,
	managedComposeFile,
	stackEnvFile,
	type FholdState
} from './foundation.js';
import { enabledAddons, readStackConfig } from './stack-config.js';
import { akmWebComposeFile } from './akm-web.js';

export type { ComposeOptions } from './docker.js';

export function buildComposeOptions(state: FholdState): ComposeOptions {
	const managed = managedComposeFile(state.homeDir);
	if (!existsSync(managed)) throw new Error(`Managed stack file is missing: ${managed}`);
	const custom = customComposeFile(state.homeDir);
	const config = readStackConfig(state.homeDir);
	if (!config.ok) throw Error(config.error);
	const web = config.config.assistant.web?.enabled ? [akmWebComposeFile(state.homeDir)] : [];
	if (web.some((file) => !existsSync(file))) throw Error('AKM Web deployment settings need to be saved before starting.');
	return {
		projectDirectory: state.stackDir,
		files: [managed, ...web, ...(existsSync(custom) ? [custom] : [])],
		envFiles: [stackEnvFile(state.homeDir)],
		profiles: enabledAddons(state.homeDir)
	};
}

export function buildComposeCliArgs(state: FholdState): string[] {
	return buildComposeArgs(buildComposeOptions(state));
}

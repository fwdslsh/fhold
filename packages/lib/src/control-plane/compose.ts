import { existsSync } from 'node:fs';

import { buildComposeArgs, type ComposeOptions } from './docker.js';
import {
	customComposeFile,
	managedComposeFile,
	stackEnvFile,
	type FholdState
} from './foundation.js';
import { enabledAddons } from './stack-config.js';

export type { ComposeOptions } from './docker.js';

export function buildComposeOptions(state: FholdState): ComposeOptions {
	const managed = managedComposeFile(state.homeDir);
	if (!existsSync(managed)) throw new Error(`Managed stack file is missing: ${managed}`);
	const custom = customComposeFile(state.homeDir);
	return {
		projectDirectory: state.stackDir,
		files: existsSync(custom) ? [managed, custom] : [managed],
		envFiles: [stackEnvFile(state.homeDir)],
		profiles: enabledAddons(state.homeDir)
	};
}

export function buildComposeCliArgs(state: FholdState): string[] {
	return buildComposeArgs(buildComposeOptions(state));
}

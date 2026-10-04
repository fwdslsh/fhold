import { defineCommand } from 'citty';

import {
	classifyInstall,
	assertProjectOwnership,
	createFholdState,
	defaultStackConfig,
	ensureDockerReady,
	installHome,
	isInstanceName,
	parseStackConfig
} from '@fhold/lib';

import { seedSkeletonFromEmbedded } from '../lib/embedded-assets.js';
import { completeSetup } from './setup.js';

export type InstallOptions = {
	start: boolean;
	configFile?: string;
	name?: string;
};

async function readConfigFile(path: string): Promise<unknown> {
	const file = Bun.file(path);
	if (!(await file.exists())) throw new Error(`Stack config file not found: ${path}`);
	try {
		return JSON.parse(await file.text());
	} catch (error) {
		throw new Error(
			`Invalid stack config JSON: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

export async function bootstrapInstall(options: InstallOptions): Promise<void> {
	// Validate operator input before writing any installation state, so a typo
	// remains a retryable fresh install rather than a half-materialized home.
	const supplied = options.configFile
		? parseStackConfig(await readConfigFile(options.configFile))
		: null;
	if (supplied && !supplied.ok) throw new Error(supplied.error);
	if (options.name !== undefined && !isInstanceName(options.name))
		throw new Error(
			'Choose an instance name with 1–63 lowercase letters, numbers or hyphens, starting and ending with a letter or number.'
		);
	const name =
		options.name ??
		(supplied?.ok ? supplied.config.deployment.projectName : process.env.FH_PROJECT_NAME?.trim() || undefined);
	const state = createFholdState(undefined, name);
	if (classifyInstall(state.homeDir) !== 'not_installed') {
		throw new Error('fhold is already installed. Use `fhold update` to refresh it.');
	}

	if (options.start) {
		const docker = await ensureDockerReady();
		if (!docker.ok) throw new Error(docker.message);
		await assertProjectOwnership(
			options.name ??
				(supplied?.ok
					? supplied.config.deployment.projectName
					: process.env.FH_PROJECT_NAME?.trim() ||
						defaultStackConfig(state.homeDir).deployment.projectName)
		);
	}

	await seedSkeletonFromEmbedded(
		(homeDir) =>
			installHome({
				homeDir,
				...(supplied?.ok ? { config: supplied.config } : {}),
				...(options.name === undefined ? {} : { name: options.name })
			}),
		state.homeDir
	);

	if (options.start) await completeSetup({ homeDir: state.homeDir });
	const configPath = `${state.homeDir}/state/stack.json`;
	console.log(`fhold installed at ${state.homeDir}`);
	console.log(`Stack intent: ${configPath}`);
	console.log(
		options.start
			? 'Assistant and provider are ready.'
			: 'Run `fhold setup` from this directory, or select it with `--instance`, to start and verify your provider.'
	);
}

export default defineCommand({
	meta: {
		name: 'install',
		description: 'Install fhold and guide provider readiness'
	},
	args: {
		start: {
			type: 'boolean',
			description: 'Start the stack after writing configuration (use --no-start to skip)',
			default: true
		},
		config: {
			type: 'string',
			alias: 'f',
			description: 'stack configuration JSON file'
		},
		name: {
			type: 'string',
			description:
				'Instance name for containers and hostname; use --instance to select its directory'
		}
	},
	async run({ args }) {
		await bootstrapInstall({
			start: args.start !== false,
			configFile: args.config ? String(args.config) : undefined,
			name: args.name === undefined ? undefined : String(args.name)
		});
	}
});

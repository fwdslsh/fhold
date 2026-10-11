import { defineCommand } from 'citty';
import {
	buildComposeCliArgs,
	buildComposeOptions,
	createFholdState,
	inspectLocalInstance,
	operateLocalInstance,
	resolveFholdHome,
	requireInstall,
	runComposeStreaming
} from '@fhold/lib';

import { defineAction } from '../lib/action.js';

export async function runStartAction(homeDir?: string): Promise<void> {
	await operateLocalInstance(resolveFholdHome(homeDir), 'start');
}

export async function runStopAction(): Promise<void> {
	await operateLocalInstance(resolveFholdHome(), 'stop');
}

export async function runRestartAction(homeDir?: string): Promise<void> {
	await operateLocalInstance(resolveFholdHome(homeDir), 'restart');
}

export async function runLogsAction(): Promise<void> {
	const state = createFholdState();
	requireInstall(state.homeDir);
	const options = buildComposeOptions(state);
	await runComposeStreaming([...buildComposeCliArgs(state), 'logs', '--tail', '100'], {
		envFiles: options.envFiles
	});
}

export async function readStatus(): Promise<Record<string, unknown>> {
	const snapshot = await inspectLocalInstance(resolveFholdHome());
	return {
		homeDir: snapshot.location, config: snapshot.config,
		pendingRestart: snapshot.pendingRestart,
		services: snapshot.services.map(row => ({ ...row, service: row.name })),
		...(snapshot.warnings.length ? { dockerError: snapshot.warnings.join(' ') } : {})
	};
}

export const startCommand = defineCommand({
	meta: { name: 'start', description: 'Start the configured stack' },
	run: defineAction(() => runStartAction())
});

export const stopCommand = defineCommand({
	meta: { name: 'stop', description: 'Stop the stack without deleting volumes' },
	run: defineAction(runStopAction)
});

export const restartCommand = defineCommand({
	meta: { name: 'restart', description: 'Recreate the configured stack' },
	run: defineAction(() => runRestartAction())
});

export const logsCommand = defineCommand({
	meta: { name: 'logs', description: 'Print the last 100 service log lines' },
	run: defineAction(runLogsAction)
});

export const statusCommand = defineCommand({
	meta: { name: 'status', description: 'Show stack intent and container status' },
	run: defineAction(async () => console.log(JSON.stringify(await readStatus(), null, 2)))
});

import { defineCommand } from 'citty';
import {
	buildComposeCliArgs,
	buildComposeOptions,
	createFholdState,
	inspectLocalInstance,
	localInstanceLogs,
	operateLocalInstance,
	resolveFholdHome,
	runComposeStreaming
} from '@fhold/lib';

export async function runStartAction(homeDir?: string): Promise<void> {
	await operateLocalInstance(resolveFholdHome(homeDir), 'start');
}

export async function runStopAction(): Promise<void> {
	await operateLocalInstance(resolveFholdHome(), 'stop');
}

export async function runRestartAction(homeDir?: string): Promise<void> {
	await operateLocalInstance(resolveFholdHome(homeDir), 'restart');
}

/** Run `docker compose exec <execArgs>` in the selected instance's Compose project. */
export async function execAssistant(homeDir: string, execArgs: string[]): Promise<void> {
	const state = createFholdState(homeDir);
	await runComposeStreaming([...buildComposeCliArgs(state), 'exec', ...execArgs], {
		envFiles: buildComposeOptions(state).envFiles
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
	run: () => runStartAction()
});

export const stopCommand = defineCommand({
	meta: { name: 'stop', description: 'Stop the stack without deleting volumes' },
	run: runStopAction
});

export const restartCommand = defineCommand({
	meta: { name: 'restart', description: 'Recreate the configured stack' },
	run: () => runRestartAction()
});

export const logsCommand = defineCommand({
	meta: { name: 'logs', description: 'Print the last 100 service log lines' },
	run: async () => {
		process.stdout.write(await localInstanceLogs(resolveFholdHome()));
	}
});

export const statusCommand = defineCommand({
	meta: { name: 'status', description: 'Show stack intent and container status' },
	run: async () => console.log(JSON.stringify(await readStatus(), null, 2))
});

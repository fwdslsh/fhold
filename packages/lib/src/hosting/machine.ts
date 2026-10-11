import { isAbsolute } from 'node:path';
import {
	inspectLocalInstance,
	listLocalInstances,
	localInstanceLogs,
	operateLocalInstance
} from './local-docker.js';
import { withDockerMachineOutput } from '../control-plane/docker.js';
import { HOSTING_WIRE_VERSION, type MachineRequest, type MachineResponse } from './ssh-docker.js';

const actions = ['hello', 'list', 'inspect', 'logs', 'start', 'stop', 'restart'] as const;
function path(value: unknown): string {
	if (typeof value !== 'string' || !isAbsolute(value) || /[\0\r\n]/.test(value))
		throw new Error('Provide an absolute directory on the remote host.');
	return value;
}
export async function hostingMachineRequest(value: unknown): Promise<MachineResponse> {
	try {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new Error('Invalid hosting request.');
		const input = value as MachineRequest;
		if (input.version !== HOSTING_WIRE_VERSION || !actions.includes(input.action))
			throw new Error('Unsupported hosting protocol or action.');
		if (input.action === 'hello') return { version: 1, ok: true, value: { actions } };
		if (input.action === 'list') {
			if (input.roots !== undefined && !Array.isArray(input.roots))
				throw new Error('Instance roots must be an array.');
			return { version: 1, ok: true, value: listLocalInstances(input.roots?.map(path)) };
		}
		const homeDir = path(input.homeDir);
		if (input.action === 'inspect')
			return { version: 1, ok: true, value: await inspectLocalInstance(homeDir) };
		if (input.action === 'logs') {
			if (
				input.tail !== undefined &&
				(!Number.isInteger(input.tail) || input.tail < 1 || input.tail > 300)
			)
				throw new Error('Log tail must be 1–300.');
			return {
				version: 1,
				ok: true,
				value: await localInstanceLogs(homeDir, { tail: input.tail })
			};
		}
		if (input.confirmed !== true)
			throw new Error('Confirm lifecycle changes before executing them.');
		await withDockerMachineOutput(() =>
			operateLocalInstance(homeDir, input.action as 'start' | 'stop' | 'restart')
		);
		return { version: 1, ok: true, value: null };
	} catch (error) {
		return {
			version: 1,
			ok: false,
			error: error instanceof Error ? error.message : 'Hosting request failed.'
		};
	}
}

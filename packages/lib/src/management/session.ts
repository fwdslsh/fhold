import { createInterface } from 'node:readline';
import { isAbsolute } from 'node:path';
import { isInstanceName } from '../control-plane/stack-config.js';
import { withDockerMachineOutput } from '../control-plane/docker.js';
import { localInstanceManagement } from './instance.js';
import { localDockerManagementHost } from './local-host-port.js';
import { MANAGEMENT_METHODS, type InstanceManagement } from './types.js';
import type { ManagementRequest, ManagementResponse } from './ssh.js';
import { parseManagementArgs } from './wire-input.js';

/** Native CLI session scope preserves OAuth, model verification and native prompt processes. */
export async function serveManagementSession(
	input: NodeJS.ReadableStream = process.stdin,
	output: NodeJS.WritableStream = process.stdout
): Promise<void> {
	const instances = new Map<string, InstanceManagement>();
	const lines = createInterface({ input });
	const write = (value: ManagementResponse) => output.write(`${JSON.stringify(value)}\n`);
	try {
		for await (const line of lines) {
			let id = 0;
			try {
				const request = JSON.parse(line) as ManagementRequest;
				id = request.id;
				if (
					!Number.isSafeInteger(id) ||
					id < 1 ||
					typeof request.homeDir !== 'string' ||
					!isAbsolute(request.homeDir) ||
					!MANAGEMENT_METHODS.includes(request.method)
				)
					throw Error('Invalid instance management request.');
				if (request.setupName !== undefined && !isInstanceName(request.setupName))
					throw Error('Choose a lowercase instance name.');
				if (request.extra !== undefined && !Array.isArray(request.extra))
					throw Error('Invalid operation options.');
				let instance = instances.get(request.homeDir);
				if (!instance) {
					instance = localInstanceManagement(request.homeDir, {
						setupName: request.setupName,
						host: localDockerManagementHost(request.homeDir),
						openUrl: (url) => write({ event: 'open-url', url })
					});
					instances.set(request.homeDir, instance);
				}
				const args = parseManagementArgs(request.method, request.value, request.extra);
				const selected = instance;
				const value = await withDockerMachineOutput(() => selected.call(request.method, ...args));
				write({ id, ok: true, value });
			} catch (error) {
				write({
					id,
					ok: false,
					error: error instanceof Error ? error.message : 'Instance operation failed.'
				});
			}
		}
	} finally {
		lines.close();
		await Promise.all([...instances.values()].map((instance) => instance.close()));
	}
}

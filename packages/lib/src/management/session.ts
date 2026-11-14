import { createInterface } from 'node:readline';
import { isAbsolute } from 'node:path';
import { isInstanceName } from '../control-plane/stack-config.js';
import { withDockerMachineOutput } from '../control-plane/docker.js';
import { localInstanceManagement } from './instance.js';
import { localDockerManagementHost } from '../control-plane/local-instance-host.js';
import type { InstanceManagement } from './types.js';
import type { ManagementRequest, ManagementResponse } from './ssh.js';
import { isManagementOperation, parseManagementInput } from './wire-input.js';
import { parseRequestContext } from './operation-input.js';

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
					!isManagementOperation(request.operation)
				)
					throw Error('Invalid instance management request.');
				if (request.setupName !== undefined && !isInstanceName(request.setupName))
					throw Error('Choose a lowercase instance name.');
				let instance = instances.get(request.homeDir);
				if (!instance) {
					instance = localInstanceManagement(request.homeDir, {
						setupName: request.setupName,
						host: localDockerManagementHost(request.homeDir),
						openUrl: (url) => write({ event: 'open-url', url })
					});
					instances.set(request.homeDir, instance);
				}
				const input = parseManagementInput(request.operation, request.input);
				const context = parseRequestContext(request.context);
				const selected = instance;
				const value = await withDockerMachineOutput(() =>
					selected.call(request.operation, input as never, context)
				);
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

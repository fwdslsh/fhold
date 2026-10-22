import {
	inspectLocalInstance,
	localInstanceLogs,
	operateLocalInstance
} from '../hosting/local-docker.js';
import type { LocalManagementHostPort } from './contracts.js';

/** CLI session composition for the Docker host that owns the selected home. */
export const localDockerManagementHost: LocalManagementHostPort = {
	inspect: inspectLocalInstance,
	operate: operateLocalInstance,
	logs: localInstanceLogs
};

import {
	inspectLocalInstance,
	localInstanceLogs,
	operateLocalInstance
} from '../hosting/local-docker.js';
import type { LocalManagementHostPort } from './contracts.js';

/** A management port is bound to one selected Docker home; callers cannot retarget it. */
export function localDockerManagementHost(homeDir: string): LocalManagementHostPort {
	return {
		inspect: () => inspectLocalInstance(homeDir),
		operate: (action) => operateLocalInstance(homeDir, action),
		logs: (options) => localInstanceLogs(homeDir, options)
	};
}

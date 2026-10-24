import { join } from 'node:path';
import { configureSkeletonDirectory, configureSshHelperDirectory } from '@fhold/lib';

/** Recompute from the current installation, including after an AppImage update. */
export function configureAdminResources(
	app: { isPackaged: boolean; getAppPath(): string },
	resourcesPath: string,
	environment: NodeJS.ProcessEnv = process.env
): void {
	configureSkeletonDirectory(
		app.isPackaged
			? join(resourcesPath, 'skeleton')
			: environment.FH_SKELETON_DIR ||
					(environment.FH_REPO_ROOT
						? join(environment.FH_REPO_ROOT, 'packages/skeleton')
						: join(app.getAppPath(), '../skeleton'))
	);
	configureSshHelperDirectory(
		app.isPackaged ? join(resourcesPath, 'management') : join(app.getAppPath(), '../cli/embedded')
	);
}

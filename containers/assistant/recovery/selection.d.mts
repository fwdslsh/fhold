export type RecoverySelection = {
	version?: 1;
	paths: string[];
	sqlite: string[];
	excludePaths?: string[];
	externalMounts?: string[];
	autoExcludeNetworkMounts?: boolean;
	recoverMounts?: string[];
};
export function canonicalPath(value: unknown): value is string;
export function containsPath(parent: string, child: string): boolean;
export function overlapsPath(a: string, b: string): boolean;
export function validPathCharacters(value: string): boolean;
export function normalizeSelection(value?: unknown): RecoverySelection;
export function boundaryPolicy(selection: RecoverySelection): {
	excludePaths: string[];
	externalMounts: string[];
	autoExcludeNetworkMounts: boolean;
	recoverMounts: string[];
};

import libPackage from '../../package.json' with { type: 'json' };
import skeletonPackage from '../../../skeleton/package.json' with { type: 'json' };
import bridgePackage from '../../../claude-desktop/package.json' with { type: 'json' };
import guardianPackage from '../../../guardian/package.json' with { type: 'json' };
import portalPackage from '../../../portal/package.json' with { type: 'json' };

/** Build identity, deliberately separate from all configuration schema versions. */
export const FH_RELEASE_VERSION = libPackage.version;
/** Published Assistant version, also used by Assistant-only hosting targets. */
export const FH_RUNTIME_VERSION = skeletonPackage.version;
/** Each image retains its last published version until that component is released. */
export const FH_IMAGE_VERSIONS: Record<'assistant' | 'guardian' | 'portal', string> = {
	assistant: skeletonPackage.version,
	guardian: guardianPackage.version,
	portal: portalPackage.version
};
export const FH_RUNTIME_LABEL = new Set(Object.values(FH_IMAGE_VERSIONS)).size === 1
	? FH_RUNTIME_VERSION
	: Object.entries(FH_IMAGE_VERSIONS).map(([name, version]) => `${name}: ${version}`).join(', ');
/** The bridge remains available from its own last published release. */
export const FH_BRIDGE_VERSION = bridgePackage.version;

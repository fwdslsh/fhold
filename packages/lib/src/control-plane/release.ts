import libPackage from '../../package.json' with { type: 'json' };
import skeletonPackage from '../../../skeleton/package.json' with { type: 'json' };
import bridgePackage from '../../../claude-desktop/package.json' with { type: 'json' };

/** Build identity, deliberately separate from all configuration schema versions. */
export const FH_RELEASE_VERSION = libPackage.version;
/** Last published runtime cohort; tooling-only releases do not invent image tags. */
export const FH_RUNTIME_VERSION = skeletonPackage.version;
/** The bridge remains available from its own last published release. */
export const FH_BRIDGE_VERSION = bridgePackage.version;

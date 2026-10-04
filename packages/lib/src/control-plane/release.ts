import libPackage from '../../package.json' with { type: 'json' };

/** Build identity, deliberately separate from all configuration schema versions. */
export const FH_RELEASE_VERSION = libPackage.version;

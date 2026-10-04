#!/usr/bin/env node
// Single source of truth for stamping a package.json's version.
//
// Product workspaces are source-only and use workspace:* references, so release
// stamping changes only each manifest's own version. Used by bump-release.mjs and
// release workflows so there is exactly one place that writes that field.
import { readFileSync, writeFileSync } from 'node:fs';

import { parseSemver } from './release-version.mjs';
export { SEMVER_RE, parseSemver, compareVersions, releaseIntent } from './release-version.mjs';
/** Stamp only image-tag defaults; schema versions stay independent. */
/*
 * Compose fallback tags match the release. StackConfig owns actual image intent;
 * the control plane advances managed default tags using its installation receipt
 * while preserving explicit operator pins. Managed topology remains one file.
 *
 * Throws when nothing matched, so an unstamped release fails the run instead
 * of shipping compose files pointing at the previous version.
 */
export function setComposeImageTags(file, version) {
	if (!parseSemver(version)) {
		throw new Error(`version must be a calendar-valid X.Y.yyMMddHHmm fhold release, got '${version}'`);
	}
	const before = readFileSync(file, 'utf-8');
	let count = 0;
	const after = before.replace(
		/\$\{(FH_(?:ASSISTANT|GUARDIAN|PORTAL)_VERSION):-[^}]*\}/g,
		(_match, key) => {
			count += 1;
			return `\${${key}:-${version}}`;
		}
	);
	if (count === 0) {
		throw new Error(`No image-tag defaults found to stamp in ${file}`);
	}
	writeFileSync(file, after);
	return count;
}

/** Stamp `version` into a package.json file (in place). Returns the new version. */
export function setVersion(file, version) {
	if (!parseSemver(version)) {
		throw new Error(`version must be a calendar-valid X.Y.yyMMddHHmm fhold release, got '${version}'`);
	}
	const pkg = JSON.parse(readFileSync(file, 'utf-8'));
	pkg.version = version;
	writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
	return version;
}

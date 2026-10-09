#!/usr/bin/env node
// Stamp every release manifest and Compose image default to one explicit version.
//
// Env in:
//   STAMP   — 'true' to write files in place; any other value = preview only
//   VERSION — explicit semver to stamp (required)
//
// Preview locally: VERSION='<candidate-version>' node scripts/bump-release.mjs

import { existsSync, readFileSync } from 'node:fs';
import { compareVersions, parseSemver, setComposeImageTags, setVersion } from './set-version.mjs';

const RELEASE = JSON.parse(readFileSync('.github/release-manifest.json', 'utf8'));
const manifests = RELEASE.manifests ?? [];
const composeFiles = RELEASE.compose ?? [];

const version = process.env.VERSION?.trim() || null;
const doStamp = process.env.STAMP === 'true';

if (!version || !parseSemver(version)) {
	console.error(`Error: Cannot parse VERSION: ${version ?? '(unset)'}`);
	process.exit(1);
}

console.log(`fhold → ${version}${doStamp ? '' : ' (STAMP=false — preview only)'}`);
// Validate the complete candidate before the first file is changed.
for (const file of [...manifests, ...composeFiles]) {
	if (!existsSync(file)) throw new Error(`Cannot stamp: file not found: ${file}`);
	const content = readFileSync(file, 'utf8');
	if (manifests.includes(file)) {
		const current = JSON.parse(content).version;
		if (!parseSemver(current)) throw new Error(`Invalid current release in ${file}`);
		if (parseSemver(version).date < parseSemver(current).date) throw new Error(`Release date regression in ${file}`);
		if (compareVersions(version, current) < 0) throw new Error(`Release precedence/clock regression in ${file}`);
	}
	else if (!/\$\{FH_(?:ASSISTANT|GUARDIAN|PORTAL)_VERSION:-[^}]*\}/.test(content))
		throw new Error(`No image-tag defaults found to stamp in ${file}`);
}
for (const f of manifests) {
	if (!existsSync(f)) {
		console.error(`Error: Cannot stamp: file not found: ${f}`);
		process.exit(1);
	}
	if (doStamp) setVersion(f, version);
	console.log(`  ${f} → ${version}`);
}

for (const f of composeFiles) {
	if (!existsSync(f)) {
		console.error(`Error: Cannot stamp: file not found: ${f}`);
		process.exit(1);
	}
	const count = doStamp ? setComposeImageTags(f, version) : '(preview)';
	console.log(`  ${f} → image tags ${version} ${doStamp ? `(${count} refs)` : '(preview)'}`);
}

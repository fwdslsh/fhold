import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
	createReadStream,
	readFileSync,
	readdirSync,
	lstatSync,
	writeFileSync,
	mkdirSync,
	copyFileSync,
	appendFileSync,
	unlinkSync,
	existsSync
} from 'node:fs';
import { resolve, join } from 'node:path';
import { releaseImages } from './release-scope.mjs';

export const components = ['assistant', 'guardian', 'portal'];
export const architectures = ['amd64', 'arm64'];
export const copyImage =
	// Upstream stable container: Skopeo 1.22.3, including CVE-2025-11395 fix.
	'quay.io/skopeo/stable@sha256:2681eccb8b02c495b013c2669cbf7f41d5c0b0b0e644e7c69bd3ea9bcb20641f';
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const run = (command, args) =>
	execFileSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

export function candidateKinds(scope) {
	const images = releaseImages(scope);
	return [
		'cli-x64',
		'cli-arm64',
		'admin',
		...(scope === 'full' ? ['mcpb'] : []),
		...images.flatMap((image) => architectures.map((arch) => `image-${image}-${arch}`))
	];
}

export function selectArtifacts(artifacts, scope, attempt) {
	assert(Number.isSafeInteger(attempt) && attempt > 0, 'Invalid run attempt');
	return candidateKinds(scope).map((kind) => {
		const matches = artifacts.filter(
			(artifact) => artifact.name === `candidate-${attempt}-${kind}`
		);
		assert.equal(matches.length, 1, `Missing or duplicate candidate: ${kind}`);
		const artifact = matches[0];
		assert(
			!artifact.expired &&
				Number.isSafeInteger(artifact.id) &&
				artifact.id > 0 &&
				/^sha256:[a-f0-9]{64}$/.test(artifact.digest),
			`Invalid artifact: ${kind}`
		);
		return { kind, id: artifact.id, digest: artifact.digest };
	});
}

async function fileDigest(path) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return `sha256:${hash.digest('hex')}`;
}

function identity() {
	const value = {
		sha: process.env.GITHUB_SHA,
		version: process.env.VERSION,
		run: Number(process.env.CANDIDATE_RUN_ID || process.env.GITHUB_RUN_ID),
		attempt: Number(process.env.CANDIDATE_ATTEMPT || process.env.GITHUB_RUN_ATTEMPT)
	};
	assert(
		/^[a-f0-9]{40}$/.test(value.sha) &&
			typeof value.version === 'string' &&
			/^[0-9A-Za-z.+-]+$/.test(value.version),
		'Invalid candidate identity'
	);
	assert(
		Number.isSafeInteger(value.run) &&
			value.run > 0 &&
			Number.isSafeInteger(value.attempt) &&
			value.attempt > 0,
		'Invalid candidate run'
	);
	return value;
}

export async function seal(directory, kind, expected = identity()) {
	const files = {};
	for (const name of readdirSync(directory).sort()) {
		assert(
			/^[0-9A-Za-z._-]+$/.test(name) && name !== 'receipt.json',
			'Unexpected candidate filename'
		);
		assert(lstatSync(join(directory, name)).isFile(), 'Candidate must contain regular files');
		files[name] = await fileDigest(join(directory, name));
	}
	assert(Object.keys(files).length > 0, 'Empty candidate');
	const receipt = { schema: 1, ...expected, kind, files };
	writeFileSync(join(directory, 'receipt.json'), `${JSON.stringify(receipt)}\n`);
	return receipt;
}

export async function verify(directory, kind, expected = identity()) {
	assert(lstatSync(join(directory, 'receipt.json')).isFile(), 'Receipt must be a regular file');
	const receipt = json(join(directory, 'receipt.json'));
	assert.equal(receipt.schema, 1);
	for (const [key, value] of Object.entries({ ...expected, kind }))
		assert.equal(receipt[key], value, `Candidate ${key} mismatch`);
	const names = readdirSync(directory)
		.filter((name) => name !== 'receipt.json')
		.sort();
	assert(names.length > 0, 'Empty candidate');
	assert.deepEqual(names, Object.keys(receipt.files).sort(), 'Candidate file set changed');
	for (const name of names) {
		assert(
			/^[0-9A-Za-z._-]+$/.test(name) && lstatSync(join(directory, name)).isFile(),
			'Unsafe candidate file'
		);
		assert.equal(
			await fileDigest(join(directory, name)),
			receipt.files[name],
			`Candidate digest mismatch: ${name}`
		);
	}
	return receipt;
}

export function inspectOCI(archive, platform, expected = identity()) {
	const read = (path) => run('tar', ['-xOf', archive, path]);
	const blob = (descriptor) => {
		assert(/^sha256:[a-f0-9]{64}$/.test(descriptor.digest), 'Invalid OCI digest');
		const bytes = read(`blobs/sha256/${descriptor.digest.slice(7)}`);
		assert.equal(Buffer.byteLength(bytes), descriptor.size);
		assert.equal(digest(bytes), descriptor.digest, 'OCI descriptor digest mismatch');
		return JSON.parse(bytes);
	};
	const root = JSON.parse(read('index.json'));
	assert.equal(root.manifests?.length, 1, 'Expected one exported OCI index');
	const index = blob(root.manifests[0]);
	const [os, architecture] = platform.split('/');
	const executable = index.manifests.filter(
		(entry) => entry.platform?.os === os && entry.platform?.architecture === architecture
	);
	assert.equal(executable.length, 1, 'Expected one native platform image');
	const manifest = blob(executable[0]);
	const config = blob(manifest.config);
	assert.equal(config.os, os);
	assert.equal(config.architecture, architecture);
	assert.equal(config.config.Labels['org.opencontainers.image.revision'], expected.sha);
	assert.equal(config.config.Labels['org.opencontainers.image.version'], expected.version);
	const attestations = index.manifests.filter(
		(entry) =>
			entry.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest' &&
			entry.annotations?.['vnd.docker.reference.digest'] === executable[0].digest
	);
	assert.equal(
		index.manifests.length,
		executable.length + attestations.length,
		'Unexpected platform or attestation'
	);
	const predicates = new Set();
	for (const entry of attestations) {
		for (const layer of blob(entry).layers) {
			const statement = blob(layer);
			assert(
				statement.subject?.some(
					(subject) => subject.digest?.sha256 === executable[0].digest.slice(7)
				),
				'Wrong attestation subject'
			);
			predicates.add(statement.predicateType);
		}
	}
	assert(
		predicates.has('https://spdx.dev/Document') &&
			[...predicates].some((type) => type.startsWith('https://slsa.dev/provenance/')),
		'Missing SBOM or provenance'
	);
	return {
		platform,
		index: root.manifests[0].digest,
		manifest: executable[0].digest,
		descriptors: index.manifests,
		config: manifest.config.digest,
		diffIDs: config.rootfs.diff_ids
	};
}

export function assertLoadedImage(info, loaded) {
	// Docker's classic store identifies a config; its containerd store identifies
	// the imported index (or platform manifest with --platform). All three hashes
	// are verified members of this one OCI graph, including its config descriptor.
	assert(
		[info.config, info.manifest, info.index].includes(loaded.Id),
		'Tested image differs from candidate OCI graph'
	);
	assert.equal(
		`${loaded.Os}/${loaded.Architecture}`,
		info.platform,
		'Tested platform differs from candidate'
	);
	assert.deepEqual(loaded.RootFS.Layers, info.diffIDs, 'Tested rootfs differs from candidate');
}

function skopeo(directory, args, authenticated = false) {
	const options = [
		'run',
		'--rm',
		'--user',
		`${process.getuid()}:${process.getgid()}`,
		'--volume',
		`${resolve(directory)}:/candidate`
	];
	if (authenticated)
		options.push(
			'--volume',
			`${resolve(process.env.DOCKER_CONFIG || join(process.env.HOME, '.docker'))}/config.json:/auth/config.json:ro`
		);
	return run('docker', [
		...options,
		copyImage,
		'copy',
		'--all',
		'--preserve-digests',
		...(authenticated ? ['--authfile', '/auth/config.json'] : []),
		...args
	]);
}

export function combinedIndex(images) {
	assert.deepEqual(
		images.map((image) => image.platform).sort(),
		['linux/amd64', 'linux/arm64'],
		'Both native platforms are required'
	);
	return {
		schemaVersion: 2,
		mediaType: 'application/vnd.oci.image.index.v1+json',
		manifests: images.flatMap((image) => image.descriptors)
	};
}

export function publicationAction(existing, expectedDigest) {
	assert(/^sha256:[a-f0-9]{64}$/.test(expectedDigest), 'Invalid candidate index digest');
	if (existing === null) return 'copy';
	assert(
		/^sha256:[a-f0-9]{64}$/.test(existing?.digest),
		'Registry did not return an immutable digest'
	);
	assert.equal(
		existing.digest,
		expectedDigest,
		'Published version has different bytes; use a new version'
	);
	return 'reuse';
}

export function candidateTag(component, arch, expected = identity()) {
	assert(components.includes(component) && architectures.includes(arch), 'Unknown image target');
	assert(/^[a-f0-9]{40}$/.test(expected.sha), 'Invalid candidate SHA');
	assert(
		Number.isSafeInteger(expected.run) &&
			expected.run > 0 &&
			Number.isSafeInteger(expected.attempt) &&
			expected.attempt > 0,
		'Invalid candidate run'
	);
	return `fwdslsh/fhold-${component}:candidate-${expected.sha}-${expected.run}-${expected.attempt}-${arch}`;
}

const registryManifest = (reference) =>
	JSON.parse(
		run('docker', ['buildx', 'imagetools', 'inspect', reference, '--format', '{{json .Manifest}}'])
	);

export function assertRegistryImage(info, component, arch, manifest) {
	assert(components.includes(component) && architectures.includes(arch), 'Unknown image target');
	assert.equal(info.platform, `linux/${arch}`);
	assert(/^sha256:[a-f0-9]{64}$/.test(info.index), 'Invalid image index');
	assert.equal(
		info.reference,
		`fwdslsh/fhold-${component}@${info.index}`,
		'Unexpected candidate registry'
	);
	assert.equal(manifest.digest, info.index, 'Staged index changed');
	assert.deepEqual(manifest.manifests, info.descriptors, 'Staged descriptors changed');
}

function stage(directory, component, arch) {
	const info = json(join(directory, 'image.json'));
	const target = candidateTag(component, arch);
	assert.equal(info.platform, `linux/${arch}`);
	// The image command bound this OCI graph to the locally tested rootfs before
	// the suites ran. Preserve every digest when staging it in its final repository.
	assertLoadedImage(
		info,
		JSON.parse(run('docker', ['image', 'inspect', `fhold/${component}:ci`]))[0]
	);
	let existing = null;
	try {
		existing = registryManifest(target);
	} catch (error) {
		if (!/manifest unknown|not found/i.test(String(error.stderr))) throw error;
	}
	if (publicationAction(existing, info.index) === 'copy')
		console.log(
			skopeo(directory, ['oci-archive:/candidate/image.tar', `docker://${target}`], true)
		);
	info.reference = `fwdslsh/fhold-${component}@${info.index}`;
	assertRegistryImage(info, component, arch, registryManifest(info.reference));
	writeFileSync(join(directory, 'image.json'), `${JSON.stringify(info)}\n`);
	// Only the small digest-bound receipt crosses the Actions artifact boundary.
	unlinkSync(join(directory, 'image.tar'));
}

export function promotionBytes(output, images) {
	// Buildx prints the exact bytes it would push followed by one newline.
	assert(output.endsWith('\n'), 'Expected buildx manifest output');
	const bytes = output.slice(0, -1);
	const manifest = JSON.parse(bytes);
	const expected = combinedIndex(images);
	// Buildx places attestations after executable manifests. Descriptor order
	// may change; the complete descriptor objects and multiplicity must not.
	const ordered = (entries) => [...entries].sort((a, b) => a.digest.localeCompare(b.digest));
	assert.deepEqual(
		{ ...manifest, manifests: ordered(manifest.manifests) },
		{ ...expected, manifests: ordered(expected.manifests) },
		'Promotion changed the qualified OCI graph'
	);
	return bytes;
}

async function promote(directory, component, dryRun) {
	assert(components.includes(component), 'Unknown component');
	const expected = identity();
	const images = [];
	for (const arch of architectures) {
		const kind = `image-${component}-${arch}`;
		const name = `candidate-${expected.attempt}-${kind}`;
		const path = join(directory, name);
		const receipt = await verify(path, kind, expected);
		assert.deepEqual(
			Object.keys(receipt.files),
			['image.json'],
			'Expected a registry candidate receipt'
		);
		const info = json(join(path, 'image.json'));
		// Refuse mutable tags, other registries, or a graph different from the
		// sealed, native-tested candidate. Buildx fetches manifests, not rootfs tarballs.
		assert.equal(info.reference, `fwdslsh/fhold-${component}@${info.index}`);
		assert(/^sha256:[a-f0-9]{64}$/.test(info.index), 'Invalid candidate index');
		assertRegistryImage(info, component, arch, registryManifest(info.reference));
		images.push(info);
	}
	const sources = images.map((image) => image.reference);
	const bytes = promotionBytes(
		run('docker', ['buildx', 'imagetools', 'create', '--dry-run', ...sources]),
		images
	);
	const expectedDigest = digest(bytes);
	const target = `fwdslsh/fhold-${component}:${expected.version}`;
	if (!dryRun) {
		let existing = null;
		try {
			existing = JSON.parse(
				run('docker', ['buildx', 'imagetools', 'inspect', target, '--format', '{{json .Manifest}}'])
			);
		} catch (error) {
			if (!/manifest unknown|not found/i.test(String(error.stderr))) throw error;
		}
		if (publicationAction(existing, expectedDigest) === 'copy')
			console.log(run('docker', ['buildx', 'imagetools', 'create', '--tag', target, ...sources]));
		assert.equal(
			JSON.parse(
				run('docker', ['buildx', 'imagetools', 'inspect', target, '--format', '{{json .Manifest}}'])
			).digest,
			expectedDigest,
			'Published digest changed'
		);
	}
	if (process.env.GITHUB_OUTPUT)
		appendFileSync(process.env.GITHUB_OUTPUT, `digest=${expectedDigest}\n`);
	console.log(
		`${component}: ${expectedDigest}${dryRun ? ' (verified registry candidate; no release tag published)' : ''}`
	);
}

async function assemble(directory, destination, scope) {
	const expected = identity();
	mkdirSync(destination, { recursive: true });
	for (const kind of candidateKinds(scope).filter((kind) => !kind.startsWith('image-'))) {
		const path = join(directory, `candidate-${expected.attempt}-${kind}`);
		const receipt = await verify(path, kind, expected);
		for (const name of Object.keys(receipt.files)) {
			assert(!existsSync(join(destination, name)), 'Duplicate release asset');
			copyFileSync(join(path, name), join(destination, name));
		}
	}
}

if (import.meta.main) {
	const [command, directory, kind, platform] = process.argv.slice(2);
	if (command === 'seal') await seal(directory, kind);
	else if (command === 'verify') await verify(directory, kind);
	else if (command === 'image') {
		const info = inspectOCI(join(directory, 'image.tar'), platform);
		assertLoadedImage(info, JSON.parse(run('docker', ['image', 'inspect', `fhold/${kind}:ci`]))[0]);
		writeFileSync(join(directory, 'image.json'), `${JSON.stringify(info)}\n`);
	} else if (command === 'stage') stage(directory, kind, platform);
	else if (command === 'promote') await promote(directory, kind, process.env.DRY_RUN !== 'false');
	else if (command === 'assemble') await assemble(directory, kind, process.env.SCOPE);
	else throw new Error('Expected seal, verify, image, stage, promote or assemble');
}

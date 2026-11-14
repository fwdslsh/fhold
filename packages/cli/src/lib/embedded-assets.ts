import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configureSkeletonDirectory } from '@fhold/lib';
import { x as extractTar } from 'tar';

async function embeddedSkeletonPath(): Promise<string | null> {
	try {
		const module = await import('../../embedded/skeleton.tar.gz', {
			with: { type: 'file' }
		});
		return module.default;
	} catch {
		return null;
	}
}

async function extractEmbeddedSkeleton(): Promise<void> {
	const embedded = await embeddedSkeletonPath();
	if (!embedded) return;
	const extraction = mkdtempSync(join(tmpdir(), 'fhold-skeleton-'));
	// Both paths are generated for this process; no operator path is removed.
	process.once('exit', () => rmSync(extraction, { recursive: true, force: true }));
	const archive = join(tmpdir(), `fhold-skeleton-${process.pid}-${crypto.randomUUID()}.tar.gz`);
	try {
		writeFileSync(archive, new Uint8Array(await Bun.file(embedded).arrayBuffer()));
		await extractTar({ file: archive, cwd: extraction, strict: true });
	} finally {
		rmSync(archive, { force: true });
	}
	if (!existsSync(join(extraction, 'system', 'stack', 'stack.compose.yml'))) {
		throw new Error('Embedded skeleton does not contain the managed stack.');
	}
	configureSkeletonDirectory(extraction);
}

let extracted: Promise<void> | undefined;

/** Seed from the binary's embedded skeleton, extracted once per process. */
export function useEmbeddedSkeleton(): Promise<void> {
	// An explicitly selected source wins over any stale development archive.
	// Standalone release binaries use their embedded assets by default.
	if (process.env.FH_SKELETON_DIR || process.env.FH_REPO_ROOT) return Promise.resolve();
	extracted ??= extractEmbeddedSkeleton();
	return extracted;
}

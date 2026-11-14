import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
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

const MANAGED_STACK = join('system', 'stack', 'stack.compose.yml');

/**
 * Extract once per release into a private, content-addressed cache, like the
 * SSH management helper. A directory appears only by an atomic rename of a
 * complete extraction, so nothing needs cleanup when the CLI is interrupted.
 */
async function extractEmbeddedSkeleton(): Promise<void> {
	const embedded = await embeddedSkeletonPath();
	if (!embedded) return;
	const bytes = new Uint8Array(await Bun.file(embedded).arrayBuffer());
	const root = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'fhold', 'skeleton');
	const target = join(root, createHash('sha256').update(bytes).digest('hex'));
	if (!existsSync(join(target, MANAGED_STACK))) {
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const staging = mkdtempSync(join(root, '.extract-'));
		try {
			const archive = join(staging, 'skeleton.tar.gz');
			const files = join(staging, 'files');
			writeFileSync(archive, bytes);
			mkdirSync(files);
			await extractTar({ file: archive, cwd: files, strict: true });
			if (!existsSync(join(files, MANAGED_STACK)))
				throw new Error('Embedded skeleton does not contain the managed stack.');
			try {
				renameSync(files, target);
			} catch (error) {
				// A concurrent CLI process published the same release first.
				if (!existsSync(join(target, MANAGED_STACK))) throw error;
			}
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}
	}
	configureSkeletonDirectory(target);
}

let extracted: Promise<void> | undefined;

/** Seed from the binary's embedded skeleton, extracted once per release. */
export function useEmbeddedSkeleton(): Promise<void> {
	// An explicitly selected source wins over any stale development archive.
	// Standalone release binaries use their embedded assets by default.
	if (process.env.FH_SKELETON_DIR || process.env.FH_REPO_ROOT) return Promise.resolve();
	extracted ??= extractEmbeddedSkeleton();
	return extracted;
}

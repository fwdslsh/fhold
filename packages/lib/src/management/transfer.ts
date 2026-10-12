import { t, x } from 'tar';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
	mkdirSync,
	readdirSync,
	lstatSync,
	symlinkSync,
	chmodSync,
	utimesSync,
	lutimesSync
} from 'node:fs';
import { join, posix } from 'node:path';

/** Standard tar preserves links and private modes; SCP's recursive mode follows links. */
export async function packTransfer(source: string, archive: string): Promise<void> {
	// PAX is the standard format for subsecond timestamps. GNU tar preserves
	// these and symlink targets; recursive SCP and USTAR do not.
	await promisify(execFile)('tar', [
		'--create',
		'--gzip',
		'--format=pax',
		'--file',
		archive,
		'--directory',
		source,
		'--transform=flags=rh;s,^\\.$,payload,;s,^\\./,payload/,',
		'.'
	]);
}
export async function unpackTransfer(archive: string, destination: string): Promise<void> {
	if (
		lstatSync(destination, { throwIfNoEntry: false }) &&
		(!lstatSync(destination).isDirectory() || readdirSync(destination).length)
	)
		throw Error('Choose an empty transfer destination.');
	let invalid = false;
	const links: Array<{ path: string; target: string }> = [];
	const paths: string[] = [];
	const metadata: Array<{ path: string; mode?: number; mtime?: Date; symlink: boolean }> = [];
	const member = (path: string) =>
		!posix.isAbsolute(path) &&
		!path.split('/').includes('..') &&
		(posix.normalize(path) === 'payload' || posix.normalize(path).startsWith('payload/'));
	await t({
		file: archive,
		strict: true,
		onReadEntry(entry) {
			paths.push(posix.normalize(entry.path));
			metadata.push({
				path: entry.path,
				mode: entry.mode,
				mtime: entry.mtime,
				symlink: entry.type === 'SymbolicLink'
			});
			if (
				!member(entry.path) ||
				!['File', 'Directory', 'SymbolicLink', 'Link'].includes(entry.type)
			)
				invalid = true;
			if (entry.type === 'Link' && (!entry.linkpath || !member(entry.linkpath))) invalid = true;
			if (entry.type === 'SymbolicLink') {
				if (!entry.linkpath || posix.normalize(entry.path) === 'payload') invalid = true;
				else links.push({ path: entry.path, target: entry.linkpath });
			}
		}
	});
	if (links.some((link) => paths.some((path) => path.startsWith(`${posix.normalize(link.path)}/`))))
		invalid = true;
	if (invalid) throw Error('Invalid transfer archive member.');
	mkdirSync(destination, { recursive: true, mode: 0o700 });
	// Extract ordinary files first, with tar's path protections intact. Create links
	// last: they remain metadata and can never redirect another extracted file.
	await x({
		file: archive,
		cwd: destination,
		strict: true,
		preservePaths: false,
		preserveOwner: false,
		filter: (_path, entry) => !('type' in entry) || entry.type !== 'SymbolicLink'
	});
	for (const link of links) symlinkSync(link.target, join(destination, link.path));
	// Directory writes and creating links change timestamps. Restore the archive
	// metadata after extraction, children first, without following symbolic links.
	for (const entry of metadata.reverse()) {
		const target = join(destination, entry.path);
		if (!entry.symlink && entry.mode !== undefined) chmodSync(target, entry.mode & 0o777);
		if (entry.mtime) (entry.symlink ? lutimesSync : utimesSync)(target, entry.mtime, entry.mtime);
	}
}

/** fs.cp preserves file timestamps, not directory/link timestamps. Complete that contract. */
export function preserveTransferMetadata(source: string, destination: string): void {
	const stat = lstatSync(source);
	if (stat.isDirectory())
		for (const child of readdirSync(source))
			preserveTransferMetadata(join(source, child), join(destination, child));
	if (!stat.isSymbolicLink()) chmodSync(destination, stat.mode & 0o777);
	(stat.isSymbolicLink() ? lutimesSync : utimesSync)(destination, stat.atime, stat.mtime);
}

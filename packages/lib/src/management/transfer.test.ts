import { afterEach, expect, test } from 'bun:test';
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	lstatSync,
	symlinkSync,
	utimesSync,
	lutimesSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packTransfer, unpackTransfer } from './transfer.js';
import { Header } from 'tar';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'fhold-transfer-test-'));
	roots.push(root);
	return root;
}
test('standard transfer preserves private files, empty folders and symlinks without following them', async () => {
	const root = fixture(),
		source = join(root, 'source'),
		target = join(root, 'target'),
		archive = join(root, 'transfer.tgz');
	mkdirSync(join(source, 'empty'), { recursive: true });
	writeFileSync(join(source, 'private'), 'private test data', { mode: 0o600 });
	symlinkSync('private', join(source, 'relative'));
	symlinkSync('/not/mounted/test-path', join(source, 'external'));
	const stamp = new Date(1791000000123);
	utimesSync(join(source, 'empty'), stamp, stamp);
	utimesSync(join(source, 'private'), stamp, stamp);
	lutimesSync(join(source, 'external'), stamp, stamp);
	await packTransfer(source, archive);
	await unpackTransfer(archive, target);
	expect(readFileSync(join(target, 'payload/private'), 'utf8')).toBe('private test data');
	expect(statSync(join(target, 'payload/private')).mode & 0o777).toBe(0o600);
	expect(statSync(join(target, 'payload/empty')).isDirectory()).toBe(true);
	expect(readlinkSync(join(target, 'payload/relative'))).toBe('private');
	expect(readlinkSync(join(target, 'payload/external'))).toBe('/not/mounted/test-path');
	for (const name of ['empty', 'private', 'external'])
		expect(Math.trunc(lstatSync(join(target, 'payload', name)).mtimeMs)).toBe(1791000000123);
});
test('transfer cannot overwrite a chosen nonempty directory', async () => {
	const root = fixture(),
		source = join(root, 'source'),
		target = join(root, 'target');
	mkdirSync(source);
	mkdirSync(target);
	writeFileSync(join(target, 'keep'), 'unchanged');
	await packTransfer(source, join(root, 'transfer.tgz'));
	await expect(unpackTransfer(join(root, 'transfer.tgz'), target)).rejects.toThrow('empty');
	expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('unchanged');
});

test('transfer rejects escaped members before extracting any files', async () => {
	const root = fixture(),
		header = new Header({ path: '../escape', size: 4, mode: 0o600, type: 'File' });
	header.encode();
	writeFileSync(
		join(root, 'invalid.tar'),
		Buffer.concat([header.block!, Buffer.from('data'), Buffer.alloc(508 + 1024)])
	);
	await expect(unpackTransfer(join(root, 'invalid.tar'), join(root, 'target'))).rejects.toThrow(
		'Invalid'
	);
});

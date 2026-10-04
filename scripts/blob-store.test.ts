import { describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBlobStore, parseBlobDestination } from '../containers/assistant/recovery/blob-store.mjs';

// Fast boundary tests execute the actual adapter/parser. They never authenticate
// to Azure and are not transport/E2E evidence; Azurite is a separate real-API run.
describe('Blob adapter namespace boundary', () => {
	it('parses account/container and a fixed contained prefix', () => {
		expect(parseBlobDestination('azblob://account123/private-backups')).toEqual({ account: 'account123', container: 'private-backups', prefix: '' });
		expect(parseBlobDestination('azblob://account123/private-backups/owner_one/run-2')).toEqual({ account: 'account123', container: 'private-backups', prefix: 'owner_one/run-2/' });
	});

	it('rejects secret-bearing, ambiguous, traversal and invalid backend URLs', () => {
		for (const value of [
			'azblob://account123/private-backups?sig=synthetic',
			'azblob://account123/private-backups#secret',
			'azblob://user:password@account123/private-backups',
			'azblob://account123:10000/private-backups',
			'azblob://account123/private-backups/../escape',
			'azblob://account123/private-backups/%2e%2e/escape',
			'azblob://account123/private-backups//empty',
			'azblob://account123/private-backups/trailing/',
			'azblob://account123/private--backups',
			'azblob://Account123/private-backups',
			'azblob://ab/private-backups',
			'azblob://account123/ab',
			'https://account123.blob.core.windows.net/private-backups',
			'azblob://account123/private-backups/native.config'
		]) expect(() => parseBlobDestination(value)).toThrow();
	});

	it('rejects invalid finite transfer bounds before acquiring credentials', async () => {
		for (const bounds of [{ maxReadBytes: 0 }, { maxReadBytes: Number.POSITIVE_INFINITY }, { operationTimeoutMs: 0 }, { operationTimeoutMs: 10_001 }]) {
			await expect(createBlobStore('azblob://account123/private-backups', { ...bounds, env: {} })).rejects.toThrow('bounds');
		}
	});

	it('constructs only the explicit managed-identity adapter without authenticating', async () => {
		const store = await createBlobStore('azblob://account123/private-backups/fixture', { env: {} });
		expect(store.transport).toBe('azblob');
		expect(store.privatePaths).toEqual([]);
	});

	it('requires private credentials, matching account and explicit HTTP opt-in without network calls', async () => {
		const root = await mkdtemp(join(tmpdir(), 'fhold-blob-boundary-'));
		const file = join(root, 'connection');
		const key = Buffer.alloc(32, 1).toString('base64');
		const connection = `DefaultEndpointsProtocol=http;AccountName=account123;AccountKey=${key};BlobEndpoint=http://127.0.0.1:10000/account123;`;
		await writeFile(file, connection, { mode: 0o644 });
		await expect(createBlobStore('azblob://account123/private-backups', { env: { FH_RECOVERY_CREDENTIAL_FILE: file, FH_RECOVERY_ALLOW_INSECURE: '1' } })).rejects.toThrow('private');
		await chmod(file, 0o600);
		await expect(createBlobStore('azblob://account123/private-backups', { env: { FH_RECOVERY_CREDENTIAL_FILE: file } })).rejects.toThrow('endpoint');
		await expect(createBlobStore('azblob://otheraccount/private-backups', { env: { FH_RECOVERY_CREDENTIAL_FILE: file, FH_RECOVERY_ALLOW_INSECURE: '1' } })).rejects.toThrow('account mismatch');
		await expect(createBlobStore('azblob://account123/private-backups', { env: { AZURE_CLIENT_ID: 'not-a-uuid' } })).rejects.toThrow('identity selection');
		const linked = join(root, 'linked-connection');
		await symlink(file, linked);
		await expect(createBlobStore('azblob://account123/private-backups', { env: { FH_RECOVERY_CREDENTIAL_FILE: linked, FH_RECOVERY_ALLOW_INSECURE: '1' } })).rejects.toThrow();
		await writeFile(file, connection.replace('127.0.0.1', 'remote.example'));
		await expect(createBlobStore('azblob://account123/private-backups', { env: { FH_RECOVERY_CREDENTIAL_FILE: file, FH_RECOVERY_ALLOW_INSECURE: '1' } })).rejects.toThrow('endpoint');
		await writeFile(file, `AccountName=account123;SharedAccessSignature=synthetic-secret-not-accepted;`);
		await expect(createBlobStore('azblob://account123/private-backups', { env: { FH_RECOVERY_CREDENTIAL_FILE: file } })).rejects.toThrow('account mismatch');
	});
});

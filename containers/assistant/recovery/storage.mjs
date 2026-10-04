import { createDirectoryStore } from './directory-store.mjs';
import { createBlobStore } from './blob-store.mjs';

export async function createRecoveryStore(url, options = {}) {
	let protocol;
	try {
		protocol = new URL(url).protocol;
	} catch {
		throw new Error('invalid recovery destination');
	}
	if (protocol === 'file:') return createDirectoryStore(url, options);
	if (protocol === 'azblob:') return createBlobStore(url, options);
	throw new Error('unsupported recovery destination');
}

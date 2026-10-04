import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { readRegular } from './directory-store.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => Buffer.from(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function parseBlobDestination(text) {
	if (
		typeof text !== 'string' ||
		!/^azblob:\/\/[a-z0-9]{3,24}\/[a-z0-9][a-z0-9-]{1,61}[a-z0-9](?:\/[A-Za-z0-9_-]{1,128})*$/.test(
			text
		)
	)
		throw new Error('invalid Blob recovery destination');
	let url;
	try {
		url = new URL(text);
	} catch {
		throw new Error('invalid recovery destination');
	}
	if (
		url.protocol !== 'azblob:' ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.port ||
		!/^[a-z0-9]{3,24}$/.test(url.hostname)
	)
		throw new Error('invalid Blob recovery destination');
	const components = url.pathname.slice(1).split('/');
	const container = components.shift();
	if (
		!container ||
		!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(container) ||
		container.includes('--') ||
		components.some((part) => !/^[A-Za-z0-9_-]{1,128}$/.test(part))
	)
		throw new Error('invalid Blob recovery namespace');
	return {
		account: url.hostname,
		container,
		prefix: components.length ? `${components.join('/')}/` : ''
	};
}
function azureSdk() {
	let require;
	try {
		require = createRequire('/opt/fhold/tools/package.json');
		return { ...require('@azure/storage-blob'), ...require('@azure/identity') };
	} catch {
		require = createRequire(new URL('../tools/package.json', import.meta.url));
		return { ...require('@azure/storage-blob'), ...require('@azure/identity') };
	}
}
function classified(error) {
	if (error?.name === 'RecoveryBlobError') return error;
	let message = 'recovery Blob transport failed';
	if (
		error?.statusCode === 401 ||
		error?.statusCode === 403 ||
		error?.name === 'AuthenticationError' ||
		error?.name === 'CredentialUnavailableError'
	)
		message = 'recovery Blob authentication failed';
	else if (error?.statusCode === 404) message = 'recovery Blob object missing';
	else if (error?.statusCode === 409 || error?.statusCode === 412)
		message = 'recovery Blob condition conflict';
	else if (error?.name === 'AbortError' || error?.name === 'TimeoutError')
		message = 'recovery Blob deadline exceeded';
	else if (
		error?.statusCode >= 500 ||
		['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(error?.code)
	)
		message = 'recovery Blob transport unavailable';
	return failure(message);
}
function failure(message) {
	const error = new Error(message);
	error.name = 'RecoveryBlobError';
	return error;
}

/** Data plane only: container provisioning, routing, scaling and retention are
 * external. A descriptor lease fences head writes, not every object/local tool.
 * Its persistent owner nonce forbids takeover merely because a lease expired. */
export async function createBlobStore(
	url,
	{ env = process.env, maxReadBytes = 256 * 1024 * 1024, operationTimeoutMs = 10000 } = {}
) {
	const destination = parseBlobDestination(url);
	if (
		!Number.isSafeInteger(maxReadBytes) ||
		maxReadBytes < 1 ||
		!Number.isSafeInteger(operationTimeoutMs) ||
		operationTimeoutMs < 1 ||
		operationTimeoutMs > 10000
	)
		throw failure('invalid Blob recovery bounds');
	const { BlobServiceClient, ManagedIdentityCredential } = azureSdk();
	const clientOptions = {
		retryOptions: { maxTries: 1, tryTimeoutInMs: operationTimeoutMs },
		allowInsecureConnection: env.FH_RECOVERY_ALLOW_INSECURE === '1'
	};
	let service;
	try {
		if (env.FH_RECOVERY_CREDENTIAL_FILE) {
			if (!path.isAbsolute(env.FH_RECOVERY_CREDENTIAL_FILE))
				throw failure('recovery Blob credential file must be absolute');
			const credentialStat = await stat(env.FH_RECOVERY_CREDENTIAL_FILE);
			if ((credentialStat.mode & 0o077) !== 0)
				throw failure('recovery Blob credential file must be private');
			const connection = (await readRegular(env.FH_RECOVERY_CREDENTIAL_FILE, 16384))
				.toString()
				.trim();
			const account = /(?:^|;)AccountName=([^;]+)(?:;|$)/i.exec(connection)?.[1];
			if (
				account !== destination.account ||
				/(?:^|;)SharedAccessSignature=/i.test(connection) ||
				/(?:^|;)UseDevelopmentStorage=/i.test(connection)
			)
				throw failure('recovery Blob credential account mismatch');
			service = BlobServiceClient.fromConnectionString(connection, clientOptions);
		} else {
			if (env.AZURE_CLIENT_ID && !UUID.test(env.AZURE_CLIENT_ID))
				throw failure('invalid recovery managed identity selection');
			const credential = env.AZURE_CLIENT_ID
				? new ManagedIdentityCredential({ clientId: env.AZURE_CLIENT_ID })
				: new ManagedIdentityCredential();
			service = new BlobServiceClient(
				`https://${destination.account}.blob.core.windows.net`,
				credential,
				clientOptions
			);
		}
		const actual = new URL(service.url);
		if (
			actual.protocol === 'http:' &&
			!['localhost', '127.0.0.1', '[::1]', 'azurite'].includes(actual.hostname)
		)
			throw failure('recovery Blob insecure endpoint must be local emulator');
		if (
			actual.search ||
			actual.hash ||
			actual.username ||
			actual.password ||
			(actual.protocol !== 'https:' &&
				!(actual.protocol === 'http:' && env.FH_RECOVERY_ALLOW_INSECURE === '1'))
		)
			throw failure('recovery Blob endpoint rejected');
		if (service.accountName !== destination.account)
			throw failure('recovery Blob credential account mismatch');
	} catch (error) {
		throw classified(error);
	}
	const container = service.getContainerClient(destination.container);
	const descriptor = container.getBlockBlobClient(`${destination.prefix}descriptor.json`);
	let active;
	const key = (value) => {
		if (!/^(objects|manifests)\/[a-f0-9]{64}$/.test(value))
			throw failure('invalid recovery object key');
		return container.getBlockBlobClient(`${destination.prefix}${value}`);
	};
	const request = async (operation) => {
		try {
			return await operation(AbortSignal.timeout(operationTimeoutMs));
		} catch (error) {
			throw classified(error);
		}
	};
	async function download(client, limit) {
		return request(async (abortSignal) => {
			const response = await client.download(0, undefined, { abortSignal, maxRetryRequests: 0 });
			const stream = response.readableStreamBody;
			if (
				!stream ||
				!Number.isSafeInteger(response.contentLength) ||
				response.contentLength < 0 ||
				response.contentLength > limit
			) {
				stream?.destroy();
				throw failure('recovery Blob object exceeds limit');
			}
			const chunks = [];
			let bytes = 0;
			const aborted = () => stream.destroy(failure('recovery Blob deadline exceeded'));
			abortSignal.addEventListener('abort', aborted, { once: true });
			if (abortSignal.aborted) aborted();
			try {
				for await (const chunk of stream) {
					bytes += chunk.length;
					if (bytes > limit) throw failure('recovery Blob object exceeds limit');
					chunks.push(Buffer.from(chunk));
				}
			} finally {
				abortSignal.removeEventListener('abort', aborted);
				stream.destroy();
			}
			if (bytes !== response.contentLength || !response.etag)
				throw failure('recovery Blob incomplete read');
			return { bytes: Buffer.concat(chunks, bytes), token: response.etag };
		});
	}
	async function readDescriptor() {
		try {
			const result = await download(descriptor, 65536);
			let value;
			try {
				value = JSON.parse(result.bytes.toString());
			} catch {
				throw failure('recovery Blob descriptor invalid');
			}
			return { value, token: result.token };
		} catch (error) {
			if (error.message === 'recovery Blob object missing') return null;
			throw error;
		}
	}
	function assertOwned(owner) {
		if (!active || active.nonce !== owner?.nonce) throw failure('recovery ownership lost');
		if (active.lost || performance.now() >= active.safeUntil) {
			if (active) active.lost = true;
			throw failure('recovery ownership lost');
		}
	}
	async function renewLease(owner) {
		assertOwned(owner);
		if (active.renewing) return active.renewing;
		const current = active;
		const began = performance.now();
		current.renewing = request((abortSignal) => current.lease.renewLease({ abortSignal }))
			.then(() => {
				if (active !== current || current.lost || performance.now() >= current.safeUntil)
					throw failure('recovery ownership lost');
				current.safeUntil = began + 45000;
				current.renewedAt = began;
			})
			.catch((error) => {
				current.lost = true;
				clearInterval(current.timer);
				throw error;
			})
			.finally(() => {
				current.renewing = null;
			});
		return current.renewing;
	}
	async function renew(owner) {
		assertOwned(owner);
		if (performance.now() - active.renewedAt >= 10000) await renewLease(owner);
		assertOwned(owner);
		return owner;
	}
	async function publish(expected, value, owner, claim = false) {
		await renew(owner);
		const current = await readDescriptor();
		if (
			!current ||
			current.token !== expected ||
			value.owner !== owner.nonce ||
			(claim
				? current.value.owner !== null || value.epoch !== current.value.epoch + 1
				: current.value.owner !== owner.nonce || value.epoch !== current.value.epoch)
		)
			throw failure('recovery descriptor conflict');
		assertOwned(owner);
		try {
			await request((abortSignal) =>
				descriptor.upload(json(value), json(value).length, {
					abortSignal,
					conditions: { ifMatch: expected, leaseId: owner.nonce }
				})
			);
		} catch (error) {
			// An interrupted response is not permission to overwrite. Reconcile only
			// our exact intended descriptor while our existing ownership remains valid.
			assertOwned(owner);
			const accepted = await readDescriptor();
			if (!accepted || !same(accepted.value, value)) throw error;
			return accepted;
		}
		assertOwned(owner);
		const accepted = await readDescriptor();
		if (!accepted || !same(accepted.value, value))
			throw failure('recovery publication readback failed');
		return accepted;
	}
	return {
		transport: 'azblob',
		privatePaths: env.FH_RECOVERY_CREDENTIAL_FILE
			? [path.resolve(env.FH_RECOVERY_CREDENTIAL_FILE)]
			: [],
		readDescriptor,
		async initialize(value) {
			// List only the chosen bounded namespace, never all accounts/containers.
			await request(async (abortSignal) => {
				for await (const item of container.listBlobsFlat({
					prefix: destination.prefix,
					abortSignal
				})) {
					if (item) throw failure('recovery namespace must be unused');
				}
			});
			const bytes = json(value);
			if (bytes.length > 65536 || value.owner !== null || value.epoch !== 0)
				throw failure('recovery Blob descriptor invalid');
			try {
				await request((abortSignal) =>
					descriptor.upload(bytes, bytes.length, { abortSignal, conditions: { ifNoneMatch: '*' } })
				);
			} catch (error) {
				const accepted = await readDescriptor();
				if (!accepted || !same(accepted.value, value)) throw error;
				// A create-only conflict means already initialized even identical bytes.
				if (error.message === 'recovery Blob condition conflict')
					throw failure('recovery namespace already initialized');
			}
			const accepted = await readDescriptor();
			if (!accepted || !same(accepted.value, value))
				throw failure('recovery publication readback failed');
			return accepted;
		},
		async acquire() {
			if (active) throw failure('recovery owner exists; no automatic takeover');
			const before = await readDescriptor();
			if (!before) throw failure('recovery namespace requires explicit initialization');
			if (before.value.owner !== null)
				throw failure('recovery owner exists; no automatic takeover');
			const nonce = randomUUID();
			const lease = descriptor.getBlobLeaseClient(nonce);
			const began = performance.now();
			await request((abortSignal) => lease.acquireLease(60, { abortSignal }));
			active = {
				nonce,
				lease,
				safeUntil: began + 45000,
				renewedAt: began,
				lost: false,
				renewing: null,
				timer: null
			};
			const owner = { nonce };
			active.timer = setInterval(() => {
				renewLease(owner).catch(() => {});
			}, 10000);
			active.timer.unref();
			try {
				const after = await readDescriptor();
				if (!after || after.value.owner !== null || after.token !== before.token)
					throw failure('recovery descriptor conflict');
				assertOwned(owner);
				return owner;
			} catch (error) {
				clearInterval(active.timer);
				await request((abortSignal) => lease.releaseLease({ abortSignal })).catch(() => {});
				active = null;
				throw error;
			}
		},
		renew,
		async claim(expected, owner) {
			await renew(owner);
			const current = await readDescriptor();
			if (!current || current.token !== expected || current.value.owner !== null)
				throw failure('recovery claim conflict');
			return publish(
				expected,
				{ ...current.value, owner: owner.nonce, epoch: current.value.epoch + 1 },
				owner,
				true
			);
		},
		compareAndSwap: publish,
		async read(name, limit = maxReadBytes) {
			return (await download(key(name), Math.min(limit, maxReadBytes))).bytes;
		},
		async createImmutable(name, bytes, owner) {
			await renew(owner);
			if (bytes.length > maxReadBytes || hash(bytes) !== name.split('/')[1])
				throw failure('recovery Blob object size/hash rejected');
			const client = key(name);
			try {
				await request((abortSignal) =>
					client.upload(bytes, bytes.length, { abortSignal, conditions: { ifNoneMatch: '*' } })
				);
			} catch {
				// Existing identical content is the only valid immutable retry, including
				// an unknown-success response. Never replace an existing object.
				const existing = await download(client, maxReadBytes);
				if (!existing.bytes.equals(bytes)) throw failure('immutable object conflict');
				await renew(owner);
				return;
			}
			const stored = await download(client, maxReadBytes);
			if (!stored.bytes.equals(bytes)) throw failure('recovery Blob checksum mismatch');
			await renew(owner);
		},
		async release(owner) {
			if (active?.nonce === owner?.nonce) clearInterval(active.timer);
			try {
				await renew(owner);
				const current = await readDescriptor();
				if (current && current.value.owner === null) {
					clearInterval(active.timer);
					await request((abortSignal) => active.lease.releaseLease({ abortSignal }));
					active = null;
					return;
				}
				if (!current || current.value.owner !== owner.nonce)
					throw failure('recovery ownership lost');
				assertOwned(owner);
				const value = { ...current.value, owner: null };
				try {
					await request((abortSignal) =>
						descriptor.upload(json(value), json(value).length, {
							abortSignal,
							conditions: { ifMatch: current.token, leaseId: owner.nonce }
						})
					);
				} catch (error) {
					assertOwned(owner);
					const accepted = await readDescriptor();
					if (!accepted || !same(accepted.value, value)) throw error;
				}
				const accepted = await readDescriptor();
				assertOwned(owner);
				if (!accepted || !same(accepted.value, value))
					throw failure('recovery publication readback failed');
				clearInterval(active.timer);
				await request((abortSignal) => active.lease.releaseLease({ abortSignal }));
				active = null;
			} catch (error) {
				if (active?.nonce === owner?.nonce) active.lost = true;
				throw error;
			}
		},
		async breakOwnership(expectedNonce, instanceId, { confirmedStopped = false } = {}) {
			if (
				confirmedStopped !== true ||
				!UUID.test(expectedNonce) ||
				!/^[a-z0-9][a-z0-9-]{0,62}$/.test(instanceId) ||
				active
			)
				throw failure('explicit confirmed termination and exact owner required');
			const before = await readDescriptor();
			if (!before || before.value.owner !== expectedNonce || before.value.instanceId !== instanceId)
				throw failure('recovery break owner/identity mismatch');
			// Only the externally confirmed terminated owner is broken. Its nonce is
			// also its proposed lease id; no discovery or automatic expiry takeover.
			const oldLease = descriptor.getBlobLeaseClient(expectedNonce);
			await request((abortSignal) => oldLease.releaseLease({ abortSignal })).catch((error) => {
				if (error.message !== 'recovery Blob condition conflict') throw error;
			});
			const nonce = randomUUID();
			const lease = descriptor.getBlobLeaseClient(nonce);
			await request((abortSignal) => lease.acquireLease(60, { abortSignal }));
			try {
				const current = await readDescriptor();
				if (
					!current ||
					current.token !== before.token ||
					current.value.owner !== expectedNonce ||
					current.value.instanceId !== instanceId
				)
					throw failure('recovery break owner/identity mismatch');
				const value = { ...current.value, owner: null };
				await request((abortSignal) =>
					descriptor.upload(json(value), json(value).length, {
						abortSignal,
						conditions: { ifMatch: current.token, leaseId: nonce }
					})
				);
				const accepted = await readDescriptor();
				if (!accepted || !same(accepted.value, value))
					throw failure('recovery publication readback failed');
				return accepted;
			} finally {
				await request((abortSignal) => lease.releaseLease({ abortSignal }));
			}
		}
	};
}

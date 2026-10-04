import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const digest = (value) => createHash('sha256').update(value).digest('hex');
export async function assertNoLinks(target) {
	const absolute = path.resolve(target);
	let current = path.parse(absolute).root;
	for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, component);
		try {
			const stat = await fs.lstat(current);
			if (stat.isSymbolicLink()) throw new Error('recovery path contains a link');
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
	}
}
export async function readRegular(target, limit) {
	await assertNoLinks(target);
	const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.size > limit)
			throw new Error('recovery file type/size rejected');
		const chunks = [];
		let length = 0;
		while (true) {
			const buffer = Buffer.alloc(Math.min(64 * 1024, limit - length + 1));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (!bytesRead) break;
			length += bytesRead;
			if (length > limit) throw new Error('recovery file grew beyond limit');
			chunks.push(buffer.subarray(0, bytesRead));
		}
		const result = Buffer.concat(chunks, length);
		const after = await handle.stat();
		if (
			result.length > limit ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs
		)
			throw new Error('recovery file changed during capture');
		return result;
	} finally {
		await handle.close();
	}
}
async function atomic(target, bytes) {
	await assertNoLinks(target);
	const temporary = `${target}.${randomUUID()}.tmp`;
	const handle = await fs.open(temporary, 'wx', 0o600);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fs.rename(temporary, target);
	const dir = await fs.open(path.dirname(target), 'r');
	try {
		await dir.sync();
	} finally {
		await dir.close();
	}
}

/** Directory destination holds artifacts only. Requires working atomic mkdir,
 * link/create-only, rename and coherent read-after-write from the mounted FS.
 * Ownership never expires: a paused writer is not safe to replace by a clock. */
export function createDirectoryStore(url, { maxReadBytes = 256 * 1024 * 1024 } = {}) {
	const parsed = new URL(url);
	if (
		parsed.protocol !== 'file:' ||
		parsed.host ||
		parsed.search ||
		parsed.hash ||
		parsed.username ||
		parsed.password
	)
		throw new Error('unsupported recovery destination');
	const root = fileURLToPath(parsed);
	if (!path.isAbsolute(root) || root === '/') throw new Error('invalid recovery directory');
	const descriptor = path.join(root, 'descriptor.json');
	const ownerDir = path.join(root, 'owner');
	const ownerFile = path.join(ownerDir, 'nonce');
	const mutationDir = path.join(root, 'descriptor-mutation');
	const keyPath = (key) => {
		if (!/^(objects|manifests)\/[a-f0-9]{64}$/.test(key))
			throw new Error('invalid recovery object key');
		return path.join(root, key);
	};
	async function prepare() {
		await assertNoLinks(root);
		await fs.mkdir(root, { recursive: true, mode: 0o700 });
		for (const name of ['objects', 'manifests']) {
			await assertNoLinks(path.join(root, name));
			await fs.mkdir(path.join(root, name), { recursive: true, mode: 0o700 });
		}
	}
	async function readDescriptor() {
		try {
			const bytes = await readRegular(descriptor, 64 * 1024);
			return { value: JSON.parse(bytes.toString()), token: digest(bytes) };
		} catch (error) {
			if (error.code === 'ENOENT') return null;
			throw error;
		}
	}
	async function renew(owner) {
		const actual = (await readRegular(ownerFile, 128)).toString();
		if (actual !== owner.nonce) throw new Error('recovery ownership lost');
		return owner;
	}
	async function withMutation(operation) {
		await assertNoLinks(mutationDir);
		try {
			await fs.mkdir(mutationDir, { mode: 0o700 });
		} catch (error) {
			if (error.code === 'EEXIST')
				throw new Error('recovery descriptor busy; external recovery required after interruption');
			throw error;
		}
		try {
			return await operation();
		} finally {
			await fs.rmdir(mutationDir);
		}
	}
	return {
		root,
		readDescriptor,
		async initialize(value) {
			await assertNoLinks(root);
			try {
				if ((await fs.readdir(root)).length) throw new Error('recovery namespace must be unused');
			} catch (error) {
				if (error.code !== 'ENOENT') throw error;
			}
			await prepare();
			return withMutation(async () => {
				if (await readDescriptor()) throw new Error('recovery namespace already initialized');
				try {
					await fs.lstat(ownerDir);
					throw new Error('recovery namespace is owned');
				} catch (error) {
					if (error.code !== 'ENOENT') throw error;
				}
				await atomic(descriptor, Buffer.from(JSON.stringify(value)));
				return readDescriptor();
			});
		},
		async acquire() {
			await prepare();
			const owner = { nonce: randomUUID() };
			await assertNoLinks(ownerDir);
			try {
				await fs.mkdir(ownerDir, { mode: 0o700 });
			} catch (error) {
				if (error.code === 'EEXIST')
					throw new Error('recovery owner exists; no automatic takeover');
				throw error;
			}
			const nonceFile = await fs.open(ownerFile, 'wx', 0o600);
			try {
				await nonceFile.writeFile(owner.nonce);
				await nonceFile.sync();
			} finally {
				await nonceFile.close();
			}
			for (const target of [ownerDir, root]) {
				const directory = await fs.open(target, 'r');
				try {
					await directory.sync();
				} finally {
					await directory.close();
				}
			}
			await renew(owner);
			return owner;
		},
		renew,
		async breakOwnership(expectedNonce, instanceId, { confirmedStopped = false } = {}) {
			if (
				confirmedStopped !== true ||
				!/^[a-f0-9-]{36}$/.test(expectedNonce) ||
				!/^[a-z0-9][a-z0-9-]{0,62}$/.test(instanceId)
			)
				throw new Error('explicit confirmed termination and exact owner required');
			const check = async () => {
				const current = await readDescriptor();
				if (
					!current ||
					current.value.instanceId !== instanceId ||
					current.value.owner !== expectedNonce ||
					(await readRegular(ownerFile, 128)).toString() !== expectedNonce
				)
					throw new Error('recovery break owner/identity mismatch');
				return current;
			};
			await check();
			// External confirmation means every old writer/publisher is terminated,
			// not merely unreachable or old. Only an empty generated mutation lock
			// can be cleared. No timestamps or automatic takeover are involved.
			await assertNoLinks(mutationDir);
			try {
				await fs.rmdir(mutationDir);
			} catch (error) {
				if (error.code !== 'ENOENT') throw error;
			}
			return withMutation(async () => {
				const current = await check();
				await atomic(descriptor, Buffer.from(JSON.stringify({ ...current.value, owner: null })));
				await fs.unlink(ownerFile);
				await fs.rmdir(ownerDir);
				return readDescriptor();
			});
		},
		async release(owner) {
			await withMutation(async () => {
				await renew(owner);
				await fs.unlink(ownerFile);
				await fs.rmdir(ownerDir);
			});
		},
		async read(key, limit = maxReadBytes) {
			return readRegular(keyPath(key), Math.min(limit, maxReadBytes));
		},
		async createImmutable(key, bytes, owner) {
			await renew(owner);
			if (bytes.length > maxReadBytes) throw new Error('recovery object exceeds limit');
			const target = keyPath(key);
			if (digest(bytes) !== key.split('/')[1]) throw new Error('recovery object key/hash mismatch');
			await assertNoLinks(target);
			const temporary = path.join(root, `${randomUUID()}.upload`);
			const handle = await fs.open(temporary, 'wx', 0o600);
			try {
				await handle.writeFile(bytes);
				await handle.sync();
			} finally {
				await handle.close();
			}
			try {
				await fs.link(temporary, target);
			} catch (error) {
				if (error.code !== 'EEXIST') throw error;
			} finally {
				await fs.unlink(temporary);
			}
			const directory = await fs.open(path.dirname(target), 'r');
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
			const stored = await readRegular(target, maxReadBytes);
			if (!stored.equals(bytes)) throw new Error('immutable object conflict');
			await renew(owner);
		},
		async compareAndSwap(expected, value, owner) {
			return withMutation(async () => {
				await renew(owner);
				const current = await readDescriptor();
				if (
					current?.token !== expected ||
					current.value.owner !== owner.nonce ||
					value.owner !== owner.nonce ||
					value.epoch !== current.value.epoch
				)
					throw new Error('recovery descriptor conflict');
				await atomic(descriptor, Buffer.from(JSON.stringify(value)));
				const accepted = await readDescriptor();
				if (JSON.stringify(accepted.value) !== JSON.stringify(value))
					throw new Error('recovery publication readback failed');
				return accepted;
			});
		},
		async claim(expected, owner) {
			return withMutation(async () => {
				await renew(owner);
				const current = await readDescriptor();
				if (!current || current.token !== expected) throw new Error('recovery claim conflict');
				await atomic(
					descriptor,
					Buffer.from(
						JSON.stringify({ ...current.value, owner: owner.nonce, epoch: current.value.epoch + 1 })
					)
				);
				return readDescriptor();
			});
		}
	};
}

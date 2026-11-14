#!/usr/bin/env -S bun --no-env-file
// Short-lived stdio client of Codex's native hook/config APIs. No model calls,
// plugin installation, blanket trust, or independent approval store.
import { createHash } from 'node:crypto';
import { remoteEnvironment } from './fhold-remote.mjs';

export function recallReview(value) {
	if (!Array.isArray(value)) throw new Error('Invalid Codex hook inventory.');
	const hooks = value.filter((h) => h?.pluginId === 'akm@akm-plugins');
	if (!hooks.length || hooks.length > 16)
		throw new Error('Plugin hooks are unavailable. Check the native Codex plugin installation.');
	const reviewed = hooks
		.map((h) => {
			if (
				(h.source !== 'plugin' || h.isManaged !== false) ||
				h.handlerType !== 'command' ||
				typeof h.key !== 'string' ||
				h.key.length > 1024 ||
				// Native plugin hashes may bind both handler and package content.
				// Preserve that opaque native value instead of reinterpreting it.
				typeof h.currentHash !== 'string' || !h.currentHash || h.currentHash.length > 512 ||
				typeof h.command !== 'string' ||
				h.command.length > 8192 ||
				typeof h.eventName !== 'string' ||
				typeof h.sourcePath !== 'string' ||
				typeof h.enabled !== 'boolean' ||
				!['trusted', 'untrusted', 'modified'].includes(h.trustStatus)
			)
				throw new Error('Unsupported plugin hook definition; native review is required.');
			return {
				key: h.key,
				hash: h.currentHash,
				event: h.eventName,
				command: h.command,
				sourcePath: h.sourcePath,
				enabled: h.enabled,
				trust: h.trustStatus
			};
		})
		.sort((a, b) => a.key.localeCompare(b.key));
	if (new Set(reviewed.map((h) => h.key)).size !== reviewed.length)
		throw new Error('Duplicate plugin hook identity.');
	const digest = createHash('sha256').update(JSON.stringify(reviewed)).digest('hex');
	const status = reviewed.every((h) => !h.enabled)
		? 'installed'
		: reviewed.every((h) => h.enabled && h.trust === 'trusted')
			? 'ready'
			: 'approval-needed';
	return { status, digest, hooks: reviewed };
}

export async function reviewRecall(rpc) {
	const result = await rpc('hooks/list', { cwds: ['/work'] });
	if (!Array.isArray(result?.data) || result.data.length !== 1)
		throw new Error('Invalid Codex hook inventory.');
	if (result.data[0].errors?.length)
		throw new Error(
			'Native Codex reported hook configuration errors. Review its configuration first.'
		);
	return recallReview(result.data[0].hooks);
}

export async function changeRecall(rpc, action, digest) {
	if (!['approve', 'disable'].includes(action) || !/^[a-f0-9]{64}$/.test(digest))
		throw new Error('Review the current plugin hooks and explicitly approve your choice first.');
	const config = await rpc('config/read', { includeLayers: true, cwd: '/work' });
	const layer = config.layers?.find((l) => l.name?.type === 'user' && l.name.profile === null);
	if (!layer || typeof layer.version !== 'string')
		throw new Error('Native Codex user configuration is unavailable.');
	const review = await reviewRecall(rpc);
	if (digest !== review.digest)
		throw new Error('Plugin hooks changed since review. Review the current definitions again.');
	const edits = review.hooks.flatMap((h) => {
		const key = `hooks.state.${JSON.stringify(h.key)}`;
		return action === 'disable'
			? [{ keyPath: `${key}.enabled`, value: false, mergeStrategy: 'replace' }]
			: [
					{ keyPath: `${key}.trusted_hash`, value: h.hash, mergeStrategy: 'replace' },
					{ keyPath: `${key}.enabled`, value: true, mergeStrategy: 'replace' }
				];
	});
	const result = await rpc('config/batchWrite', { edits, expectedVersion: layer.version });
	if (result.overriddenMetadata)
		throw new Error('Native policy overrides plugin hooks. Review your Codex configuration.');
	return reviewRecall(rpc);
}

// One bounded JSON-RPC session over a native Codex app-server transport.
async function withCodexRpc(callback, { connect, client, failure, rejected, timeoutMs }) {
	const pending = new Map();
	let serial = 0;
	let stopped;
	let transport;
	const fail = () => {
		stopped = new Error(failure);
		for (const entry of pending.values()) entry.reject(stopped);
		pending.clear();
		transport?.stop(stopped);
	};
	const receive = (message) => {
		const response = JSON.parse(message);
		const entry = pending.get(response.id);
		if (!entry) return;
		pending.delete(response.id);
		if (response.error) entry.reject(new Error(rejected));
		else entry.resolve(response.result);
	};
	transport = connect({ receive, fail });
	const timer = setTimeout(fail, timeoutMs);
	const rpc = (method, params) => new Promise((resolve, reject) => {
		if (stopped) return reject(stopped);
		const id = ++serial;
		pending.set(id, { resolve, reject });
		try { transport.send({ jsonrpc: '2.0', id, method, params }); }
		catch { fail(); }
	});
	try {
		await rpc('initialize', { clientInfo: { name: client, version: '1' } });
		transport.send({ jsonrpc: '2.0', method: 'initialized' });
		return await callback(rpc);
	} finally {
		clearTimeout(timer);
		await transport.close();
	}
}

/** Short-lived private app-server over stdio for native hook review/changes. */
export function withCodexRecall(
	callback,
	{ env = process.env, workdir = '/work', timeoutMs = 12_000 } = {}
) {
	return withCodexRpc(callback, {
		client: 'fhold-recall-setup',
		failure: 'Codex hook review failed or timed out. Check native configuration and update Assistant.',
		rejected: 'Native Codex rejected the hook configuration change; review again.',
		timeoutMs,
		connect: ({ receive, fail }) => {
			const child = Bun.spawn(['codex', 'app-server'], {
				cwd: workdir,
				env: remoteEnvironment(env),
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'ignore'
			});
			const reader = (async () => {
				let buffer = '';
				const decoder = new TextDecoder();
				try {
					for await (const chunk of child.stdout) {
						buffer += decoder.decode(chunk, { stream: true });
						if (buffer.length > 1_048_576) throw new Error('Invalid native output');
						while (buffer.includes('\n')) {
							const end = buffer.indexOf('\n');
							const line = buffer.slice(0, end);
							buffer = buffer.slice(end + 1);
							receive(line);
						}
					}
				} catch { /* reported below */ }
				fail();
			})();
			return {
				send: (message) => {
					child.stdin.write(`${JSON.stringify(message)}\n`);
					child.stdin.flush();
				},
				stop: () => child.kill(),
				close: async () => {
					child.kill();
					const force = setTimeout(() => child.kill('SIGKILL'), 2000);
					try {
						await child.exited;
						await reader;
					} finally {
						clearTimeout(force);
					}
				}
			};
		}
	});
}

if (import.meta.main) {
	try {
		const [action = 'review', digest] = process.argv.slice(2);
		const result = await withCodexRecall((rpc) =>
			action === 'review' ? reviewRecall(rpc) : changeRecall(rpc, action, digest)
		);
		console.log(JSON.stringify(result));
	} catch (error) {
		console.log(JSON.stringify({ error: error.message }));
		process.exitCode = 1;
	}
}

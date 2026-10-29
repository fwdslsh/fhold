// Runs inside the candidate image, through its shipped adapter and Azure SDK.
// The proxy injects real HTTP/socket faults; product clocks/state are untouched.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createBlobStore } from '/usr/local/bin/recovery/blob-store.mjs';

assert.equal(process.env.FIXTURE_LIVE, '0', 'fault injection is emulator-only');
assert.ok(process.pid > 1, 'run under the image init, as the normal writer parent does');
const { BlobServiceClient } = createRequire('/opt/fhold/tools/package.json')('@azure/storage-blob');
const connection = await readFile('/run/secrets/recovery-storage', 'utf8');
const runtime = process.versions.bun ? 'bun' : 'node';
const upstream = new URL(/BlobEndpoint=([^;]+)/.exec(connection)[1]);
assert.equal(upstream.hostname, 'azurite');
const container = BlobServiceClient.fromConnectionString(connection).getContainerClient(
	process.env.FIXTURE_CONTAINER
);
const cases = new Map();
const timers = new Set();
const children = new Set();
const later = (callback, milliseconds) => {
	const timer = setTimeout(() => { timers.delete(timer); callback(); }, milliseconds);
	timers.add(timer);
};
let writerStoppedAt;
const writerStop = () => { writerStoppedAt ??= performance.now(); };
process.on('SIGTERM', writerStop);
const proxy = createServer((request, response) => {
	const state = [...cases.values()].find((item) => request.url.includes(`/${item.name}/`));
	const renewing = state && request.headers['x-ms-lease-action'] === 'renew';
	if (renewing) {
		state.attempts++;
		state.lastAttemptAt = performance.now();
		if (state.mode === 'hung' || (state.mode === 'stalled' && state.attempts === 1)) {
			// The network accepts the request but never completes it. Unlike the
			// delayed control below, the fixture must not supply a socket error.
			request.resume();
			response.on('close', () => { state.clientClosed = true; });
			return;
		}
		if (state.mode === 'outage') {
			response.writeHead(500, { 'content-type': 'application/xml' });
			response.end('<Error><Code>OperationTimedOut</Code><Message>emulator fault</Message></Error>');
			request.resume();
			return;
		}
		if (state.mode === 'delayed' && state.attempts === 1) {
			request.resume();
			later(() => response.destroy(), 12_000);
			return;
		}
	}
	const forward = httpRequest({
		hostname: upstream.hostname, port: upstream.port,
		method: request.method, path: request.url, headers: request.headers
	}, (reply) => {
		if (state && request.headers['x-ms-lease-action'] === 'acquire' && reply.statusCode === 201)
			state.acquiredAt = performance.now();
		if (renewing && (state.mode === 'late' ||
			(state.attempts === 1 && ['unknown', 'stalled-unknown'].includes(state.mode)))) {
			assert.equal(reply.statusCode, 200, 'real server accepted the same-owner renewal');
			state.acceptedUnknown = true;
			reply.resume();
			if (state.mode === 'stalled-unknown') response.on('close', () => { state.clientClosed = true; });
			else if (state.mode === 'unknown') later(() => response.destroy(), 12_000);
			else later(() => {
				state.lateReplyAttempted = true;
				response.writeHead(reply.statusCode, reply.headers);
				response.end();
			}, Math.max(0, state.acquiredAt + 47_000 - performance.now()));
			return;
		}
		response.writeHead(reply.statusCode, reply.headers);
		reply.pipe(response);
	});
	forward.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
	request.on('aborted', () => forward.destroy());
	request.pipe(forward);
});
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const credential = `/fixture/renewal-credential-${runtime}`;
await writeFile(credential, connection.replace(/BlobEndpoint=[^;]+/,
	`BlobEndpoint=http://127.0.0.1:${proxy.address().port}${upstream.pathname}`), { mode: 0o600 });
const env = { ...process.env, FH_RECOVERY_CREDENTIAL_FILE: credential };
const base = `azblob://${process.env.FIXTURE_ACCOUNT}/${process.env.FIXTURE_CONTAINER}/`;
const descriptor = { format: 1, instanceId: 'renewal-fault', owner: null, epoch: 0, generation: null };
const checks = {};
async function adapterCase(mode) {
	const state = { name: `renewal-${runtime}-${mode}`, mode, attempts: 0 };
	cases.set(mode, state);
	const url = base + state.name;
	const store = await createBlobStore(url, { env });
	await store.initialize(descriptor);
	const owner = await store.acquire();
	const head = await store.claim((await store.readDescriptor()).token, owner);
	if (mode === 'conflict')
		await container.getBlobClient(`${state.name}/descriptor.json`).getBlobLeaseClient().breakLease(0);
	await delay(11_000);
	if (['delayed', 'unknown', 'stalled', 'stalled-unknown'].includes(mode)) {
		state.awaitedAt = performance.now();
		await store.renew(owner);
		state.returnedAt = performance.now();
		assert.ok(state.attempts >= 2, `the same-owner renewal retried: ${JSON.stringify(state)}`);
		if (['unknown', 'stalled-unknown'].includes(mode)) assert.equal(state.acceptedUnknown, true);
		if (mode.startsWith('stalled')) {
			assert.equal(state.clientClosed, true, 'client aborted the unresponsive attempt');
			assert.ok(state.returnedAt - state.acquiredAt < 25_000, 'retry completes within the original safety window');
		}
		const recovered = { attempts: state.attempts, recoveredAtMs: Math.round(state.returnedAt - state.acquiredAt) };
		assert.equal((await store.readDescriptor()).value.owner, owner.nonce, 'same owner retained');
		await store.release(owner);
		assert.equal((await store.readDescriptor()).value.owner, null);
		const replacement = await createBlobStore(url, { env });
		const nextOwner = await replacement.acquire();
		await replacement.claim((await replacement.readDescriptor()).token, nextOwner);
		await replacement.release(nextOwner);
		checks[mode] = { sameOwnerRecovered: true, ordinaryReplacement: true, ...recovered };
		return;
	}
	await assert.rejects(() => store.renew(owner));
	const failedAt = performance.now() - state.acquiredAt;
	if (mode === 'conflict') {
		assert.equal(state.attempts, 1, 'definitive conflict is not retried');
		assert.ok(failedAt < 15_000, 'conflict fails promptly');
	} else {
		assert.ok(failedAt >= 43_000 && failedAt < 47_000, 'old safety window bounds the operation');
		if (mode === 'late') {
			await delay(Math.max(0, state.acquiredAt + 47_200 - performance.now()));
			assert.equal(state.lateReplyAttempted, true);
			assert.equal(state.acceptedUnknown, true);
		} else {
			assert.ok(state.attempts > 1, 'unresponsive requests retry without extending authority');
		}
		await assert.rejects(() => store.renew(owner), /ownership lost/);
	}
	await assert.rejects(() => store.compareAndSwap(head.token, { ...head.value, generation: 'a'.repeat(64) }, owner));
	await assert.rejects(() => store.release(owner), /ownership lost/);
	const after = (await store.readDescriptor()).value;
	assert.equal(after.owner, owner.nonce);
	assert.equal(after.generation, null, 'no publication after loss');
	await assert.rejects(() => createBlobStore(url, { env }).then((other) => other.acquire()), /no automatic takeover/);
	checks[mode] = { failedAtMs: Math.round(failedAt), ownerRetained: true, unsafePublicationRejected: true, attempts: state.attempts };
}

async function wrapperOutage() {
	const state = { name: `renewal-${runtime}-outage`, mode: 'outage', attempts: 0 };
	cases.set('outage', state);
	const root = `/fixture/renewal-wrapper-${runtime}`;
	await mkdir(root, { recursive: true });
	const program = `
		import {mkdir,writeFile,readFile} from 'node:fs/promises';
		import {createBlobStore} from '/usr/local/bin/recovery/blob-store.mjs';
		import {createEngine} from '/usr/local/bin/recovery/engine.mjs';
		import {runRecovery} from '/usr/local/bin/fhold-recovery';
		const root=${JSON.stringify(root)}, runtimeDir=root+'/runtime';
		const roots=Object.fromEntries(['home','stash','work','akmData','akmConfig'].map(k=>[k,root+'/'+k]));
		for(const dir of Object.values(roots))await mkdir(dir,{recursive:true});
		await mkdir(runtimeDir);await writeFile(runtimeDir+'/recovery-writers-started','synthetic writer parent');
		await writeFile(roots.work+'/payload','accepted before the outage');
		const url=${JSON.stringify(base + state.name)};
		const store=await createBlobStore(url,{env:process.env});
		const engine=createEngine({url,instanceId:'renewal-wrapper',privateDir:root+'/private'},{roots,store});
		await engine.initialize();
		let failed=false;
		try{await runRecovery({runtimeDir,intervalSeconds:60,maxUnsavedSeconds:300,probePort:0},{env:process.env,engine});}
		catch{failed=true;}
		console.log(JSON.stringify({failed,status:JSON.parse(await readFile(runtimeDir+'/recovery-status.json','utf8'))}));
	`;
	const child = spawn('bun', ['--no-env-file', '--config=/dev/null', '--eval', program], {
		env: { ...env, FH_RECOVERY_PARENT_PID: String(process.pid) }, stdio: ['ignore', 'pipe', 'pipe']
	});
	children.add(child);
	let stdout = '', stderr = '';
	child.stdout.on('data', (bytes) => { stdout += bytes; });
	child.stderr.on('data', (bytes) => { stderr += bytes; });
	const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
	children.delete(child);
	assert.equal(code, 0, stderr);
	const result = JSON.parse(stdout);
	assert.equal(result.failed, true);
	assert.equal(result.status.state, 'failed');
	assert.ok(state.attempts > 1, 'sustained transient failures were retried');
	assert.ok(writerStoppedAt, 'real recovery wrapper signaled its writer parent');
	const stoppedAtMs = writerStoppedAt - state.acquiredAt;
	assert.ok(stoppedAtMs >= 43_000 && stoppedAtMs < 47_000, 'writer-stop signal at the original safety deadline');
	const store = await createBlobStore(base + state.name, { env });
	const after = (await store.readDescriptor()).value;
	assert.ok(after.owner);
	assert.match(after.generation, /^[a-f0-9]{64}$/, 'initial checkpoint retained');
	assert.equal(after.checkpointAt, result.status.lastPublishedAt, 'no unsafe final checkpoint');
	await assert.rejects(() => store.acquire(), /no automatic takeover/);
	checks.outage = { stoppedAtMs: Math.round(stoppedAtMs), attempts: state.attempts, ownerRetained: true, acceptedCheckpointRetained: true };
}

try {
	const modes = ['delayed', 'unknown', 'stalled', 'stalled-unknown', 'conflict', 'late', 'hung'];
	const results = await Promise.allSettled(modes.map(adapterCase).concat(wrapperOutage()));
	for (const [index, result] of results.entries()) {
		assert.equal(result.status, 'fulfilled', `${modes[index] ?? 'wrapper outage'}: ${result.reason?.message}`);
	}
	console.log(JSON.stringify({ checks }));
} finally {
	for (const child of children) child.kill('SIGKILL');
	for (const timer of timers) clearTimeout(timer);
	proxy.closeAllConnections();
	await new Promise((resolve) => proxy.close(resolve));
	process.off('SIGTERM', writerStop);
}

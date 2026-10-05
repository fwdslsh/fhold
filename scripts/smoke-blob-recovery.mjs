#!/usr/bin/env node
// Azurite by default; explicit live mode uses only an existing scoped container.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const image = process.env.FH_RECOVERY_TEST_IMAGE;
assert.ok(image, 'Set FH_RECOVERY_TEST_IMAGE to the exact Blob-enabled candidate');
const uid = process.getuid?.();
const gid = process.getgid?.();
assert.ok(
	Number.isInteger(uid) && uid > 0 && Number.isInteger(gid) && gid >= 0,
	'Run image qualification as a non-root Linux user with access to Docker'
);
const runtimeUser = `${uid}:${gid}`;
const root = await mkdtemp(join(tmpdir(), 'fhold-blob-smoke-'));
await chmod(root, 0o700);
const suffix = randomUUID().slice(0, 8);
const live = process.env.FH_RECOVERY_TEST_LIVE === '1';
const suppliedUrl = process.env.FH_RECOVERY_TEST_URL;
const liveMatch = suppliedUrl?.match(
	/^azblob:\/\/([a-z0-9]{3,24})\/([a-z0-9-]{3,63})\/([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)$/
);
if (live) {
	assert.ok(liveMatch, 'Live mode requires an explicit account/container/disposable-prefix URL');
	assert.ok(
		process.env.FH_RECOVERY_TEST_CREDENTIAL_FILE?.startsWith('/'),
		'Live mode requires an absolute private credential file'
	);
	const credentialStat = await lstat(process.env.FH_RECOVERY_TEST_CREDENTIAL_FILE);
	assert.ok(
		credentialStat.isFile() && (credentialStat.mode & 0o077) === 0,
		'Live credential must be an owner-only regular file'
	);
}
const account = live ? liveMatch[1] : 'devstoreaccount1';
const prefix = live ? `${liveMatch[3]}/smoke-${randomUUID()}` : '';
const network = live
	? process.env.FH_RECOVERY_TEST_DOCKER_NETWORK || 'bridge'
	: `fhold-recovery-smoke-${suffix}`;
const emulator = `fhold-recovery-smoke-${suffix}-azurite`;
const container = live ? liveMatch[2] : `smoke-${suffix}`;
const credentialFile = live
	? process.env.FH_RECOVERY_TEST_CREDENTIAL_FILE
	: join(root, 'emulator-credential');
// Microsoft's PUBLIC emulator credential, never a production storage secret.
// https://learn.microsoft.com/azure/storage/common/storage-connect-azurite
const emulatorKey =
	'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
const connection = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${emulatorKey};BlobEndpoint=http://azurite:10000/devstoreaccount1;`;
if (!live) await writeFile(credentialFile, connection, { mode: 0o600 });
const report = {
	image,
	runtimeUser,
	fixture: root,
	emulatorVersion: live ? null : '3.37.0',
	destination: `azblob://${account}/${container}/${prefix || '(emulator fixture)'}`,
	checks: {},
	qualification: live
		? 'explicit scoped live data-plane fixture; no management API, managed identity, outage, performance, or native account qualification'
		: 'local emulator only; no live Azure identity, outage, performance, or native account qualification'
};
if (!live)
	report.emulatorApiVersionCheck =
		'skipped for shipped SDK API 2026-10-06; emulator semantics only';
const created = new Set();
let madeNetwork = false;

function command(executable, args, { timeout = 120000, env = process.env } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
		const chunks = [];
		let bytes = 0;
		const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
		for (const stream of [child.stdout, child.stderr])
			stream.on('data', (chunk) => {
				bytes += chunk.length;
				if (bytes > 2000000) child.kill('SIGKILL');
				else chunks.push(chunk);
			});
		child.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once('exit', (code, signal) => {
			clearTimeout(timer);
			const output = Buffer.concat(chunks)
				.toString()
				.replaceAll(emulatorKey, '[public-emulator-key]')
				.replaceAll(connection, '[emulator-connection]');
			if (code === 0) resolve(output.trim());
			else
				reject(
					new Error(
						`${executable} ${args[0]} failed (${code ?? signal})${live ? '' : `: ${output.slice(-6000)}`}`
					)
				);
		});
	});
}
const docker = (args, timeout) => command('docker', args, { timeout });
async function imageScript(name, script, timeout = 180000) {
	const target = `fhold-recovery-smoke-${suffix}-${name}`;
	created.add(target);
	return docker(
		[
			'run',
			'--rm',
			'--name',
			target,
			'--user',
			runtimeUser,
			'--network',
			network,
			'--mount',
			`type=bind,source=${root},target=/fixture`,
			'--mount',
			`type=bind,source=${credentialFile},target=/run/secrets/recovery-storage,readonly`,
			'-e',
			'FH_RECOVERY_CREDENTIAL_FILE=/run/secrets/recovery-storage',
			'-e',
			`FH_RECOVERY_ALLOW_INSECURE=${live ? '0' : '1'}`,
			'-e',
			`FIXTURE_ACCOUNT=${account}`,
			'-e',
			`FIXTURE_PREFIX=${prefix}`,
			'-e',
			`FIXTURE_LIVE=${live ? '1' : '0'}`,
			'-e',
			`FIXTURE_CONTAINER=${container}`,
			'--entrypoint',
			'bun',
			image,
			'--no-env-file',
			'--config=/dev/null',
			'-e',
			script
		],
		timeout
	);
}

// The image's shipped SDK and transport are exercised directly. Only this test
// script creates a Blob container; the product transport must never do so.
const conformance = `
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createBlobStore} from '/usr/local/bin/recovery/blob-store.mjs';
import {createEngine} from '/usr/local/bin/recovery/engine.mjs';
import {Database} from 'bun:sqlite';
const require=createRequire('/opt/fhold/tools/package.json');
const {BlobServiceClient}=require('@azure/storage-blob');
const connection=await readFile('/run/secrets/recovery-storage','utf8');
const service=BlobServiceClient.fromConnectionString(connection,{retryOptions:{maxTries:1}});
const container=service.getContainerClient(process.env.FIXTURE_CONTAINER);
let created=false;let lastFailure='not ready';
if(process.env.FIXTURE_LIVE==='1'){await container.getProperties();created=true;}
else for(let i=0;i<40;i++){try{await container.create();created=true;break;}catch(error){if(error.statusCode===409){created=true;break;}lastFailure=String(error.statusCode||'transport')+':'+String(error.code||error.name||'error')+':'+String(error.details?.headerName||'')+':'+String(error.details?.headerValue||'');await new Promise(r=>setTimeout(r,250));}}
assert.equal(created,true,'emulator fixture container create: '+lastFailure);
const checks={};
const scoped=(path)=>[process.env.FIXTURE_PREFIX,path].filter(Boolean).join('/');
const base='azblob://'+process.env.FIXTURE_ACCOUNT+'/'+process.env.FIXTURE_CONTAINER+'/';
const destination=base+scoped('conformance');
const store=await createBlobStore(destination,{env:process.env,operationTimeoutMs:10000});
const descriptor={format:1,catalog:1,instanceId:'conformance',versions:{native:'fixture'},owner:null,epoch:0,generation:null};
await store.initialize(descriptor);
await assert.rejects(()=>store.initialize(descriptor));
checks.initializeCreateOnly=true;
let owner=await store.acquire();
let head=await store.claim((await store.readDescriptor()).token,owner);
const second=await createBlobStore(destination,{env:process.env,operationTimeoutMs:10000});
await assert.rejects(()=>second.acquire());
checks.descriptorLeaseExclusive=true;
const bytes=Buffer.from('immutable synthetic blob payload');
const key='objects/'+createHash('sha256').update(bytes).digest('hex');
await Promise.all([store.createImmutable(key,bytes,owner),store.createImmutable(key,bytes,owner)]);
assert.equal((await store.read(key)).equals(bytes),true);
await assert.rejects(()=>store.createImmutable(key,Buffer.from('wrong bytes'),owner));
checks.immutableRaceAndIntegrity=true;
const before=head.token;
const casRace=await Promise.allSettled([
  store.compareAndSwap(head.token,{...head.value,generation:'a'.repeat(64)},owner),
  store.compareAndSwap(head.token,{...head.value,generation:'b'.repeat(64)},owner)
]);
assert.equal(casRace.filter(r=>r.status==='fulfilled').length,1);
head=casRace.find(r=>r.status==='fulfilled').value;
await assert.rejects(()=>store.compareAndSwap(before,{...head.value,generation:'b'.repeat(64)},owner));
checks.etagCasRejectsStale=true;
await store.release(owner);
await assert.rejects(()=>store.compareAndSwap(head.token,{...head.value,generation:'c'.repeat(64)},owner));
checks.releasedPublisherRejected=true;
const bad='/fixture/bad-credential';
await writeFile(bad,connection.replace(/AccountKey=[^;]+/,'AccountKey='+Buffer.alloc(64,7).toString('base64')),{mode:0o600});
const badStore=await createBlobStore(destination,{env:{...process.env,FH_RECOVERY_CREDENTIAL_FILE:bad},operationTimeoutMs:3000});
await assert.rejects(()=>badStore.readDescriptor());
checks.badCredentialFailsClosed=true;
// Lease break does not authorize takeover of the persisted owner. External
// confirmed termination is mandatory; no emulator clock manipulation is used.
owner=await store.acquire();
head=await store.claim((await store.readDescriptor()).token,owner);
await container.getBlobClient(scoped('conformance/descriptor.json')).getBlobLeaseClient().breakLease(0);
await assert.rejects(()=>second.acquire());
await assert.rejects(()=>store.compareAndSwap(head.token,{...head.value,generation:'d'.repeat(64)},owner));
checks.brokenLeaseDoesNotAutoTakeover=true;
if(typeof second.breakOwnership==='function'){
  await assert.rejects(()=>second.breakOwnership(owner.nonce,'conformance',{confirmedStopped:false}));
  await second.breakOwnership(owner.nonce,'conformance',{confirmedStopped:true});
  checks.confirmedStoppedUnlock=true;
}
// The generic engine uses real committed WAL SQLite and bounded file artifacts.
const roots={home:'/fixture/engine-home',stash:'/fixture/engine-stash',work:'/fixture/engine-work',akmData:'/fixture/engine-data',akmConfig:'/fixture/engine-config'};
for(const path of Object.values(roots))await mkdir(path,{recursive:true});
await mkdir(roots.home+'/.local/share/opencode',{recursive:true});
const db=new Database(roots.home+'/.local/share/opencode/opencode.db');
db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE marker(value TEXT)');
db.query('INSERT INTO marker VALUES (?)').run('committed WAL marker');
await writeFile(roots.work+'/fixture.txt','durable workspace file');
const engineUrl=base+scoped('engine');
const engineStore=await createBlobStore(engineUrl,{env:process.env,operationTimeoutMs:10000});
const config={url:engineUrl,instanceId:'engine-fixture',versions:{native:'fixture'},privateDir:'/fixture/engine-private'};
let dropUpload=false;
const faultStore={...engineStore,createImmutable:async(...args)=>{if(dropUpload)throw new Error('synthetic dropped upload');return engineStore.createImmutable(...args);}};
const engine=createEngine(config,{roots,store:faultStore});
await engine.initialize();await engine.acquireRestore();await engine.checkpoint();
const durable=(await engineStore.readDescriptor()).value.generation;
await writeFile(roots.work+'/failed-upload.txt','not durably published');
dropUpload=true;await assert.rejects(()=>engine.checkpoint());dropUpload=false;
assert.equal((await engineStore.readDescriptor()).value.generation,durable);
checks.failedImmutableUploadPreservesHead=true;
// An orphan immutable object must not advance the accepted head. A real aborted
// SDK upload similarly must remain invisible as a complete generation.
const pending=container.getBlockBlobClient(scoped('engine/objects/'+'e'.repeat(64)));
const abort=new AbortController();let progressed=false;
await assert.rejects(()=>pending.uploadData(Buffer.alloc(20*1024*1024),{blockSize:1024*1024,maxSingleShotSize:1024*1024,concurrency:1,abortSignal:abort.signal,onProgress:()=>{progressed=true;abort.abort();}}));
assert.equal(progressed,true,'cancel after a real partial upload');
assert.equal((await engineStore.readDescriptor()).value.generation,durable);
checks.abortedUploadPreservesHead=true;
db.close();await engine.release();
const fresh={};for(const [name,path]of Object.entries(roots)){fresh[name]=path+'-replacement';await mkdir(fresh[name],{recursive:true});}
const restored=createEngine({...config,privateDir:'/fixture/engine-private-replacement'},{roots:fresh,store:await createBlobStore(engineUrl,{env:process.env,operationTimeoutMs:10000})});
await restored.acquireRestore();
const recovered=new Database(fresh.home+'/.local/share/opencode/opencode.db',{readonly:true});
assert.equal(recovered.query('SELECT value FROM marker').get().value,'committed WAL marker');recovered.close();
assert.equal(await readFile(fresh.work+'/fixture.txt','utf8'),'durable workspace file');
await assert.rejects(()=>readFile(fresh.work+'/failed-upload.txt'));
await restored.release();checks.genericEngineWalAndFilesReplacement=true;
await writeFile('/fixture/conformance-report.json',JSON.stringify({checks},null,2),{mode:0o600});
console.log(JSON.stringify({checks}));
`;

try {
	report.imageId = await docker(['image', 'inspect', image, '--format', '{{.Id}}']);
	if (!live) {
		await docker(['network', 'create', network]);
		madeNetwork = true;
		created.add(emulator);
		await docker([
			'run',
			'-d',
			'--name',
			emulator,
			'--network',
			network,
			'--network-alias',
			'azurite',
			'--user',
			runtimeUser,
			'mcr.microsoft.com/azure-storage/azurite:3.37.0',
			'azurite-blob',
			'--blobHost',
			'0.0.0.0',
			'--location',
			'/tmp/fhold-azurite',
			'--silent',
			'--disableTelemetry',
			'--disableProductStyleUrl',
			'--skipApiVersionCheck'
		]);
	}
	report.conformance = JSON.parse(await imageScript('conformance', conformance));
	report.checks.transportConformance = true;
	const smoke = join(dirname(fileURLToPath(import.meta.url)), 'smoke-recovery.mjs');
	const output = await command(process.execPath, [smoke], {
		timeout: 420000,
		env: {
			...process.env,
			FH_RECOVERY_TEST_URL: `azblob://${account}/${container}/${prefix ? `${prefix}/` : ''}native`,
			FH_RECOVERY_TEST_DOCKER_NETWORK: network,
			FH_RECOVERY_TEST_CREDENTIAL_FILE: credentialFile,
			FH_RECOVERY_TEST_ALLOW_INSECURE: live ? '0' : '1'
		}
	});
	report.nativeImage = JSON.parse(output);
	assert.equal(report.nativeImage.ok, true);
	report.checks.fullNativeImageBlobReplacement = true;
	report.nativeDescriptor = JSON.parse(
		await imageScript(
			'verify-native',
			`import assert from'node:assert/strict';import{createRequire}from'node:module';import{readFile}from'node:fs/promises';const{BlobServiceClient}=createRequire('/opt/fhold/tools/package.json')('@azure/storage-blob');const service=BlobServiceClient.fromConnectionString(await readFile('/run/secrets/recovery-storage','utf8'));const blob=service.getContainerClient(process.env.FIXTURE_CONTAINER).getBlobClient([process.env.FIXTURE_PREFIX,'native/descriptor.json'].filter(Boolean).join('/'));const descriptor=JSON.parse((await blob.downloadToBuffer()).toString());assert.equal(descriptor.owner,null);assert.equal(descriptor.epoch,3);assert.match(descriptor.generation,/^[a-f0-9]{64}$/);console.log(JSON.stringify({epoch:descriptor.epoch,generation:descriptor.generation,checkpointAt:descriptor.checkpointAt}));`
		)
	);
	report.checks.nativeBlobFinalCheckpointAndOwnerRelease = true;
	report.ok = true;
} catch (error) {
	report.ok = false;
	report.error = live
		? 'scoped live qualification failed; raw transport output suppressed'
		: error.message.replaceAll(emulatorKey, '[public-emulator-key]');
	process.exitCode = 1;
} finally {
	for (const name of created) {
		try {
			await docker(['inspect', name, '--format', '{{.Id}}']);
		} catch {
			continue;
		}
		try {
			await docker(['stop', '--time', '10', name], 20000);
		} catch {
			/* already exited */
		}
		try {
			await docker(['rm', name]);
		} catch (error) {
			report.cleanupError = error.message;
			process.exitCode = 1;
		}
	}
	if (madeNetwork) {
		try {
			await docker(['network', 'rm', network]);
		} catch (error) {
			report.cleanupError = error.message;
			process.exitCode = 1;
		}
	}
	await writeFile(join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {
		mode: 0o600
	});
	console.log(JSON.stringify(report, null, 2));
}

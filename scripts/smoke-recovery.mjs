#!/usr/bin/env node
// Black-box image qualification. Uses only new synthetic containers and retains
// its private destination/report. Does not prove vendor sign-in or reconnect.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const image = process.env.FH_RECOVERY_TEST_IMAGE;
assert.ok(image, 'Set FH_RECOVERY_TEST_IMAGE to the exact candidate image');
const sourceImage = process.env.FH_RECOVERY_UPGRADE_FROM_IMAGE || image;
const survivingHome = process.env.FH_RECOVERY_TEST_SURVIVING_HOME === '1';
const uid = process.getuid?.();
const gid = process.getgid?.();
assert.ok(
	Number.isInteger(uid) && uid > 0 && Number.isInteger(gid) && gid >= 0,
	'Run image qualification as a non-root Linux user with access to Docker'
);
const runtimeUser = `${uid}:${gid}`;
const root = await mkdtemp(join(tmpdir(), 'fhold-recovery-smoke-'));
await chmod(root, 0o700);
const backup = join(root, 'backup');
await mkdir(backup, { mode: 0o700 });
const nativeHome = join(root, 'native-home');
if (survivingHome) await mkdir(nativeHome, { mode: 0o700 });
const url = process.env.FH_RECOVERY_TEST_URL || 'file:///backup';
const network = process.env.FH_RECOVERY_TEST_DOCKER_NETWORK;
const credentialFile = process.env.FH_RECOVERY_TEST_CREDENTIAL_FILE;
const instance = `smoke-${randomUUID().slice(0, 8)}`;
const password = 'synthetic-recovery-smoke-only';
const lockMarker = `synthetic-process-lock-${randomUUID()}`;
const claudeSpawnFile = '/home/fhold/.claude/bridge-spawn/fhold-recovery-fixture/append-system-prompt.txt';
const processLockFiles = [
	claudeSpawnFile,
	'/opt/akm/data/index.rebuild.lock',
	'/opt/akm/data/akm.lock.lck',
	'/opt/akm/data/state/locks/fhold-recovery-fixture/improve.lock',
	'/opt/akm/data/secret-locks/fhold-recovery-fixture.lock',
	'/opt/akm/data/extract-locks/fhold-recovery-fixture.lock',
	'/opt/akm/data/workflow-run-locks/fhold-recovery-fixture.lock',
	'/etc/akm/config.json.lck'
];
const envFile = join(root, 'runtime.env');
const includeFile = join(root, 'include.json');
const customSelection = {
	version: 1,
	paths: [
		'/home/fhold/.claude',
		'/home/fhold/.codex',
		'/home/fhold/.custom-client',
		'/tmp/fhold-extra state',
		'/tmp/fhold-extra state/nested',
		'/tmp/fhold-settings.json'
	],
	sqlite: [
		'/tmp/fhold-extra state/nested/app.sqlite',
		'/tmp/fhold-independent.sqlite',
		'/work/custom.sqlite'
	],
	excludePaths: ['/work/volatile'],
	externalMounts: ['/work/drive-ro', '/stash/drive', '/mounted-drive'],
	autoExcludeNetworkMounts: false,
	recoverMounts: []
};
const external = Object.fromEntries(
	['read-only', 'read-write', 'outside'].map((name) => [name, join(root, name)])
);
for (const [name, directory] of Object.entries(external)) {
	await mkdir(directory, { mode: 0o755 });
	await writeFile(join(directory, 'external.txt'), `initial-${name}`, { mode: 0o644 });
	// An independently owned database is intentionally not cataloged or traversed.
	await writeFile(join(directory, 'external.sqlite'), 'externally-owned-synthetic-content', {
		mode: 0o644
	});
}
await writeFile(includeFile, JSON.stringify(customSelection), { mode: 0o644 });
await writeFile(
	envFile,
	`${[
		`FH_RECOVERY_URL=${url}`,
		`FH_INSTANCE_ID=${instance}`,
		'FH_RECOVERY_INCLUDE_FILE=/run/fhold-recovery-includes.json',
		'FH_SCHEDULER_ENABLED=0',
		'FH_RECOVERY_INTERVAL_SECONDS=2',
		'FH_RECOVERY_MAX_UNSAVED_SECONDS=120',
		'FH_SHUTDOWN_SECONDS=25',
		'FH_AUTOMATIC_MEMORY=0',
		`OPENCODE_SERVER_PASSWORD=${password}`,
		...(credentialFile ? ['FH_RECOVERY_CREDENTIAL_FILE=/run/secrets/recovery-storage'] : []),
		...(process.env.FH_RECOVERY_TEST_ALLOW_INSECURE === '1' ? ['FH_RECOVERY_ALLOW_INSECURE=1'] : [])
	].join('\n')}\n`,
	{ mode: 0o600 }
);
const created = new Set();
const report = {
	image,
	sourceImage,
	survivingHome,
	runtimeUser,
	instance,
	fixture: root,
	checks: {},
	qualification: 'synthetic local image only; no provider or vendor account readiness'
};

const runFile = promisify(execFile);
async function command(executable, args, timeout = 120_000) {
	const redact = (text) => String(text ?? '').replaceAll(password, '[synthetic-password]');
	try {
		const { stdout, stderr } = await runFile(executable, args, {
			timeout,
			killSignal: 'SIGKILL',
			maxBuffer: 2_000_000
		});
		// JSON belongs on stdout; degraded-state diagnostics stay on stderr.
		if (stderr) process.stderr.write(redact(stderr));
		return redact(stdout).trim();
	} catch (error) {
		throw new Error(
			`${executable} ${args[0]} failed (${error.code ?? error.signal}): ${redact(`${error.stdout ?? ''}${error.stderr ?? ''}`).slice(-6000)}`
		);
	}
}
const docker = (args, timeout) => command('docker', args, timeout);
const common = [
	'--user',
	runtimeUser,
	'--env-file',
	envFile,
	'--mount',
	`type=bind,source=${backup},target=/backup`,
	...(survivingHome ? ['--mount', `type=bind,source=${nativeHome},target=/home/fhold`] : []),
	'--mount',
	`type=bind,source=${includeFile},target=/run/fhold-recovery-includes.json,readonly`,
	'--mount',
	`type=bind,source=${external['read-only']},target=/work/drive-ro,readonly`,
	'--mount',
	`type=bind,source=${external['read-write']},target=/stash/drive`,
	'--mount',
	`type=bind,source=${external.outside},target=/mounted-drive`,
	...(network ? ['--network', network] : []),
	...(credentialFile
		? [
				'--mount',
				`type=bind,source=${credentialFile},target=/run/secrets/recovery-storage,readonly`
			]
		: [])
];
async function poll(probe, label, timeout = 120_000) {
	const deadline = Date.now() + timeout;
	let last;
	while (Date.now() < deadline) {
		try {
			const value = await probe();
			if (value) return value;
		} catch (error) {
			if (error.fatal) throw error;
			last = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`Timed out ${label}: ${last?.message || 'condition not met'}`);
}
async function start(suffix, selectedImage = image) {
	const name = `fhold-recovery-smoke-${instance}-${suffix}`;
	const id = await docker([
		'run',
		'-d',
		'--name',
		name,
		...common,
		'-p',
		'127.0.0.1::4096',
		selectedImage
	]);
	created.add(id);
	await poll(async () => {
		await docker(['exec', id, 'fhold-healthcheck'], 15_000);
		return true;
	}, `${suffix} native authenticated and recovery health`);
	const bindings = JSON.parse(
		await docker(['inspect', id, '--format', '{{json .NetworkSettings.Ports}}'])
	);
	return {
		id,
		image: selectedImage,
		v2: /(?:^|\s)v?2\./.test(await docker(['exec', id, 'opencode', '--version'])),
		endpoint: `http://127.0.0.1:${bindings['4096/tcp'][0].HostPort}`
	};
}
async function api(container, route, options = {}, authenticated = true) {
	const response = await fetch(container.endpoint + (container.v2 ? '/api' : '') + route, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			...(authenticated
				? {
						Authorization: `Basic ${Buffer.from(`${container.v2 ? 'opencode' : 'user'}:${password}`).toString('base64')}`
					}
				: {})
		},
		signal: AbortSignal.timeout(10_000)
	});
	return response;
}
const execBun = (id, source) =>
	docker(['exec', id, 'bun', '--no-env-file', '--config=/dev/null', '-e', source]);
const nativeClient = `import {OpenCode} from '/opt/fhold/tools/node_modules/@opencode/client/dist/promise/index.js';
const client=OpenCode.make({baseUrl:'http://127.0.0.1:4096',headers:{authorization:'Basic '+Buffer.from('opencode:'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64')}});`;
async function nativeMessages(container, sessionID) {
	return JSON.parse(
		await execBun(
			container.id,
			`${nativeClient}
console.log(JSON.stringify((await client.message.list({sessionID:${JSON.stringify(sessionID)},order:'asc',limit:200})).data));`
		)
	);
}
async function completeNativeReply(container, sessionID) {
	const marker = `synthetic-complete-recovery-reply-${randomUUID()}`;
	// Only the disposable fixture supplies an HTTP model. Use native configuration,
	// prompting and persistence rather than inserting rows or patching vendor code.
	const server = `import http from 'node:http';import{writeFileSync}from'node:fs';
http.createServer(async(req,res)=>{for await(const _chunk of req){};
const chunk=(delta,finish_reason)=>({id:'recovery',object:'chat.completion.chunk',created:1,model:'marker',choices:[{index:0,delta,finish_reason}]});
res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify(chunk({role:'assistant',content:${JSON.stringify(marker)}},null))+'\\n\\ndata: '+JSON.stringify(chunk({},'stop'))+'\\n\\ndata: [DONE]\\n\\n');
}).listen(0,'127.0.0.1',function(){writeFileSync('/tmp/fhold-recovery-model-port',String(this.address().port));});`;
	await docker(['exec', '-d', container.id, 'node', '--input-type=module', '-e', server]);
	const port = await poll(
		async () =>
			Number(
				await execBun(
					container.id,
					`import{readFileSync}from'node:fs';console.log(readFileSync('/tmp/fhold-recovery-model-port','utf8'));`
				)
			),
		'controlled model listener'
	);
	await execBun(
		container.id,
		`import{readFileSync,writeFileSync,renameSync}from'node:fs';
const file=process.env.OPENCODE_CONFIG;const settings=JSON.parse(readFileSync(file,'utf8'));
settings.model='recovery-fixture/marker';settings.providers={...settings.providers,'recovery-fixture':{name:'Recovery fixture',package:'@opencode/ai/providers/openai-compatible',settings:{baseURL:'http://127.0.0.1:${port}/v1',apiKey:'synthetic-fixture'},models:{marker:{capabilities:{tools:true,input:['text'],output:['text']}}}}};
writeFileSync(file+'.fixture',JSON.stringify(settings));renameSync(file+'.fixture',file);`
	);
	await poll(
		async () =>
			JSON.parse(
				await execBun(
					container.id,
					`${nativeClient}
console.log(JSON.stringify((await client.model.default({location:{directory:'/work'}})).data?.id==='marker'));`
				)
			),
		'native model configuration'
	);
	await execBun(
		container.id,
		`${nativeClient}
await client.session.prompt({sessionID:${JSON.stringify(sessionID)},text:'Return the synthetic recovery marker.'});`
	);
	await poll(
		async () =>
			(await nativeMessages(container, sessionID)).some(
				(message) =>
					message.type === 'assistant' &&
					message.time.completed &&
					message.content.some((part) => part.type === 'text' && part.text === marker)
			),
		'completed native final reply'
	);
	// Match the reported short reply-to-Stop interval. Compare complete native
	// records, including IDs, parts and completion fields, immediately before Stop.
	await new Promise((resolve) => setTimeout(resolve, 7_000));
	const messages = await nativeMessages(container, sessionID);
	await writeFile(join(root, 'native-messages-before-stop.json'), JSON.stringify(messages), {
		mode: 0o600
	});
	return messages;
}
async function stop(container) {
	await docker(['stop', '--time', '360', container.id], 380_000);
	const status = JSON.parse(await docker(['inspect', container.id, '--format', '{{json .State}}']));
	assert.equal(status.ExitCode, 0, 'graceful runtime exit');
	if (container.image === image) {
		const { stdout, stderr } = await runFile('docker', ['logs', container.id], {
			timeout: 10_000,
			maxBuffer: 2_000_000
		});
		const logs = stdout + stderr;
		const writers = logs.indexOf('assistant: shutdown: stopping native writers');
		const recovery = logs.indexOf(
			'assistant: shutdown: writers stopped; finishing recovery checkpoint and owner release'
		);
		const released = logs.indexOf(
			'assistant: shutdown: recovery checkpoint completed and owner released'
		);
		const complete = logs.indexOf('assistant: shutdown complete');
		assert.ok(
			writers >= 0 && recovery > writers && released > recovery && complete > released,
			'PID 1 must observe writer shutdown, successful recovery and ownership release before exit'
		);
		report.checks.pid1ShutdownAndRecoveryCompletionLogged = true;
	}
}
async function released(checkpointImage = image) {
	if (url !== 'file:///backup') return;
	const descriptor = JSON.parse(await readFile(join(backup, 'descriptor.json'), 'utf8'));
	const ownerGone = await readFile(join(backup, 'owner/nonce'))
		.then(() => false)
		.catch((error) => error.code === 'ENOENT');
	assert.equal(ownerGone, true, 'ownership lock released after final checkpoint');
	assert.match(descriptor.generation, /^[a-f0-9]{64}$/);
	assert.equal(descriptor.catalog, 3);
	const manifest = JSON.parse(
		await readFile(join(backup, 'manifests', descriptor.generation), 'utf8')
	);
	assert.equal(manifest.selectionHash, descriptor.selectionHash);
	assert.deepEqual(manifest.selection, {
		version: 1,
		paths: [...customSelection.paths].sort(),
		sqlite: [...customSelection.sqlite].sort(),
		excludePaths: customSelection.excludePaths,
		externalMounts: [...customSelection.externalMounts].sort(),
		recoverMounts: [],
		autoExcludeNetworkMounts: false
	});
	assert.deepEqual(manifest.networkMounts, []);
	assert.equal(
		manifest.members.some((member) => /^(drive-ro|drive|volatile)(\/|$)/.test(member.path)),
		false
	);
	assert.equal(
		manifest.members.filter(
			(member) => member.kind === 'sqlite' && member.id?.startsWith('custom-')
		).length,
		3
	);
	assert.equal(
		manifest.members.some((member) => /-wal$|-shm$|not-selected/.test(member.path)),
		false
	);
	const capturedClaudeSpawn = manifest.members.some(
		(member) => member.root === 'home' && member.path.startsWith('.claude/bridge-spawn/')
	);
	if (checkpointImage === image) {
		assert.equal(capturedClaudeSpawn, false, 'candidate checkpoints must exclude Claude spawn files');
		report.checks.candidateCheckpointsExcludeClaudeSpawn = true;
	} else {
		// Historical source images predate this exclusion. The replacement must
		// accept those manifests and omit their spawn files from fresh storage.
		report.historicalCheckpointContainsClaudeSpawn = capturedClaudeSpawn;
	}
	report.checks.customSelectionRecordedAndSqliteSnapshotted = true;
	report.checks.externalMountsAbsentFromCheckpoint = true;
	report.descriptor = {
		epoch: descriptor.epoch,
		generation: descriptor.generation,
		checkpointAt: descriptor.checkpointAt
	};
}

async function qualifyAkmIndexCache() {
	const cacheBackup = join(root, 'akm-cache-backup');
	const cacheBundle = join(root, 'akm-cache-bundle');
	await mkdir(cacheBackup, { mode: 0o700 });
	await mkdir(join(cacheBundle, 'knowledge'), { recursive: true, mode: 0o755 });
	const knowledge = async (name, description) =>
		writeFile(
			join(cacheBundle, 'knowledge', `${name}.md`),
			`---\nname: ${name}\ndescription: ${description}\n---\n\n${description}\n`,
			{ mode: 0o644 }
		);
	await knowledge('cache-keep', 'Synthetic cache smoke surviving original content');
	await knowledge('cache-deleted', 'Synthetic cache smoke deleted original content');
	const cacheCommon = [
		'--user',
		runtimeUser,
		'--mount',
		`type=bind,source=${cacheBackup},target=/backup`,
		'--mount',
		`type=bind,source=${cacheBundle},target=/cache-bundle,readonly`,
		'--env',
		`FH_RECOVERY_URL=${url.startsWith('file:') ? 'file:///backup' : `${url}/akm-cache`}`,
		'--env',
		`FH_INSTANCE_ID=${instance}-cache`,
		'--env',
		'FH_RECOVERY_AKM_INDEX_CAPTURE=1',
		'--env',
		'FH_RECOVERY_AKM_INDEX_RESTORE=1',
		'--env',
		'FH_RECOVERY_INTERVAL_SECONDS=2',
		'--env',
		'FH_RECOVERY_MAX_UNSAVED_SECONDS=120',
		'--env',
		'FH_SCHEDULER_ENABLED=0',
		'--env',
		'FH_AUTOMATIC_MEMORY=0',
		'--env',
		'FH_CODEX_REMOTE=0',
		'--env',
		'FH_CLAUDE_REMOTE=0',
		'--env',
		'AKM_BUNDLE_DIR=/cache-bundle',
		'--env',
		`OPENCODE_SERVER_PASSWORD=${password}`,
		...(network ? ['--network', network] : []),
		...(credentialFile
			? [
					'--mount',
					`type=bind,source=${credentialFile},target=/run/secrets/recovery-storage,readonly`,
					'--env',
					'FH_RECOVERY_CREDENTIAL_FILE=/run/secrets/recovery-storage'
				]
			: []),
		...(process.env.FH_RECOVERY_TEST_ALLOW_INSECURE === '1'
			? ['--env', 'FH_RECOVERY_ALLOW_INSECURE=1']
			: [])
	];
	const initName = `fhold-recovery-smoke-${instance}-cache-init`;
	created.add(initName);
	await docker([
		'run',
		'--rm',
		'--name',
		initName,
		...cacheCommon,
		'--entrypoint',
		'fhold-recovery',
		image,
		'init',
		'--confirm-new-instance'
	]);
	const startCache = async (suffix) => {
		const began = Date.now();
		const name = `fhold-recovery-smoke-${instance}-cache-${suffix}`;
		const id = await docker(['run', '-d', '--name', name, ...cacheCommon, image]);
		created.add(id);
		await poll(async () => {
			await docker(['exec', id, 'fhold-healthcheck'], 15_000);
			return true;
		}, `cache ${suffix} authenticated core readiness`);
		return { id, coreReadyMs: Date.now() - began };
	};
	const stopCache = async (id) => {
		await docker(['stop', '--time', '360', id], 380_000);
		assert.equal(
			JSON.parse(await docker(['inspect', id, '--format', '{{json .State}}'])).ExitCode,
			0
		);
	};
	const first = await startCache('first');
	await docker([
		'exec',
		first.id,
		'akm',
		'bundle',
		'add',
		'/cache-bundle',
		'--adapter',
		'akm',
		'--format',
		'json',
		'-q'
	]);
	await docker(['exec', first.id, 'akm', 'index', '--clean', '--format', 'json', '-q']);
	await poll(
		async () =>
			JSON.parse(await docker(['exec', first.id, 'fhold-recovery', 'status'])).akmIndexCache
				?.state === 'captured',
		'native optional cache capture'
	);
	await stopCache(first.id);
	await knowledge('cache-keep', 'Synthetic cache smoke surviving CHANGED content');
	await rm(join(cacheBundle, 'knowledge/cache-deleted.md'));
	await knowledge('cache-added', 'Synthetic cache smoke added content');
	const second = await startCache('second');
	// Authenticated core readiness can precede writer admission and the first
	// checkpoint. Wait for recovery's own ready status before inspecting its
	// per-boot cache result; optional diagnostics are not a core health gate.
	const status = await poll(
		async () => JSON.parse(await docker(['exec', second.id, 'fhold-recovery', 'status'])),
		'replacement recovery writer admission'
	);
	assert.equal(
		status.akmIndexCache.restored,
		true,
		'replacement must admit a cleaned cache before native readers'
	);
	const beganKnowledge = Date.now();
	const result = JSON.parse(
		await docker([
			'exec',
			second.id,
			'akm',
			'search',
			'Synthetic cache smoke',
			'--format',
			'json',
			'--detail',
			'full',
			'-q'
		])
	);
	assert.ok(Array.isArray(result.hits));
	assert.ok(result.hits.find((hit) => hit.name === 'cache-keep')?.description.includes('CHANGED'));
	assert.ok(result.hits.some((hit) => hit.name === 'cache-added'));
	assert.ok(!result.hits.some((hit) => hit.name === 'cache-deleted'));
	report.akmIndexCache = {
		firstCoreReadyMs: first.coreReadyMs,
		replacementCoreReadyMs: second.coreReadyMs,
		firstCorrectKnowledgeQueryMs: Date.now() - beganKnowledge,
		restored: true,
		qualification:
			'synthetic native image/read-only bind only; no embedding provider or CIFS performance qualification'
	};
	await stopCache(second.id);
	report.checks.experimentalAkmCacheNativeReplacement = true;
}

async function qualifyRuntimeRecovery() {
	report.imageId = await docker(['image', 'inspect', image, '--format', '{{.Id}}']);
	report.sourceImageId = await docker(['image', 'inspect', sourceImage, '--format', '{{.Id}}']);
	const initName = `fhold-recovery-smoke-${instance}-init`;
	created.add(initName);
	await docker([
		'run',
		'--rm',
		'--name',
		initName,
		...(!network ? ['--network', 'none'] : []),
		...common,
		'--entrypoint',
		'/usr/local/bin/fhold-recovery',
		sourceImage,
		'init',
		'--confirm-new-instance'
	]);
	const outsideIndex = common.indexOf(`type=bind,source=${external.outside},target=/mounted-drive`);
	assert.ok(outsideIndex > 0);
	const missingMount = [...common.slice(0, outsideIndex - 1), ...common.slice(outsideIndex + 1)];
	const missingName = `fhold-recovery-smoke-${instance}-missing-mount`;
	created.add(missingName);
	await assert.rejects(
		docker([
			'run',
			'--rm',
			'--name',
			missingName,
			...missingMount,
			'--entrypoint',
			'fhold-recovery',
			image,
			'run'
		]),
		/required external mount missing/
	);
	report.checks.missingRequiredMountBlocksNativeStartup = true;
	report.checks.explicitInitialization = true;
	const first = await start('first', sourceImage);
	assert.equal(await docker(['exec', first.id, 'id', '-u']), String(uid));
	assert.equal(await docker(['exec', first.id, 'id', '-g']), String(gid));
	report.checks.nonRootHostIdentity = true;
	const coverage = JSON.parse(await docker(['exec', first.id, 'fhold-recovery', 'inspect']));
	assert.equal(
		coverage.externalMounts.find((mount) => mount.path === '/work/drive-ro').readOnly,
		true
	);
	assert.equal(
		coverage.externalMounts.find((mount) => mount.path === '/mounted-drive').readOnly,
		false
	);
	report.checks.realMountNamespaceInspected = true;
	assert.equal((await api(first, first.v2 ? '/info' : '/global/health', {}, false)).status, 401);
	report.checks.authenticationRejectsAnonymous = true;
	const createdSession = await api(first, '/session', {
		method: 'POST',
		body: JSON.stringify({
			title: 'synthetic recovery fixture',
			...(first.v2 ? { location: { directory: '/work' } } : {})
		})
	});
	assert.equal(createdSession.ok, true, 'native session creation');
	const sessionResponse = await createdSession.json();
	const session = first.v2 ? sessionResponse.data : sessionResponse;
	assert.equal(typeof session.id, 'string');
	report.sessionId = session.id;
	const apiMarker = `synthetic-native-api-${randomUUID()}`;
	const shellResponse = await api(first, `/session/${session.id}/shell`, {
		method: 'POST',
		body: JSON.stringify({
			...(!first.v2 ? { agent: 'build' } : {}),
			command: `mkdir -p /stash/knowledge; printf '%s' '${apiMarker}' > /work/recovery-api-fixture.txt; printf '%s' '${apiMarker}' > /stash/knowledge/recovery-api-fixture.txt`
		})
	});
	assert.equal(shellResponse.ok, true, 'native shell writes synthetic markers without a provider');
	async function verifyNativeFiles(container) {
		for (const directory of ['/work', '/stash/knowledge']) {
			const query = new URLSearchParams(
				container.v2
					? { 'location[directory]': directory }
					: { directory, path: 'recovery-api-fixture.txt' }
			);
			const response = await api(
				container,
				`${container.v2 ? '/fs/read/recovery-api-fixture.txt' : '/file/content'}?${query}`
			);
			assert.equal(response.ok, true, `native file API for ${directory}`);
			assert.equal(
				container.v2 ? await response.text() : (await response.json()).content,
				apiMarker
			);
		}
	}
	await verifyNativeFiles(first);
	async function nativeCodexInventory(container) {
		return JSON.parse(await execBun(container.id,
			`import{readFile}from'node:fs/promises';import{withCodexRecall,reviewRecall}from'/usr/local/bin/fhold-codex-recall.mjs';const review=await withCodexRecall(reviewRecall);const userConfig=await readFile('/home/fhold/.codex/config.toml','utf8').catch(()=>null);console.log(JSON.stringify({status:review.status,digest:review.digest,hooks:review.hooks,userConfig}));`
		));
	}
	const codexInventory = await nativeCodexInventory(first);
	assert.ok(codexInventory.hooks.length > 0, 'real native hooks must be discoverable');
	assert.ok(codexInventory.hooks.every((hook) => hook.enabled));
	if (sourceImage === image) {
		assert.equal(codexInventory.status, 'approval-needed', 'fresh native hooks require explicit consent');
	} else {
		// The published source may have used system-managed registration. The
		// current image must still honor its own native consent after upgrade.
		assert.ok(['ready', 'approval-needed'].includes(codexInventory.status));
	}
	report.codexHookStatusBeforeRecovery = codexInventory.status;
	report.checks.nativeCodexInventoryInitializedWithoutAccount = true;
	const codexPresence = JSON.parse(
		await execBun(
			first.id,
			`import{access}from'node:fs/promises';const presence={};for(const name of ['state_5.sqlite','logs_2.sqlite','goals_1.sqlite','thread_history_1.sqlite','memories_1.sqlite','queue_1.sqlite']){presence[name]=await access('/home/fhold/.codex/'+name).then(()=>true).catch(()=>false);}console.log(JSON.stringify(presence));`
		)
	);
	assert.ok(
		Object.values(codexPresence).some(Boolean),
		'native app-server initialized SQLite state'
	);
	report.codexDatabasePresence = codexPresence;
	await execBun(
		first.id,
		`import{mkdir,writeFile}from'node:fs/promises';for(const p of ['/stash/knowledge','/home/fhold/.codex'])await mkdir(p,{recursive:true});await writeFile('/stash/knowledge/recovery-fixture.md','Synthetic durable knowledge marker.');await writeFile('/work/recovery-fixture.txt','Synthetic workspace marker.');await writeFile('/home/fhold/.codex/auth.json',JSON.stringify({fixtureOnly:'synthetic-account-marker'}));await writeFile('/home/fhold/.claude.json',JSON.stringify({fixtureTrustMarker:'synthetic-trust-marker'}));`
	);
	await execBun(
		first.id,
		`
		import{mkdir,writeFile}from'node:fs/promises';import{Database}from'bun:sqlite';
		for(const p of ['/home/fhold/.custom-client','/tmp/fhold-extra state/nested'])await mkdir(p,{recursive:true});
		await mkdir('/work/volatile',{recursive:true});await writeFile('/work/volatile/ignored.sqlite','not traversed');
		await writeFile('/home/fhold/.custom-client/auth.json','synthetic-custom-client-account',{mode:0o600});
		await writeFile('/tmp/fhold-extra state/nested/note','synthetic-extra-directory',{mode:0o700});
		await writeFile('/tmp/fhold-settings.json','synthetic-individual-file');
		await writeFile('/home/fhold/not-selected','excluded-sentinel');
		for(const[index,file]of ${JSON.stringify(customSelection.sqlite)}.entries()){
			const db=new Database(file);db.exec('PRAGMA journal_mode=WAL;CREATE TABLE marker(id INTEGER PRIMARY KEY,value TEXT)');
			db.query('INSERT INTO marker(value) VALUES(?)').run('synthetic-custom-sqlite-'+index);db.close();
		}
	`
	);
	await execBun(
		first.id,
		`import{mkdir,writeFile}from'node:fs/promises';import path from'node:path';
	for(const file of ${JSON.stringify(processLockFiles)}){
		await mkdir(path.dirname(file),{recursive:true});
		await writeFile(file,JSON.stringify({pid:1,fixture:${JSON.stringify(lockMarker)}}),{flag:'wx',mode:0o600});
	}
	await writeFile('/opt/akm/data/akm.lock.lck.notes',${JSON.stringify(lockMarker)}, {mode:0o600});`
	);
	const initial = JSON.parse(await docker(['exec', first.id, 'fhold-recovery', 'status']));
	await poll(async () => {
		const current = JSON.parse(await docker(['exec', first.id, 'fhold-recovery', 'status']));
		report.periodicStatus = current;
		if (
			current.lastAttemptFailed &&
			/link|uncataloged|SQLite snapshot\/validation/.test(current.failure || '')
		) {
			const error = new Error(`Native checkpoint rejected: ${current.failure}`);
			error.fatal = true;
			throw error;
		}
		return current.lastPublishedAt >= initial.lastPublishedAt + 4000;
	}, 'multiple complete independent checkpoints');
	report.checks.independentPeriodicCheckpoints = true;
	report.catalog = JSON.parse(
		await execBun(
			first.id,
			`import{readFile,readdir}from'node:fs/promises';const data={};data.opencodeFiles=await readdir('/home/fhold/.local/share/opencode');data.akmFiles=await readdir('/opt/akm/data');data.versions=JSON.parse(await readFile('/opt/fhold/tools/package.json','utf8')).dependencies;console.log(JSON.stringify(data));`
		)
	);
	report.checks.realPinnedCatalogInspected = true;
	const nativeBeforeStop = first.v2 ? await completeNativeReply(first, session.id) : null;
	await stop(first);
	await released(first.image);
	if (survivingHome)
		await writeFile(
			join(nativeHome, '.custom-client/newer-local-note'),
			'newer-surviving-native-state',
			{ mode: 0o600 }
		);
	for (const [name, directory] of Object.entries(external))
		await writeFile(join(directory, 'external.txt'), `newer-${name}`, { mode: 0o644 });
	report.checks.gracefulFinalCheckpointAndRelease = true;
	const second = await start('replacement');
	await execBun(
		second.id,
		`import assert from'node:assert/strict';import{readFile}from'node:fs/promises';
	for(const file of ${JSON.stringify(processLockFiles)}){
		const value=await readFile(file,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
		if(${survivingHome} && file===${JSON.stringify(claudeSpawnFile)}){
			// This file survived on the bind mount; recovery must not delete it.
			assert.equal(value,JSON.stringify({pid:1,fixture:${JSON.stringify(lockMarker)}}),'surviving native state must remain unchanged');
			continue;
		}
		assert.equal(value.includes(${JSON.stringify(lockMarker)}),false,'historical process lock must not be restored');
	}
	assert.equal(await readFile('/opt/akm/data/akm.lock.lck.notes','utf8'),${JSON.stringify(lockMarker)});`
	);
	report.checks.nativeProcessLocksNotRestoredAndSimilarDurableFilesPreserved = true;
	if (survivingHome) {
		await execBun(
			second.id,
			`import assert from'node:assert/strict';import{readFile}from'node:fs/promises';assert.equal(await readFile('/home/fhold/.custom-client/newer-local-note','utf8'),'newer-surviving-native-state');`
		);
		report.checks.survivingReceiptAndNewerLocalStatePreserved = true;
	}
	report.checks.imageUpgradeRestored = sourceImage !== image;
	await execBun(
		second.id,
		`import assert from'node:assert/strict';import{readFile,access}from'node:fs/promises';
		for(const [name,root]of Object.entries({'read-only':'/work/drive-ro','read-write':'/stash/drive',outside:'/mounted-drive'})){
			assert.equal(await readFile(root+'/external.txt','utf8'),'newer-'+name);
			assert.equal(await readFile(root+'/external.sqlite','utf8'),'externally-owned-synthetic-content');
		}assert.equal(await access('/work/volatile').then(()=>true).catch(()=>false),false);`
	);
	report.checks.independentReadOnlyAndWritableMountsPreserved = true;
	const sessionsResponse = await api(second, '/session');
	assert.equal(sessionsResponse.ok, true);
	const sessionsBody = await sessionsResponse.json();
	const sessions = second.v2 ? sessionsBody.data : sessionsBody;
	assert.ok(
		sessions.some((value) => value.id === session.id),
		'native session recovered into empty writable layer'
	);
	if (nativeBeforeStop) {
		const restoredMessages = await nativeMessages(second, session.id);
		await writeFile(
			join(root, 'native-messages-after-restore.json'),
			JSON.stringify(restoredMessages),
			{ mode: 0o600 }
		);
		assert.deepEqual(
			restoredMessages,
			nativeBeforeStop,
			'complete native messages survive final checkpoint and fresh restore'
		);
		report.checks.completedNativeReplyAndFullMessageRecordsRestored = true;
	}
	await execBun(
		second.id,
		`import assert from'node:assert/strict';import{readFile,access}from'node:fs/promises';assert.equal(await readFile('/stash/knowledge/recovery-fixture.md','utf8'),'Synthetic durable knowledge marker.');assert.equal(await readFile('/work/recovery-fixture.txt','utf8'),'Synthetic workspace marker.');assert.equal(JSON.parse(await readFile('/home/fhold/.codex/auth.json','utf8')).fixtureOnly,'synthetic-account-marker');assert.equal(JSON.parse(await readFile('/home/fhold/.claude.json','utf8')).fixtureTrustMarker,'synthetic-trust-marker');for(const name of ['scheduler.pid','reconciliation.pid']){let found=false;try{await access('/tmp/fhold-runtime/'+name);found=true;}catch{}assert.equal(found,false);}console.log('synthetic state and scheduler-off assertions passed');`
	);
	report.checks.emptyLayerReplacement = !survivingHome;
	await execBun(
		second.id,
		`
		import assert from'node:assert/strict';import{readFile,stat,access}from'node:fs/promises';import{Database}from'bun:sqlite';
		assert.equal(await readFile('/home/fhold/.custom-client/auth.json','utf8'),'synthetic-custom-client-account');
		assert.equal((await stat('/home/fhold/.custom-client/auth.json')).mode&0o777,0o600);
		assert.equal(await readFile('/tmp/fhold-extra state/nested/note','utf8'),'synthetic-extra-directory');
		assert.equal((await stat('/tmp/fhold-extra state/nested/note')).mode&0o777,0o700);
		assert.equal(await readFile('/tmp/fhold-settings.json','utf8'),'synthetic-individual-file');
		assert.equal(await access('/home/fhold/not-selected').then(()=>true).catch(()=>false),${survivingHome});
		if(${survivingHome})assert.equal(await readFile('/home/fhold/not-selected','utf8'),'excluded-sentinel');
		for(const[index,file]of ${JSON.stringify(customSelection.sqlite)}.entries()){
			const db=new Database(file,{readonly:true});assert.equal(Object.values(db.query('PRAGMA integrity_check').get())[0],'ok');
			assert.equal(db.query('SELECT value FROM marker').get().value,'synthetic-custom-sqlite-'+index);db.close();
		}
		console.log('custom paths and registered SQLite files preserved or restored');
	`
	);
	report.checks.customPathsAndSqliteRestored = true;
	await verifyNativeFiles(second);
	report.checks.nativeShellAndFileApiRestored = true;
	await execBun(
		second.id,
		`import assert from'node:assert/strict';import{Database}from'bun:sqlite';const presence=${JSON.stringify(codexPresence)};for(const[name,initialized]of Object.entries(presence)){if(!initialized)continue;const db=new Database('/home/fhold/.codex/'+name,{readonly:true});assert.equal(Object.values(db.query('PRAGMA integrity_check').get())[0],'ok');db.close();}console.log('initialized pinned native Codex database catalog restored');`
	);
	report.checks.nativeCodexInitializedDatabasesRecovered = true;
	const restoredCodexInventory = await nativeCodexInventory(second);
	assert.equal(restoredCodexInventory.status, 'approval-needed', 'recovery must not silently approve native hooks');
	assert.ok(restoredCodexInventory.hooks.length > 0);
	assert.ok(restoredCodexInventory.hooks.every((hook) => hook.enabled));
	if (codexInventory.userConfig !== null) {
		assert.equal(restoredCodexInventory.userConfig, codexInventory.userConfig,
			'recovery preserves existing native user settings/consent bytes');
	}
	if (sourceImage === image) {
		assert.equal(restoredCodexInventory.digest, codexInventory.digest);
		assert.deepEqual(restoredCodexInventory.hooks, codexInventory.hooks);
	}
	report.codexHookStatusAfterRecovery = restoredCodexInventory.status;
	report.checks.nativeCodexInventoryAndConsentRecovered = true;
	report.checks.syntheticKnowledgeWorkspaceAccountTrustRestored = true;
	report.checks.schedulerDisabled = true;
	await stop(second);
	await released();
	const restarted = await start('candidate-restart');
	const restartedBody = await (await api(restarted, '/session')).json();
	const restartedSessions = restarted.v2 ? restartedBody.data : restartedBody;
	assert.ok(
		restartedSessions.some((value) => value.id === session.id),
		'new candidate checkpoint restores on the next restart'
	);
	await verifyNativeFiles(restarted);
	await stop(restarted);
	await released();
	report.checks.upgradedCheckpointRestoredOnNextRestart = true;
	const offlineName = `fhold-recovery-smoke-${instance}-offline`;
	created.add(offlineName);
	await docker([
		'run',
		'--name',
		offlineName,
		...common,
		'--entrypoint',
		'fhold-recovery',
		image,
		'restore',
		'--confirm-stopped'
	]);
	const offlineState = JSON.parse(
		await docker(['inspect', offlineName, '--format', '{{json .State}}'])
	);
	assert.equal(offlineState.Running, false);
	assert.equal(offlineState.ExitCode, 0);
	await docker([
		'cp',
		`${offlineName}:/work/recovery-fixture.txt`,
		join(root, 'offline-workspace.txt')
	]);
	assert.equal(
		await readFile(join(root, 'offline-workspace.txt'), 'utf8'),
		'Synthetic workspace marker.'
	);
	await released();
	report.checks.offlineRestoreWithoutNativeWritersAndRelease = true;
	const harnessPath = join(dirname(fileURLToPath(import.meta.url)), 'smoke-akm-harnesses.mjs');
	const harnessName = `fhold-recovery-smoke-${instance}-harnesses`;
	created.add(harnessName);
	report.harnessResult = await docker(
		[
			'run',
			'--rm',
			'--name',
			harnessName,
			'--user',
			runtimeUser,
			'--network',
			'none',
			'--mount',
			`type=bind,source=${harnessPath},target=/tmp/smoke-akm-harnesses.mjs,readonly`,
			'--entrypoint',
			'bun',
			image,
			'--no-env-file',
			'--config=/dev/null',
			'/tmp/smoke-akm-harnesses.mjs'
		],
		240_000
	);
	report.checks.realNativeAkmHarnesses = true;
}

try {
	if (!process.argv.includes('--akm-index-cache-only')) await qualifyRuntimeRecovery();
	await qualifyAkmIndexCache();
	report.ok = true;
} catch (error) {
	report.ok = false;
	report.error = error.message.replaceAll(password, '[synthetic-password]');
	process.exitCode = 1;
	for (const id of created) {
		try {
			const output = await docker(['exec', id, 'fhold-recovery', 'status']);
			report.failedStatus = JSON.parse(output);
		} catch {
			/* stopped or unhealthy; last periodic status remains recorded */
		}
	}
} finally {
	for (const id of created) {
		try {
			await docker(['inspect', id, '--format', '{{.Id}}']);
		} catch {
			continue; /* --rm transient already removed */
		}
		try {
			await docker(['stop', '--time', '65', id], 80_000);
		} catch {
			/* already exited */
		}
		try {
			await docker(['rm', id]);
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

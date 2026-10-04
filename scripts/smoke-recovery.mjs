#!/usr/bin/env node
// Black-box image qualification. Uses only new synthetic containers and retains
// its private destination/report. Does not prove vendor sign-in or reconnect.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const image = process.env.FH_RECOVERY_TEST_IMAGE;
assert.ok(image, 'Set FH_RECOVERY_TEST_IMAGE to the exact candidate image');
const root = await mkdtemp(join(tmpdir(), 'fhold-recovery-smoke-'));
await chmod(root, 0o700);
const backup = join(root, 'backup');
await mkdir(backup, { mode: 0o700 });
const url = process.env.FH_RECOVERY_TEST_URL || 'file:///backup';
const network = process.env.FH_RECOVERY_TEST_DOCKER_NETWORK;
const credentialFile = process.env.FH_RECOVERY_TEST_CREDENTIAL_FILE;
const instance = `smoke-${randomUUID().slice(0, 8)}`;
const password = 'synthetic-recovery-smoke-only';
const envFile = join(root, 'runtime.env');
const includeFile = join(root, 'include.json');
const customSelection = {
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
	]
};
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
	instance,
	fixture: root,
	checks: {},
	qualification: 'synthetic local image only; no provider or vendor account readiness'
};

function command(executable, args, timeout = 120_000) {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		const chunks = [];
		let length = 0;
		const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
		for (const stream of [child.stdout, child.stderr])
			stream.on('data', (chunk) => {
				length += chunk.length;
				if (length > 2_000_000) child.kill('SIGKILL');
				else chunks.push(chunk);
			});
		child.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once('exit', (code, signal) => {
			clearTimeout(timer);
			const output = Buffer.concat(chunks).toString().replaceAll(password, '[synthetic-password]');
			if (code === 0) resolve(output.trim());
			else
				reject(
					new Error(`${executable} ${args[0]} failed (${code ?? signal}): ${output.slice(-6000)}`)
				);
		});
	});
}
const docker = (args, timeout) => command('docker', args, timeout);
const common = [
	'--env-file',
	envFile,
	'--mount',
	`type=bind,source=${backup},target=/backup`,
	'--mount',
	`type=bind,source=${includeFile},target=/run/fhold-recovery-includes.json,readonly`,
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
async function start(suffix) {
	const name = `fhold-recovery-smoke-${instance}-${suffix}`;
	const id = await docker(['run', '-d', '--name', name, ...common, '-p', '127.0.0.1::4096', image]);
	created.add(id);
	await poll(async () => {
		await docker(['exec', id, 'fhold-healthcheck'], 15_000);
		return true;
	}, `${suffix} native authenticated and recovery health`);
	const bindings = JSON.parse(
		await docker(['inspect', id, '--format', '{{json .NetworkSettings.Ports}}'])
	);
	return { id, endpoint: `http://127.0.0.1:${bindings['4096/tcp'][0].HostPort}` };
}
async function api(container, route, options = {}, authenticated = true) {
	const response = await fetch(container.endpoint + route, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			...(authenticated
				? { Authorization: `Basic ${Buffer.from(`user:${password}`).toString('base64')}` }
				: {})
		},
		signal: AbortSignal.timeout(10_000)
	});
	return response;
}
const execBun = (id, source) =>
	docker(['exec', id, 'bun', '--no-env-file', '--config=/dev/null', '-e', source]);
async function stop(container) {
	await docker(['stop', '--time', '360', container.id], 380_000);
	const status = JSON.parse(await docker(['inspect', container.id, '--format', '{{json .State}}']));
	assert.equal(status.ExitCode, 0, 'graceful runtime exit');
}
async function released() {
	if (url !== 'file:///backup') return;
	const descriptor = JSON.parse(await readFile(join(backup, 'descriptor.json'), 'utf8'));
	const ownerGone = await readFile(join(backup, 'owner/nonce'))
		.then(() => false)
		.catch((error) => error.code === 'ENOENT');
	assert.equal(ownerGone, true, 'ownership lock released after final checkpoint');
	assert.match(descriptor.generation, /^[a-f0-9]{64}$/);
	assert.equal(descriptor.catalog, 2);
	const manifest = JSON.parse(
		await readFile(join(backup, 'manifests', descriptor.generation), 'utf8')
	);
	assert.equal(manifest.selectionHash, descriptor.selectionHash);
	assert.deepEqual(manifest.selection, {
		paths: [...customSelection.paths].sort(),
		sqlite: [...customSelection.sqlite].sort()
	});
	assert.equal(
		manifest.members.filter((member) => member.kind === 'sqlite' && member.id.startsWith('custom-'))
			.length,
		3
	);
	assert.equal(
		manifest.members.some((member) => /-wal$|-shm$|not-selected/.test(member.path)),
		false
	);
	report.checks.customSelectionRecordedAndSqliteSnapshotted = true;
	report.descriptor = {
		epoch: descriptor.epoch,
		generation: descriptor.generation,
		checkpointAt: descriptor.checkpointAt
	};
}

try {
	report.imageId = await docker(['image', 'inspect', image, '--format', '{{.Id}}']);
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
		image,
		'init',
		'--confirm-new-instance'
	]);
	report.checks.explicitInitialization = true;
	const first = await start('first');
	assert.equal((await api(first, '/global/health', {}, false)).status, 401);
	report.checks.authenticationRejectsAnonymous = true;
	const createdSession = await api(first, '/session', {
		method: 'POST',
		body: JSON.stringify({ title: 'synthetic recovery fixture' })
	});
	assert.equal(createdSession.ok, true, 'native session creation');
	const session = await createdSession.json();
	assert.equal(typeof session.id, 'string');
	report.sessionId = session.id;
	const toolsResponse = await api(first, '/experimental/tool/ids');
	assert.equal(toolsResponse.ok, true, 'native tool inventory');
	const toolIds = await toolsResponse.json();
	assert.ok(Array.isArray(toolIds) && toolIds.every((value) => typeof value === 'string'));
	assert.ok(toolIds.includes('bash'), 'native shell tool available');
	const apiMarker = `synthetic-native-api-${randomUUID()}`;
	const shellResponse = await api(first, `/session/${session.id}/shell`, {
		method: 'POST',
		body: JSON.stringify({
			agent: 'build',
			command: `mkdir -p /stash/knowledge; printf '%s' '${apiMarker}' > /work/recovery-api-fixture.txt; printf '%s' '${apiMarker}' > /stash/knowledge/recovery-api-fixture.txt`
		})
	});
	assert.equal(shellResponse.ok, true, 'native shell writes synthetic markers without a provider');
	async function verifyNativeFiles(container) {
		for (const directory of ['/work', '/stash/knowledge']) {
			const query = new URLSearchParams({ directory, path: 'recovery-api-fixture.txt' });
			const response = await api(container, `/file/content?${query}`);
			assert.equal(response.ok, true, `native file API for ${directory}`);
			assert.equal((await response.json()).content, apiMarker);
		}
	}
	await verifyNativeFiles(first);
	const codexInventory = JSON.parse(
		await execBun(
			first.id,
			`import{withCodexRecall,reviewRecall}from'/usr/local/bin/fhold-codex-recall.mjs';const review=await withCodexRecall(reviewRecall);console.log(JSON.stringify({status:review.status,managed:review.managed}));`
		)
	);
	assert.equal(codexInventory.status, 'ready', 'managed hooks are ready without user approval');
	assert.equal(codexInventory.managed, true);
	report.checks.nativeCodexInitializedWithoutAccountOrApproval = true;
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
			`import{readFile,readdir}from'node:fs/promises';const root='/opt/fhold/tools/node_modules/akm-cli/dist/core';const data={};for(const name of ['state-db.js','logs-db.js','paths.js']){const source=await readFile(root+'/'+name,'utf8');data[name]=source.split(String.fromCharCode(10)).filter(x=>/state[.]db|logs[.]db|index[.]db|function getStateDbPath|function getLogsDbPath/.test(x)).slice(0,12);}data.opencodeFiles=await readdir('/home/fhold/.local/share/opencode');data.akmFiles=await readdir('/opt/akm/data');data.versions=JSON.parse(await readFile('/opt/fhold/tools/package.json','utf8')).dependencies;console.log(JSON.stringify(data));`
		)
	);
	report.checks.realPinnedCatalogInspected = true;
	await stop(first);
	await released();
	report.checks.gracefulFinalCheckpointAndRelease = true;
	const second = await start('replacement');
	const sessionsResponse = await api(second, '/session');
	assert.equal(sessionsResponse.ok, true);
	const sessions = await sessionsResponse.json();
	assert.ok(
		sessions.some((value) => value.id === session.id),
		'native session recovered into empty writable layer'
	);
	await execBun(
		second.id,
		`import assert from'node:assert/strict';import{readFile,access}from'node:fs/promises';assert.equal(await readFile('/stash/knowledge/recovery-fixture.md','utf8'),'Synthetic durable knowledge marker.');assert.equal(await readFile('/work/recovery-fixture.txt','utf8'),'Synthetic workspace marker.');assert.equal(JSON.parse(await readFile('/home/fhold/.codex/auth.json','utf8')).fixtureOnly,'synthetic-account-marker');assert.equal(JSON.parse(await readFile('/home/fhold/.claude.json','utf8')).fixtureTrustMarker,'synthetic-trust-marker');for(const name of ['scheduler.pid','reconciliation.pid']){let found=false;try{await access('/tmp/fhold-runtime/'+name);found=true;}catch{}assert.equal(found,false);}console.log('synthetic state and scheduler-off assertions passed');`
	);
	report.checks.emptyLayerReplacement = true;
	await execBun(
		second.id,
		`
		import assert from'node:assert/strict';import{readFile,stat,access}from'node:fs/promises';import{Database}from'bun:sqlite';
		assert.equal(await readFile('/home/fhold/.custom-client/auth.json','utf8'),'synthetic-custom-client-account');
		assert.equal((await stat('/home/fhold/.custom-client/auth.json')).mode&0o777,0o600);
		assert.equal(await readFile('/tmp/fhold-extra state/nested/note','utf8'),'synthetic-extra-directory');
		assert.equal((await stat('/tmp/fhold-extra state/nested/note')).mode&0o777,0o700);
		assert.equal(await readFile('/tmp/fhold-settings.json','utf8'),'synthetic-individual-file');
		assert.equal(await access('/home/fhold/not-selected').then(()=>true).catch(()=>false),false);
		for(const[index,file]of ${JSON.stringify(customSelection.sqlite)}.entries()){
			const db=new Database(file,{readonly:true});assert.equal(Object.values(db.query('PRAGMA integrity_check').get())[0],'ok');
			assert.equal(db.query('SELECT value FROM marker').get().value,'synthetic-custom-sqlite-'+index);db.close();
		}
		console.log('custom paths and registered SQLite files restored into an empty container');
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
	report.checks.syntheticKnowledgeWorkspaceAccountTrustRestored = true;
	report.checks.schedulerDisabled = true;
	await stop(second);
	await released();
	const harnessPath = join(dirname(fileURLToPath(import.meta.url)), 'smoke-akm-harnesses.mjs');
	const harnessName = `fhold-recovery-smoke-${instance}-harnesses`;
	created.add(harnessName);
	report.harnessResult = await docker(
		[
			'run',
			'--rm',
			'--name',
			harnessName,
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

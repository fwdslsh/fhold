import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoveryConfig } from '../containers/assistant/fhold-recovery.mjs';
import { createRecoveryStore } from '../containers/assistant/recovery/storage.mjs';

const base = { FH_RECOVERY_URL: 'file:///tmp/synthetic-backup', FH_INSTANCE_ID: 'synthetic-owner' };
const wrapper = join(import.meta.dir, '../containers/assistant/fhold-recovery.mjs');

describe('recovery wrapper configuration and private status', () => {
	it('finishes an in-flight capture then checkpoints stopped writers before release on TERM', () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-wrapper-stop-capture-'));
		for (const finalFails of [false, true]) {
			const runtimeDir = join(root, finalFails ? 'failure' : 'success');
			const code = `
				import {runRecovery} from ${JSON.stringify(wrapper)};
				import {mkdir,writeFile} from 'node:fs/promises';
				const runtimeDir=${JSON.stringify(runtimeDir)};
				const events=[];let count=0;const publication={lastCheckpointAt:null,lastCheckpointTick:null};
				const engine={status(){return {failure:null,...publication};},
					async acquireRestore(){await mkdir(runtimeDir,{recursive:true});await writeFile(runtimeDir+'/recovery-writers-started','fixture');},
					async renew(){},
					async checkpoint(){const n=++count;events.push('start'+n);if(n===1){setTimeout(()=>process.kill(process.pid,'SIGTERM'),20);await new Promise(r=>setTimeout(r,100));}if(n===2&&${finalFails})throw Error('synthetic final failure');publication.lastCheckpointAt=Date.now();publication.lastCheckpointTick=performance.now();events.push('done'+n);},
					async release(){events.push('release');}};
				try{await runRecovery({runtimeDir,intervalSeconds:60,maxUnsavedSeconds:300,probePort:0},{env:{},engine});events.push('success');}catch{events.push('failure');}
				process.stdout.write(JSON.stringify(events));
			`;
			const result = spawnSync(process.execPath, ['--no-env-file', '--eval', code], {
				env: { PATH: process.env.PATH },
				encoding: 'utf8',
				timeout: 5_000
			});
			expect(result.status).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual(
				finalFails
					? ['start1', 'done1', 'start2', 'release', 'failure']
					: ['start1', 'done1', 'start2', 'done2', 'release', 'success']
			);
			expect(result.stderr).toBe(
				finalFails ? 'fhold recovery: checkpoint failed (recovery operation failed).\n' : ''
			);
		}
	});
	it('rejects secret-bearing URLs and invalid independent timing inputs', () => {
		for (const url of [
			'file:///tmp/backup?secret=fake-private-value',
			'file:///tmp/backup#token',
			'https://user:password@storage.example/private'
		]) {
			expect(() => recoveryConfig({ ...base, FH_RECOVERY_URL: url })).toThrow();
		}
		for (const interval of ['0', 'false', '-1', '1.5', '999999'])
			expect(() => recoveryConfig({ ...base, FH_RECOVERY_INTERVAL_SECONDS: interval })).toThrow();
		expect(() =>
			recoveryConfig({
				...base,
				FH_RECOVERY_INTERVAL_SECONDS: '60',
				FH_RECOVERY_MAX_UNSAVED_SECONDS: '5'
			})
		).toThrow();
	});

	it('keeps durability interval unchanged when user scheduling is disabled', () => {
		const on = recoveryConfig({ ...base, FH_SCHEDULER_ENABLED: '1' });
		const off = recoveryConfig({ ...base, FH_SCHEDULER_ENABLED: '0' });
		expect(off.intervalSeconds).toBe(on.intervalSeconds);
		expect(off.url).toBe(on.url);
	});

	it('rejects noncanonical aliases for private/runtime directories', () => {
		for (const name of ['FH_RUNTIME_DIR', 'FH_RECOVERY_STATE_DIR']) {
			for (const value of [
				'/tmp/fixture/../other',
				'/tmp//fixture',
				'/tmp/fixture/',
				'relative-fixture',
				'/'
			]) {
				expect(() => recoveryConfig({ ...base, [name]: value })).toThrow();
			}
			expect(recoveryConfig({ ...base, [name]: '/tmp/canonical-fixture' })).toBeDefined();
		}
	});

	it('accepts only a canonical absolute include-file location', () => {
		for (const value of [
			'',
			'relative.json',
			'/tmp//include.json',
			'/tmp/../include.json',
			'/',
			'/tmp/line\nbreak'
		])
			expect(() => recoveryConfig({ ...base, FH_RECOVERY_INCLUDE_FILE: value })).toThrow(
				'include file'
			);
		expect(
			recoveryConfig({ ...base, FH_RECOVERY_INCLUDE_FILE: '/run/fhold/include.json' }).includeFile
		).toBe('/run/fhold/include.json');
	});

	it('loads the selection during namespace init and reports malformed files without revealing content', () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-wrapper-includes-'));
		const includeFile = join(root, 'include.json');
		const env = {
			PATH: process.env.PATH,
			...base,
			FH_RECOVERY_URL: `file://${root}/backup`,
			FH_RECOVERY_INCLUDE_FILE: includeFile
		};
		writeFileSync(
			includeFile,
			JSON.stringify({ paths: [join(root, 'custom')], sqlite: [join(root, 'custom.db')] })
		);
		const initialized = spawnSync(
			process.execPath,
			['--no-env-file', wrapper, 'init', '--confirm-new-instance'],
			{ env, encoding: 'utf8' }
		);
		expect(initialized.status).toBe(0);
		expect(initialized.stderr).toBe('');
		writeFileSync(includeFile, '{synthetic-private-marker');
		const invalid = spawnSync(process.execPath, ['--no-env-file', wrapper, 'run'], {
			env,
			encoding: 'utf8'
		});
		expect(invalid.status).toBe(1);
		expect(invalid.stderr).toContain('valid JSON');
		expect(invalid.stderr).not.toContain('synthetic-private-marker');
		expect(invalid.stderr).not.toContain(includeFile);
	});

	it('coverage inspection is read-only; offline restore requires confirmation and an initialized namespace', () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-wrapper-inspect-'));
		const includeFile = join(root, 'include.json');
		writeFileSync(
			includeFile,
			JSON.stringify({ version: 1, excludePaths: [join(root, 'excluded')] })
		);
		const env = {
			PATH: process.env.PATH,
			...base,
			FH_RECOVERY_URL: `file://${root}/backup`,
			FH_RECOVERY_INCLUDE_FILE: includeFile,
			FH_RECOVERY_STATE_DIR: join(root, 'private')
		};
		const inspected = spawnSync(process.execPath, ['--no-env-file', wrapper, 'inspect'], {
			env,
			encoding: 'utf8'
		});
		expect(inspected.status).toBe(0);
		expect(JSON.parse(inspected.stdout).catalog).toBe(3);
		expect(JSON.parse(inspected.stdout).exclusions).toEqual([
			{ path: join(root, 'excluded'), reason: 'excluded-path' }
		]);
		for (const args of [['restore'], ['restore', '--confirm-stopped']]) {
			const result = spawnSync(process.execPath, ['--no-env-file', wrapper, ...args], {
				env,
				encoding: 'utf8'
			});
			expect(result.status).toBe(1);
			if (args.length === 2) expect(result.stderr).toContain('requires explicit initialization');
		}
		expect(existsSync(join(root, 'private'))).toBe(false);
		expect(existsSync(join(root, 'backup'))).toBe(false);
	});

	it('keeps raw Blob namespace text for the actual transport to reject (no network)', async () => {
		for (const url of [
			'azblob://account123/private-backups/../other',
			'azblob://account123/private-backups/%2e%2e/other',
			'azblob://Account123/private-backups'
		]) {
			const config = recoveryConfig({ ...base, FH_RECOVERY_URL: url });
			expect(config.url).toBe(url);
			await expect(createRecoveryStore(config.url, { env: {} })).rejects.toThrow();
		}
	});

	it('fails stale private status without reading stack environment', () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-wrapper-status-'));
		writeFileSync(
			join(root, 'recovery-status.json'),
			JSON.stringify({
				healthy: true,
				updatedAt: Date.now() - 10_000,
				lastPublishedAt: Date.now(),
				maxUnsavedSeconds: 300
			}),
			{ mode: 0o600 }
		);
		const result = spawnSync(process.execPath, ['--no-env-file', wrapper, 'status'], {
			env: { PATH: process.env.PATH, FH_RUNTIME_DIR: root },
			encoding: 'utf8'
		});
		expect(result.status).toBe(1);
		expect(JSON.parse(result.stdout).healthy).toBe(false);
		expect(result.stderr).toBe('');
	});

	it('redacts failed configuration rather than emitting secrets or a stack', () => {
		const result = spawnSync(process.execPath, ['--no-env-file', wrapper, 'run'], {
			env: {
				PATH: process.env.PATH,
				...base,
				FH_RECOVERY_URL: 'file:///tmp/backup?secret=synthetic-sensitive-marker'
			},
			encoding: 'utf8'
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('fhold recovery:');
		expect(result.stderr).not.toContain('synthetic-sensitive-marker');
		expect(result.stderr).not.toContain(' at ');
		expect(result.stdout).toBe('');
	});

	it('refuses future or nonfinite wall-clock status and publication timestamps', () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-wrapper-future-'));
		for (const timestamps of [
			{ updatedAt: Date.now() + 30_000, lastPublishedAt: Date.now() },
			{ updatedAt: Date.now(), lastPublishedAt: Date.now() + 30_000 },
			{ updatedAt: null, lastPublishedAt: Date.now() },
			{ updatedAt: Date.now(), lastPublishedAt: 'not-a-number' }
		]) {
			writeFileSync(
				join(root, 'recovery-status.json'),
				JSON.stringify({ healthy: true, ...timestamps, maxUnsavedSeconds: 300 }),
				{ mode: 0o600 }
			);
			const result = spawnSync(process.execPath, ['--no-env-file', wrapper, 'status'], {
				env: { PATH: process.env.PATH, FH_RUNTIME_DIR: root },
				encoding: 'utf8'
			});
			expect(result.status).toBe(1);
			expect(JSON.parse(result.stdout).healthy).toBe(false);
			expect(result.stderr).toBe('');
		}
	});

	it('reports a safe missing-namespace failure without dumping environment', () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-wrapper-missing-'));
		const result = spawnSync(process.execPath, ['--no-env-file', wrapper, 'run'], {
			env: {
				PATH: process.env.PATH,
				...base,
				FH_RECOVERY_URL: `file://${root}/unused-backup`,
				FH_RUNTIME_DIR: join(root, 'runtime'),
				FH_RECOVERY_STATE_DIR: join(root, 'private'),
				SYNTHETIC_SECRET: 'fixture-sensitive-value'
			},
			encoding: 'utf8'
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('recovery namespace requires explicit initialization');
		expect(result.stderr).not.toContain('fixture-sensitive-value');
		expect(result.stderr).not.toContain(' at ');
		expect(result.stdout).toBe('');
	});

	it('preserves safe restore, renewal and release failures in status without logging raw errors', () => {
		for (const [phase, message, expected] of [
			[
				'restore',
				'recovery owner exists; no automatic takeover',
				'recovery owner exists; no automatic takeover'
			],
			['renew', 'recovery Blob deadline exceeded', 'recovery Blob deadline exceeded'],
			['release', 'recovery ownership lost', 'recovery ownership lost'],
			['restore', 'synthetic-private-token-and-path', 'recovery operation failed']
		]) {
			const runtimeDir = mkdtempSync(join(tmpdir(), 'fhold-wrapper-error-'));
			const code = `
				import {runRecovery} from ${JSON.stringify(wrapper)};
				import {sanitizeRecoveryError} from ${JSON.stringify(join(import.meta.dir, '../containers/assistant/recovery/engine.mjs'))};
				import {mkdir,writeFile,readFile} from 'node:fs/promises';
				const runtimeDir=${JSON.stringify(runtimeDir)};const phase=${JSON.stringify(phase)};
				const error=()=>{throw Error(${JSON.stringify(message)});};
				const publication={lastCheckpointAt:null,lastCheckpointTick:null};
				const engine={status(){return {failure:null,...publication};},
					async acquireRestore(){if(phase==='restore')error();await mkdir(runtimeDir,{recursive:true});await writeFile(runtimeDir+'/recovery-writers-started','fixture');},
					async renew(){if(phase==='renew')error();},async checkpoint(){publication.lastCheckpointAt=Date.now();publication.lastCheckpointTick=performance.now();},
					async release(){if(phase==='release')error();}};
				const timer=phase==='release'?setTimeout(()=>process.kill(process.pid,'SIGTERM'),50):null;
				try{await runRecovery({runtimeDir,intervalSeconds:60,maxUnsavedSeconds:20,probePort:0},{env:{},engine});throw Error('unexpected success');}
				catch(error){const status=JSON.parse(await readFile(runtimeDir+'/recovery-status.json','utf8'));process.stdout.write(JSON.stringify({reason:sanitizeRecoveryError(error),status:status.failure,state:status.state}));}
				finally{clearTimeout(timer);}
			`;
			const result = spawnSync(process.execPath, ['--no-env-file', '--eval', code], {
				env: { PATH: process.env.PATH },
				encoding: 'utf8',
				timeout: 5_000
			});
			expect(result.status).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({
				reason: expected,
				status: expected,
				state: 'failed'
			});
			expect(result.stderr).toBe('');
			expect(result.stdout).not.toContain('synthetic-private-token-and-path');
		}
	});

	it('logs a deduplicated sanitized checkpoint failure and clears it after successful capture', () => {
		const runtimeDir = mkdtempSync(join(tmpdir(), 'fhold-wrapper-capture-error-'));
		const code = `
			import {runRecovery} from ${JSON.stringify(wrapper)};
			import {mkdir,writeFile,readFile} from 'node:fs/promises';
			const runtimeDir=${JSON.stringify(runtimeDir)};let captures=0;const publication={lastCheckpointAt:null,lastCheckpointTick:null};
			const engine={status(){return {failure:null,...publication};},
				async acquireRestore(){await mkdir(runtimeDir,{recursive:true});await writeFile(runtimeDir+'/recovery-writers-started','fixture');},
				async renew(){},async checkpoint(){if(++captures<=2)throw Error('synthetic-private-checkpoint-secret');publication.lastCheckpointAt=Date.now();publication.lastCheckpointTick=performance.now();process.kill(process.pid,'SIGTERM');},async release(){}};
			await runRecovery({runtimeDir,intervalSeconds:0,maxUnsavedSeconds:20,probePort:0},{env:{},engine});
			const status=JSON.parse(await readFile(runtimeDir+'/recovery-status.json','utf8'));
			process.stdout.write(JSON.stringify({captures,state:status.state,failure:status.failure,lastAttemptFailed:status.lastAttemptFailed}));
		`;
		const result = spawnSync(process.execPath, ['--no-env-file', '--eval', code], {
			env: { PATH: process.env.PATH },
			encoding: 'utf8',
			timeout: 5_000
		});
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			captures: 4,
			state: 'stopped',
			failure: null,
			lastAttemptFailed: false
		});
		expect(result.stderr).toBe('fhold recovery: checkpoint failed (recovery operation failed).\n');
		expect(result.stdout + result.stderr).not.toContain('synthetic-private-checkpoint-secret');
	});

	it('runs the scheduler-off timer across a backward wall-clock jump, final checkpoint before release (injected engine)', () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-wrapper-timer-'));
		const code = `
			import {runRecovery} from ${JSON.stringify(wrapper)};
			import {mkdir,writeFile} from 'node:fs/promises';
			const runtimeDir=${JSON.stringify(root)};
			const events=[];const publication={lastCheckpointAt:null,lastCheckpointTick:null};
			const wallNow=Date.now;
			setTimeout(()=>{Date.now=()=>wallNow()-60000;},100);
			const engine={
				status(){return {failure:null,...publication};},
				async acquireRestore(){events.push('restore'); await mkdir(runtimeDir,{recursive:true}); await writeFile(runtimeDir+'/recovery-writers-started','fixture');},
				async renew(){events.push('renew');},
				async checkpoint(){publication.lastCheckpointAt=Date.now();publication.lastCheckpointTick=performance.now();events.push('checkpoint');},
				async release(){events.push('release');}
			};
			setTimeout(()=>process.kill(process.pid,'SIGTERM'),1300);
			await runRecovery({runtimeDir,intervalSeconds:1,maxUnsavedSeconds:10,probePort:0},{env:{FH_SCHEDULER_ENABLED:'0'},engine});
			process.stdout.write(JSON.stringify(events));
		`;
		const result = spawnSync(process.execPath, ['--no-env-file', '--eval', code], {
			env: { PATH: process.env.PATH },
			encoding: 'utf8',
			timeout: 5_000
		});
		expect(result.status).toBe(0);
		const events = JSON.parse(result.stdout) as string[];
		expect(events[0]).toBe('restore');
		expect(events.filter((event) => event === 'checkpoint').length).toBeGreaterThanOrEqual(3);
		expect(events.at(-2)).toBe('checkpoint');
		expect(events.at(-1)).toBe('release');
		expect(result.stderr).toBe('');
	});

	it('uses accepted engine publication even when later local cleanup fails', () => {
		const runtimeDir = mkdtempSync(join(tmpdir(), 'fhold-wrapper-accepted-clock-'));
		const code = `
			import {runRecovery} from ${JSON.stringify(wrapper)};
			import {mkdir,writeFile,readFile} from 'node:fs/promises';
			const runtimeDir=${JSON.stringify(runtimeDir)},publication={lastCheckpointAt:null,lastCheckpointTick:null};
			let observed;
			const engine={status(){return {failure:null,...publication};},
				async acquireRestore(){await mkdir(runtimeDir,{recursive:true});await writeFile(runtimeDir+'/recovery-writers-started','fixture');},
				async renew(){},async checkpoint(){publication.lastCheckpointAt=Date.now();publication.lastCheckpointTick=performance.now();throw Object.assign(Error('synthetic private cleanup path'),{code:'ENOENT'});},async release(){}};
			const timer=setTimeout(async()=>{const s=JSON.parse(await readFile(runtimeDir+'/recovery-status.json','utf8'));observed={healthy:s.healthy,lastAttemptFailed:s.lastAttemptFailed,accepted:s.lastPublishedAt===publication.lastCheckpointAt};process.kill(process.pid,'SIGTERM');},600);
			try{await runRecovery({runtimeDir,intervalSeconds:1,maxUnsavedSeconds:5,probePort:0},{env:{},engine});}catch{}
			finally{clearTimeout(timer);}
			process.stdout.write(JSON.stringify(observed));
		`;
		const result = spawnSync(
			process.execPath,
			['--no-env-file', '--config=/dev/null', '--eval', code],
			{
				env: { PATH: process.env.PATH },
				encoding: 'utf8',
				timeout: 5000
			}
		);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			healthy: true,
			lastAttemptFailed: true,
			accepted: true
		});
		expect(result.stderr).toBe(
			'fhold recovery: checkpoint failed (recovery filesystem failure (ENOENT)).\n'
		);
		expect(result.stdout + result.stderr).not.toContain('synthetic private cleanup path');
	});

	it('advances durable health after every real periodic checkpoint, not just the first', () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-wrapper-live-clock-'));
		const enginePath = join(import.meta.dir, '../containers/assistant/recovery/engine.mjs');
		const code = `
			import {runRecovery} from ${JSON.stringify(wrapper)};
			import {createEngine} from ${JSON.stringify(enginePath)};
			import {mkdir,writeFile,readFile} from 'node:fs/promises';
			import {join} from 'node:path';import {pathToFileURL} from 'node:url';
			const root=${JSON.stringify(root)},runtimeDir=join(root,'runtime');
			const roots=Object.fromEntries(['home','stash','work','akmData','akmConfig'].map(k=>[k,join(root,k)]));
			for(const dir of Object.values(roots))await mkdir(dir,{recursive:true});
			for(let i=0;i<150;i++)await writeFile(join(roots.work,'file-'+i),'synthetic durable file '+i);
			const engine=createEngine({url:pathToFileURL(join(root,'backup')).href,instanceId:'health-clock',versions:{test:'1'},privateDir:join(roots.home,'.fhold-recovery')},{roots});
			await engine.initialize();await mkdir(runtimeDir);await writeFile(join(runtimeDir,'recovery-writers-started'),'fixture');
			const reservation=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){return new Response('fixture');}});const probePort=reservation.port;reservation.stop(true);
			const values=[];let finished=false;
			const observer=setInterval(async()=>{try{await fetch('http://127.0.0.1:'+probePort+'/live');const s=JSON.parse(await readFile(join(runtimeDir,'recovery-status.json'),'utf8'));if(s.lastPublishedAt!==null)values.push(s.lastPublishedAt);}catch{}},50);
			const stop=setTimeout(()=>process.kill(process.pid,'SIGTERM'),6500);
			try{await runRecovery({runtimeDir,intervalSeconds:1,maxUnsavedSeconds:5,probePort},{env:{},engine});finished=true;}
			finally{clearInterval(observer);clearTimeout(stop);}
			process.stdout.write(JSON.stringify({finished,publications:new Set(values).size}));
		`;
		const result = spawnSync(
			process.execPath,
			['--no-env-file', '--config=/dev/null', '--eval', code],
			{
				env: { PATH: process.env.PATH },
				encoding: 'utf8',
				timeout: 12_000
			}
		);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe('');
		const measured = JSON.parse(result.stdout);
		expect(measured.finished).toBe(true);
		expect(measured.publications).toBeGreaterThanOrEqual(3);
	}, 15_000);
});

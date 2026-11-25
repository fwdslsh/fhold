import { buildComposeCliArgs, buildComposeOptions } from './compose.js';
import { assertProjectOwnership, composeProcessEnvironment, runDocker } from './docker.js';
import type { FholdState } from './foundation.js';
import { acquireStackLock, releaseStackLock } from './lock.js';
import { requireInstall } from './state.js';
import { readStackConfig } from './stack-config.js';

export type CustodyRequest =
	| { action: 'inspect' }
	| { action: 'set-secret'; name: string; value: string }
	| { action: 'save-task'; name: string; credential: string; script: string }
	| { action: 'review' | 'revoke'; name: string }
	| { action: 'approve'; name: string; digest: string };
export type CustodyReview = {
	name: string;
	task: string;
	script: string;
	digest: string;
	command: string;
	approved: boolean;
};
export type CustodyResult = {
	enabled: boolean;
	reason?: string;
	tasks?: string[];
	grants?: string[];
	review?: CustodyReview;
	saved?: boolean;
};

const privateHome = '/var/lib/fhold-credentials';
const privateBundle = `${privateHome}/akm`;
const assertPrivateWriteTarget = `
const fs = require('node:fs');
const cp = require('node:child_process');
const home = '/var/lib/fhold-credentials';
const bundle = home + '/akm';
const name = process.argv[1];
const configPath = home + '/.config/akm/config.json';
function safe(path, directory) {
 const stat = fs.lstatSync(path, { throwIfNoEntry: false });
 if (!stat) return false;
 if (!(directory ? stat.isDirectory() : stat.isFile()) || stat.uid !== 1101 ||
     (stat.mode & 0o022) || fs.realpathSync(path) !== path) process.exit(1);
 return true;
}
function verifySetupTree(path) {
 if (!safe(path, true)) return;
 for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
  const child = path + '/' + entry.name;
  if (entry.isDirectory()) verifySetupTree(child);
  else safe(child, false);
 }
}
const configured = safe(configPath, false);
safe(bundle, true);
safe(bundle + '/secrets', true);
if (fs.lstatSync(home + '/.git', { throwIfNoEntry: false })) process.exit(1);
if (safe(bundle + '/.git', true)) {
 const remotes = cp.execFileSync('/usr/bin/git', ['-C', bundle, 'remote'], { encoding: 'utf8', timeout: 5000 });
 if (remotes.trim()) process.exit(1);
}
if (!configured) {
 if (name) process.exit(1);
 for (const root of [bundle, home + '/.config', home + '/.cache', home + '/.local']) verifySetupTree(root);
}
if (name) {
 const entry = JSON.parse(fs.readFileSync(configPath, 'utf8')).bundles?.[name];
 if (entry?.path !== bundle || (entry.root !== undefined && entry.root !== '.')) process.exit(1);
}
process.stdout.write(String(configured));
`;
const namePattern = /^[a-z][a-z0-9-]{0,47}$/;
export function parseCustodyRequest(value: unknown): CustodyRequest {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw Error('Invalid credential custody request.');
	const r = value as Record<string, unknown>;
	if (r.action === 'inspect') return { action: 'inspect' };
	if (typeof r.name !== 'string' || !namePattern.test(r.name))
		throw Error(
			'Use a name starting with a lowercase letter, followed by lowercase letters, numbers or hyphens (48 characters maximum).'
		);
	if (r.action === 'review' || r.action === 'revoke') return { action: r.action, name: r.name };
	if (r.action === 'approve' && typeof r.digest === 'string' && /^[a-f0-9]{64}$/.test(r.digest))
		return { action: r.action, name: r.name, digest: r.digest };
	if (
		r.action === 'set-secret' &&
		typeof r.value === 'string' &&
		r.value.length > 0 &&
		r.value.length <= 16_384 &&
		!r.value.includes('\0')
	)
		return { action: r.action, name: r.name, value: r.value };
	if (
		r.action === 'save-task' &&
		typeof r.credential === 'string' &&
		namePattern.test(r.credential) &&
		typeof r.script === 'string' &&
		r.script.startsWith('#!/bin/sh\n') &&
		r.script.length <= 32_768 &&
		!r.script.includes('\0')
	)
		return { action: r.action, name: r.name, credential: r.credential, script: r.script };
	throw Error('Invalid credential custody input. Review the fields and try again.');
}

// Operator-side filesystem integration, sent to the image's ordinary Node over
// Docker exec. No daemon, agent tool, credential resolver or runtime wrapper.
// Runs as UID1101; root is used separately only for native sudoers files.
export const custodyFiles = String.raw`
const fs=require('node:fs'), crypto=require('node:crypto');
const r=JSON.parse(fs.readFileSync(0,'utf8')), home='/var/lib/fhold-credentials', bundle=home+'/akm';
function directory(p){const s=fs.lstatSync(p); if(!s.isDirectory()||s.uid!==1101||(s.mode&0o022))throw Error('private-directory');}
function read(p){const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==1101||(s.mode&0o022)||s.size>65536)throw Error('private-file');return fs.readFileSync(fd,'utf8');}finally{fs.closeSync(fd);}}
directory(home);
if(r.action==='inspect'&&!fs.existsSync(bundle+'/tasks')){console.log(JSON.stringify({tasks:[]}));process.exit(0);}
directory(bundle);
if(r.action==='inspect'){directory(bundle+'/tasks');console.log(JSON.stringify({tasks:fs.readdirSync(bundle+'/tasks').filter(n=>/^admin-[a-z][a-z0-9-]{0,47}\.yml$/.test(n)).map(n=>n.slice(6,-4))}));process.exit(0);}
for(const d of ['scripts','tasks']){if(!fs.existsSync(bundle+'/'+d)&&r.action==='save-task')fs.mkdirSync(bundle+'/'+d,{mode:0o700});directory(bundle+'/'+d);}
if(!/^[a-z][a-z0-9-]{0,47}$/.test(r.name))throw Error('name');
const id='admin-'+r.name, task=bundle+'/tasks/'+id+'.yml', script=bundle+'/scripts/'+id+'.sh';
if(r.action==='save-task'){
 const definition=JSON.stringify({version:'5-beta.1',steps:[{name:'operation',run:'scripts/'+id+'.sh',secret:['secrets/'+r.credential+':CREDENTIAL']}]},null,2)+'\n';
 // New immutable names only: never replace code beneath an existing grant.
 const fd=fs.openSync(script,'wx',0o700);try{fs.writeFileSync(fd,r.script);}finally{fs.closeSync(fd);}
 try{fs.writeFileSync(task,definition,{flag:'wx',mode:0o600});}catch(e){fs.unlinkSync(script);throw e;}
}
const t=read(task), code=read(script);
const parsed=JSON.parse(t), credential=parsed.steps?.[0]?.secret?.[0];
if(typeof credential!=='string'||!/^secrets\/[a-z][a-z0-9-]{0,47}:CREDENTIAL$/.test(credential)||JSON.stringify(parsed)!==JSON.stringify({version:'5-beta.1',steps:[{name:'operation',run:'scripts/'+id+'.sh',secret:[credential]}]}))throw Error('unsupported-task-definition');
console.log(JSON.stringify({name:r.name,task:t,script:code,digest:crypto.createHash('sha256').update(JSON.stringify([t,code])).digest('hex'),command:'sudo -n -H -u fhold-credentials /usr/local/bin/akm run tasks/'+id}));
`;

const custodyPolicy = String.raw`
const fs=require('node:fs'), cp=require('node:child_process'), crypto=require('node:crypto');
const r=JSON.parse(fs.readFileSync(0,'utf8')), dir='/etc/sudoers.d';
const s=fs.lstatSync(dir);if(!s.isDirectory()||s.uid!==0||(s.mode&0o022))throw Error('policy-directory');
if(r.action==='inspect'){console.log(JSON.stringify({grants:fs.readdirSync(dir).filter(n=>/^fhold-custody-admin-[a-z][a-z0-9-]{0,47}$/.test(n)).map(n=>n.slice('fhold-custody-admin-'.length))}));process.exit(0);}
if(!/^[a-z][a-z0-9-]{0,47}$/.test(r.name))throw Error('name');
const file=dir+'/fhold-custody-admin-'+r.name;
const rule='Defaults:fhold env_reset\nfhold ALL=(fhold-credentials) CWD=/var/lib/fhold-credentials NOPASSWD: NOSETENV: /usr/local/bin/akm run tasks/admin-'+r.name+'\n';
function exists(){try{const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const st=fs.fstatSync(fd);if(!st.isFile()||st.uid!==0||(st.mode&0o022)||st.size>8192)throw Error('policy-file');return fs.readFileSync(fd,'utf8');}finally{fs.closeSync(fd);}}catch(e){if(e.code==='ENOENT')return null;throw e;}}
const old=exists(); if(old!==null&&old!==rule)throw Error('operator-policy-changed');
if(r.action==='revoke'){if(old!==null)fs.unlinkSync(file);}
if(r.action==='approve'){
 const tmp=dir+'/.fhold-custody-'+crypto.randomUUID();
 try{fs.writeFileSync(tmp,rule,{flag:'wx',mode:0o440});if(cp.spawnSync('/usr/sbin/visudo',['-cf',tmp],{stdio:'ignore'}).status!==0)throw Error('invalid-policy');fs.renameSync(tmp,file);}finally{try{fs.unlinkSync(tmp);}catch{}}
}
console.log(JSON.stringify({approved:r.action==='revoke'?false:r.action==='approve'||old===rule}));
`;

/** Native Docker/SSH management only. Secrets never enter snapshots or argv. */
export async function manageCustody(
	state: FholdState,
	value: CustodyRequest,
	confirmed = false
): Promise<CustodyResult> {
	const input = parseCustodyRequest(value);
	if (!['inspect', 'review'].includes(input.action) && !confirmed)
		throw Error('Confirm the credential custody change first.');
	requireInstall(state.homeDir);
	const config = readStackConfig(state.homeDir);
	if (!config.ok) throw Error('Cannot read instance configuration.');
	const lock = acquireStackLock(state.dataDir);
	if (!lock) throw Error('Another instance operation is running.');
	try {
		await assertProjectOwnership(config.config.deployment.projectName, state.stackDir);
		const selected = await runDocker(
			['compose', ...buildComposeCliArgs(state), 'ps', '-q', 'assistant'],
			{ env: composeProcessEnvironment(buildComposeOptions(state).envFiles) }
		);
		const id = selected.stdout.trim();
		if (!selected.ok || !/^[a-f0-9]{12,64}$/.test(id))
			throw Error('Start Assistant before managing private credentials.');
		const inspected = await runDocker(['inspect', id]);
		if (!inspected.ok) throw Error('Cannot inspect Assistant.');
		const c = JSON.parse(inspected.stdout)[0];
		const capabilities = (c.HostConfig.CapAdd ?? []).map((name: string) =>
			name.replace(/^CAP_/, '')
		);
		const enabled =
			c.Config.User === '1000:1000' &&
			c.HostConfig.SecurityOpt?.includes('no-new-privileges:false') &&
			['SETUID', 'SETGID'].every((x) => capabilities.includes(x)) &&
			[privateHome, '/etc/sudoers.d'].every((p) =>
				c.Mounts.some(
					(m: { Destination: string; Type: string }) => m.Destination === p && m.Type === 'volume'
				)
			);
		if (!enabled) {
			if (input.action === 'inspect')
				return {
					enabled: false,
					reason:
						'Enable the experimental credential custody Docker overlay with the supported UID1000/1101 identities first.'
				};
			throw Error('Credential custody is not enabled for this Assistant.');
		}
		async function exec(uid: string, args: string[], stdin: string) {
			const result = await runDocker(
				[
					'exec',
					'-i',
					'--user',
					uid,
					'--workdir',
					uid === '0' ? '/' : privateHome,
					id,
					'/usr/bin/env',
					'-i',
					`HOME=${privateHome}`,
					'PATH=/usr/local/bin:/usr/sbin:/usr/bin:/bin',
					...args
				],
				{ input: stdin, timeoutMs: 30_000, maxOutputBytes: 262_144 }
			);
			// Never reflect native stdout/stderr/errors: credentials can appear there.
			if (!result.ok)
				throw Error(
					'Credential custody operation failed. Check private home ownership, native AKM setup, unique task names and sudo policy. No command output was returned.'
				);
			return result.stdout;
		}
		async function assertPrivateHome() {
			await exec(
				'1101:1101',
				[
					'/usr/local/bin/node',
					'-e',
					"const s=require('node:fs').lstatSync('/var/lib/fhold-credentials');if(!s.isDirectory()||s.uid!==1101||(s.mode&0o077))process.exit(1)"
				],
				''
			);
		}
		if (input.action === 'set-secret') {
			await assertPrivateHome();
			const configured = await exec(
				'1101:1101',
				[
					'/usr/local/bin/node',
					'-e',
					assertPrivateWriteTarget
				],
				''
			);
			if (configured === 'false')
				await exec(
					'1101:1101',
					[
						'/usr/local/bin/akm',
						'setup',
						'--yes',
						'--no-probe',
						'--embedding',
						'off',
						'--dir',
						privateBundle
					],
					''
				);
			// Native secret writes otherwise follow defaultWriteTarget, which can
			// point to a shared directory or a remote store.
			let bundleName: string;
			try {
				const inventory = JSON.parse(
					await exec(
						'1101:1101',
						['/usr/local/bin/akm', 'bundle', 'list', '--format', 'json', '--quiet'],
						''
					)
				);
				const bundle = inventory.sources?.find(
					(source: { kind?: string; path?: string; writable?: boolean }) =>
						source.kind === 'filesystem' &&
						source.path === privateBundle &&
						source.writable === true
				);
				if (
					inventory.ok !== true ||
					inventory.shape !== 'list' ||
					inventory.schemaVersion !== 1 ||
					typeof bundle?.name !== 'string' ||
					!bundle.name
				)
					throw Error('Private AKM bundle is unavailable');
				bundleName = bundle.name;
				await exec(
					'1101:1101',
					['/usr/local/bin/node', '-e', assertPrivateWriteTarget, '--', bundleName],
					''
				);
			} catch {
				throw Error(
					'Credential custody operation failed. The private AKM bundle must be writable and located in the private credential home.'
				);
			}
			await exec(
				'1101:1101',
				['/usr/local/bin/akm', 'secret', 'set', `secrets/${input.name}`, '--bundle', bundleName],
				input.value
			);
			return { enabled: true, saved: true };
		}
		if (input.action === 'revoke') {
			await exec('0', ['/usr/local/bin/node', '-e', custodyPolicy], JSON.stringify(input));
			return { enabled: true, saved: true };
		}
		if (input.action === 'inspect') {
			const { grants } = JSON.parse(
				await exec('0', ['/usr/local/bin/node', '-e', custodyPolicy], JSON.stringify(input))
			) as { grants: string[] };
			let tasks: string[] = [];
			let reason: string | undefined;
			try {
				await assertPrivateHome();
				tasks = JSON.parse(
					await exec(
						'1101:1101',
						['/usr/local/bin/node', '-e', custodyFiles],
						JSON.stringify(input)
					)
				).tasks;
			} catch {
				reason = 'Task files could not be inspected. Existing Admin grants can still be revoked.';
			}
			return {
				enabled: true,
				tasks: [...new Set([...tasks, ...grants])].sort(),
				grants,
				...(reason ? { reason } : {})
			};
		}
		await assertPrivateHome();
		const output = JSON.parse(
			await exec('1101:1101', ['/usr/local/bin/node', '-e', custodyFiles], JSON.stringify(input))
		);
		if (input.action === 'approve' && output.digest !== input.digest)
			throw Error('Task changed since review. Review its current definition before approving.');
		if (input.action === 'approve') {
			// AKM owns task/source/reference validation. Inspect as the private
			// identity without executing the task or exposing its diagnostic
			// output. Keep fhold's ownership and review checks. Native CLI usage
			// bookkeeping follows the private account's settings.
			try {
				const validation = JSON.parse(
					await exec(
						'1101:1101',
						[
							'/usr/bin/timeout',
							'--kill-after=2s',
							'10s',
							'/usr/local/bin/akm',
							'doctor',
							'explain',
							`tasks/admin-${input.name}`,
							'--format',
							'json',
							'--quiet'
						],
						''
					)
				);
				if (
					validation?.ok !== true ||
					validation.shape !== 'task-explain' ||
					validation.schemaVersion !== 1 ||
					validation.sourcePath !== `${privateBundle}/tasks/admin-${input.name}.yml`
				)
					throw Error('Unsupported native validation response');
			} catch {
				throw Error(
					'Native AKM task validation failed or timed out. No approval was written. Check the task and referenced assets in the private AKM home, then review and approve again.'
				);
			}
		}
		const policy = JSON.parse(
			await exec(
				'0',
				['/usr/local/bin/node', '-e', custodyPolicy],
				JSON.stringify({
					action: input.action === 'approve' ? 'approve' : 'review',
					name: input.name
				})
			)
		);
		return { enabled: true, review: { ...output, approved: policy.approved } };
	} finally {
		releaseStackLock(lock);
	}
}

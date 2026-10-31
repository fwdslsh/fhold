import type { NativeAgentAccess, NativeAgentService } from './native-agent.js';
import { startNativePty, type NativePtyOptions, type NativePtySession } from './native-pty.js';
import { editNativePreferenceJsonc, parseNativePreferenceDocument } from './provider-files.js';
import { DISCOVER_MODELS, type NativeProviderSettingsPort } from './provider-settings.js';

const LINE_INPUT = `import { createInterface } from 'node:readline';
const lines=createInterface({input:process.stdin});
const input=await new Promise(resolve=>lines.once('line',resolve));
lines.close();process.stdin.pause();
`;
const PREFERENCE_FAILURES = [
	'Linked native preferences are not editable.',
	'Native preferences file is not a bounded regular file.',
	'The selected preference document is outside the native user configuration directory.',
	'Native preferences changed. Refresh before saving.',
	'Native preference access failed. Check native user-directory permissions and available storage. No rollback was attempted.'
];

// Native HTTP fs.write uses writeWithDirs without an atomic replacement or
// condition. This ordinary editor save runs in the native agent's namespace.
// The hash guard rejects observed concurrent changes; no native CAS exists to
// exclude a different editor racing the final check/rename. Never roll back.
export const NATIVE_PREFERENCE_COMMAND =
	LINE_INPUT +
	`
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const request=JSON.parse(input), root=path.join(process.env.HOME||'/home/fhold','.config/opencode');
const hash=text=>createHash('sha256').update(text).digest('hex');
function safe(file){let p='/';for(const part of file.split('/').filter(Boolean)){p=path.join(p,part);const stat=fs.lstatSync(p,{throwIfNoEntry:false});if(stat?.isSymbolicLink())throw Error('Linked native preferences are not editable.');}}
function read(file){safe(file);let fd;try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>1048576)throw Error('Native preferences file is not a bounded regular file.');return {text:fs.readFileSync(fd,'utf8'),mode:stat.mode&0o777};}catch(error){if(error.code==='ENOENT')return {text:'{}\\n',mode:0o600};throw error;}finally{if(fd!==undefined)fs.closeSync(fd);}}
try {
 let file=request.policy?'/etc/opencode/opencode.json':process.env.OPENCODE_CONFIG;
 if(!file)file=path.join(root,['opencode.jsonc','opencode.json','config.json'].find(name=>fs.existsSync(path.join(root,name)))||'opencode.json');
 if(!path.isAbsolute(file)||(!request.policy&&path.dirname(file)!==root))throw Error('The selected preference document is outside the native user configuration directory.');
 const current=read(file);
 if(request.write){
  if(request.policy||typeof request.text!=='string'||Buffer.byteLength(request.text)>1048576||request.path!==file||request.digest!==hash(current.text))throw Error('Native preferences changed. Refresh before saving.');
  safe(path.dirname(file));fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temp=path.join(path.dirname(file),'.fhold-preference-'+randomUUID());let fd;
  try{fd=fs.openSync(temp,'wx',current.mode);fs.writeFileSync(fd,request.text);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
   if(hash(read(file).text)!==request.digest)throw Error('Native preferences changed. Refresh before saving.');
   fs.renameSync(temp,file);const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
  }finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}
  console.log(JSON.stringify({saved:true}));
 }else console.log(JSON.stringify({path:file,text:current.text,digest:hash(current.text)}));
}catch(error){const allowed=${JSON.stringify(PREFERENCE_FAILURES)};console.log(JSON.stringify({error:allowed.includes(error.message)?error.message:allowed.at(-1)}));process.exitCode=1;}
`;

export const RECOVERY_INSPECTION_ENVIRONMENT = [
	'FH_RECOVERY_URL',
	'FH_INSTANCE_ID',
	'FH_RECOVERY_INCLUDE_FILE',
	'FH_RECOVERY_STATE_DIR',
	'FH_RECOVERY_INTERVAL_SECONDS',
	'FH_RECOVERY_MAX_UNSAVED_SECONDS',
	'FH_RECOVERY_OPERATION_TIMEOUT_SECONDS',
	'FH_RECOVERY_AKM_INDEX_CAPTURE',
	'FH_RECOVERY_AKM_INDEX_RESTORE'
] as const;

function executeSource(command: string, args: string[]): string {
	// Commands/arguments are fixed host code, never credential-bearing input.
	return (
		LINE_INPUT +
		`import { spawn } from 'node:child_process';
const child=spawn(${JSON.stringify(command)},${JSON.stringify(args)},{stdio:['pipe','pipe','pipe']});
child.stdout.pipe(process.stdout);child.stderr.resume();
child.stdin.end(input);child.once('error',()=>process.exit(127));child.once('close',code=>process.exit(code??1));
process.on('SIGTERM',()=>child.kill('SIGTERM'));
`
	);
}

export function createNativeManagement(
	access: NativeAgentAccess,
	agent: NativeAgentService,
	options: NativePtyOptions = {}
) {
	let locked = false;
	const sessions = new Set<NativePtySession>();
	async function terminal(source: string, overrides: NativePtyOptions = {}) {
		const signals = [options.signal, overrides.signal].filter(
			(value): value is AbortSignal => value instanceof AbortSignal
		);
		const session = await startNativePty(access, source, {
			...options,
			...overrides,
			...(signals.length
				? { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) }
				: {})
		});
		sessions.add(session);
		void session.done.finally(() => sessions.delete(session)).catch(() => {});
		return session;
	}
	async function run(source: string, input: unknown, allowFailure = false): Promise<string> {
		const session = await terminal(source);
		session.input(JSON.stringify(input) + '\n');
		const result = await session.done;
		if (result.exitCode !== 0 && !allowFailure) {
			let failure: unknown;
			try {
				failure = (JSON.parse(result.output.trim()) as { error?: unknown }).error;
			} catch {
				/* Do not expose arbitrary command output. */
			}
			throw new Error(
				typeof failure === 'string' && PREFERENCE_FAILURES.includes(failure)
					? failure
					: `The native management command exited with status ${result.exitCode}. Check the image's native commands and selected configuration. No operation was retried.`
			);
		}
		return result.output.trim();
	}
	async function document(policy = false) {
		const raw: unknown = JSON.parse(await run(NATIVE_PREFERENCE_COMMAND, { policy }));
		if (
			!raw ||
			typeof raw !== 'object' ||
			!('text' in raw) ||
			typeof raw.text !== 'string' ||
			!('path' in raw) ||
			typeof raw.path !== 'string' ||
			!('digest' in raw) ||
			typeof raw.digest !== 'string'
		)
			throw new Error('Native preference document is unavailable.');
		return { ...parseNativePreferenceDocument(raw.text), path: raw.path, digest: raw.digest };
	}
	const settings: NativeProviderSettingsPort = {
		agent,
		async readPreferences() {
			return (await document()).value;
		},
		async readPolicy() {
			return (await document(true)).value;
		},
		async writePreferences(patch) {
			const current = await document();
			const text = editNativePreferenceJsonc(current.text, patch);
			const raw: unknown = JSON.parse(
				await run(NATIVE_PREFERENCE_COMMAND, {
					write: true,
					path: current.path,
					digest: current.digest,
					text
				})
			);
			if ((raw as { saved?: unknown })?.saved !== true)
				throw new Error('Native preference write was not confirmed. Refresh before retrying.');
			return { saved: true, effective: 'unconfirmed' };
		},
		async withLock(run) {
			if (locked) throw new Error('Another native preferences operation is running.');
			locked = true;
			try {
				return await run();
			} finally {
				locked = false;
			}
		},
		async discoverModels(input) {
			const raw: unknown = JSON.parse(
				await run(
					executeSource('node', ['--input-type=module', '-e', DISCOVER_MODELS]),
					input,
					true
				)
			);
			const value = raw as { models?: unknown; error?: unknown };
			if (!Array.isArray(value.models) || value.models.some((item) => typeof item !== 'string'))
				throw new Error(
					typeof value.error === 'string' ? value.error : 'The agent could not discover models.'
				);
			return value.models as string[];
		}
	};
	return {
		settings,
		async remoteSettings() {
			const value: unknown = JSON.parse(
				await run(
					LINE_INPUT +
						`console.log(JSON.stringify({claude:process.env.FH_CLAUDE_REMOTE!=='0',codex:process.env.FH_CODEX_REMOTE!=='0',sandbox:process.env.FH_CODEX_SANDBOX||'workspace-write'}));`,
					{}
				)
			);
			const settings = value as {
				claude: boolean;
				codex: boolean;
				sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
			};
			if (
				typeof settings.claude !== 'boolean' ||
				typeof settings.codex !== 'boolean' ||
				!['read-only', 'workspace-write', 'danger-full-access'].includes(settings.sandbox)
			)
				throw new Error('Native remote startup settings are unavailable.');
			return settings;
		},
		async remoteSetup(
			tool: 'claude' | 'codex',
			sandbox: 'read-only' | 'workspace-write' | 'danger-full-access',
			output: (value: string) => void,
			overrides: Pick<NativePtyOptions, 'signal'> = {}
		) {
			// The existing image script owns vendor login, native sandbox checks and
			// explicit consent. execve replaces this preamble, preserving its PTY.
			const session = await terminal(
				LINE_INPUT +
					`process.execve('/usr/local/bin/fhold-remote-setup',['fhold-remote-setup',${JSON.stringify(tool)},${JSON.stringify(sandbox)}],process.env);`,
				{ ...overrides, timeoutMs: 900_000, output, cancelInput: '{"cancel":true}\n' }
			);
			session.input('{}\n');
			return session;
		},
		async remoteConnection(tool: 'claude' | 'codex') {
			return run(
				executeSource(
					tool === 'codex' ? 'codex' : 'fhold-remote',
					tool === 'codex' ? ['remote-control', 'pair', '--json'] : ['claude', 'logs']
				),
				{}
			);
		},
		async recoveryStatus() {
			// status reads the already-sanitized runtime diagnostic; recovery storage
			// credentials are deliberately not supplied to native OpenCode processes.
			let value: unknown;
			try {
				value = JSON.parse(await run(executeSource('fhold-recovery', ['status']), {}, true));
			} catch {
				throw new Error(
					'No valid recovery status is available. Check whether recovery is enabled and inspect private instance logs.'
				);
			}
			if (!value || typeof value !== 'object' || Array.isArray(value))
				throw new Error('Recovery status is unavailable.');
			return {
				...(value as Record<string, unknown>),
				state: (value as { healthy?: unknown }).healthy === true ? 'ready' : 'not-ready'
			};
		},
		async recoveryInspect(environment: Record<string, string>) {
			if (
				Object.entries(environment).some(
					([key, value]) =>
						!RECOVERY_INSPECTION_ENVIRONMENT.includes(
							key as (typeof RECOVERY_INSPECTION_ENVIRONMENT)[number]
						) ||
						typeof value !== 'string' ||
						value.length > 4_096 ||
						/[\r\n\0]/.test(value)
				)
			)
				throw new Error(
					'Coverage inspection accepts only non-secret recovery deployment settings.'
				);
			// The owning engine's inspect only evaluates its catalog and mount
			// policy. No storage credential/identity endpoint is supplied, and no
			// namespace, lease, restore or initialization operation is invoked.
			return run(
				LINE_INPUT +
					`import { spawn } from 'node:child_process';
const env=JSON.parse(input);const child=spawn('fhold-recovery',['inspect'],{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
child.stdout.pipe(process.stdout);child.stderr.resume();child.once('error',()=>process.exit(127));child.once('close',code=>process.exit(code??1));
process.on('SIGTERM',()=>child.kill('SIGTERM'));`,
				environment
			);
		},
		async close() {
			await Promise.all([...sessions].map((session) => session.cancel()));
		}
	};
}

import { describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
	symlinkSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { installHome } from '../packages/lib/src/control-plane/install.js';
import { defaultStackConfig } from '../packages/lib/src/control-plane/stack-config.js';
import {
	runNativeWorker,
	type NativeWorkerContext
} from '../packages/lib/src/control-plane/native-worker.js';
import { exportHistory, restoreHistory } from '../packages/lib/src/control-plane/history.js';
import { createBackup } from '../packages/lib/src/control-plane/backup.js';
import { applyRestore } from '../packages/lib/src/control-plane/restore.js';
import { runDocker } from '../packages/lib/src/control-plane/docker.js';
import { recordAppliedRuntime, restartStatus, runtimeRevision } from '../packages/lib/src/control-plane/runtime-revision.js';

const image = process.env.FH_NATIVE_TEST_IMAGE;
const oldImage = process.env.FH_HISTORY_SOURCE_IMAGE;
const runtime = (home: string) => join(home, 'data/assistant/.local/share');
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
async function home(root: string, name: string) {
	const path = join(root, name);
	const config = defaultStackConfig(path);
	config.deployment.projectName = `fhold-transfer-${name}-${process.pid}`;
	const separator = image!.lastIndexOf(':');
	config.deployment.imageNamespace = image!.slice(0, separator).replace(/\/fhold-assistant$/, '');
	config.deployment.images.assistant = image!.slice(separator + 1);
	await installHome({ homeDir: path, config });
	mkdirSync(join(runtime(path), 'opencode'), { recursive: true });
	return path;
}
const mounts = (path: string) => [
	'--mount',
	`type=bind,src=${runtime(path)},dst=/native-data`,
	'--mount',
	`type=bind,src=${join(path, 'workspace')},dst=/work,readonly`
];
async function seed({ open, api }: NativeWorkerContext) {
	await open('/native-data');
	const root = (
		(await api('/session', { title: 'template', location: { directory: '/work' } })) as {
			data: Record<string, unknown>;
		}
	).data;
	await api(`/session/${root.id}`, undefined, 'DELETE');
	const parent = `ses_${process.env.FH_FIXTURE}`;
	const messages = Array.from({ length: 205 }, (_, index) => ({
		id: `msg_${process.env.FH_FIXTURE}${index}`,
		type: 'user',
		text: `authored text ${index}`,
		time: { created: 1780000000000 + index }
	}));
	await api('/experimental/session/import', {
		info: {
			...root,
			id: parent,
			title: 'parent',
			metadata: { fixture: 'preserved' },
			permissions: [{ action: '*', resource: '*', effect: 'allow' }]
		},
		messages,
		location: { directory: '/work' }
	});
	await api('/experimental/session/import', {
		info: { ...root, id: `${parent}child`, parentID: parent, title: 'child' },
		messages: [],
		location: { directory: '/work' }
	});
	await api('/credential', {
		id: `cred_${process.env.FH_FIXTURE}`,
		integrationID: 'openai',
		label: 'Synthetic key',
		value: { type: 'key', key: 'synthetic-test-key' },
		activate: true
	});
	await api('/credential', {
		id: `cred_${process.env.FH_FIXTURE}oauth`,
		integrationID: 'anthropic',
		label: 'Synthetic OAuth',
		value: {
			type: 'oauth',
			methodID: 'oauth',
			access: 'synthetic-access',
			refresh: 'synthetic-refresh',
			expires: 2000000000000
		},
		activate: true
	});
	await api('/credential', {
		id: `cred_${process.env.FH_FIXTURE}mcp`,
		integrationID: 'mcp_example',
		label: 'Do not export',
		value: { type: 'key', key: 'synthetic-mcp-secret' }
	});
}

describe.skipIf(!image)('native v2 offline transfer (real image, no model usage)', () => {
	it('preserves paginated parent/child history and session metadata, round-trips keys and OAuth, and retries without duplicating', async () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-v2-transfer-'));
		const source = await home(root, 'source');
		const target = await home(root, 'target');
		await runNativeWorker(image!, mounts(source), seed, ['FH_FIXTURE=source']);
		await runNativeWorker(image!, mounts(target), seed, ['FH_FIXTURE=existing']);
		const sourceHash = digest(join(runtime(source), 'opencode/opencode.db'));
		const targetHash = digest(join(runtime(target), 'opencode/opencode.db'));
		const archive = join(root, 'history');
		expect(
			(await exportHistory({ sourceHome: source, image: image!, destination: archive })).sessions
		).toBe(2);
		const options = { homeDir: target, archive, directories: { '/work': '/work' } };
		const preview = await restoreHistory(options);
		expect(preview).toMatchObject({ sessions: 2, messages: 205, applied: false });
		expect(digest(join(runtime(target), 'opencode/opencode.db'))).toBe(targetHash);
		expect(digest(join(runtime(source), 'opencode/opencode.db'))).toBe(sourceHash);
		const applied = await restoreHistory({ ...options, apply: true, sameInstance: true });
		expect(applied.applied).toBe(true);
		expect((await restoreHistory({ ...options, apply: true, sameInstance: true })).sessions).toBe(
			2
		);
		await runNativeWorker(image!, mounts(target), async ({ open, api }) => {
			await open('/native-data');
			const restored = ((await api('/session/ses_source')) as { data: { metadata?: unknown } })
				.data;
			if ((restored.metadata as { fixture?: unknown } | undefined)?.fixture !== 'preserved')
				throw new Error('Native session metadata was not preserved.');
			await api('/session/ses_source/synthetic', {
				text: 'Later work must survive retry',
				resume: false
			});
			await api('/session/ses_source', { title: 'Renamed after import' }, 'PATCH');
		});
		expect((await restoreHistory({ ...options, apply: true, sameInstance: true })).sessions).toBe(
			2
		);
		const privateBackup = join(root, 'portable');
		const backup = await createBackup({
			sourceHome: source,
			destination: privateBackup,
			includeProviderAuth: true
		});
		expect(backup.files.some((entry) => entry.path.endsWith('opencode-credentials.json'))).toBe(
			true
		);
		const auth = JSON.parse(
			readFileSync(join(privateBackup, 'knowledge/secrets/opencode-credentials.json'), 'utf8')
		);
		expect(auth.map((entry: { integrationID: string }) => entry.integrationID).sort()).toEqual([
			'anthropic',
			'openai'
		]);
		const fresh = await home(root, 'fresh');
		await applyRestore({
			sourceHome: privateBackup,
			destinationHome: fresh,
			includeProviderAuth: true,
			acknowledgeUnrestored: true
		});
		await runNativeWorker(image!, mounts(fresh), async ({ open, api }) => {
			await open('/native-data');
			const entries = (
				(await api('/credential')) as {
					data: Array<{
						integrationID: string;
						value: { type: string; key?: string; refresh?: string };
					}>;
				}
			).data;
			if (
				entries.length !== 2 ||
				entries.find((entry) => entry.integrationID === 'openai')?.value.key !==
					'synthetic-test-key' ||
				entries.find((entry) => entry.integrationID === 'anthropic')?.value.refresh !==
					'synthetic-refresh'
			)
				throw new Error('Native credentials were not preserved.');
		});
		const targetBeforeCollision = digest(join(runtime(target), 'opencode/opencode.db'));
		const sessionPath = join(archive, 'ses_source.json');
		const changed = JSON.parse(readFileSync(sessionPath, 'utf8'));
		changed.messages[0].text = 'Do not overwrite the target';
		writeFileSync(sessionPath, JSON.stringify(changed));
		await expect(restoreHistory({ ...options, apply: true, sameInstance: true })).rejects.toThrow(
			'checksum'
		);
		const manifestPath = join(archive, 'history.json');
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
		manifest.sessions.find((entry: { id: string }) => entry.id === 'ses_source').sha256 =
			digest(sessionPath);
		writeFileSync(manifestPath, JSON.stringify(manifest));
		await expect(restoreHistory({ ...options, apply: true, sameInstance: true })).rejects.toThrow(
			'collision'
		);
		expect(digest(join(runtime(target), 'opencode/opencode.db'))).toBe(targetBeforeCollision);
	}, 180_000);

	it.skipIf(!oldImage)(
		'upgrades v1 history and credentials through upstream migration without changing its source',
		async () => {
			const root = mkdtempSync(join(tmpdir(), 'fhold-v1-v2-transfer-'));
			const source = await home(root, 'legacy');
			const target = await home(root, 'fresh');
			const fixture = {
				info: {
					id: 'ses_legacy',
					slug: 'legacy',
					projectID: 'global',
					directory: '/work',
					title: 'Legacy conversation',
					version: '1.18.21',
					time: { created: 1780000000000, updated: 1780000000000 }
				},
				messages: [
					{
						info: {
							id: 'msg_legacy',
							sessionID: 'ses_legacy',
							role: 'user',
							time: { created: 1780000000000 },
							agent: 'build',
							model: { providerID: 'test', modelID: 'test' }
						},
						parts: [
							{
								id: 'prt_legacy',
								sessionID: 'ses_legacy',
								messageID: 'msg_legacy',
								type: 'text',
								text: 'Keep this conversation'
							}
						]
					}
				] as Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
			};
			const summaryText = 'Compaction summary: the operator asked to preserve the conversation and workspace notes.';
			// Native v1 compaction is a user request part followed by its summary
			// assistant. A standalone summary flag is not a compaction operation.
			fixture.messages.push({
				info: {
					id: 'msg_legacy_compaction', sessionID: 'ses_legacy', role: 'user',
					time: { created: 1780000000003 }, agent: 'build',
					model: { providerID: 'test', modelID: 'test' }
				},
				parts: [{ id: 'prt_legacy_compaction', sessionID: 'ses_legacy', messageID: 'msg_legacy_compaction', type: 'compaction', auto: false }]
			});
			for (const [id, text, summary] of [
				['msg_legacy_reply', 'I will preserve the conversation and notes.', false],
				['msg_legacy_summary', summaryText, true]
			] as const) {
				fixture.messages.push({
					info: {
						id, sessionID: 'ses_legacy', role: 'assistant', summary,
						time: { created: summary ? 1780000000004 : 1780000000001, completed: summary ? 1780000000005 : 1780000000002 },
						parentID: summary ? 'msg_legacy_compaction' : 'msg_legacy', agent: 'build', mode: 'build',
						providerID: 'test', modelID: 'test', path: { cwd: '/work', root: '/work' },
						cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
						finish: 'stop'
					},
					parts: [{ id: `prt_${id}`, sessionID: 'ses_legacy', messageID: id, type: 'text', text }]
				});
			}
			const preserved = ['workspace/operator-note.txt', 'knowledge/operator-note.md', 'config/codex/config.toml'];
			for (const path of preserved) writeFileSync(join(source, path), `Operator-owned ${path}\n`);
			recordAppliedRuntime(source, runtimeRevision(source));
			writeFileSync(join(source, 'config/codex/config.toml'), 'approval_policy = "on-request"\n');
			const pendingReceipt = digest(join(source, 'state/applied-runtime.json'));
			const preservedHashes = preserved.map((path) => digest(join(source, path)));
			writeFileSync(join(root, 'seed.json'), JSON.stringify(fixture));
			const result = await runDocker([
				'run',
				'--rm',
				'--network',
				'none',
				'--user',
				`${process.getuid?.()}:${process.getgid?.()}`,
				'--tmpfs',
				'/tmp:rw,mode=1777',
				'--env',
				'HOME=/tmp/home',
				'--env',
				'XDG_DATA_HOME=/native-data',
				'--env',
				'OPENCODE_CONFIG_DIR=/tmp/config',
				'--env',
				'OPENCODE_CONFIG_CONTENT={}',
				...mounts(source),
				'--mount',
				`type=bind,src=${join(root, 'seed.json')},dst=/seed.json,readonly`,
				'--entrypoint',
				'opencode',
				oldImage!,
				'--pure',
				'import',
				'/seed.json'
			]);
			if (!result.ok) throw new Error(result.stderr);
			writeFileSync(
				join(source, 'knowledge/secrets/auth.json'),
				JSON.stringify({ openai: { type: 'api', key: 'legacy-synthetic-key' } })
			);
			const before = digest(join(runtime(source), 'opencode/opencode.db'));
			const archive = join(root, 'history');
			// The v2 worker opens a private SQLite-native snapshot of the v1 DB.
			// This exercises upstream startup migration, not legacy transcript import,
			// while leaving the original database and credentials untouched.
			await exportHistory({ sourceHome: source, image: image!, destination: archive });
			const restored = await restoreHistory({
				homeDir: target,
				archive,
				directories: { '/work': '/work' },
				apply: true,
				sameInstance: true
			});
			expect(restored.sessions).toBe(1);
			const migrated = JSON.parse(readFileSync(join(archive, 'ses_legacy.json'), 'utf8'));
			expect(migrated.info.id).toBe('ses_legacy');
			expect(migrated.messages.find((message: { id: string }) => message.id === 'msg_legacy')?.text).toBe('Keep this conversation');
			expect(JSON.stringify(migrated.messages)).toContain('I will preserve the conversation and notes.');
			const migratedSummary = migrated.messages.find((message: { type: string; summary?: unknown }) => message.type === 'compaction' && JSON.stringify(message.summary).includes(summaryText));
			expect(migratedSummary).toBeDefined();
			const targetArchive = join(root, 'restored-history');
			await exportHistory({ sourceHome: target, image: image!, destination: targetArchive });
			const targetSession = JSON.parse(readFileSync(join(targetArchive, 'ses_legacy.json'), 'utf8'));
			expect(targetSession.info.id).toBe('ses_legacy');
			const summary = targetSession.messages.find((message: { type: string; summary?: unknown }) => message.type === 'compaction' && JSON.stringify(message.summary).includes(summaryText));
			expect(summary).toBeDefined();
			expect(preserved.map((path) => digest(join(source, path)))).toEqual(preservedHashes);
			expect(digest(join(source, 'state/applied-runtime.json'))).toBe(pendingReceipt);
			expect(restartStatus(source).required).toBe(true);
			expect(digest(join(runtime(source), 'opencode/opencode.db'))).toBe(before);
			const backup = join(root, 'portable');
			await createBackup({ sourceHome: source, destination: backup, includeProviderAuth: true });
			expect(
				JSON.parse(
					readFileSync(join(backup, 'knowledge/secrets/opencode-credentials.json'), 'utf8')
				)[0].value.key
			).toBe('legacy-synthetic-key');
			const credentials = JSON.parse(readFileSync(join(backup, 'knowledge/secrets/opencode-credentials.json'), 'utf8'));
			expect(credentials).toHaveLength(1);
			expect(credentials[0].integrationID).toBe('openai');
			await applyRestore({ sourceHome: backup, destinationHome: target, includeProviderAuth: true, acknowledgeUnrestored: true });
			await runNativeWorker(image!, mounts(target), async ({ open, api }) => {
				await open('/native-data');
				const entries = ((await api('/credential')) as { data: Array<{ id: string; integrationID: string; value: { key?: string } }> }).data;
				if (entries.length !== 1 || entries[0]?.id !== process.env.FH_EXPECTED_CREDENTIAL_ID || entries[0]?.integrationID !== 'openai' || entries[0]?.value.key !== 'legacy-synthetic-key')
					throw new Error('Migrated native credential identity/value was not preserved.');
			}, [`FH_EXPECTED_CREDENTIAL_ID=${credentials[0].id}`]);
		},
		180_000
	);

	it('archives interrupted v2 tool and shell history without replaying work', async () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-v2-interrupted-'));
		const source = await home(root, 'source');
		const target = await home(root, 'target');
		await runNativeWorker(image!, mounts(source), async ({ open, api }) => {
			await open('/native-data');
			const info = (
				(await api('/session', { title: 'Interrupted', location: { directory: '/work' } })) as {
					data: Record<string, unknown>;
				}
			).data;
			await api(`/session/${info.id}`, undefined, 'DELETE');
			await api('/experimental/session/import', {
				info: { ...info, id: 'ses_interrupted' },
				location: { directory: '/work' },
				messages: [
					{
						id: 'msg_interrupted',
						type: 'assistant',
						agent: 'build',
						model: { providerID: 'test', id: 'test' },
						time: { created: 1780000000000, completed: 1780000000001 },
						content: [
							{
								type: 'tool',
								id: 'call_interrupted',
								name: 'shell',
								state: {
									status: 'completed',
									input: { command: 'touch /work/must-not-execute' },
									content: [{ type: 'text', text: 'synthetic' }]
								},
								time: { created: 1780000000000 }
							}
						]
					},
					{
						id: 'msg_shell',
						type: 'shell',
						shellID: 'sh_interrupted',
						command: 'touch /work/must-not-execute',
						status: 'exited',
						time: { created: 1780000000001, completed: 1780000000002 }
					}
				]
			});
		});
		const archive = join(root, 'history');
		await exportHistory({ sourceHome: source, destination: archive, image: image! });
		// Native import itself excludes unfinished messages. Model an unfinished
		// archived timeline explicitly, then exercise fhold's reviewed conversion
		// and the real native importer (no database schema writes).
		const path = join(archive, 'ses_interrupted.json');
		const data = JSON.parse(readFileSync(path, 'utf8'));
		delete data.messages[0].time.completed;
		data.messages[0].content[0].state = {
			status: 'running',
			input: { command: 'touch /work/must-not-execute' },
			metadata: {}
		};
		data.messages[1].status = 'running';
		delete data.messages[1].time.completed;
		writeFileSync(path, JSON.stringify(data));
		const manifest = JSON.parse(readFileSync(join(archive, 'history.json'), 'utf8'));
		manifest.sessions[0].sha256 = digest(path);
		writeFileSync(join(archive, 'history.json'), JSON.stringify(manifest));
		const options = {
			homeDir: target,
			archive,
			directories: { '/work': '/work' },
			apply: true,
			sameInstance: true
		};
		await expect(restoreHistory(options)).rejects.toThrow('Interrupted');
		const restored = await restoreHistory({ ...options, archiveInterrupted: true });
		expect(restored.interruptedTools).toBeGreaterThan(0);
		expect(existsSync(join(target, 'workspace/must-not-execute'))).toBe(false);
		expect(
			JSON.parse(readFileSync(join(archive, 'ses_interrupted.json'), 'utf8')).messages[0].content[0]
				.state.status
		).toBe('running');
	}, 180_000);

	it('requires explicit resolved selection for a linked runtime root', async () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-history-linked-'));
		mkdirSync(join(root, 'old/data'), { recursive: true });
		mkdirSync(join(root, 'external'));
		symlinkSync(join(root, 'external'), join(root, 'old/data/assistant'));
		await expect(
			exportHistory({
				sourceHome: join(root, 'old'),
				image: image!,
				destination: join(root, 'archive')
			})
		).rejects.toThrow();
	});
});

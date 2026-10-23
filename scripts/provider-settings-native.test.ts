import { it } from 'bun:test';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
	writeFileSync,
	mkdirSync,
	readFileSync,
	existsSync,
	mkdtempSync,
	statSync,
	accessSync,
	constants
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename, resolve, isAbsolute, dirname } from 'node:path';
import assert from 'node:assert/strict';
import {
	defaultStackConfig,
	listProviderSettings,
	saveProviderEndpoint,
	useProviderModel,
	removeProviderSetup,
	discoverProviderModels,
	testAssistantReadiness,
	waitForAssistant,
	buildComposeCliArgs,
	createFholdState,
	setProviderApiKey,
	restartStatus
} from '../packages/lib/src/index.js';
import { readAssistantConfig } from '../packages/lib/src/control-plane/opencode.js';
import { verifyNativeGuardian } from '../packages/guardian/src/native-test-helper.js';

const MODEL_SERVER = String.raw`
const http = require('node:http');
const requests = [];
http.createServer(async (req,res) => {
  const path = new URL(req.url,'http://fixture').pathname;
  const json = (value,status=200) => { res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value)); };
  if(path==='/qa/requests') return json(requests);
  if(path.endsWith('/v1/models')) { requests.push({path,method:req.method});return json({object:'list',data:[{id:'team/qa-model',object:'model'},{id:'team/edited-model',object:'model'}]}); }
  if(path.endsWith('/v1/chat/completions')) {
    let input='';for await(const chunk of req)input+=chunk;
    const body=JSON.parse(input);
    const supplied=JSON.stringify(body.messages);
    const text=supplied.includes('Classify the following untrusted JSON string') ? JSON.stringify({verdict:'block',reason:'Controlled native moderator verdict'}) : supplied.includes('internal memory extraction') ? JSON.stringify({facts:[{fact:'The user prefers jasmine tea.',evidence:'I prefer jasmine tea.',confidence:0.95}]}) : 'FH_READY';
    requests.push({path,method:req.method,model:body.model,tools:body.tools?.length||0,stream:body.stream===true});
    const usage={prompt_tokens:1,completion_tokens:1,total_tokens:2};
    if(!body.stream)return json({id:'qa',object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}],usage});
    const chunk=(delta,finish_reason)=>({id:'qa',object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:body.model,choices:[{index:0,delta,finish_reason}]});
    res.writeHead(200,{'content-type':'text/event-stream'});
    return res.end('data: '+JSON.stringify(chunk({role:'assistant',content:text},null))+'\n\ndata: '+JSON.stringify({...chunk({},'stop'),usage})+'\n\ndata: [DONE]\n\n');
  }
  requests.push({path,method:req.method});json({error:{message:'Unexpected controlled fixture request'}},404);
}).listen(8080,'0.0.0.0');
`;

// Opt in only with Docker, an explicit locked Assistant image and a current compiled CLI.
// This tests the real native SDK with controlled HTTP responses, not vendor entitlement.
it.skipIf(process.env.FH_NATIVE_PROVIDER_TESTS !== '1')(
	'applies native AI settings live without restarting and preserves them through normal restart',
	async () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-provider-native-'));
		const home = join(root, 'home');
		const cli = resolve(process.env.FH_NATIVE_PROVIDER_CLI || '');
		assert(
			process.env.FH_NATIVE_PROVIDER_CLI &&
				isAbsolute(process.env.FH_NATIVE_PROVIDER_CLI) &&
				existsSync(cli) &&
				statSync(cli).isFile(),
			'Set FH_NATIVE_PROVIDER_CLI to the absolute path of the current built standalone CLI file'
		);
		accessSync(cli, constants.X_OK);
		const image = process.env.FH_NATIVE_PROVIDER_IMAGE || '';
		const imageMatch = image.match(/^([a-z0-9][a-z0-9./_-]*)\/fhold-assistant:([A-Za-z0-9._-]+)$/);
		assert(
			imageMatch,
			'Set FH_NATIVE_PROVIDER_IMAGE to an explicit locked namespace/fhold-assistant:tag'
		);
		const execute = promisify(execFile);
		const commands: Array<{ command: string; args: string[]; stdout: string }> = [];
		const requests: Array<{
			path: string;
			method: string;
			model?: string;
			tools?: number;
			stream?: boolean;
		}> = [];
		const stages: string[] = [];
		const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
		let url = '';
		let editedUrl = '';
		let fixtureName = '';
		let fixtureId = '';
		let observer = '';
		const syncRequests = async () => {
			if (!observer) return;
			const response = await fetch(`${observer}/qa/requests`);
			assert(response.ok, 'Controlled endpoint observation failed');
			requests.splice(0, requests.length, ...((await response.json()) as typeof requests));
		};
		const freePort = () => {
			const holder = Bun.serve({
				hostname: '127.0.0.1',
				port: 0,
				fetch: () => new Response('unused')
			});
			const port = holder.port;
			holder.stop(true);
			return port;
		};
		const config = defaultStackConfig(home);
		config.deployment.imageNamespace = imageMatch[1];
		config.deployment.images.assistant = imageMatch[2];
		config.deployment.projectName = `provider-qa-${basename(root).split('-').at(-1)?.toLowerCase()}`;
		config.assistant.port = freePort();
		config.gateway.port = freePort();
		config.assistant.codexRemote = false;
		config.assistant.claudeRemote = false;
		writeFileSync(join(root, 'fixture-stack.json'), JSON.stringify(config, null, 2));
		const run = async (args: string[]) => {
			const result = await execute(cli, ['--name', home, ...args], {
				cwd: root,
				maxBuffer: 2 * 1024 * 1024
			});
			commands.push({ command: cli, args: ['--name', home, ...args], stdout: result.stdout });
			return result;
		};
		const authIds = async () => {
			const password = readFileSync(
				join(home, 'state/secrets/fhold_opencode_password'),
				'utf8'
			).trim();
			const response = await fetch(`http://127.0.0.1:${config.assistant.port}/api/credential`, {
				headers: {
					authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
				}
			});
			assert(response.ok);
			return ((await response.json()) as { data: Array<{ integrationID: string }> }).data
				.map((entry) => entry.integrationID)
				.sort();
		};
		const posts = () => requests.filter((item) => item.method === 'POST');
		let started = false;
		let primaryError: unknown;
		const cleanupErrors: unknown[] = [];
		let mounts: Array<{ Source: string; Destination: string; RW: boolean }> = [];
		const identities: Array<{ stage: string; container: string; opencodePids: string[] }> = [];
		try {
			console.info('Native settings regression fixture:', root);
			await run(['install', '--no-start', '--config', join(root, 'fixture-stack.json')]);
			const managedPaths = [
				'system/assistant/opencode.json',
				'system/codex/config.toml',
				'system/codex/requirements.toml',
				'system/claude/managed-settings.json'
			].map((path) => join(home, path));
			const beforeHashes = Object.fromEntries(managedPaths.map((path) => [path, digest(path)]));
			const preserved = {
				'config/assistant/opencode.json': '{"$schema":"https://opencode.ai/config.json"}\n',
				'config/assistant/persona.md': 'Disposable operator persona\n',
				'config/opencode/opencode.json': '{"permission":{"bash":"deny"}}\n',
				'config/codex/config.toml': 'approval_policy = "never"\n',
				'config/codex/requirements.toml': 'allowed_approval_policies = ["never"]\n',
				'config/claude/managed-settings.json': '{"permissions":{"defaultMode":"plan"}}\n'
			};
			for (const path of Object.keys(preserved).filter((path) => !path.startsWith('config/assistant/')))
				assert(!existsSync(join(home, path)), `Fresh install must not seed obsolete ${path}`);
			for (const [path, content] of Object.entries(preserved)) {
				mkdirSync(dirname(join(home, path)), { recursive: true });
				writeFileSync(join(home, path), content);
			}
			const overlay = readFileSync(join(home, 'config/stack/custom.compose.yml'));
			for (const path of managedPaths) writeFileSync(path, 'prior release bytes\n');
			await run(['update', '--no-start']);
			assert.deepEqual(Object.fromEntries(managedPaths.map((path) => [path, digest(path)])), beforeHashes);
			for (const [path, content] of Object.entries(preserved))
				assert.equal(readFileSync(join(home, path), 'utf8'), content);
			assert.deepEqual(readFileSync(join(home, 'config/stack/custom.compose.yml')), overlay);
			stages.push('normal compiled CLI install/update --no-start refreshes all native system policies, preserving user settings and inert old config policies');
			started = true;
			await run(['start']);
			await waitForAssistant(home);
			const composeArgs = ['compose', ...buildComposeCliArgs(createFholdState(home))];
			await execute('docker', [
				...composeArgs,
				'--profile',
				'gateway',
				'--profile',
				'discord',
				'--profile',
				'slack',
				'config',
				'--quiet'
			]);
			const cid = (
				await execute('docker', [...composeArgs, 'ps', '--quiet', 'assistant'])
			).stdout.trim();
			assert.match(cid, /^[a-f0-9]+$/);
			const identity = async (stage: string) => {
				const container = (
					await execute('docker', [...composeArgs, 'ps', '--quiet', 'assistant'])
				).stdout.trim();
				const processes = (await execute('docker', ['top', container, '-eo', 'pid,comm'])).stdout;
				const opencodePids = processes
					.split('\n')
					.filter((line) => /\bopencode\b/.test(line))
					.map((line) => line.trim().split(/\s+/)[0])
					.sort();
				assert(opencodePids.length > 0, 'Native OpenCode PID must be observable');
				const result = { stage, container, opencodePids };
				identities.push(result);
				return result;
			};
			const initialIdentity = await identity('before provider settings');
			await execute('docker', [
				'exec',
				cid,
				'node',
				'--input-type=module',
				'-e',
				readFileSync(join(import.meta.dir, 'smoke-opencode-v2-live.mjs'), 'utf8')
			]);
			stages.push(
				'native watcher applies providers, models, shell, agents, commands, existing-session permissions and plugin add/edit/remove on managed mounts without reload or restart'
			);
			const liveImage = (
				await execute('docker', ['inspect', '--format', '{{.Config.Image}}', cid])
			).stdout.trim();
			assert.equal(liveImage, image);
			assert.equal(
				digest(join(home, 'system/stack/stack.compose.yml')),
				digest(join(import.meta.dir, '../packages/skeleton/system/stack/stack.compose.yml')),
				'Build the CLI with current embedded managed Compose'
			);
			const networks = JSON.parse(
				(
					await execute('docker', [
						'inspect',
						'--format',
						'{{json .NetworkSettings.Networks}}',
						cid
					])
				).stdout
			) as Record<string, unknown>;
			const network = Object.keys(networks).find((name) => name.endsWith('_agent_net'));
			assert(network, 'Expected the normal isolated Assistant network');
			fixtureName = `${config.deployment.projectName}-model-fixture`;
			const fixture = await execute('docker', [
				'run',
				'--detach',
				'--name',
				fixtureName,
				'--label',
				`fh.test-home=${home}`,
				'--network',
				network,
				'--user',
				'fhold',
				'--cap-drop',
				'ALL',
				'--security-opt',
				'no-new-privileges:true',
				'--read-only',
				'--publish',
				'127.0.0.1::8080',
				'--entrypoint',
				'node',
				image,
				'-e',
				MODEL_SERVER
			]);
			fixtureId = fixture.stdout.trim();
			assert.match(fixtureId, /^[a-f0-9]{64}$/);
			const published = (await execute('docker', ['port', fixtureName, '8080/tcp'])).stdout.trim();
			assert.match(published, /^127\.0\.0\.1:\d+$/);
			observer = `http://${published}`;
			const deadline = Date.now() + 5000;
			while (true) {
				try {
					await syncRequests();
					break;
				} catch (error) {
					if (Date.now() > deadline) throw error;
					await Bun.sleep(50);
				}
			}
			url = `http://${fixtureName}:8080/v1`;
			editedUrl = `http://${fixtureName}:8080/edited/v1`;
			mounts = JSON.parse(
				(await execute('docker', ['inspect', '--format', '{{json .Mounts}}', cid])).stdout
			);
			assert.equal(
				mounts.find((item) => item.Destination === '/home/fhold/.config/opencode')?.RW,
				true
			);
			assert.equal(mounts.find((item) => item.Destination === '/etc/opencode')?.RW, false);
			assert(!mounts.some((item) => item.Destination === '/etc/opencode/opencode.json'));
			for (const [source, target] of [
				['system/codex/config.toml', '/etc/codex/config.toml'],
				['system/codex/requirements.toml', '/etc/codex/requirements.toml'],
				['system/claude/managed-settings.json', '/etc/claude-code/managed-settings.json']
			]) {
				const mount = mounts.find((item) => item.Destination === target);
				assert.equal(mount?.Source, join(home, source));
				assert.equal(mount?.RW, false);
			}
			assert(!mounts.some((item) => ['/etc/codex', '/etc/claude-code'].includes(item.Destination)));
			for (const [source, target] of [
				['system/assistant/opencode.json', '/etc/opencode/opencode.json'],
				['system/codex/config.toml', '/etc/codex/config.toml'],
				['system/codex/requirements.toml', '/etc/codex/requirements.toml'],
				['system/claude/managed-settings.json', '/etc/claude-code/managed-settings.json']
			]) assert.equal((await execute('docker', ['exec', cid, 'cat', target])).stdout, readFileSync(join(home, source), 'utf8'));
			await execute('docker', ['exec', cid, 'test', '-s', '/etc/codex/hooks.json']);
			await execute('docker', ['exec', cid, 'test', '-s', '/etc/claude-code/managed-settings.d/10-fhold.json']);
			const effective = await readAssistantConfig(home);
			assert.deepEqual(effective.permissions, JSON.parse(readFileSync(managedPaths[0], 'utf8')).permissions);
			const writableConfig = mounts.filter(
				(item) => item.Destination === '/home/fhold/.config/opencode' && item.RW
			);
			assert.equal(writableConfig.length, 1);
			assert.equal(writableConfig[0].Destination, '/home/fhold/.config/opencode');
			const preferencesPath = join(writableConfig[0].Source, 'opencode.json');
			stages.push(
				'normal CLI install/start; writable native user settings directory, managed plugins and system policy read-only'
			);
			const before = await readAssistantConfig(home);
			await setProviderApiKey(home, 'anthropic', 'synthetic-unrelated-key');
			await syncRequests();
			assert.equal(posts().length, 0);
			for (const provider of ['qa-ollama', 'qa-lmstudio', 'qa-llama-cpp', 'qa-custom']) {
				const settings = await saveProviderEndpoint(home, {
					provider,
					name: `QA ${provider}`,
					url,
					model: 'team/qa-model',
					...(provider === 'qa-llama-cpp' ? { key: 'synthetic-test-key' } : {})
				});
				const summary = settings.providers.find((item) => item.id === provider);
				assert(summary?.models?.some((model) => model.id === 'team/qa-model'));
				assert.equal(summary?.disabled, false);
				assert.equal((await readAssistantConfig(home)).model, before.model);
				await syncRequests();
				assert.equal(posts().length, 0);
			}
			stages.push(
				'four endpoint setups saved and effective immediately; native auth separate; no inference/default change'
			);
			const savedIdentity = await identity('after four endpoint saves');
			assert.equal(savedIdentity.container, initialIdentity.container);
			assert.deepEqual(savedIdentity.opencodePids, initialIdentity.opencodePids);
			assert.equal(restartStatus(home).required, false);
			assert.deepEqual(await discoverProviderModels(home, { url }), [
				'team/edited-model',
				'team/qa-model'
			]);
			await syncRequests();
			assert.equal(posts().length, 0);
			stages.push('models discovered from Assistant network; exact slash IDs; no inference');
			const tested = await testAssistantReadiness(home, {
				provider: 'qa-ollama',
				model: 'team/qa-model',
				timeoutMs: 20000
			});
			assert.equal(tested.ok, true, JSON.stringify(tested));
			assert.equal((await readAssistantConfig(home)).model, before.model);
			const used = await useProviderModel(home, 'qa-ollama', 'team/qa-model');
			assert.deepEqual(used.currentModel, { provider: 'qa-ollama', model: 'team/qa-model' });
			assert.deepEqual((await readAssistantConfig(home)).model, {
				providerID: 'qa-ollama',
				model: 'team/qa-model'
			});
			await syncRequests();
			assert.equal(posts().length, 1);
			const usedIdentity = await identity('after explicit Use');
			assert.equal(usedIdentity.container, initialIdentity.container);
			assert.deepEqual(usedIdentity.opencodePids, initialIdentity.opencodePids);
			assert.equal(restartStatus(home).required, false);
			stages.push(
				'exact native no-tool response before explicit Use; Use confirmed native default without an inference request'
			);
			await saveProviderEndpoint(home, {
				provider: 'qa-ollama',
				name: 'Edited QA Ollama',
				url: editedUrl,
				model: 'team/edited-model'
			});
			assert.deepEqual((await readAssistantConfig(home)).model, {
				providerID: 'qa-ollama',
				model: 'team/qa-model'
			});
			const edited = await testAssistantReadiness(home, {
				provider: 'qa-ollama',
				model: 'team/edited-model',
				timeoutMs: 20000
			});
			assert.equal(edited.ok, true, JSON.stringify(edited));
			await syncRequests();
			assert.equal(posts().at(-1)?.path, '/edited/v1/chat/completions');
			assert.deepEqual((await readAssistantConfig(home)).model, {
				providerID: 'qa-ollama',
				model: 'team/qa-model'
			});
			stages.push(
				'endpoint URL/model edit applied immediately and preserved old default; explicit test used edited transport'
			);
			const userConfigBeforeRestart = digest(preferencesPath);
			const authBeforeRestart = await authIds();
			// Model the prior release's persisted, operator-owned AKM config.
			const akmPath = join(home, 'config/akm/config.json');
			const oldAkm = JSON.parse(readFileSync(akmPath, 'utf8'));
			oldAkm.engines.scheduled.args[1] = '--attach';
			writeFileSync(akmPath, JSON.stringify(oldAkm));
			await run(['restart']);
			await waitForAssistant(home);
			const upgradedAkm = JSON.parse(readFileSync(akmPath, 'utf8'));
			assert.equal(restartStatus(home).required, false, 'One healthy normal restart applies the converted engine');
			oldAkm.engines.scheduled.args[1] = '--server';
			assert.deepEqual(
				upgradedAkm,
				oldAkm,
				'Normal startup upgrades the exact shipped scheduler arguments and preserves all other settings'
			);
			await identity('after explicit CLI restart');
			const afterRestart = await listProviderSettings(home);
			assert.deepEqual(afterRestart.currentModel, {
				provider: 'qa-ollama',
				model: 'team/qa-model'
			});
			assert.equal(
				afterRestart.providers.find((item) => item.id === 'qa-ollama')?.endpoint?.url,
				editedUrl
			);
			assert.equal(digest(preferencesPath), userConfigBeforeRestart);
			assert.deepEqual(await authIds(), authBeforeRestart);
			stages.push(
				'normal CLI restart retained exact default, endpoint edit, native preferences and auth bytes'
			);
			const disabled = await removeProviderSetup(home, 'qa-llama-cpp', { endpoint: true });
			assert.equal(disabled.providers.find((item) => item.id === 'qa-llama-cpp')?.disabled, true);
			assert.equal(
				disabled.providers.find((item) => item.id === 'qa-llama-cpp')?.authenticated,
				true
			);
			assert.equal(
				disabled.providers.find((item) => item.id === 'qa-llama-cpp')?.endpoint?.url,
				url
			);
			assert((await authIds()).includes('anthropic'));
			const removedAuth = await removeProviderSetup(home, 'qa-llama-cpp');
			assert.equal(
				removedAuth.providers.find((item) => item.id === 'qa-llama-cpp')?.authenticated,
				false
			);
			assert.equal(
				removedAuth.providers.find((item) => item.id === 'qa-llama-cpp')?.disabled,
				true
			);
			assert((await authIds()).includes('anthropic'));
			await saveProviderEndpoint(home, {
				provider: 'qa-llama-cpp',
				name: 'QA llama.cpp enabled again',
				url,
				model: 'team/qa-model'
			});
			assert.equal(
				(await listProviderSettings(home)).providers.find((item) => item.id === 'qa-llama-cpp')
					?.disabled,
				false
			);
			await assert.rejects(
				removeProviderSetup(home, 'qa-ollama', { endpoint: true }),
				/another model/i
			);
			assert.deepEqual((await readAssistantConfig(home)).model, {
				providerID: 'qa-ollama',
				model: 'team/qa-model'
			});
			await syncRequests();
			assert.equal(posts().length, 2);
			assert(posts().every((item) => item.tools === 0));
			assert(
				posts().every((item) => item.stream === true),
				'Native generation must exercise the provider streaming transport'
			);
			assert.deepEqual(
				Object.fromEntries(managedPaths.map((path) => [path, digest(path)])),
				beforeHashes
			);
			stages.push(
				'endpoint disabled non-destructively; auth-only removal exact; separate auth preserved; re-enable works; current default protected; managed policy bytes unchanged'
			);
			await verifyNativeGuardian(home, `http://127.0.0.1:${config.assistant.port}`, root);
			stages.push(
				'real native Guardian MCP two-turn completion, cross-credential denial, chat/read permissions, question/approval replies and tool-free moderation'
			);
			const currentContainer = (
				await execute('docker', [...composeArgs, 'ps', '--quiet', 'assistant'])
			).stdout.trim();
			await execute('docker', [
				'exec',
				currentContainer,
				'fhold-task',
				'create',
				'native-qa',
				'--schedule',
				'0 0 1 1 *',
				'--prompt',
				'Return the readiness marker.'
			]);
			await execute('docker', ['exec', currentContainer, 'fhold-task', 'run', 'native-qa'], {
				timeout: 60000
			});
			const history = await execute('docker', [
				'exec',
				currentContainer,
				'fhold-task',
				'history',
				'native-qa'
			]);
			const runRecord = JSON.parse(history.stdout).rows[0];
			assert.equal(runRecord.status, 'completed');
			assert.match(runRecord.log, /^\/opt\/akm\/cache\/tasks\/logs\/native-qa\//);
			assert.match(
				(await execute('docker', ['exec', currentContainer, 'cat', runRecord.log])).stdout,
				/FH_READY/
			);
			stages.push(
				'scheduled profile attached to the native server and retained a real task result in AKM history'
			);
			await syncRequests();
			const finalAuthIds = await authIds();
			await run(['stop']);
			const portable = join(root, 'compiled-portable');
			await run(['backup', '--to', portable, '--include-provider-auth']);
			assert(
				existsSync(join(portable, 'knowledge/secrets/opencode-credentials.json')),
				'Compiled CLI must execute the native credential worker'
			);
			const archive = join(root, 'compiled-history');
			await run(['history', 'export', '--from', home, '--image', image, '--to', archive]);
			assert.equal(JSON.parse(readFileSync(join(archive, 'history.json'), 'utf8')).version, 2);
			stages.push(
				'compiled CLI successfully exported native credentials and v2 history through isolated workers'
			);
			writeFileSync(
				join(root, 'report.json'),
				JSON.stringify(
					{
						ok: true,
						home,
						url,
						image,
						cliSha256: digest(cli),
						testSha256: digest(import.meta.path),
						stages,
						commands,
						requests,
						mounts,
						identities,
						currentModel: afterRestart.currentModel,
						authIds: finalAuthIds,
						managedHashes: beforeHashes,
						evidence:
							'Published shipped Assistant native API+SDK with controlled OpenAI-compatible responses. Actual Ollama/LM Studio/llama.cpp products and vendor entitlement are not claimed.'
					},
					null,
					2
				)
			);
			console.info('Native provider acceptance PASS:', join(root, 'report.json'));
		} catch (error) {
			writeFileSync(
				join(root, 'failure.json'),
				JSON.stringify(
					{ error: String(error), stages, commands, requests, mounts, identities },
					null,
					2
				)
			);
			primaryError = error;
		} finally {
			// Remove only the container returned by our own run before Compose removes its network.
			if (fixtureId) {
				try {
					await execute('docker', ['rm', '--force', fixtureId]);
				} catch (error) {
					cleanupErrors.push(error);
				}
			}
			if (started) {
				try {
					await run(['stop']);
				} catch (error) {
					cleanupErrors.push(error);
				}
			}
			// Generated fixture home and reports deliberately stay available for review.
			writeFileSync(join(root, 'commands.json'), JSON.stringify(commands, null, 2));
		}
		if (primaryError && cleanupErrors.length)
			throw new AggregateError([primaryError, ...cleanupErrors], 'Regression and cleanup failed');
		if (primaryError) throw primaryError;
		if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Isolated cleanup failed');
	},
	180_000
);

import { defineCommand } from 'citty';
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import {
	beginRemoteEnable,
	disableRemote,
	isCodexSandbox,
	remoteBrowserUrls,
	remoteTool,
	buildComposeCliArgs,
	buildComposeOptions,
	composePs,
	parseComposePsRows,
	createFholdState,
	readStackConfig,
	requireInstall,
	runComposeStreaming
} from '@fhold/lib';
import { reviewCodexRecall, changeCodexRecall } from '@fhold/lib';
import type { CodexSandbox, CodexRecallReview } from '@fhold/lib';

import { defineAction } from '../lib/action.js';
import { runStartAction } from './lifecycle.js';

export function describeRecall(review: CodexRecallReview): string {
	return (
		'Automatic knowledge recall: AKM runs local commands when a Codex session starts and before each prompt. It searches your configured knowledge bundles and adds relevant context to Codex. Your prompt is passed to AKM; configured search/embedding endpoints may be contacted. This does not grant tool permissions or enable automatic memory writes.\n' +
		review.hooks
			.map(
				(h) =>
					`${h.event} (${h.trust}${h.enabled ? '' : ', off'})\n  ${h.command}\n  Definition: ${h.sourcePath}`
			)
			.join('\n')
	);
}

async function guideRecall(
	reader: ReturnType<typeof createInterface>,
	homeDir?: string
): Promise<void> {
	const state = createFholdState(homeDir);
	const review = await reviewCodexRecall(state);
	if (review.managed) {
		console.log(
			`Automatic knowledge recall: Managed (${review.status === 'ready' ? 'ready' : 'not fully enabled'}). No personal hook approval is required.`
		);
		if (review.status !== 'ready')
			console.log(
				'Review config/codex/requirements.toml in the instance directory to enable all AKM hooks.'
			);
		return;
	}
	if (review.status === 'ready') {
		console.log('Automatic knowledge recall: Ready (previous approval retained).');
		return;
	}
	console.log(describeRecall(review));
	if (
		/^y(es)?$/i.test(
			(await reader.question('Enable automatic knowledge recall with these hooks? [y/N] ')).trim()
		)
	) {
		const result = await changeCodexRecall(state, 'approve', review.digest, true);
		if (result.status !== 'ready') throw new Error('Native hook approval did not become ready.');
		console.log(
			'Automatic knowledge recall: Ready. Approval applies to new sessions and survives restarts. Changed definitions require another review.'
		);
	} else
		console.log('Knowledge recall approval skipped. Your previous native decision is unchanged.');
}

export async function enableRemote(
	toolValue: unknown,
	options: { homeDir?: string; trust?: boolean; browser?: boolean; sandbox?: string } = {}
): Promise<void> {
	const tool = remoteTool(toolValue);
	if (options.sandbox !== undefined && !isCodexSandbox(options.sandbox))
		throw new Error(
			'Choose workspace-write, read-only, or explicit danger-full-access container isolation.'
		);
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		throw new Error(
			'Guided remote enable needs an interactive terminal. Use fhold Admin for browser-based setup.'
		);
	const reader = createInterface({ input: process.stdin, output: process.stdout });
	try {
		console.log(
			'Experimental: this enables a separate native coding agent with trusted workspace and knowledge access, bypassing Guardian. Host and account support vary. Your OpenCode provider login is not reused.'
		);
		if (tool === 'codex' && options.sandbox === 'danger-full-access')
			console.log(
				'Container isolation: Codex can access all files, credentials and network available inside Assistant. There is no inner filesystem/network sandbox. Task permissions follow the instance policy. Use only when this container is your intended isolation boundary.'
			);
		if (
			!options.trust &&
			!/^y(es)?$/i.test(
				(await reader.question('Continue with trusted native access? [y/N] ')).trim()
			)
		)
			return;
		console.log(
			'Follow the native sign-in prompts. Browser links open automatically when a desktop is available. Trust and consent require your answers; Ctrl+C cancels.'
		);
		if (tool === 'codex') {
			await runStartAction(options.homeDir);
			await guideRecall(reader, options.homeDir);
		}
		const opened = new Set<string>();
		let displayed = '';
		let stage = '';
		const session = await beginRemoteEnable(createFholdState(options.homeDir), tool, {
			trusted: true,
			sandbox: options.sandbox as CodexSandbox | undefined,
			update(progress) {
				if (progress.stage !== stage) {
					stage = progress.stage;
					console.log(`\nRemote setup: ${stage}`);
				}
				if (progress.output !== displayed) {
					process.stdout.write(
						progress.output.startsWith(displayed)
							? progress.output.slice(displayed.length)
							: progress.output
					);
					displayed = progress.output;
				}
				if (options.browser === false) return;
				for (const url of remoteBrowserUrls(progress.output)) {
					if (opened.has(url)) continue;
					opened.add(url);
					const [binary, ...args] =
						process.platform === 'darwin'
							? ['open', url]
							: process.platform === 'win32'
								? ['rundll32.exe', 'url.dll,FileProtocolHandler', url]
								: ['xdg-open', url];
					execFile(binary, args, { timeout: 10_000 }, (error) => {
						if (error) console.log('Open the native sign-in link above in your browser.');
					});
				}
			}
		});
		const input = (line: string) => {
			try {
				session.input(line);
			} catch (error) {
				console.error(error instanceof Error ? error.message : String(error));
			}
		};
		const cancel = () => session.cancel();
		reader.on('line', input);
		reader.on('SIGINT', cancel);
		reader.on('close', cancel);
		try {
			const result = await session.done;
			if (result.error) throw new Error(result.error);
			console.log(
				`\n${tool} remote startup enabled. Pairing details are above; use a supported client and verify a real tool request. To refresh: fhold remote pair ${tool}.`
			);
		} finally {
			reader.off('line', input);
			reader.off('SIGINT', cancel);
			reader.off('close', cancel);
		}
	} finally {
		reader.close();
	}
}

const enable = defineCommand({
	meta: {
		name: 'enable',
		description: 'Guide experimental native sign-in, trust, sandbox checks, and remote startup'
	},
	args: {
		tool: { type: 'positional', required: true, description: 'codex or claude' },
		trust: {
			type: 'boolean',
			default: false,
			description: 'Confirm trusted native workspace access (vendor consent still required)'
		},
		browser: {
			type: 'boolean',
			default: true,
			description: 'Open native sign-in links (use --no-browser over SSH)'
		},
		sandbox: {
			type: 'string',
			description:
				'Codex: workspace-write (default), read-only, or explicit danger-full-access container isolation; retains on-request approvals'
		}
	},
	run: defineAction(async ({ args }) =>
		enableRemote(args.tool, { trust: args.trust, browser: args.browser, sandbox: args.sandbox })
	)
});

const disable = defineCommand({
	meta: {
		name: 'disable',
		description: 'Stop native remote startup without removing account state'
	},
	args: { tool: { type: 'positional', required: true, description: 'codex or claude' } },
	run: defineAction(async ({ args }) => {
		await disableRemote(createFholdState(), args.tool);
		console.log(
			'Remote startup disabled. Account state is retained; revoke devices through the vendor.'
		);
	})
});

const recall = defineCommand({
	meta: {
		name: 'recall',
		description: 'Review and approve Codex automatic knowledge recall using native hook trust'
	},
	args: {
		tool: { type: 'positional', required: true, description: 'codex' },
		status: {
			type: 'boolean',
			default: false,
			description: 'Print current native hook review as JSON (read-only)'
		},
		approve: {
			type: 'boolean',
			default: false,
			description: 'Explicitly approve the exact --review digest'
		},
		review: {
			type: 'string',
			description: 'Current digest returned by --status; changes invalidate approval'
		},
		off: {
			type: 'boolean',
			default: false,
			description: 'Disable the exact reviewed hooks; requires --review'
		}
	},
	run: defineAction(async ({ args }) => {
		if (args.tool !== 'codex') throw new Error('Knowledge hook review is for codex.');
		if ((args.approve && args.off) || (args.status && (args.approve || args.off)))
			throw new Error('Choose status, approve, or off.');
		const state = createFholdState();
		if (args.approve || args.off) {
			console.log(
				JSON.stringify(
					await changeCodexRecall(state, args.off ? 'disable' : 'approve', args.review ?? '', true),
					null,
					2
				)
			);
		} else if (args.status) console.log(JSON.stringify(await reviewCodexRecall(state), null, 2));
		else {
			if (!process.stdin.isTTY || !process.stdout.isTTY)
				throw new Error(
					'Use Admin or --status, then --approve --review DIGEST after reviewing the hooks.'
				);
			await runStartAction();
			const reader = createInterface({ input: process.stdin, output: process.stdout });
			try {
				await guideRecall(reader);
			} finally {
				reader.close();
			}
		}
	})
});

export function remoteExecArguments(action: string, tool: string): string[] {
	if (tool !== 'codex' && tool !== 'claude') throw new Error('Choose codex or claude.');
	if (action === 'setup')
		return tool === 'codex' ? ['codex', 'login', '--device-auth'] : ['claude'];
	if (action === 'pair')
		return tool === 'codex'
			? ['codex', 'remote-control', 'pair', '--json']
			: ['fhold-remote', 'claude', 'logs'];
	if (action === 'status') return ['fhold-remote', tool, 'status'];
	if (action === 'logs') return ['fhold-remote', tool, 'logs'];
	throw new Error('Choose setup, pair, status, or logs.');
}

function command(action: 'setup' | 'pair' | 'status' | 'logs') {
	return defineCommand({
		meta: {
			name: action,
			description: `${action} an experimental vendor-native remote coding agent (not Guardian MCP)`
		},
		args: { tool: { type: 'positional', required: true, description: 'codex or claude' } },
		run: defineAction(async ({ args }) => {
			const tool = String(args.tool);
			const nativeArgs = remoteExecArguments(action, tool);
			const state = createFholdState();
			requireInstall(state.homeDir);
			const parsed = readStackConfig(state.homeDir);
			if (!parsed.ok) throw new Error(parsed.error);
			const enabled =
				tool === 'codex'
					? parsed.config.assistant.codexRemote
					: parsed.config.assistant.claudeRemote;
			if (action === 'setup') {
				if (enabled)
					throw new Error(
						`Disable startup first: fhold remote disable ${tool}. This avoids competing sign-in and background sessions.`
					);
				if (!process.stdin.isTTY || !process.stdout.isTTY)
					throw new Error(
						'Remote setup needs an interactive terminal for native sign-in and consent.'
					);
				console.log(
					'Experimental: this grants trusted native workspace access, bypassing Guardian. Host and account support vary. Your OpenCode provider login is not reused.'
				);
				if (tool === 'claude')
					console.log(
						'In Claude Code: accept workspace trust, use /login with an eligible subscription, then /remote-control and approve its consent prompt. Use /exit when done. fhold never accepts these prompts for you.'
					);
			} else if (!enabled && action === 'status') {
				console.log(JSON.stringify({ tool, state: 'disabled' }));
				return;
			} else if (!enabled)
				throw new Error(`Remote startup is disabled. Run fhold remote enable ${tool}.`);
			if (action === 'status' || action === 'logs') {
				const ps = await composePs(buildComposeOptions(state));
				if (!ps.ok)
					throw new Error(ps.stderr || 'Could not inspect Assistant; check Docker availability.');
				if (
					!parseComposePsRows(ps.stdout).some(
						(row) => row.service === 'assistant' && row.state === 'running'
					)
				) {
					console.log(
						JSON.stringify({
							tool,
							enabled: true,
							state: 'stopped',
							note: 'Assistant is stopped. Run fhold start explicitly to inspect the native worker.'
						})
					);
					return;
				}
			} else await runStartAction();
			if (action === 'setup' && tool === 'codex') {
				const reader = createInterface({ input: process.stdin, output: process.stdout });
				try {
					await guideRecall(reader);
				} finally {
					reader.close();
				}
			}
			await runComposeStreaming(
				[
					...buildComposeCliArgs(state),
					'exec',
					...(action === 'setup' ? [] : ['-T']),
					'--workdir',
					'/work',
					'assistant',
					...nativeArgs
				],
				{ envFiles: [`${state.homeDir}/state/stack.env`] }
			);
			if (action === 'setup') console.log(`Enable startup when ready: fhold remote enable ${tool}`);
			if (action === 'pair' || action === 'logs')
				console.log(
					'Treat pairing codes and connection links as private. A link or running process is not proof that your client has connected.'
				);
			if (action === 'status')
				console.log(
					'process-running reports the local process only, not vendor connection readiness. If waiting-to-retry, inspect fhold remote logs ' +
						tool +
						' or repeat setup after disabling startup.'
				);
		})
	});
}

export default defineCommand({
	meta: {
		name: 'remote',
		description: 'Set up experimental native Codex / Claude Code remote sessions'
	},
	subCommands: {
		enable,
		disable,
		recall,
		setup: command('setup'),
		pair: command('pair'),
		status: command('status'),
		logs: command('logs')
	}
});

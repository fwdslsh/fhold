import {
	createMcpHandler,
	McpServer,
	ResourceTemplate,
	type CallToolResult,
	type McpHttpHandler,
	type ServerContext
} from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { AuthenticatedCredential, CredentialClass } from './credentials.js';
import {
	GatewayError,
	GatewayService,
	type AgentProgress,
	type GatewayServiceOptions
} from './gateway-service.js';
import { createLogger } from './logger.js';

const logger = createLogger('guardian:mcp');
const HANDLE = z.string().min(1).max(4_096);
const PUBLIC_SESSION = z
	.object({
		handle: z.string(),
		title: z.string(),
		createdAt: z.number(),
		updatedAt: z.number(),
		status: z.enum(['idle', 'busy', 'retry']),
		parent: z.string().optional(),
		summary: z
			.object({ additions: z.number(), deletions: z.number(), files: z.number() })
			.strict()
			.optional()
	})
	.strict();
const PUBLIC_MESSAGE = z
	.object({
		handle: z.string(),
		role: z.enum(['user', 'assistant']),
		createdAt: z.number(),
		completedAt: z.number().optional(),
		text: z.string(),
		files: z.array(z.string()),
		error: z.string().optional(),
		cost: z.number().optional(),
		tokens: z
			.object({
				total: z.number().optional(),
				input: z.number(),
				output: z.number(),
				reasoning: z.number(),
				cache: z.object({ read: z.number(), write: z.number() }).strict()
			})
			.strict()
			.optional()
	})
	.strict();
const PUBLIC_DIFF = z
	.object({
		file: z.string(),
		additions: z.number(),
		deletions: z.number(),
		status: z.enum(['added', 'deleted', 'modified']).optional()
	})
	.strict();
const PUBLIC_SESSION_DETAIL = PUBLIC_SESSION.extend({
	messages: z.array(PUBLIC_MESSAGE).optional(),
	diff: z.array(PUBLIC_DIFF).optional()
}).strict();
const QUESTION = z
	.object({
		header: z.string(),
		question: z.string(),
		options: z.array(z.object({ label: z.string(), description: z.string() }).strict()),
		multiple: z.boolean().optional(),
		custom: z.boolean().optional()
	})
	.strict();
const INTERACTION = z.discriminatedUnion('kind', [
	z
		.object({ kind: z.literal('question'), handle: z.string(), questions: z.array(QUESTION) })
		.strict(),
	z
		.object({
			kind: z.literal('permission'),
			handle: z.string(),
			permission: z.string(),
			patterns: z.array(z.string()),
			allowedDecisions: z.array(z.enum(['once', 'always', 'reject']))
		})
		.strict()
]);
const AGENT_RESULT = z
	.object({
		status: z.enum(['completed', 'running', 'input_required', 'failed']),
		session: z.string(),
		job: z.string(),
		text: z.string().optional(),
		tools: z
			.array(
				z
					.object({
						name: z.string(),
						status: z.enum(['pending', 'running', 'completed', 'error'])
					})
					.strict()
			)
			.optional(),
		error: z.string().optional(),
		interactions: z.array(INTERACTION).optional(),
		changedFiles: z.array(z.string()).optional(),
		usage: z
			.object({
				cost: z.number().optional(),
				inputTokens: z.number(),
				outputTokens: z.number(),
				reasoningTokens: z.number(),
				cacheReadTokens: z.number(),
				cacheWriteTokens: z.number()
			})
			.strict()
			.optional()
	})
	.strict();

export type McpAgentOptions = GatewayServiceOptions & {
	service?: GatewayService;
};

function asStructured(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: { result: value };
}

function result(value: unknown, text?: string): CallToolResult {
	const structuredContent = asStructured(value);
	return {
		content: [
			{
				type: 'text',
				text: text ?? JSON.stringify(structuredContent)
			}
		],
		structuredContent
	};
}

function errorResult(error: unknown): CallToolResult {
	const message =
		error instanceof GatewayError ? error.message : 'Guardian could not complete the request.';
	if (!(error instanceof GatewayError)) {
		logger.error('tool_failed', {
			error: error instanceof Error ? error.message : String(error)
		});
	}
	return { content: [{ type: 'text', text: message }], isError: true };
}

function guarded<Args>(
	callback: (args: Args, context: ServerContext) => Promise<CallToolResult>
): (args: Args, context: ServerContext) => Promise<CallToolResult> {
	return async (args, context) => {
		try {
			return await callback(args, context);
		} catch (error) {
			return errorResult(error);
		}
	};
}

function progress(context: ServerContext): AgentProgress {
	let sequence = 0;
	return async (_value, message, output) => {
		const progressToken = context.mcpReq._meta?.progressToken;
		if (progressToken === undefined) return;
		await context.mcpReq
			.notify({
				method: 'notifications/progress',
				params: {
					progressToken,
					progress: ++sequence,
					message,
					...(output ? { _meta: { 'io.fwdslsh.fhold/agent': output } } : {})
				}
			})
			.catch(() => {});
	};
}

function variable(value: string | string[] | undefined): string {
	if (Array.isArray(value)) return value.join('/');
	return value ?? '';
}

async function resourceValue<T>(callback: () => Promise<T>): Promise<T> {
	try {
		return await callback();
	} catch (error) {
		throw new Error(
			error instanceof GatewayError ? error.message : 'Guardian could not read the resource.'
		);
	}
}

function registerTools(server: McpServer, service: GatewayService): void {
	server.registerTool(
		'fhold.agent.run',
		{
			title: 'Run fhold agent',
			description:
				'Start or continue guarded agent work. Returns a result immediately when possible, otherwise an opaque resumable job handle.',
			inputSchema: z
				.object({
					message: z.string().min(1).max(32_000),
					session: HANDLE.optional().describe('Opaque session handle from an earlier result.'),
					title: z.string().min(1).max(160).optional(),
					waitMs: z.number().int().min(0).max(30_000).optional()
				})
				.strict(),
			outputSchema: AGENT_RESULT,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: service.policy === 'full'
			}
		},
		guarded(async (input, context) => {
			const output = await service.run(input, context.mcpReq.signal, progress(context));
			return result(output, output.text ?? `Agent status: ${output.status}`);
		})
	);

	server.registerTool(
		'fhold.job.get',
		{
			title: 'Get agent job',
			description: 'Poll a guarded agent job and retrieve output or pending interactions.',
			inputSchema: z
				.object({
					job: HANDLE,
					waitMs: z.number().int().min(0).max(30_000).optional()
				})
				.strict(),
			outputSchema: AGENT_RESULT,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false
			}
		},
		guarded(async (input, context) => {
			const output = await service.getJob(
				input.job,
				input.waitMs,
				context.mcpReq.signal,
				progress(context)
			);
			return result(output, output.text ?? `Agent status: ${output.status}`);
		})
	);

	server.registerTool(
		'fhold.job.cancel',
		{
			title: 'Cancel agent job',
			description: 'Abort the active OpenCode run associated with an opaque job handle.',
			inputSchema: z.object({ job: HANDLE }).strict(),
			outputSchema: z
				.object({ status: z.literal('cancelled'), session: z.string(), job: z.string() })
				.strict(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: false
			}
		},
		guarded(async (input, context) =>
			result(await service.cancelJob(input.job, context.mcpReq.signal), 'Agent job cancelled.')
		)
	);

	server.registerTool(
		'fhold.session.list',
		{
			title: 'List agent sessions',
			description: 'List only sessions owned by the authenticated Guardian credential class.',
			inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }).strict(),
			outputSchema: z.object({ sessions: z.array(PUBLIC_SESSION) }).strict(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false
			}
		},
		guarded(async (input, context) =>
			result({ sessions: await service.listSessions(input.limit, context.mcpReq.signal) })
		)
	);

	server.registerTool(
		'fhold.session.get',
		{
			title: 'Get agent session',
			description:
				'Get status and metadata for an owned session, optionally including history and changed-file summaries.',
			inputSchema: z
				.object({
					session: HANDLE,
					include: z
						.array(z.enum(['messages', 'diff']))
						.max(3)
						.optional()
				})
				.strict(),
			outputSchema: PUBLIC_SESSION_DETAIL,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false
			}
		},
		guarded(async (input, context) =>
			result(await service.getSession(input.session, input.include ?? [], context.mcpReq.signal))
		)
	);

	if (service.policy === 'full') {
		server.registerTool(
			'fhold.session.fork',
			{
				title: 'Fork agent session',
				description: 'Create an independently resumable copy of an owned session.',
				inputSchema: z
					.object({
						session: HANDLE,
						message: HANDLE.optional().describe('Opaque message handle to fork after.')
					})
					.strict(),
				outputSchema: PUBLIC_SESSION,
				annotations: {
					readOnlyHint: false,
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: false
				}
			},
			guarded(async (input, context) =>
				result(await service.forkSession(input.session, input.message, context.mcpReq.signal))
			)
		);

		server.registerTool(
			'fhold.session.delete',
			{
				title: 'Delete agent session',
				description: 'Permanently delete an owned OpenCode session and its history.',
				inputSchema: z.object({ session: HANDLE }).strict(),
				outputSchema: z.object({ deleted: z.literal(true) }).strict(),
				annotations: {
					readOnlyHint: false,
					destructiveHint: true,
					idempotentHint: true,
					openWorldHint: false
				}
			},
			guarded(async (input, context) =>
				result(
					await service.deleteSession(input.session, context.mcpReq.signal),
					'Session deleted.'
				)
			)
		);
	}

	if (service.policy === 'read' || service.policy === 'full') {
		server.registerTool(
			'fhold.workspace.search',
			{
				title: 'Search workspace',
				description:
					'Search non-secret workspace files by file name or text pattern.',
				inputSchema: z
					.object({
						mode: z.enum(['files', 'text']),
						query: z.string().min(1).max(500),
						limit: z.number().int().min(1).max(100).optional()
					})
					.strict(),
				outputSchema: z.discriminatedUnion('mode', [
					z.object({ mode: z.literal('files'), files: z.array(z.string()) }).strict(),
					z
						.object({
							mode: z.literal('text'),
							matches: z.array(
								z.object({ path: z.string(), line: z.number(), text: z.string() }).strict()
							)
						})
						.strict()
				]),
				annotations: {
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false
				}
			},
			guarded(async (input, context) =>
				result(
					await service.workspaceSearch(input.mode, input.query, input.limit, context.mcpReq.signal)
				)
			)
		);

		server.registerTool(
			'fhold.workspace.read',
			{
				title: 'Read workspace file',
				description:
					'Read a bounded non-secret text file from the Assistant workspace using a relative path.',
				inputSchema: z.object({ path: z.string().min(1).max(1_024) }).strict(),
				outputSchema: z
					.object({
						path: z.string(),
						text: z.string(),
						mimeType: z.string(),
						truncated: z.boolean()
					})
					.strict(),
				annotations: {
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false
				}
			},
			guarded(async (input, context) => {
				const output = await service.workspaceRead(input.path, context.mcpReq.signal);
				return result(output, output.text);
			})
		);
	}

	server.registerTool(
		'fhold.interaction.respond',
		{
			title: 'Respond to agent interaction',
			description:
				'Answer an agent question or respond to an explicit permission request. Non-full policies may only reject permissions.',
			inputSchema: z
				.object({
					interaction: HANDLE,
					decision: z.enum(['once', 'always', 'reject']).optional(),
					answers: z
						.array(z.array(z.string().min(1).max(2_000)).min(1).max(20))
						.min(1)
						.max(20)
						.optional(),
					message: z.string().max(1_000).optional()
				})
				.strict(),
			outputSchema: z
				.object({ accepted: z.literal(true), kind: z.enum(['question', 'permission']) })
				.strict(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false
			}
		},
		guarded(async (input, context) =>
			result(
				await service.respondInteraction(input, context.mcpReq.signal),
				'Interaction response accepted.'
			)
		)
	);
}

function registerResources(server: McpServer, service: GatewayService): void {
	if (service.policy === 'read' || service.policy === 'full') {
		server.registerResource(
			'fhold-workspace-file',
			new ResourceTemplate('fhold://workspace/{+path}', { list: undefined }),
			{
				title: 'fhold workspace file',
				description: 'A bounded non-secret text file in the Assistant workspace.',
				mimeType: 'text/plain'
			},
			async (uri, variables, context) => {
				const file = await resourceValue(() =>
					service.workspaceRead(variable(variables.path), context.mcpReq.signal)
				);
				return {
					contents: [
						{
							uri: uri.href,
							mimeType: file.mimeType,
							text: file.truncated ? `${file.text}\n\n[truncated by Guardian]` : file.text
						}
					]
				};
			}
		);
	}
}

function createServer(service: GatewayService): McpServer {
	const server = new McpServer(
		{ name: 'fhold-guardian', version: Bun.env.GUARDIAN_VERSION ?? 'dev' },
		{
			capabilities: {
				tools: { listChanged: false },
				resources: { subscribe: false, listChanged: false }
			}
		}
	);
	registerTools(server, service);
	registerResources(server, service);
	return server;
}

export function createMcpAgentServer(
	principal: CredentialClass | AuthenticatedCredential,
	options: McpAgentOptions = {}
): McpServer {
	const identity = typeof principal === 'string' ? { id: principal } : principal;
	return createServer(
		options.service ??
			new GatewayService(identity.id, {
				...options,
				...(typeof principal === 'string'
					? {}
					: { policy: principal.policy, username: principal.username })
			})
	);
}

export function createMcpAgentHandler(
	principal: CredentialClass | AuthenticatedCredential,
	options: McpAgentOptions = {}
): McpHttpHandler {
	const identity = typeof principal === 'string' ? { id: principal } : principal;
	const service =
		options.service ??
		new GatewayService(identity.id, {
			...options,
			...(typeof principal === 'string'
				? {}
				: { policy: principal.policy, username: principal.username })
		});
	return createMcpHandler(() => createServer(service), {
		legacy: 'stateless',
		responseMode: 'auto',
		onerror(error) {
			logger.error('protocol_failed', { principal: identity.id, error: error.message });
		}
	});
}

import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
	OpenCode,
	type SessionInfo,
	type SessionMessageInfo,
	type FormField,
	type TokenUsageInfo,
	type JsonValue,
	type PermissionRuleset
} from '@opencode/client';

import { readTextBounded } from './http-util.js';

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_UPSTREAM_RESPONSE_BYTES = 16 * 1_024 * 1_024;
const MAX_MESSAGE_TEXT = 256 * 1_024;
const MAX_MESSAGE_FILES = 100;

export type AssistantSession = {
	id: string;
	title: string;
	parentId?: string;
	agent?: string;
	metadata?: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
	cost?: number;
	tokens?: TokenUsageInfo;
};

export type AssistantMessage = {
	id: string;
	role: 'user' | 'assistant';
	parentId?: string;
	createdAt: number;
	completedAt?: number;
	finish?: string;
	text: string;
	files: string[];
	tools?: Array<{ name: string; status: 'pending' | 'running' | 'completed' | 'error' }>;
	error?: string;
	cost?: number;
	tokens?: TokenUsageInfo;
};

export type AssistantQuestion = {
	id: string;
	sessionId: string;
	messageId?: string;
	questions: Array<{
		header: string;
		question: string;
		options: Array<{ label: string; description: string }>;
		multiple?: boolean;
		custom?: boolean;
	}>;
};

export type AssistantPermission = {
	id: string;
	sessionId: string;
	messageId?: string;
	permission: string;
	patterns: string[];
	always: string[];
};

export type WorkspaceTextMatch = {
	path: string;
	line: number;
	text: string;
};

export type SessionStatus = { type: 'idle' | 'busy' | 'retry' };
export type SnapshotFileDiff = {
	file: string;
	additions: number;
	deletions: number;
	status?: 'added' | 'deleted' | 'modified';
};

export interface AssistantClient {
	listSessions(limit: number, signal: AbortSignal): Promise<AssistantSession[]>;
	createSession(title: string, agent: string, signal: AbortSignal): Promise<AssistantSession>;
	getSession(sessionId: string, signal: AbortSignal): Promise<AssistantSession>;
	setSessionMetadata(
		sessionId: string,
		metadata: Record<string, unknown>,
		signal: AbortSignal
	): Promise<AssistantSession>;
	deleteSession(sessionId: string, signal: AbortSignal): Promise<void>;
	forkSession(
		sessionId: string,
		messageId: string | undefined,
		signal: AbortSignal
	): Promise<AssistantSession>;
	listMessages(sessionId: string, limit: number, signal: AbortSignal): Promise<AssistantMessage[]>;
	sessionStatus(sessionId: string, signal: AbortSignal): Promise<SessionStatus>;
	sessionDiff(sessionId: string, signal: AbortSignal): Promise<SnapshotFileDiff[]>;
	runAsync(
		sessionId: string,
		messageId: string,
		message: string,
		agent: string,
		signal: AbortSignal
	): Promise<void>;
	abortSession(sessionId: string, signal: AbortSignal): Promise<void>;
	pendingQuestions(sessionId: string, signal: AbortSignal): Promise<AssistantQuestion[]>;
	pendingPermissions(sessionId: string, signal: AbortSignal): Promise<AssistantPermission[]>;
	answerQuestion(
		sessionId: string,
		requestId: string,
		answers: string[][],
		signal: AbortSignal
	): Promise<void>;
	rejectQuestion(sessionId: string, requestId: string, signal: AbortSignal): Promise<void>;
	answerPermission(
		sessionId: string,
		requestId: string,
		decision: 'once' | 'always' | 'reject',
		message: string | undefined,
		signal: AbortSignal
	): Promise<void>;
	findText(pattern: string, signal: AbortSignal): Promise<WorkspaceTextMatch[]>;
	findFiles(query: string, limit: number, signal: AbortSignal): Promise<string[]>;
}

export type AssistantClientOptions = {
	baseUrl?: string;
	directory?: string;
	passwordFile?: string;
	username?: string;
	timeoutMs?: number;
	fetch?: typeof fetch;
};

function boundedInt(value: string | undefined, fallback: number, maximum: number): number {
	const parsed = Number.parseInt(value ?? '', 10);
	return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function requireSessionId(sessionId: string): void {
	if (!SESSION_ID_RE.test(sessionId)) throw new Error('invalid assistant session id');
}

function readPassword(path: string): string {
	if (!path) throw new Error('assistant credential is not configured');
	let password: string;
	try {
		password = readFileSync(path, 'utf8').replace(/[\r\n]+$/, '');
	} catch {
		throw new Error('assistant credential is unavailable');
	}
	if (!password) throw new Error('assistant credential is empty');
	return password;
}

function normalizedSession(session: SessionInfo): AssistantSession {
	return {
		id: session.id,
		title: (session.title ?? 'Untitled session').slice(0, 160),
		...(session.parentID ? { parentId: session.parentID } : {}),
		...(session.agent ? { agent: session.agent } : {}),
		...(session.metadata ? { metadata: session.metadata } : {}),
		createdAt: session.time.created,
		updatedAt: session.time.updated,
		...(session.cost === undefined ? {} : { cost: session.cost }),
		...(session.tokens ? { tokens: session.tokens } : {})
	};
}

function messageText(parts: Array<{ type: string; text?: string; ignored?: boolean }>): string {
	let output = '';
	for (const part of parts) {
		if (part.type !== 'text' || part.ignored || typeof part.text !== 'string') continue;
		const separator = output ? '\n' : '';
		const remaining = MAX_MESSAGE_TEXT - output.length - separator.length;
		if (remaining <= 0) break;
		output += separator + part.text.slice(0, remaining);
	}
	return output;
}

function normalizedMessages(messages: SessionMessageInfo[]): AssistantMessage[] {
	let parentId: string | undefined;
	return [...messages]
		.sort((a, b) => a.time.created - b.time.created)
		.flatMap<AssistantMessage>((message) => {
			if (message.type === 'user') {
				parentId = message.id;
				return [
					{
						id: message.id,
						role: 'user' as const,
						createdAt: message.time.created,
						text: message.text.slice(0, MAX_MESSAGE_TEXT),
						files: []
					}
				];
			}
			if (message.type !== 'assistant') return [];
			return [
				{
					id: message.id,
					role: 'assistant' as const,
					parentId,
					createdAt: message.time.created,
					...(message.time.completed ? { completedAt: message.time.completed } : {}),
					...(message.finish ? { finish: message.finish } : {}),
					text: messageText(message.content),
					files: [...new Set(message.snapshot?.files ?? [])].slice(0, MAX_MESSAGE_FILES),
					tools: message.content.flatMap((part) =>
						part.type === 'tool' && /^[A-Za-z0-9_.:-]{1,128}$/.test(part.name)
							? [
									{
										name: part.name,
										status:
											part.state.status === 'streaming' ? ('pending' as const) : part.state.status
									}
								]
							: []
					),
					...(message.error
						? { error: `${message.error.type}: ${message.error.message.slice(0, 500)}` }
						: {}),
					cost: message.cost,
					tokens: message.tokens
				}
			];
		});
}

function formQuestion(field: FormField): AssistantQuestion['questions'][number] {
	const options =
		field.type === 'string' || field.type === 'multiselect' ? (field.options ?? []) : [];
	return {
		header: field.title ?? field.key,
		question: field.description ?? field.title ?? field.key,
		options:
			field.type === 'boolean'
				? [
						{ label: 'Yes', description: '' },
						{ label: 'No', description: '' }
					]
				: options.map((item) => ({ label: item.label, description: item.description ?? '' })),
		multiple: field.type === 'multiselect',
		custom:
			field.type === 'string' || field.type === 'multiselect'
				? (field.custom ?? !options.length)
				: field.type !== 'boolean'
	};
}

function policyPermissions(agent: string): PermissionRuleset {
	if (agent === 'remote') return [{ action: '*', resource: '*', effect: 'deny' }];
	if (agent !== 'remote-read') return [];
	return [
		{ action: '*', resource: '*', effect: 'deny' },
		...['read', 'glob', 'list'].map((action) => ({
			action,
			resource: '*',
			effect: 'allow' as const
		})),
		{ action: 'external_directory', resource: '/work/*', effect: 'allow' },
		{ action: 'external_directory', resource: '/stash/*', effect: 'allow' },
		{ action: 'read', resource: '*.env', effect: 'deny' },
		{ action: 'read', resource: '*.env.*', effect: 'deny' },
		{ action: 'read', resource: '*.env.example', effect: 'allow' },
		...['/stash/secrets/*', '/stash/env/*'].flatMap((resource) => [
			{ action: 'read', resource, effect: 'deny' as const },
			{ action: 'external_directory', resource, effect: 'deny' as const }
		])
	];
}

function formAnswer(field: FormField, values: string[]): string | string[] | number | boolean {
	if (field.type === 'boolean') {
		if (!['Yes', 'No'].includes(values[0] ?? '')) throw new Error('Choose Yes or No.');
		return values[0] === 'Yes';
	}
	if (field.type === 'number' || field.type === 'integer') {
		const value = Number(values[0]);
		if (!Number.isFinite(value) || (field.type === 'integer' && !Number.isInteger(value)))
			throw new Error('Provide a valid number.');
		return value;
	}
	if (field.type === 'external')
		throw new Error('Complete this form using the native OpenCode client.');
	const answer = values.map(
		(value) => field.options?.find((option) => option.label === value)?.value ?? value
	);
	return field.type === 'multiselect' ? answer : (answer[0] ?? '');
}

function authenticatedFetch(
	baseFetch: typeof fetch,
	username: string,
	passwordFile: string,
	timeoutMs: number
): typeof fetch {
	const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const headers = new Headers(request.headers);
		const password = readPassword(passwordFile);
		headers.set(
			'authorization',
			`Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
		);
		const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
		const response = await baseFetch(new Request(request, { headers, signal }));
		if (!response.body) return response;
		const body = await readTextBounded(response, MAX_UPSTREAM_RESPONSE_BYTES);
		const responseHeaders = new Headers(response.headers);
		responseHeaders.delete('content-encoding');
		responseHeaders.delete('content-length');
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: responseHeaders
		});
	};
	return wrapped as typeof fetch;
}

export function createNativeClient(options: AssistantClientOptions = {}) {
	const baseUrl = (options.baseUrl ?? Bun.env.FH_ASSISTANT_URL ?? 'http://assistant:4096').replace(
		/\/+$/,
		''
	);
	const passwordFile = options.passwordFile ?? Bun.env.OPENCODE_SERVER_PASSWORD_FILE ?? '';
	const username = options.username ?? 'opencode';
	const timeoutMs =
		options.timeoutMs ?? boundedInt(Bun.env.GUARDIAN_ASSISTANT_TIMEOUT_MS, 120_000, 300_000);
	return OpenCode.make({
		baseUrl,
		fetch: authenticatedFetch(options.fetch ?? fetch, username, passwordFile, timeoutMs)
	});
}

export function createAssistantClient(options: AssistantClientOptions = {}): AssistantClient {
	const directory = options.directory ?? Bun.env.FH_ASSISTANT_DIRECTORY ?? '/work';
	const timeoutMs =
		options.timeoutMs ?? boundedInt(Bun.env.GUARDIAN_ASSISTANT_TIMEOUT_MS, 120_000, 300_000);
	const client = createNativeClient(options);
	const callOptions = (signal: AbortSignal) => ({ signal });
	const location = { directory };

	return {
		async listSessions(limit, signal) {
			const sessions: AssistantSession[] = [];
			let cursor: string | undefined;
			do {
				const response = await client.session.list(
					{
						directory,
						limit: Math.min(200, limit - sessions.length),
						...(cursor ? { cursor } : {})
					},
					callOptions(signal)
				);
				sessions.push(...response.data.map(normalizedSession));
				cursor = response.data.length ? (response.cursor.next ?? undefined) : undefined;
			} while (cursor && sessions.length < limit);
			return sessions;
		},

		async createSession(title, agent, signal) {
			// A credential's upper bound is session-owned, independent of editable
			// agent preferences and v1 permission state discarded by native migration.
			return normalizedSession(
				await client.session.create(
					{ title, agent, location, permissions: policyPermissions(agent) },
					callOptions(signal)
				)
			);
		},

		async getSession(sessionId, signal) {
			requireSessionId(sessionId);
			const response = await client.session.get({ sessionID: sessionId }, callOptions(signal));
			return normalizedSession(response);
		},

		async setSessionMetadata(sessionId, metadata, signal) {
			requireSessionId(sessionId);
			await client.session.update(
				{ sessionID: sessionId, metadata: metadata as Record<string, JsonValue> },
				callOptions(signal)
			);
			return normalizedSession(
				await client.session.get({ sessionID: sessionId }, callOptions(signal))
			);
		},

		async deleteSession(sessionId, signal) {
			requireSessionId(sessionId);
			await client.session.remove({ sessionID: sessionId }, callOptions(signal));
		},

		async forkSession(sessionId, messageId, signal) {
			requireSessionId(sessionId);
			const response = await client.session.fork(
				{ sessionID: sessionId, ...(messageId ? { before: messageId } : {}) },
				callOptions(signal)
			);
			return normalizedSession(response);
		},

		async listMessages(sessionId, limit, signal) {
			requireSessionId(sessionId);
			const response = await client.message.list(
				{ sessionID: sessionId, limit: Math.min(limit, 200), order: 'desc' },
				callOptions(signal)
			);
			return normalizedMessages(response.data);
		},

		async sessionStatus(sessionId, signal) {
			requireSessionId(sessionId);
			const response = await client.session.active(callOptions(signal));
			return { type: response[sessionId] ? 'busy' : 'idle' };
		},

		async sessionDiff(sessionId, signal) {
			requireSessionId(sessionId);
			const response = await client.session.diff({ sessionID: sessionId }, callOptions(signal));
			return response;
		},

		async runAsync(sessionId, messageId, message, agent, signal) {
			requireSessionId(sessionId);
			// Reapply the credential's current ceiling on every turn, including
			// sessions whose v1 permissions were reset by native database migration.
			await client.session.update(
				{ sessionID: sessionId, permissions: policyPermissions(agent) },
				callOptions(signal)
			);
			await client.session.switchAgent({ sessionID: sessionId, agent }, callOptions(signal));
			await client.session.prompt(
				{
					sessionID: sessionId,
					id: messageId,
					text: message,
					delivery: 'queue'
				},
				callOptions(signal)
			);
		},

		async abortSession(sessionId, signal) {
			requireSessionId(sessionId);
			await client.session.interrupt({ sessionID: sessionId }, callOptions(signal));
		},

		async pendingQuestions(sessionId, signal) {
			requireSessionId(sessionId);
			const response = await client.session.form.list(
				{ sessionID: sessionId },
				callOptions(signal)
			);
			return response.map((item) => ({
				id: item.id,
				sessionId: item.sessionID,
				questions: item.fields.map(formQuestion)
			}));
		},

		async pendingPermissions(sessionId, signal) {
			requireSessionId(sessionId);
			const response = await client.permission.list({ sessionID: sessionId }, callOptions(signal));
			return response.map((item) => ({
				id: item.id,
				sessionId: item.sessionID,
				...(item.source?.messageID ? { messageId: item.source.messageID } : {}),
				permission: item.action,
				patterns: item.resources,
				always: item.save ?? []
			}));
		},

		async answerQuestion(sessionId, requestId, answers, signal) {
			const form = await client.session.form.get(
				{ sessionID: sessionId, formID: requestId },
				callOptions(signal)
			);
			const answer = Object.fromEntries(
				form.fields.map((field, index) => [field.key, formAnswer(field, answers[index] ?? [])])
			);
			await client.session.form.reply(
				{ sessionID: sessionId, formID: requestId, answer },
				callOptions(signal)
			);
		},

		async rejectQuestion(sessionId, requestId, signal) {
			await client.session.form.cancel(
				{ sessionID: sessionId, formID: requestId },
				callOptions(signal)
			);
		},

		async answerPermission(sessionId, requestId, decision, message, signal) {
			await client.permission.reply(
				{ sessionID: sessionId, requestID: requestId, decision, ...(message ? { message } : {}) },
				callOptions(signal)
			);
		},

		async findText(pattern, signal) {
			// V2 has no text-search route. Search Guardian's read-only workspace;
			// Gateway still validates every result through its file boundary.
			let stdout: string;
			try {
				({ stdout } = await promisify(execFile)(
					'rg',
					['--json', '--max-count', '20', '--max-filesize', '1M', '--', pattern, directory],
					{ signal, timeout: timeoutMs, maxBuffer: MAX_UPSTREAM_RESPONSE_BYTES }
				));
			} catch (error) {
				if (error && typeof error === 'object' && 'code' in error && error.code === 1) return [];
				throw error;
			}
			return stdout
				.split('\n')
				.filter(Boolean)
				.flatMap((line) => {
					const value = JSON.parse(line) as {
						type: string;
						data: { path: { text: string }; line_number: number; lines: { text: string } };
					};
					return value.type === 'match'
						? [
								{
									path: value.data.path.text,
									line: value.data.line_number,
									text: value.data.lines.text.slice(0, 2_000)
								}
							]
						: [];
				});
		},

		async findFiles(query, limit, signal) {
			const response = await client.file.find(
				{ query, limit, type: 'file', location },
				callOptions(signal)
			);
			return response.data.map((entry) => entry.path);
		}
	};
}

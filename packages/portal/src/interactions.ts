import { randomUUID } from 'node:crypto';

import type { GuardianChatClient, ChatResult, PortalInteraction } from './chat-client.js';
import type { PortalCredential } from './credential-registry.js';

export type PendingPrompt = {
	id: string;
	key: string;
	user: string;
	username: string;
	job: string;
	interaction: PortalInteraction;
	questionIndex: number;
	answers: string[][];
	selected: Set<number>;
	busy: boolean;
	outcome?: 'answered' | 'cancelled';
	wake?: () => void;
};

export type PromptAction = { value: string; label: string; selected?: boolean; danger?: boolean };

export function promptView(prompt: PendingPrompt): { text: string; actions: PromptAction[] } {
	const interaction = prompt.interaction;
	if (interaction.kind === 'permission') {
		return {
			text: `Permission requested: ${interaction.permission}\n${interaction.patterns.join('\n')}\nOnly the person who requested this work can decide.`,
			actions: interaction.allowedDecisions.map((value) => ({
				value,
				label: value === 'once' ? 'Allow once' : value === 'always' ? 'Always allow' : 'Deny',
				danger: value === 'reject'
			}))
		};
	}
	const question = interaction.questions[prompt.questionIndex];
	const actions: PromptAction[] = question.options.map((option, index) => ({
		value: `option_${index}`,
		label: option.label,
		selected: prompt.selected.has(index)
	}));
	if (question.multiple) actions.push({ value: 'done', label: 'Continue' });
	actions.push({ value: 'reject', label: 'Cancel question', danger: true });
	return {
		text: `${interaction.questions.length > 1 ? `Question ${prompt.questionIndex + 1} of ${interaction.questions.length}\n` : ''}${question.question}${question.options.length ? `\n${question.options.map((option) => `${option.label}${option.description ? ` — ${option.description}` : ''}`).join('\n')}` : ''}${question.multiple ? '\nChoose one or more options, then Continue.' : ''}${question.custom !== false ? '\nYou can also reply in this thread with your own answer.' : ''}`,
		actions
	};
}

/** Platform actions carry a short local ID, never a Guardian handle/key.
 * Approval remains an explicit requester decision through Guardian MCP.
 */
export class PortalInteractions {
	private readonly prompts = new Map<string, PendingPrompt>();
	private readonly jobs = new Map<
		string,
		{ id: string; user: string; username: string; job: string; cancelled: boolean }
	>();

	constructor(private readonly chat: GuardianChatClient) {}

	open(
		key: string,
		user: string,
		credential: PortalCredential,
		result: ChatResult
	): PendingPrompt | undefined {
		const interaction = result.pending?.interactions[0];
		if (!interaction || !result.pending) return;
		const current = this.prompts.get(key);
		if (
			current &&
			JSON.stringify({ ...current.interaction, handle: '' }) ===
				JSON.stringify({ ...interaction, handle: '' })
		) {
			current.interaction = interaction;
			return current;
		}
		this.prompts.delete(key);
		const prompt: PendingPrompt = {
			id: randomUUID(),
			key,
			user,
			username: credential.username,
			job: result.pending.job,
			interaction,
			questionIndex: 0,
			answers: [],
			selected: new Set(),
			busy: false
		};
		this.prompts.set(key, prompt);
		return prompt;
	}

	forKey(key: string): PendingPrompt | undefined {
		return this.prompts.get(key);
	}

	async wait(prompt: PendingPrompt): Promise<'answered' | 'cancelled' | undefined> {
		if (prompt.outcome) return prompt.outcome;
		await new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				prompt.wake = undefined;
				resolve();
			};
			const timer = setTimeout(done, 2_000);
			prompt.wake = done;
		});
		return prompt.outcome;
	}

	working(key: string, user: string, credential: PortalCredential, job: string): string {
		const current = this.jobs.get(key);
		if (current?.job === job) return current.id;
		const entry = {
			id: randomUUID(),
			user,
			username: credential.username,
			job,
			cancelled: false
		};
		this.jobs.set(key, entry);
		return entry.id;
	}

	get(id: string, user: string, credential: PortalCredential, key: string): PendingPrompt {
		const prompt = this.prompts.get(key);
		if (!prompt || prompt.id !== id) throw new Error('This prompt is no longer active.');
		if (prompt.user !== user || prompt.username !== credential.username) {
			throw new Error('Only the person who requested this work can answer.');
		}
		if (prompt.busy) throw new Error('Your previous response is still being recorded.');
		return prompt;
	}

	async action(
		prompt: PendingPrompt,
		credential: PortalCredential,
		value: string
	): Promise<boolean> {
		this.get(prompt.id, prompt.user, credential, prompt.key);
		if (prompt.interaction.kind === 'permission' || value === 'reject') {
			if (value !== 'once' && value !== 'always' && value !== 'reject')
				throw new Error('Unknown decision.');
			if (
				prompt.interaction.kind === 'permission' &&
				!prompt.interaction.allowedDecisions.includes(value)
			) {
				throw new Error('This access policy does not allow that decision.');
			}
			return this.submit(prompt, credential, { decision: value });
		}
		const question = prompt.interaction.questions[prompt.questionIndex];
		if (value === 'done') {
			return this.answer(
				prompt,
				credential,
				[...prompt.selected].sort((a, b) => a - b).map((index) => question.options[index].label)
			);
		}
		if (!/^option_\d+$/.test(value)) throw new Error('Unknown answer.');
		const index = Number(value.slice(7));
		const option = question.options[index];
		if (!option) throw new Error('Unknown answer.');
		if (!question.multiple) return this.answer(prompt, credential, [option.label]);
		if (prompt.selected.has(index)) prompt.selected.delete(index);
		else prompt.selected.add(index);
		return false;
	}

	async answer(
		prompt: PendingPrompt,
		credential: PortalCredential,
		answer: string[]
	): Promise<boolean> {
		this.get(prompt.id, prompt.user, credential, prompt.key);
		if (prompt.interaction.kind !== 'question')
			throw new Error('Use the approval buttons to allow or deny this action.');
		const question = prompt.interaction.questions[prompt.questionIndex];
		if (!answer.length || answer.some((value) => !value.trim()))
			throw new Error('Choose an option or provide an answer.');
		if (!question.multiple && answer.length !== 1) throw new Error('Choose one answer.');
		if (
			question.custom === false &&
			answer.some((value) => !question.options.some((option) => option.label === value))
		) {
			throw new Error('Choose one of the listed options.');
		}
		const answers = [...prompt.answers, answer];
		if (prompt.questionIndex + 1 < prompt.interaction.questions.length) {
			prompt.answers = answers;
			prompt.questionIndex += 1;
			prompt.selected.clear();
			return false;
		}
		return this.submit(prompt, credential, { answers });
	}

	private async submit(
		prompt: PendingPrompt,
		credential: PortalCredential,
		response: { decision?: 'once' | 'always' | 'reject'; answers?: string[][] }
	): Promise<boolean> {
		if (prompt.busy) throw new Error('Your previous response is still being recorded.');
		prompt.busy = true;
		try {
			await this.chat.respond(credential, { interaction: prompt.interaction.handle, ...response });
			this.prompts.delete(prompt.key);
			prompt.outcome = 'answered';
			prompt.wake?.();
			return true;
		} finally {
			prompt.busy = false;
		}
	}

	async stop(id: string, key: string, user: string, credential: PortalCredential): Promise<void> {
		const job = this.jobs.get(key);
		if (!job || job.id !== id) throw new Error('This work is no longer active.');
		if (job.user !== user || job.username !== credential.username)
			throw new Error('Only the person who requested this work can stop it.');
		await this.chat.cancel(job.job, credential);
		job.cancelled = true;
		const prompt = this.prompts.get(key);
		if (prompt) {
			prompt.outcome = 'cancelled';
			prompt.wake?.();
		}
	}

	cancelled(key: string): boolean {
		return this.jobs.get(key)?.cancelled ?? false;
	}

	close(key: string): void {
		this.prompts.delete(key);
		this.jobs.delete(key);
	}
}

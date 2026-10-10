import { describe, expect, it, mock } from 'bun:test';

import type { ChatResult, GuardianChatClient, PortalInteraction } from './chat-client.js';
import { PortalInteractions, promptView } from './interactions.js';

const credential = { username: 'owner', key: 'private-test-key' };
const key = 'credential:owner:thread:123';
const question: PortalInteraction = {
	kind: 'question',
	handle: 'question-handle',
	questions: [
		{
			question: 'Which target?',
			options: [{ label: 'API', description: 'API deployment' }],
			custom: true
		}
	]
};
function fixture(interaction: PortalInteraction = question) {
	const respond = mock(async () => {});
	const cancel = mock(async () => {});
	const interactions = new PortalInteractions({ respond, cancel } as unknown as GuardianChatClient);
	const result: ChatResult = {
		conversation: 'session',
		text: '',
		pending: { job: 'job', interactions: [interaction] }
	};
	const prompt = interactions.open(key, 'requester', credential, result);
	if (!prompt) throw new Error('missing prompt');
	return { interactions, prompt, result, respond, cancel };
}

describe('requester-owned portal interactions', () => {
	it('isolates decisions by requester, credential, conversation and prompt ID', () => {
		const { interactions, prompt } = fixture();
		for (const [id, user, username, otherKey] of [
			[prompt.id, 'other-user', 'owner', key],
			[prompt.id, 'requester', 'other-credential', key],
			[prompt.id, 'requester', 'owner', 'other-thread'],
			['expired-id', 'requester', 'owner', key]
		])
			expect(() => interactions.get(id, user, { ...credential, username }, otherKey)).toThrow();
		expect(interactions.get(prompt.id, 'requester', credential, key)).toBe(prompt);
		expect(promptView(prompt).text).toContain('API deployment');
	});

	it('collects multiple questions and multiselect answers before one native response', async () => {
		const { interactions, prompt, respond } = fixture({
			kind: 'question',
			handle: 'questions',
			questions: [
				{
					question: 'Targets?',
					options: [
						{ label: 'API', description: '' },
						{ label: 'Web', description: '' }
					],
					multiple: true,
					custom: false
				},
				{ question: 'Details?', options: [], custom: true }
			]
		});
		await interactions.action(prompt, credential, 'option_1');
		await interactions.action(prompt, credential, 'option_0');
		expect(promptView(prompt).actions.filter((action) => action.selected)).toHaveLength(2);
		expect(await interactions.action(prompt, credential, 'done')).toBe(false);
		expect(prompt.questionIndex).toBe(1);
		expect(respond).not.toHaveBeenCalled();
		expect(await interactions.answer(prompt, credential, ['Use staging'])).toBe(true);
		expect(respond).toHaveBeenCalledWith(credential, {
			interaction: 'questions',
			answers: [['API', 'Web'], ['Use staging']]
		});
		expect(interactions.forKey(key)).toBeUndefined();
		expect(await interactions.wait(prompt)).toBe('answered');
		await expect(interactions.action(prompt, credential, 'option_0')).rejects.toThrow(
			'no longer active'
		);
	});

	it('requires buttons for permissions and respects the native policy decisions', async () => {
		const { interactions, prompt, respond } = fixture({
			kind: 'permission',
			handle: 'permission',
			permission: 'bash',
			patterns: ['bun test'],
			allowedDecisions: ['reject']
		});
		await expect(interactions.answer(prompt, credential, ['yes'])).rejects.toThrow(
			'approval buttons'
		);
		await expect(interactions.action(prompt, credential, 'once')).rejects.toThrow('policy');
		expect(respond).not.toHaveBeenCalled();
		await interactions.action(prompt, credential, 'reject');
		expect(respond).toHaveBeenCalledWith(credential, {
			interaction: 'permission',
			decision: 'reject'
		});
	});

	it('allows retry after native response failure, but rejects concurrent double clicks', async () => {
		const { interactions, prompt, respond } = fixture();
		respond.mockRejectedValueOnce(new Error('temporary MCP failure'));
		await expect(interactions.action(prompt, credential, 'option_0')).rejects.toThrow('temporary');
		expect(prompt.busy).toBe(false);
		const finish = Promise.withResolvers<void>();
		respond.mockImplementationOnce(() => finish.promise);
		const answering = interactions.action(prompt, credential, 'option_0');
		await expect(interactions.action(prompt, credential, 'option_0')).rejects.toThrow(
			'still being recorded'
		);
		finish.resolve();
		await answering;
		expect(respond).toHaveBeenCalledTimes(2);
	});

	it('refreshes expiring handles without resetting a partially answered question', () => {
		const { interactions, prompt, result } = fixture();
		prompt.selected.add(0);
		const refreshed = interactions.open(key, 'requester', credential, {
			...result,
			pending: { job: 'job', interactions: [{ ...question, handle: 'fresh-handle' }] }
		});
		expect(refreshed).toBe(prompt);
		expect(prompt.interaction.handle).toBe('fresh-handle');
		expect(prompt.selected.has(0)).toBe(true);
	});

	it('stops only the requester job and wakes a waiting question', async () => {
		const { interactions, prompt, cancel } = fixture();
		const id = interactions.working(key, 'requester', credential, 'job');
		await expect(interactions.stop(id, key, 'other-user', credential)).rejects.toThrow(
			'Only the person'
		);
		const waiting = interactions.wait(prompt);
		await interactions.stop(id, key, 'requester', credential);
		expect(await waiting).toBe('cancelled');
		expect(cancel).toHaveBeenCalledWith('job', credential);
		expect(interactions.cancelled(key)).toBe(true);
		interactions.close(key);
		expect(interactions.forKey(key)).toBeUndefined();
	});
});

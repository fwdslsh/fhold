import editions from '../../../skeleton/assistant-editions.json' with { type: 'json' };

export type AssistantEdition = keyof typeof editions;
export const ASSISTANT_EDITIONS = Object.keys(editions) as AssistantEdition[];
export const PUBLISHED_ASSISTANT_EDITIONS = ASSISTANT_EDITIONS.filter((name) => editions[name].publish);
export function isAssistantEdition(value: unknown): value is AssistantEdition {
	return typeof value === 'string' && Object.hasOwn(editions, value);
}
export function assistantImage(edition: AssistantEdition = 'aio'): string {
	return `fhold-${editions[edition].image}`;
}
export function editionIncludes(edition: AssistantEdition, harness: 'claude' | 'codex'): boolean {
	return editions[edition].harnesses.includes(harness);
}
export function assetHarness(path: string): 'claude' | 'codex' | undefined {
	if (path.startsWith('system/assistant/skills/codex-remote-setup/')) return 'codex';
	if (path.startsWith('system/assistant/skills/claude-code-login/')) return 'claude';
	return undefined;
}
export function editionOwnsAsset(path: string, edition: AssistantEdition = 'aio'): boolean {
	const harness = assetHarness(path);
	return !harness || editionIncludes(edition, harness);
}

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { assistantAssets } from './bake-assistant-assets.mjs';
import { candidateKinds } from './release-candidate.mjs';
import { imageVariants } from './release-scope.mjs';

const json = (path: string) => JSON.parse(readFileSync(new URL('../' + path, import.meta.url), 'utf8'));
test('automatic builds and retained release candidates include only Slim and AIO Assistant editions', () => {
	const bake = json('docker-bake.json');
	expect(bake.group.default.targets).toEqual(['assistant', 'assistant-slim']);
	expect(imageVariants(['assistant'])).toEqual(['assistant', 'assistant-slim']);
	const kinds = candidateKinds('assistant');
	for (const image of ['assistant', 'assistant-slim']) for (const arch of ['amd64', 'arm64']) expect(kinds).toContain(`image-${image}-${arch}`);
	for (const image of ['assistant-claude', 'assistant-codex']) expect(kinds.some((kind: string) => kind.startsWith('image-' + image + '-'))).toBe(false);
	for (const [edition, target] of [['aio', 'assistant'], ['slim', 'assistant-slim'], ['claude', 'assistant-claude'], ['codex', 'assistant-codex']]) {
		expect(bake.target[target!].dockerfile).toBe('containers/assistant/Dockerfile.' + edition);
		expect(bake.target[target!].contexts['fhold-assistant']).toBe('target:' + target + '-base');
		expect(bake.target[target! + '-base'].args.ASSISTANT_EDITION).toBe(edition);
	}
});
test('each baked discovery surface matches its included clients without removing shared skills', () => {
	for (const edition of ['aio', 'slim', 'claude', 'codex']) {
		const paths = assistantAssets(edition).map((asset: { source: string }) => asset.source);
		expect(paths).toContain('system/assistant/skills/fhold-admin/SKILL.md');
		for (const [harness, skill] of [['claude', 'claude-code-login'], ['codex', 'codex-remote-setup']]) {
			expect(paths.includes('system/assistant/skills/' + skill + '/SKILL.md')).toBe(edition === 'aio' || edition === harness);
		}
	}
	const core = json('containers/assistant/tools/package.json').dependencies;
	expect(core['@anthropic-ai/claude-code']).toBeUndefined();
	expect(core['@openai/codex']).toBeUndefined();
});

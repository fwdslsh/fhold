import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

test('MCPB signing tooling stays outside the delivered unsigned bridge', () => {
	const manifest = JSON.parse(
		readFileSync(join(root, 'packages/claude-desktop/package.json'), 'utf8')
	) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
	expect(manifest.devDependencies['@anthropic-ai/mcpb']).toBeDefined();
	expect(manifest.dependencies['@anthropic-ai/mcpb']).toBeUndefined();
	expect(manifest.dependencies['node-forge']).toBeUndefined();
	const packer = readFileSync(join(root, 'packages/claude-desktop/scripts/pack.ts'), 'utf8');
	expect(packer).toContain("['bun', 'run', 'mcpb', 'pack', 'dist', destination]");
	expect(packer).not.toMatch(/signMcpbFile|verifyMcpbFile/);
	const bridge = readFileSync(join(root, 'packages/claude-desktop/dist/server/index.js'), 'utf8');
	expect(bridge).not.toContain('node-forge');
	expect(bridge).not.toContain('@anthropic-ai/mcpb');
});

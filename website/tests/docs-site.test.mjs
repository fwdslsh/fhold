import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateDocs } from '../scripts/gen-docs.mjs';

const temporary = [];
afterEach(() => {
	for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('nested docs resolve links by full path and keep contributor content out of user indexes', () => {
	const repo = mkdtempSync(join(tmpdir(), 'fhold-site-'));
	temporary.push(repo);
	const docs = join(repo, 'docs');
	const output = join(repo, 'output');
	const sources = {
		'README.md': '# Documentation\n\nOld mixed navigation.',
		'installation.md':
			'# Installation\n\nInstall your agent.\n\n[API](technical/api-spec.md#tools) [Release](operations/release.md) [Source](../packages/cli/src/main.ts)\n\n```md\n[example](technical/api-spec.md)\n```\n\n`[inline](technical/api-spec.md)`',
		'technical/api-spec.md':
			'# API\n\nUser interface details.\n\n## Tools\n\n[Install](../installation.md)',
		'technical/testing-workflow.md': '# Testing\n\nContributor tests.',
		'operations/release.md': '# Release\n\nMaintainer release process.',
		'operations/testing-workflow.md': '# Verification\n\nA different file with the same basename.',
		'portals/slack-setup.md': '# Slack\n\nConnect your agent.'
	};
	for (const [file, body] of Object.entries(sources)) {
		mkdirSync(join(docs, file, '..'), { recursive: true });
		writeFileSync(join(docs, file), body);
	}
	expect(generateDocs({ docs, repo, output })).toBe(7);
	const install = readFileSync(join(output, 'guides/installation.md'), 'utf8');
	expect(install).toContain('/reference/api-spec.html#tools');
	expect(install).toContain('/maintainers/operations/release.html');
	expect(install).toContain('https://github.com/fwdslsh/fhold/blob/main/packages/cli/src/main.ts');
	expect(install).toContain('```md\n[example](technical/api-spec.md)\n```');
	expect(install).toContain('`[inline](technical/api-spec.md)`');
	expect(readFileSync(join(output, 'reference/api-spec.md'), 'utf8')).toContain(
		'/guides/installation.html'
	);
	const guides = readFileSync(join(output, 'guides/index.md'), 'utf8');
	expect(guides).not.toContain('Testing');
	expect(guides).not.toContain('Release');
	const maintainers = readFileSync(join(output, 'maintainers/index.md'), 'utf8');
	expect(maintainers).toContain('technical/testing-workflow.html');
	expect(maintainers).toContain('operations/testing-workflow.html');
	expect(readFileSync(join(output, 'connect/index.md'), 'utf8')).toContain('slack-setup.html');
	const before = install;
	generateDocs({ docs, repo, output });
	expect(readFileSync(join(output, 'guides/installation.md'), 'utf8')).toBe(before);
	for (const [file, body] of Object.entries(sources))
		expect(readFileSync(join(docs, file), 'utf8')).toBe(body);
});

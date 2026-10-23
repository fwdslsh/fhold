import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const sourceRoot = resolve(import.meta.dir, '..', 'packages', 'lib', 'src');

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
	});
}

const files = sourceFiles(sourceRoot);
const knownFiles = new Set(files);
const transpiler = new Bun.Transpiler({ loader: 'ts' });

/** Runtime imports only: Bun omits erased `import type` declarations. */
function runtimeImports(file: string): string[] {
	return transpiler.scanImports(readFileSync(file, 'utf8')).flatMap((entry) => {
		if (!entry.path.startsWith('.')) return [];
		const target = resolve(dirname(file), entry.path).replace(/\.js$/, '.ts');
		return knownFiles.has(target) ? [target] : [];
	});
}

const graph = new Map(files.map((file) => [file, runtimeImports(file)]));
const relative = (file: string) => file.slice(sourceRoot.length + 1);

describe('hosting and agent management boundaries', () => {
	it('keeps control-plane implementation independent from hosting and management runtime layers', () => {
		for (const file of files.filter((path) => relative(path).startsWith('control-plane/')))
			for (const dependency of graph.get(file) ?? [])
				expect(relative(dependency), relative(file)).not.toMatch(/^(?:hosting|management)\//);
	});

	it('has no executable dependency cycles across the library implementation graph', () => {
		const active = new Set<string>();
		const complete = new Set<string>();
		const visit = (file: string, chain: string[]): void => {
			if (active.has(file)) {
				const start = chain.indexOf(file);
				throw new Error(
					`Runtime import cycle: ${[...chain.slice(start), file].map(relative).join(' -> ')}`
				);
			}
			if (complete.has(file)) return;
			active.add(file);
			for (const dependency of graph.get(file) ?? []) visit(dependency, [...chain, file]);
			active.delete(file);
			complete.add(file);
		};
		for (const file of files) visit(file, []);
	});
});

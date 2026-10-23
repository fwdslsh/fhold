import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = join(import.meta.dir, '..');
function run(args: string[]): void {
	const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
	if (result.status !== 0) throw new Error(`Build failed: ${args.join(' ')}`);
}
run(['run', 'scripts/pack-embedded-assets.ts']);
mkdirSync(join(root, 'embedded'), { recursive: true });
const flags = ['--compile', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig'];
for (const arch of ['x64', 'arm64']) {
	run([
		'build',
		'src/main.ts',
		...flags,
		`--target=bun-linux-${arch}`,
		'--outfile',
		`embedded/fhold-linux-${arch}`
	]);
	writeFileSync(
		join(root, `embedded/fhold-linux-${arch}.gz`),
		gzipSync(readFileSync(join(root, `embedded/fhold-linux-${arch}`)))
	);
}
if (!process.argv.includes('--helpers-only')) {
	const target = process.argv.find((arg) => arg.startsWith('--target='));
	const arch = target?.replace('--target=bun-linux-', '');
	run([
		'build',
		'src/standalone.ts',
		...flags,
		...(target ? [target] : []),
		'--outfile',
		arch ? `dist/fhold-cli-linux-${arch}` : 'dist/fhold-cli'
	]);
}

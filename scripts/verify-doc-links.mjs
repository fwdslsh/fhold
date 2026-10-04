import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const files = [];
function collect(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'release', '.dev'].includes(entry.name)) continue;
    const full = join(path, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
  }
}
collect(root);
const failures = [];
let checked = 0;
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1];
    if (/^(https?:|mailto:|data:)/.test(href) || /[{}<>]/.test(href)) continue;
    const [name, anchor] = href.split('#');
    const target = name ? resolve(dirname(file), decodeURIComponent(name)) : file;
    if (!existsSync(target)) { failures.push(`${file}: missing ${href}`); continue; }
    if (anchor && statSync(target).isFile() && target.endsWith('.md')) {
      const headings = [...readFileSync(target, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)]
        .map((heading) => heading[1].toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-'));
      if (!headings.includes(decodeURIComponent(anchor))) failures.push(`${file}: missing anchor ${href}`);
    }
    checked++;
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log(`Verified ${checked} local links in ${files.length} Markdown files.`);

// Build-time metadata is the runtime source of truth, not startup toggles.
import { readFileSync, writeFileSync } from 'node:fs';
import editions from '../../packages/skeleton/assistant-editions.json' with { type: 'json' };

const edition = process.argv[2];
if (!Object.hasOwn(editions, edition)) throw new Error('Unknown Assistant edition');
const { harnesses } = editions[edition];
const manifest = JSON.parse(readFileSync('containers/assistant/tools/package.json', 'utf8'));
for (const tool of ['claude', 'codex']) {
  if (harnesses.includes(tool)) Object.assign(manifest.dependencies,
    JSON.parse(readFileSync(`containers/assistant/${tool}-tools/package.json`, 'utf8')).dependencies);
}
writeFileSync('/selected-tools.json', JSON.stringify({ ...manifest, fholdEdition: edition, harnesses }, null, 2) + '\n');

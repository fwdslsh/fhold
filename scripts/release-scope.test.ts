import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runtimeImpact } from './ci-scope.mjs';
import { componentManifests, inferReleaseScope, releaseImages } from './release-scope.mjs';
import { candidateKinds } from './release-candidate.mjs';

const root = join(import.meta.dir, '..');
const release = JSON.parse(readFileSync(join(root, '.github/release-manifest.json'), 'utf8'));
const before = '0.4.1103-beta';
const next = '0.4.1104-beta';

test('scopes reject ambiguous selections and retain only the requested native artifacts', () => {
  for (const scope of ['', 'assistant,assistant', 'assistant,unknown', 'tools,portal'])
    expect(() => releaseImages(scope)).toThrow();
  expect(releaseImages('portal,assistant')).toEqual(['assistant', 'portal']);
  expect(candidateKinds('assistant')).toEqual(candidateKinds('full').filter((kind: string) =>
    !/guardian|portal|mcpb/.test(kind)));
});

test('Assistant stamping preserves published Guardian, Portal and extension versions; missing defaults fail before writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fhold-scoped-stamp-'));
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  try {
    put('.github/release-manifest.json', JSON.stringify(release));
    for (const file of release.manifests) put(file, JSON.stringify({ version: before, preserved: true }));
    const compose = release.compose[0];
    put(compose, 'image: ${FH_GUARDIAN_VERSION:-0.4.1103-beta}\n');
    const stamp = () => spawnSync(process.execPath, [join(root, 'scripts/bump-release.mjs')], {
      cwd: dir, env: { ...process.env, SCOPE: 'assistant', STAMP: 'true', VERSION: next }, encoding: 'utf8'
    });
    expect(stamp().status).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version).toBe(before);
    put(compose, ['ASSISTANT', 'GUARDIAN', 'PORTAL'].map((name) => `image: \${FH_${name}_VERSION:-${before}}`).join('\n'));
    expect(stamp().status).toBe(0);
    for (const file of release.manifests) {
      const changed = release.toolingManifests.includes(file) || componentManifests.assistant.includes(file);
      expect(JSON.parse(readFileSync(join(dir, file), 'utf8'))).toEqual({ version: changed ? next : before, preserved: true });
    }
    expect(inferReleaseScope(next, (file: string) => readFileSync(join(dir, file), 'utf8'))).toBe('assistant');
    const text = readFileSync(join(dir, compose), 'utf8');
    expect(text).toContain(`FH_ASSISTANT_VERSION:-${next}`);
    for (const name of ['GUARDIAN', 'PORTAL']) expect(text).toContain(`FH_${name}_VERSION:-${before}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real lockfile ownership detects AKM and shared transitive changes while ignoring release-only stamps', () => {
  const lock = Bun.JSONC.parse(readFileSync(join(root, 'bun.lock'), 'utf8'));
  const impact = (after: unknown) => runtimeImpact(['bun.lock'], () => JSON.stringify(lock), () => JSON.stringify(after));
  const stamped = structuredClone(lock);
  for (const workspace of Object.values(stamped.workspaces) as Array<{version?: string}>)
    if (workspace.version) workspace.version = next;
  expect(impact(stamped)).toEqual([]);
  const akm = structuredClone(lock);
  expect(akm.packages['akm-cli']).toBeDefined();
  akm.packages['akm-cli'][3] = 'changed-integrity';
  expect(impact(akm)).toEqual(['assistant']);
  const shared = structuredClone(lock);
  shared.packages.zod[3] = 'changed-integrity';
  expect(impact(shared)).toContain('assistant');
  expect(impact(shared)).toContain('guardian');
  expect(runtimeImpact(['new-root-build-input'], () => '', () => '')).toEqual(['assistant', 'guardian', 'portal', 'bridge']);
});

test('retained-component proof rejects changed source, unpublished pins and changed transitive dependencies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fhold-retained-proof-'));
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  try {
    for (const files of Object.values(componentManifests) as string[][])
      for (const file of files) put(file, JSON.stringify({ version: before }));
    put('packages/guardian/src/server.ts', 'original');
    put('bun.lock', readFileSync(join(root, 'bun.lock'), 'utf8'));
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    git('add', '.'); git('commit', '-qm', 'published'); git('tag', before);
    for (const file of componentManifests.assistant) put(file, JSON.stringify({ version: next }));
    git('add', '.'); git('commit', '-qm', 'assistant only');
    const check = () => spawnSync(process.execPath, ['--eval', `import { assertRetainedComponents } from ${JSON.stringify(join(root, 'scripts/ci-scope.mjs'))}; assertRetainedComponents('assistant', ${JSON.stringify(next)});`], { cwd: dir, encoding: 'utf8' });
    expect(check().status).toBe(0);
    put('packages/guardian/src/server.ts', 'changed'); git('add', '.'); git('commit', '-qm', 'missed guardian');
    expect(check().stderr).toContain('guardian inputs changed');
    git('revert', '--no-edit', 'HEAD');
    const lock = Bun.JSONC.parse(readFileSync(join(dir, 'bun.lock'), 'utf8'));
    lock.packages.zod[3] = 'changed-integrity'; put('bun.lock', JSON.stringify(lock));
    git('add', '.'); git('commit', '-qm', 'missed transitive change');
    expect(check().stderr).toContain('guardian inputs changed');
    git('revert', '--no-edit', 'HEAD');
    put(componentManifests.guardian[0], JSON.stringify({ version: '0.4.1199-beta' }));
    expect(check().status).not.toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mixed-version distribution installs and upgrades using each published image pin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fhold-mixed-versions-'));
  try {
    cpSync(join(root, 'packages/lib'), join(dir, 'packages/lib'), { recursive: true, filter: (path) => !/(?:\/node_modules|\/dist)(?:\/|$)/.test(path) });
    cpSync(join(root, 'packages/skeleton'), join(dir, 'packages/skeleton'), { recursive: true });
    for (const [component, files] of Object.entries(componentManifests) as Array<[string, string[]]>) {
      const file = join(dir, files[0]);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ version: component === 'assistant' ? next : before }));
    }
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
    symlinkSync(join(root, 'packages/lib/node_modules'), join(dir, 'packages/lib/node_modules'));
    symlinkSync(join(root, 'containers'), join(dir, 'containers'));
    const result = spawnSync(process.execPath, ['test', 'packages/lib/src/control-plane/update.test.ts'], { cwd: dir, encoding: 'utf8' });
    expect(result.stderr + result.stdout).not.toContain('(fail)');
    expect(result.status, result.stderr + result.stdout).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Run inside the real image. Missing native clients must be truly absent.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const manifest = JSON.parse(readFileSync('/opt/fhold/tools/package.json', 'utf8'));
assert.equal(manifest.fholdEdition, process.env.EXPECTED_EDITION);
assert.ok(manifest.harnesses.includes('opencode'));
for (const [tool, packageName, skill] of [
  ['claude', '@anthropic-ai/claude-code', 'claude-code-login'],
  ['codex', '@openai/codex', 'codex-remote-setup']
]) {
  const included = manifest.harnesses.includes(tool);
  const command = spawnSync('sh', ['-c', 'command -v "$1"', 'edition-smoke', tool], { encoding: 'utf8' });
  assert.equal(command.status === 0, included, tool + ' executable availability');
  const nativePackage = '/opt/fhold/native/node_modules/' + packageName + '/package.json';
  assert.equal(existsSync(nativePackage), included, tool + ' package availability');
  assert.equal(existsSync('/opt/fhold/tools/node_modules/' + packageName), false, 'Native packages must stay out of shared core');
  assert.equal(existsSync('/fhold-bundle/skills/' + skill + '/SKILL.md'), included, tool + ' built-in AKM skill');
  assert.equal(existsSync('/etc/opencode/skills/' + skill + '/SKILL.md'), included, tool + ' OpenCode setup skill');
  assert.equal(existsSync('/native-defaults/' + tool + '/plugins/cache'), included, tool + ' native default plugins');
  if (included) {
    assert.equal(JSON.parse(readFileSync(nativePackage, 'utf8')).version, manifest.dependencies[packageName]);
    const version = spawnSync(tool, ['--version'], { encoding: 'utf8', timeout: 15000 });
    assert.equal(version.status, 0, version.stderr);
  } else {
    const status = spawnSync('fhold-remote', [tool, 'status'], { encoding: 'utf8', timeout: 15000 });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).state, 'not-included');
  }
}
if (manifest.fholdEdition === 'slim') assert.deepEqual(readdirSync('/akm-marketplace'), []);
console.log('Edition binaries, packages, native defaults and skills verified: ' + manifest.fholdEdition);

// Run inside the real image. Missing native clients must be truly absent.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const manifest = JSON.parse(readFileSync('/opt/fhold/tools/package.json', 'utf8'));
assert.equal(manifest.fholdEdition, process.env.EXPECTED_EDITION);
assert.ok(manifest.harnesses.includes('opencode'));
assert.notEqual(process.getuid(), 0, 'Edition smoke must use the non-root Assistant');
const keyring = spawnSync('fhold-keyring', ['status'], { encoding: 'utf8', timeout: 8000 });
assert.equal(keyring.status, 0, keyring.stdout + keyring.stderr);
try {
  const stored = spawnSync('secret-tool', ['store', '--label=fhold-edition-smoke', 'fhold-smoke', 'edition'], {
    input: 'synthetic-keyring-probe', encoding: 'utf8', timeout: 5000
  });
  assert.equal(stored.status, 0, stored.stderr);
  const found = spawnSync('secret-tool', ['lookup', 'fhold-smoke', 'edition'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(found.status, 0, found.stderr);
  assert.equal(found.stdout.trim(), 'synthetic-keyring-probe');
} finally {
  spawnSync('secret-tool', ['clear', 'fhold-smoke', 'edition'], { timeout: 5000 });
}
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
if (manifest.fholdEdition === 'slim') {
  assert.deepEqual(readdirSync('/akm-marketplace'), []);
  for (const tool of ['ssh', 'scp', 'sftp', 'ssh-keygen', 'ssh-agent']) {
    const command = spawnSync('sh', ['-c', 'command -v "$1"', 'edition-smoke', tool], { encoding: 'utf8' });
    assert.equal(command.status, 0, tool + ' must be usable by the non-root Assistant');
  }
  assert.equal(spawnSync('ssh', ['-V'], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync('ssh', ['-G', '-F', '/dev/null', '-o', 'BatchMode=yes', '127.0.0.1'], { encoding: 'utf8' }).status, 0);
}
console.log('Edition binaries, packages, native defaults and skills verified: ' + manifest.fholdEdition);

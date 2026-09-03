import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const bin = join(root, 'dist/oboete.mjs');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string;
};

function run(args: string[]) {
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env });
}

test('--version prints the package version', () => {
  const result = run(['--version']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), pkg.version);
});

test('unknown command exits 2 and prints usage to stderr', () => {
  const result = run(['not-a-command']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: oboete/);
});

test('oboete doctor exits 2 because it is not implemented yet', () => {
  const result = run(['doctor']);
  assert.equal(result.status, 2);
  assert.equal(result.stderr, 'oboete doctor is not implemented yet\n');
});

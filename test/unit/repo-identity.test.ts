import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { resolveRepoIdentity } from '../../src/repo-identity.js';

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const skip = gitAvailable ? false : 'git is not installed, so the repository identity tests cannot run.';

const temporaryRoots: string[] = [];

after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'oboete-repo-'));
  temporaryRoots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function newRepository(): string {
  const root = join(temporaryRoot(), 'work');
  mkdirSync(root);
  git(root, 'init', '--quiet', '--initial-branch', 'main');
  return root;
}

function repositoryWithRemote(url: string): string {
  const root = newRepository();
  git(root, 'remote', 'add', 'origin', url);
  return root;
}

function sha256Prefix(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

test('a credential in the remote URL never reaches the identity', { skip }, () => {
  const root = repositoryWithRemote('https://user:s3cr3tpass@github.com/Owner/Repo.git?x=1#frag');
  const identity = resolveRepoIdentity(root);
  assert.equal(identity.identityKind, 'remote');
  assert.equal(identity.normalizedIdentity, 'github.com/Owner/Repo');
  assert.equal(identity.root, realpathSync(root));
  const serialized = JSON.stringify(identity);
  assert.equal(serialized.includes('s3cr3tpass'), false);
  assert.equal(serialized.includes('user:'), false);
});

test('the scp-like remote form is normalized', { skip }, () => {
  const identity = resolveRepoIdentity(repositoryWithRemote('git@github.com:owner/repo.git'));
  assert.equal(identity.identityKind, 'remote');
  assert.equal(identity.normalizedIdentity, 'github.com/owner/repo');
});

test('a non-default port is kept and the host is lower-cased', { skip }, () => {
  const identity = resolveRepoIdentity(repositoryWithRemote('ssh://git@Host:2222/a/b.git'));
  assert.equal(identity.normalizedIdentity, 'host:2222/a/b');
  assert.equal(
    resolveRepoIdentity(repositoryWithRemote('ssh://git@Host:22/a/b.git/')).normalizedIdentity,
    'host/a/b',
  );
});

test('origin wins over another remote that is listed first', { skip }, () => {
  const root = newRepository();
  git(root, 'remote', 'add', 'alt', 'https://alt.example.com/alt/mirror.git');
  git(root, 'remote', 'add', 'origin', 'https://github.com/owner/canonical.git');
  assert.equal(git(root, 'remote').split('\n')[0], 'alt');
  assert.equal(resolveRepoIdentity(root).normalizedIdentity, 'github.com/owner/canonical');
});

test('the only remote is used when there is no origin', { skip }, () => {
  const root = newRepository();
  git(root, 'remote', 'add', 'upstream', 'https://github.com/owner/only.git');
  assert.equal(resolveRepoIdentity(root).normalizedIdentity, 'github.com/owner/only');
});

test('a repository without a remote is identified by the real path of its git common directory', { skip }, () => {
  const base = temporaryRoot();
  const root = join(base, 'real');
  mkdirSync(root);
  git(root, 'init', '--quiet', '--initial-branch', 'main');

  const identity = resolveRepoIdentity(root);
  assert.equal(identity.identityKind, 'common_dir');
  assert.equal(identity.normalizedIdentity, realpathSync(join(root, '.git')));

  symlinkSync(root, join(base, 'link'), 'dir');
  assert.equal(resolveRepoIdentity(join(base, 'link')).id, identity.id);
});

test('a linked worktree resolves to the identity of the main worktree', { skip }, () => {
  const root = newRepository();
  writeFileSync(join(root, 'file.txt'), 'content\n');
  git(root, 'add', 'file.txt');
  git(root, '-c', 'user.name=oboete test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'first');

  const linked = join(temporaryRoot(), 'linked');
  git(root, 'worktree', 'add', '--quiet', linked);

  const main = resolveRepoIdentity(root);
  const other = resolveRepoIdentity(linked);
  assert.equal(main.identityKind, 'common_dir');
  assert.equal(other.id, main.id);
  assert.equal(other.normalizedIdentity, main.normalizedIdentity);
  assert.equal(other.root, realpathSync(linked));
});

test('a directory outside any repository is identified by its own real path', () => {
  const root = temporaryRoot();
  const identity = resolveRepoIdentity(root);
  assert.equal(identity.identityKind, 'common_dir');
  assert.equal(identity.normalizedIdentity, realpathSync(root));
  assert.equal(identity.root, root);
});

test('the id is the first 16 hex characters of the sha256 of the normalized identity', { skip }, () => {
  const identity = resolveRepoIdentity(repositoryWithRemote('https://github.com/Owner/Repo.git'));
  assert.equal(identity.normalizedIdentity, 'github.com/Owner/Repo');
  assert.match(identity.id, /^[0-9a-f]{16}$/);
  assert.equal(identity.id, sha256Prefix('github.com/Owner/Repo'));

  const plain = resolveRepoIdentity(temporaryRoot());
  assert.match(plain.id, /^[0-9a-f]{16}$/);
  assert.equal(plain.id, sha256Prefix(plain.normalizedIdentity));
});

test('git repository variables in the environment cannot redirect the identity', { skip }, () => {
  const victim = newRepository();
  const attacker = repositoryWithRemote('https://github.com/attacker/other.git');
  const expected = resolveRepoIdentity(victim);
  assert.equal(expected.identityKind, 'common_dir');

  const names = ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE'];
  const previous = names.map((name) => [name, process.env[name]] as const);
  process.env.GIT_DIR = join(attacker, '.git');
  process.env.GIT_COMMON_DIR = join(attacker, '.git');
  process.env.GIT_WORK_TREE = attacker;
  try {
    assert.deepEqual(resolveRepoIdentity(victim), expected);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

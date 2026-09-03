import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export type RepoIdentity = {
  id: string;
  identityKind: 'remote' | 'common_dir';
  normalizedIdentity: string;
  root: string;
};

// A hook must return within 300 ms (FR-002), so no git call may hang the capture path.
const GIT_TIMEOUT_MS = 500;

const DEFAULT_PORTS: Record<string, string> = {
  'http:': '80',
  'https:': '443',
  'ssh:': '22',
  'git:': '9418',
};

const REMOTE_SCHEMES = ['https:', 'http:', 'ssh:', 'git:', 'file:'];

function git(cwd: string, args: string[]): string | null {
  // FR-004: the identity comes from the repository at `cwd` and nothing else, so git's own
  // repository-discovery and configuration variables (GIT_DIR, GIT_COMMON_DIR, GIT_WORK_TREE,
  // GIT_CONFIG_*) are dropped; a localized message must not change it either.
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  env.LC_ALL = 'C';

  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  if (result.error !== undefined || result.status !== 0) return null;
  return result.stdout.trim();
}

function trimPath(path: string): string {
  const withoutSlashes = path.replace(/\/+$/, '');
  return withoutSlashes.endsWith('.git')
    ? withoutSlashes.slice(0, -'.git'.length).replace(/\/+$/, '')
    : withoutSlashes;
}

/**
 * `host/path` with userinfo, query and fragment removed, so a credential embedded in a remote URL
 * never reaches the database or a pack (R8). Returns null when the URL is not one oboete knows.
 */
function normalizeRemote(url: string): string | null {
  const raw = url.trim();
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw);
  const scpLike = /^(?:[^@/]+@)?([^@/:]+):(.*)$/.exec(raw);
  if (!hasScheme && scpLike !== null) {
    const path = trimPath(scpLike[2]).replace(/^\/+/, '');
    return path === '' ? null : `${scpLike[1].toLowerCase()}/${path}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!REMOTE_SCHEMES.includes(parsed.protocol)) return null;

  // Reading only hostname, port and pathname drops the userinfo, the query and the fragment.
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port !== '' && parsed.port !== DEFAULT_PORTS[parsed.protocol] ? `:${parsed.port}` : '';
  const path = trimPath(parsed.pathname);
  if (host === '' && path === '') return null;
  return `${host}${port}${path.startsWith('/') ? path : `/${path}`}`;
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function identity(
  identityKind: RepoIdentity['identityKind'],
  normalizedIdentity: string,
  root: string,
): RepoIdentity {
  return {
    // data-model.md repos: first 16 hex of sha256 over the normalized identity.
    id: createHash('sha256').update(normalizedIdentity, 'utf8').digest('hex').slice(0, 16),
    identityKind,
    normalizedIdentity,
    root,
  };
}

/**
 * FR-004: the repository identity is derived here from the repository's remote or its location.
 * Nothing is ever taken from an event payload or an environment variable.
 */
export function resolveRepoIdentity(cwd: string): RepoIdentity {
  const root = git(cwd, ['rev-parse', '--show-toplevel']) ?? cwd;

  const listed = git(cwd, ['remote']);
  const names = (listed ?? '').split('\n').map((name) => name.trim()).filter((name) => name !== '');
  const name = names.includes('origin') ? 'origin' : names[0];
  if (name !== undefined) {
    const url = git(cwd, ['remote', 'get-url', name]);
    const normalized = url === null ? null : normalizeRemote(url);
    if (normalized !== null) return identity('remote', normalized, root);
  }

  // ponytail: without a usable remote the identity is this machine's path, so the same repository
  // on another machine gets another id; `oboete import --map-repo` maps the two.
  const commonDir = git(cwd, ['rev-parse', '--git-common-dir']);
  return identity('common_dir', realpath(commonDir === null ? cwd : resolve(cwd, commonDir)), root);
}

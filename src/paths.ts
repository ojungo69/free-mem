import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type OboetePaths = {
  home: string;
  config: string;
  db: string;
  spool: string;
  piAck: string;
  logs: string;
  hookLog: string;
  observeLog: string;
  paused: string;
};

/** The one data directory (FR-039, amendment A4): `OBOETE_HOME`, else `~/.oboete`. */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OBOETE_HOME?.trim();
  // Hooks run with the agent's working directory, so a relative override is anchored once here.
  return override ? resolve(override) : join(homedir(), '.oboete');
}

/** Every path under the data directory. No other module composes one (conventions, "Data directory and files"). */
export function oboetePaths(home: string): OboetePaths {
  const spool = join(home, 'spool');
  const logs = join(home, 'logs');
  return {
    home,
    config: join(home, 'config.toml'),
    db: join(home, 'memory.db'),
    spool,
    piAck: join(spool, 'pi-ack'),
    logs,
    hookLog: join(logs, 'hook.log'),
    observeLog: join(logs, 'observe.log'),
    paused: join(home, 'paused'),
  };
}

export function ensureDirectories(paths: OboetePaths): void {
  // The database, the spool and the logs hold captured content, so the tree stays owner-only.
  for (const directory of [paths.home, paths.spool, paths.piAck, paths.logs]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
}

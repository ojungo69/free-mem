import type { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { DatabaseSync } from 'node:sqlite';

import type { AgentDetection, SetupAgent } from './detect.js';

const PROBE_DEADLINE_MS = 90_000;

export type ProbeTarget = Pick<AgentDetection, 'agent' | 'installed' | 'configPath'>;
export type ProbeStatus = 'pass' | 'fail' | 'timeout' | 'not_installed';
export type ProbeResult = {
  agent: SetupAgent;
  status: ProbeStatus;
  elapsedMs: number;
  reason: string;
};

export type ProbeDeps = {
  spawn: typeof spawn;
  lookupProbe(agent: SetupAgent, marker: string): boolean | Promise<boolean>;
  cwd: string;
  env: NodeJS.ProcessEnv;
  now?: () => number;
};

type Invocation = {
  command: SetupAgent;
  args: string[];
  env: NodeJS.ProcessEnv;
  cleanup?: () => void;
};

type ProcessOutcome =
  | { kind: 'closed'; code: number | null }
  | { kind: 'error'; error: unknown };

function invocation(target: ProbeTarget, marker: string, deps: ProbeDeps): Invocation {
  const env = { ...deps.env };
  const message = `oboete wiring probe ${marker}. Reply with exactly OK and do not use tools.`;
  switch (target.agent) {
    case 'claude':
      return {
        command: 'claude',
        args: [
          '-p',
          message,
          '--settings',
          target.configPath,
          '--dangerously-skip-permissions',
          '--output-format',
          'json',
        ],
        env,
      };
    case 'codex':
      env.CODEX_HOME = dirname(target.configPath);
      return {
        command: 'codex',
        args: [
          'exec',
          '--dangerously-bypass-approvals-and-sandbox',
          '--skip-git-repo-check',
          '--json',
          '-C',
          deps.cwd,
          message,
        ],
        env,
      };
    case 'grok':
      env.GROK_HOME = dirname(dirname(target.configPath));
      env.GROK_CLAUDE_HOOKS_ENABLED = '0';
      env.GROK_CLAUDE_MCPS_ENABLED = '0';
      env.GROK_CURSOR_HOOKS_ENABLED = '0';
      env.GROK_CURSOR_MCPS_ENABLED = '0';
      return {
        command: 'grok',
        args: [
          '-p',
          message,
          '--always-approve',
          '--output-format',
          'json',
          '--cwd',
          deps.cwd,
        ],
        env,
      };
    case 'pi': {
      env.PI_CODING_AGENT_DIR = dirname(dirname(target.configPath));
      const sessionDir = mkdtempSync(join(tmpdir(), 'oboete-probe-pi-'));
      return {
        command: 'pi',
        args: ['-p', message, '--mode', 'json', '--session-dir', sessionDir],
        env,
        cleanup: () => rmSync(sessionDir, { recursive: true, force: true }),
      };
    }
  }
}

async function runProcess(
  spawnFn: typeof spawn,
  child: Invocation,
  cwd: string,
  signal: AbortSignal,
): Promise<ProcessOutcome> {
  let process: ReturnType<typeof spawn> | undefined;
  try {
    process = spawnFn(child.command, child.args, {
      cwd,
      env: child.env,
      signal,
      stdio: 'ignore',
    });
    const [code] = await once(process, 'close', { signal });
    return { kind: 'closed', code: typeof code === 'number' ? code : null };
  } catch (error) {
    if (signal.aborted) {
      try {
        process?.kill();
      } catch {
        // The shared deadline owns the result even when the process already exited.
      }
    }
    return { kind: 'error', error };
  }
}

function timedOut(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (typeof error !== 'object' || error === null || !('name' in error)) return false;
  return error.name === 'AbortError' || error.name === 'TimeoutError';
}

function elapsed(now: () => number, started: number): number {
  return Math.max(0, Math.round(now() - started));
}

async function lookupBeforeDeadline(
  deps: ProbeDeps,
  agent: SetupAgent,
  marker: string,
  signal: AbortSignal,
): Promise<'found' | 'missing' | 'timeout' | 'error'> {
  if (signal.aborted) return 'timeout';
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<'timeout'>((resolve) => {
    onAbort = () => resolve('timeout');
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  const lookup = Promise.resolve()
    .then(() => deps.lookupProbe(agent, marker))
    .then((found) => (found ? ('found' as const) : ('missing' as const)))
    .catch(() => 'error' as const);
  const result = await Promise.race([lookup, aborted]);
  signal.removeEventListener('abort', onAbort);
  return result;
}

async function runProbe(
  target: ProbeTarget,
  deps: ProbeDeps,
  signal: AbortSignal,
): Promise<ProbeResult> {
  const now = deps.now ?? (() => performance.now());
  const started = now();
  if (!target.installed) {
    return {
      agent: target.agent,
      status: 'not_installed',
      elapsedMs: elapsed(now, started),
      reason: 'agent_not_installed',
    };
  }

  const marker = `oboete-probe:${randomUUID()}`;
  let child: Invocation;
  try {
    child = invocation(target, marker, deps);
  } catch {
    return {
      agent: target.agent,
      status: 'fail',
      elapsedMs: elapsed(now, started),
      reason: 'spawn_failed',
    };
  }

  try {
    const outcome = await runProcess(deps.spawn, child, deps.cwd, signal);
    const lookup = await lookupBeforeDeadline(deps, target.agent, marker, signal);
    if (lookup === 'found') {
      return {
        agent: target.agent,
        status: 'pass',
        elapsedMs: elapsed(now, started),
        reason: 'probe_event_stored',
      };
    }
    if (lookup === 'error') {
      return {
        agent: target.agent,
        status: 'fail',
        elapsedMs: elapsed(now, started),
        reason: 'probe_lookup_failed',
      };
    }

    if (
      lookup === 'timeout' ||
      signal.aborted ||
      (outcome.kind === 'error' && timedOut(outcome.error, signal))
    ) {
      return {
        agent: target.agent,
        status: 'timeout',
        elapsedMs: elapsed(now, started),
        reason: 'deadline_exceeded',
      };
    }
    if (outcome.kind === 'error') {
      return {
        agent: target.agent,
        status: 'fail',
        elapsedMs: elapsed(now, started),
        reason: 'spawn_failed',
      };
    }
    return {
      agent: target.agent,
      status: 'fail',
      elapsedMs: elapsed(now, started),
      reason: outcome.code === 0 ? 'probe_event_missing' : `agent_exit_${outcome.code ?? 'signal'}`,
    };
  } finally {
    try {
      child.cleanup?.();
    } catch {
      // Probe status is about hook wiring; temporary-session cleanup cannot change that result.
    }
  }
}

/** One shared 90-second deadline covers every selected headless wiring probe (FR-031, R12). */
export async function runProbes(
  agents: readonly ProbeTarget[],
  deps: ProbeDeps,
): Promise<ProbeResult[]> {
  const signal = AbortSignal.timeout(PROBE_DEADLINE_MS);
  return await Promise.all(agents.map((agent) => runProbe(agent, deps, signal)));
}

/** The lookup seam T053/T069 can bind to their already-open database. */
export function probeEventStored(db: DatabaseSync, agent: SetupAgent, marker: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 AS present FROM raw_events
         WHERE agent = ? AND (
           (kind = 'prompt' AND instr(content, ?) > 0) OR
           (kind = 'probe' AND CASE WHEN json_valid(payload_json)
              THEN json_extract(payload_json, '$.marker') END = ?)
         )
         LIMIT 1`,
      )
      .get(agent, marker, marker) !== undefined
  );
}

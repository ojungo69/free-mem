import assert from 'node:assert/strict';
import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { openDatabase } from '../../src/db/open.js';
import { oboetePaths } from '../../src/paths.js';
import { probeEventStored, runProbes } from '../../src/setup/probe.js';
import { withTempHome } from '../helpers/home.js';

type SpawnCall = {
  command: string;
  args: readonly string[];
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    stdio?: unknown;
  };
};

function probeTargets(userHome: string) {
  return [
    {
      agent: 'claude' as const,
      installed: true,
      configPath: join(userHome, '.claude', 'settings.json'),
    },
    {
      agent: 'codex' as const,
      installed: true,
      configPath: join(userHome, '.codex', 'hooks.json'),
    },
    {
      agent: 'grok' as const,
      installed: true,
      configPath: join(userHome, '.grok', 'hooks', 'oboete.json'),
    },
    {
      agent: 'pi' as const,
      installed: true,
      configPath: join(userHome, '.pi', 'agent', 'extensions', 'oboete.js'),
    },
  ];
}

function closingChild(code: number | null, error?: Error): EventEmitter {
  const child = new EventEmitter();
  queueMicrotask(() => {
    if (error !== undefined) child.emit('error', error);
    else child.emit('close', code, null);
  });
  return child;
}

test('runProbes launches all installed agents in parallel with isolated native homes', async () => {
  await withTempHome(async (home) => {
    const userHome = join(home, 'user');
    const repo = join(home, 'repo');
    const calls: SpawnCall[] = [];
    let active = 0;
    let maxActive = 0;
    const spawnFake = ((command: string, args: readonly string[], options: SpawnCall['options']) => {
      calls.push({ command, args, options });
      active += 1;
      maxActive = Math.max(maxActive, active);
      const child = new EventEmitter();
      setImmediate(() => {
        active -= 1;
        child.emit('close', 0, null);
      });
      return child;
    }) as unknown as typeof spawn;
    const markers = new Map<string, string>();

    const results = await runProbes(probeTargets(userHome), {
      spawn: spawnFake,
      lookupProbe: (agent, marker) => {
        markers.set(agent, marker);
        return true;
      },
      cwd: repo,
      env: { HOME: userHome, PATH: '/test/bin' },
      now: () => 100,
    });

    assert.equal(maxActive, 4);
    assert.equal(new Set(markers.values()).size, 4, 'every agent receives a unique marker');
    assert.deepEqual(
      results,
      ['claude', 'codex', 'grok', 'pi'].map((agent) => ({
        agent,
        status: 'pass',
        elapsedMs: 0,
        reason: 'probe_event_stored',
      })),
    );

    assert.deepEqual(calls.map((call) => call.command), ['claude', 'codex', 'grok', 'pi']);
    assert.deepEqual(calls[0]?.args.slice(0, 1), ['-p']);
    assert.deepEqual(calls[0]?.args.slice(2), [
      '--settings',
      join(userHome, '.claude', 'settings.json'),
      '--dangerously-skip-permissions',
      '--output-format',
      'json',
    ]);
    assert.deepEqual(calls[1]?.args.slice(0, 6), [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '--json',
      '-C',
      repo,
    ]);
    assert.deepEqual(calls[2]?.args.slice(0, 1), ['-p']);
    assert.deepEqual(calls[2]?.args.slice(2), [
      '--always-approve',
      '--output-format',
      'json',
      '--cwd',
      repo,
    ]);
    assert.deepEqual(calls[3]?.args.slice(0, 1), ['-p']);
    assert.deepEqual(calls[3]?.args.slice(2, 4), ['--mode', 'json']);

    for (const [index, agent] of ['claude', 'codex', 'grok', 'pi'].entries()) {
      const args = calls[index]?.args ?? [];
      const prompt = agent === 'codex' ? args.at(-1) : args[1];
      assert.equal(typeof prompt, 'string');
      assert.ok(prompt?.includes(markers.get(agent) ?? ''), agent);
      assert.equal(calls[index]?.options.cwd, repo);
      assert.equal(calls[index]?.options.stdio, 'ignore');
    }
    assert.equal(new Set(calls.map((call) => call.options.signal)).size, 1);
    assert.equal(calls[1]?.options.env?.CODEX_HOME, join(userHome, '.codex'));
    assert.equal(calls[2]?.options.env?.GROK_HOME, join(userHome, '.grok'));
    assert.equal(calls[2]?.options.env?.GROK_CLAUDE_HOOKS_ENABLED, '0');
    assert.equal(calls[2]?.options.env?.GROK_CLAUDE_MCPS_ENABLED, '0');
    assert.equal(calls[2]?.options.env?.GROK_CURSOR_HOOKS_ENABLED, '0');
    assert.equal(calls[2]?.options.env?.GROK_CURSOR_MCPS_ENABLED, '0');
    assert.equal(calls[3]?.options.env?.PI_CODING_AGENT_DIR, join(userHome, '.pi', 'agent'));
    const sessionDir = calls[3]?.args[5];
    assert.equal(typeof sessionDir, 'string');
    assert.equal(existsSync(sessionDir ?? ''), false, 'the temporary Pi session is removed');
  });
});

test('runProbes reports missing, failed, and timed-out agents without launching the missing one', async () => {
  await withTempHome(async (home) => {
    const targets = probeTargets(join(home, 'user'));
    targets[0] = { ...targets[0], installed: false };
    const spawned: string[] = [];
    const spawnFake = ((command: string) => {
      spawned.push(command);
      if (command === 'pi') {
        const error = new Error('deadline');
        error.name = 'TimeoutError';
        return closingChild(null, error);
      }
      return closingChild(command === 'grok' ? 2 : 0);
    }) as unknown as typeof spawn;

    const results = await runProbes(targets, {
      spawn: spawnFake,
      lookupProbe: () => false,
      cwd: join(home, 'repo'),
      env: { HOME: join(home, 'user'), PATH: '/test/bin' },
      now: () => 10,
    });

    assert.deepEqual(spawned, ['codex', 'grok', 'pi']);
    assert.deepEqual(results, [
      { agent: 'claude', status: 'not_installed', elapsedMs: 0, reason: 'agent_not_installed' },
      { agent: 'codex', status: 'fail', elapsedMs: 0, reason: 'probe_event_missing' },
      { agent: 'grok', status: 'fail', elapsedMs: 0, reason: 'agent_exit_2' },
      { agent: 'pi', status: 'timeout', elapsedMs: 0, reason: 'deadline_exceeded' },
    ]);
  });
});

test('runProbes enforces one 90-second deadline even when the spawner ignores its signal', async (context) => {
  await withTempHome(async (home) => {
    const deadline = new AbortController();
    const timeoutCalls: number[] = [];
    context.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
      timeoutCalls.push(milliseconds);
      queueMicrotask(() => deadline.abort(new Error('deadline')));
      return deadline.signal;
    });
    let killed = 0;
    const spawnFake = (() =>
      Object.assign(new EventEmitter(), {
        kill: () => {
          killed += 1;
          return true;
        },
      })) as unknown as typeof spawn;

    const results = await runProbes([probeTargets(join(home, 'user'))[1]!], {
      spawn: spawnFake,
      lookupProbe: () => false,
      cwd: join(home, 'repo'),
      env: { HOME: join(home, 'user'), PATH: '/test/bin' },
      now: () => 10,
    });

    assert.deepEqual(timeoutCalls, [90_000]);
    assert.equal(killed, 1);
    assert.deepEqual(results, [
      { agent: 'codex', status: 'timeout', elapsedMs: 0, reason: 'deadline_exceeded' },
    ]);
  });
});

async function withDatabase(fn: (db: DatabaseSync) => void | Promise<void>): Promise<void> {
  await withTempHome(async (home) => {
    const { db } = openDatabase({ path: oboetePaths(home).db, timeoutMs: 1_000 });
    try {
      db.prepare(
        `INSERT INTO repos (id, identity_kind, normalized_identity, created_at, last_seen_at)
         VALUES ('repo', 'common_dir', '/tmp/repo', 1, 1)`,
      ).run();
      for (const agent of ['claude', 'codex']) {
        db.prepare(
          `INSERT INTO sessions (id, repo_id, agent, native_session_id, conversation_id, status)
           VALUES (?, 'repo', ?, ?, ?, 'active')`,
        ).run(`session-${agent}`, agent, `native-${agent}`, `session-${agent}`);
      }
      await fn(db);
    } finally {
      db.close();
    }
  });
}

test('probeEventStored accepts a marker in either a prompt row or an explicit probe row', async () => {
  await withDatabase((db) => {
    db.prepare(
      `INSERT INTO raw_events
         (id, repo_id, session_id, agent, kind, content, payload_json, sensitivity, classification_state)
       VALUES
         ('prompt', 'repo', 'session-claude', 'claude', 'prompt', 'check marker-prompt now', '{}', 'local_only', 'done'),
         ('probe', 'repo', 'session-codex', 'codex', 'probe', NULL, ?, 'local_only', 'done'),
         ('other', 'repo', 'session-codex', 'codex', 'tool_result', 'marker-wrong-kind', '{}', 'local_only', 'done')`,
    ).run(JSON.stringify({ marker: 'marker-probe' }));

    assert.equal(probeEventStored(db, 'claude', 'marker-prompt'), true);
    assert.equal(probeEventStored(db, 'codex', 'marker-probe'), true);
    assert.equal(probeEventStored(db, 'codex', 'marker-wrong-kind'), false);
    assert.equal(probeEventStored(db, 'grok', 'marker-prompt'), false);
  });
});

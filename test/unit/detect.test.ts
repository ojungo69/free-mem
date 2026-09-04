import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';

import {
  detectAgents,
  type VersionSpawn,
} from '../../src/setup/detect.js';
import { withTempHome } from '../helpers/home.js';

function fakeVersionSpawn(
  versions: Readonly<Record<string, string>>,
  calls: string[],
): VersionSpawn {
  return (command, args, options) => {
    calls.push(`${command} ${args.join(' ')}`);
    assert.equal(options.timeout, 2_000);
    // The CLI is spawned by the absolute path detection resolved, never by the bare name.
    assert.ok(command.startsWith('/'), command);
    const stdout = versions[basename(command)] ?? '';
    return {
      pid: 1,
      output: [null, stdout, ''],
      stdout,
      stderr: '',
      status: 0,
      signal: null,
    };
  };
}

function executable(directory: string, name: string): void {
  const file = join(directory, name);
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
}

test('detectAgents finds PATH CLIs or agent homes and only reports native memory coexistence', async () => {
  await withTempHome(async (home) => {
    const userHome = join(home, 'user');
    const bin = join(home, 'bin');
    mkdirSync(bin, { recursive: true });
    executable(bin, 'claude');
    executable(bin, 'codex');

    const claudeMemory = join(userHome, '.claude', 'projects', 'repo', 'memory');
    const codexMemory = join(userHome, '.codex', 'memories');
    const grokMemory = join(userHome, '.grok', 'memory');
    mkdirSync(claudeMemory, { recursive: true });
    mkdirSync(codexMemory, { recursive: true });
    mkdirSync(grokMemory, { recursive: true });
    mkdirSync(join(userHome, '.grok', 'hooks'), { recursive: true });
    writeFileSync(join(userHome, '.grok', 'hooks', 'oboete.json'), '{}\n');
    for (const directory of [claudeMemory, codexMemory, grokMemory]) {
      writeFileSync(join(directory, 'sentinel'), 'native memory stays unchanged\n');
    }

    const calls: string[] = [];
    const results = await detectAgents(
      { HOME: userHome, PATH: bin },
      fakeVersionSpawn({ claude: '2.1.258\n', codex: 'codex-cli 0.152.1\n' }, calls),
    );

    assert.deepEqual(results, [
      {
        agent: 'claude',
        installed: true,
        cliPath: join(bin, 'claude'),
        version: '2.1.258',
        configPath: join(userHome, '.claude', 'settings.json'),
        trust: 'n/a',
        nativeMemory: 'claude_auto_memory',
      },
      {
        agent: 'codex',
        installed: true,
        cliPath: join(bin, 'codex'),
        version: 'codex-cli 0.152.1',
        configPath: join(userHome, '.codex', 'hooks.json'),
        trust: 'absent',
        nativeMemory: 'codex_memories',
      },
      {
        // The Grok home is left over from an uninstalled CLI: there is configuration to manage
        // but nothing to probe (FR-031).
        agent: 'grok',
        installed: true,
        cliPath: null,
        configPath: join(userHome, '.grok', 'hooks', 'oboete.json'),
        trust: 'wired',
        nativeMemory: 'grok_native_memory',
      },
      {
        agent: 'pi',
        installed: false,
        cliPath: null,
        configPath: join(userHome, '.pi', 'agent', 'extensions', 'oboete.js'),
        trust: 'absent',
        nativeMemory: null,
      },
    ]);
    assert.deepEqual(calls, [
      `${join(bin, 'claude')} --version`,
      `${join(bin, 'codex')} --version`,
    ]);
    for (const directory of [claudeMemory, codexMemory, grokMemory]) {
      assert.equal(readFileSync(join(directory, 'sentinel'), 'utf8'), 'native memory stays unchanged\n');
    }
  });
});

test('Codex trust requires a matching row for every oboete handler', async () => {
  await withTempHome(async (home) => {
    const userHome = join(home, 'user');
    const codexHome = join(userHome, '.codex');
    const hooksPath = join(codexHome, 'hooks.json');
    const configPath = join(codexHome, 'config.toml');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: 'startup|clear|compact',
              hooks: [
                {
                  type: 'command',
                  command: 'node /opt/oboete.mjs hook --agent codex --event SessionStart',
                  timeout: 12,
                  async: true,
                  oboete: true,
                },
              ],
            },
          ],
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'node /opt/oboete.mjs hook --agent codex --event UserPromptSubmit',
                  timeout: 12,
                  oboete: true,
                },
              ],
            },
          ],
        },
      }),
    );
    writeFileSync(
      configPath,
      [
        `[hooks.state."${hooksPath}:session_start:0:0"]`,
        'trusted_hash = "sha256:113f08fe38a57f927461befe41be0866d83b5ac08a9b0d9f82afa80d5d7d9b49"',
        '',
        `[hooks.state."${hooksPath}:user_prompt_submit:0:0"]`,
        'trusted_hash = "sha256:147ba77a83c54e1a14b72c25bfdfd3d2802ed37a490d20d4041ef32502e59c7f"',
        '',
        '[features]',
        'memories = true',
        '',
      ].join('\n'),
    );

    const env = { HOME: userHome, PATH: join(home, 'empty-bin') };
    const trusted = (await detectAgents(env, fakeVersionSpawn({}, [])))[1];
    assert.equal(trusted?.trust, 'trusted');
    assert.equal(trusted?.nativeMemory, 'codex_memories');

    writeFileSync(
      configPath,
      `[hooks.state."${hooksPath}:session_start:0:0"]\ntrusted_hash = "sha256:${'0'.repeat(64)}"\n`,
    );
    const untrusted = (await detectAgents(env, fakeVersionSpawn({}, [])))[1];
    assert.equal(untrusted?.trust, 'untrusted');

    writeFileSync(hooksPath, JSON.stringify({ hooks: { SessionStart: [{ hooks: [] }] } }));
    const absent = (await detectAgents(env, fakeVersionSpawn({}, [])))[1];
    assert.equal(absent?.trust, 'absent');
  });
});

test('malformed Codex files are reported as untrusted without reading a memory store', async () => {
  await withTempHome(async (home) => {
    const userHome = join(home, 'user');
    const codexHome = join(userHome, '.codex');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'hooks.json'), '{');
    writeFileSync(join(codexHome, 'config.toml'), '[features\nmemories = true');

    const codex = (await detectAgents(
      { HOME: userHome, PATH: join(home, 'empty-bin') },
      fakeVersionSpawn({}, []),
    ))[1];
    assert.equal(codex?.installed, true);
    assert.equal(codex?.trust, 'untrusted');
    assert.equal(codex?.nativeMemory, null);
  });
});

test('an empty or relative PATH entry never resolves a CLI from the working directory', async () => {
  await withTempHome(async (home) => {
    const userHome = join(home, 'user');
    const workingDirectory = join(home, 'work');
    const relative = join(workingDirectory, 'node_modules', '.bin');
    mkdirSync(relative, { recursive: true });
    executable(workingDirectory, 'claude');
    executable(relative, 'codex');

    const calls: string[] = [];
    const previous = process.cwd();
    process.chdir(workingDirectory);
    let results;
    try {
      results = await detectAgents(
        { HOME: userHome, PATH: `:${join('node_modules', '.bin')}` },
        fakeVersionSpawn({ claude: '2.1.258\n', codex: 'codex-cli 0.152.1\n' }, calls),
      );
    } finally {
      process.chdir(previous);
    }

    assert.deepEqual(
      results.map((agent) => [agent.agent, agent.installed, agent.cliPath]),
      [
        ['claude', false, null],
        ['codex', false, null],
        ['grok', false, null],
        ['pi', false, null],
      ],
    );
    assert.deepEqual(calls, [], 'a script in the working directory is never executed');
  });
});

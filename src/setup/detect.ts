import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

import { canonicalJson, type AgentName } from '../events.js';
import { sha256Hex } from '../hash.js';

const VERSION_PROBE_TIMEOUT_MS = 2_000;

export type VersionSpawn = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

export type SetupAgent = Exclude<AgentName, 'unknown'>;
export type AgentTrust = 'n/a' | 'trusted' | 'untrusted' | 'wired' | 'absent';
export type NativeMemory =
  | 'codex_memories'
  | 'claude_auto_memory'
  | 'grok_native_memory';

export type AgentDetection = {
  agent: SetupAgent;
  installed: boolean;
  version?: string;
  configPath: string;
  trust: AgentTrust;
  nativeMemory: NativeMemory | null;
};

const handlerSchema = z.looseObject({
  type: z.string().optional(),
  command: z.string().optional(),
  timeout: z.number().optional(),
  async: z.boolean().optional(),
  oboete: z.boolean().optional(),
});

const groupSchema = z.looseObject({
  matcher: z.unknown().optional(),
  hooks: z.array(handlerSchema),
});

const hooksFileSchema = z.looseObject({
  hooks: z.record(z.string(), z.array(groupSchema)),
});

const trustRowSchema = z.looseObject({ trusted_hash: z.string().optional() });
const codexConfigSchema = z.looseObject({
  hooks: z
    .looseObject({ state: z.record(z.string(), trustRowSchema).optional() })
    .optional(),
  features: z.looseObject({ memories: z.boolean().optional() }).optional(),
  memories: z
    .union([
      z.boolean(),
      z.looseObject({
        generate_memories: z.boolean().optional(),
        use_memories: z.boolean().optional(),
      }),
    ])
    .optional(),
});

type CodexConfig = z.infer<typeof codexConfigSchema>;

function userHome(env: NodeJS.ProcessEnv): string {
  return resolve(env.HOME?.trim() || env.USERPROFILE?.trim() || homedir());
}

function configuredHome(env: NodeJS.ProcessEnv, variable: string, fallback: string): string {
  const override = env[variable]?.trim();
  return resolve(override === undefined || override === '' ? fallback : override);
}

function isExecutable(file: string): boolean {
  try {
    return statSync(file).isFile() && (accessSync(file, constants.X_OK), true);
  } catch {
    return false;
  }
}

function resolvesOnPath(command: string, env: NodeJS.ProcessEnv): boolean {
  const pathValue = env.PATH ?? env.Path ?? env.path ?? '';
  const suffixes =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter((suffix) => suffix !== '')
          .map((suffix) => suffix.toLowerCase())
      : [''];
  for (const entry of pathValue.split(delimiter)) {
    const directory = entry.replace(/^"|"$/g, '') || '.';
    for (const suffix of suffixes) {
      if (isExecutable(resolve(directory, `${command}${suffix}`))) return true;
    }
  }
  return false;
}

function firstLine(value: string): string | undefined {
  const line = value.trim().split(/\r?\n/, 1)[0]?.trim();
  return line === undefined || line === '' ? undefined : line;
}

function readVersion(
  command: string,
  env: NodeJS.ProcessEnv,
  spawnFn: VersionSpawn,
): string | undefined {
  const result = spawnFn(command, ['--version'], {
    encoding: 'utf8',
    env,
    timeout: VERSION_PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error !== undefined || result.status !== 0) return undefined;
  return firstLine(result.stdout) ?? firstLine(result.stderr);
}

function readCodexConfig(path: string): CodexConfig | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = codexConfigSchema.safeParse(parseToml(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function snakeCase(event: string): string {
  return event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function handlerTrustHash(
  event: string,
  matcher: unknown,
  handler: { command: string; type: string },
): string {
  const eventName = snakeCase(event);
  const normalized = {
    async: false,
    command: handler.command,
    timeout: eventName === 'session_end' || eventName === 'interrupt' ? 1 : 600,
    type: handler.type,
  };
  const group: Record<string, unknown> = { event_name: eventName, hooks: [normalized] };
  if (matcher !== undefined && matcher !== null) group.matcher = matcher;
  return `sha256:${sha256Hex(canonicalJson(group))}`;
}

function codexTrust(hooksPath: string, config: CodexConfig | null): AgentTrust {
  if (!existsSync(hooksPath)) return 'absent';
  let hooks: z.infer<typeof hooksFileSchema>;
  try {
    const parsed = hooksFileSchema.safeParse(JSON.parse(readFileSync(hooksPath, 'utf8')));
    if (!parsed.success) return 'untrusted';
    hooks = parsed.data;
  } catch {
    return 'untrusted';
  }

  const expected: [key: string, hash: string][] = [];
  let invalid = false;
  for (const [event, groups] of Object.entries(hooks.hooks)) {
    groups.forEach((group, groupIndex) => {
      group.hooks.forEach((handler, handlerIndex) => {
        if (handler.oboete !== true) return;
        const { command, type } = handler;
        if (command === undefined || type === undefined) {
          invalid = true;
          return;
        }
        const key = `${hooksPath}:${snakeCase(event)}:${groupIndex}:${handlerIndex}`;
        expected.push([key, handlerTrustHash(event, group.matcher, { command, type })]);
      });
    });
  }
  if (invalid) return 'untrusted';
  if (expected.length === 0) return 'absent';
  const rows = config?.hooks?.state;
  return expected.every(([key, hash]) => rows?.[key]?.trusted_hash === hash)
    ? 'trusted'
    : 'untrusted';
}

function codexMemoryEnabled(codexHome: string, config: CodexConfig | null): boolean {
  if (existsSync(join(codexHome, 'memories'))) return true;
  if (config?.features?.memories === true || config?.memories === true) return true;
  return (
    typeof config?.memories === 'object' &&
    (config.memories.generate_memories === true || config.memories.use_memories === true)
  );
}

function claudeMemoryEnabled(claudeHome: string): boolean {
  const projects = join(claudeHome, 'projects');
  try {
    return readdirSync(projects).some((project) => existsSync(join(projects, project, 'memory')));
  } catch {
    return false;
  }
}

/** Read-only installed-agent, wiring-trust and native-memory coexistence detection (FR-031/032/043). */
export function detectAgents(
  env: NodeJS.ProcessEnv = process.env,
  spawnFn: VersionSpawn = spawnSync,
): AgentDetection[] {
  const home = userHome(env);
  const claudeHome = configuredHome(env, 'CLAUDE_CONFIG_DIR', join(home, '.claude'));
  const codexHome = configuredHome(env, 'CODEX_HOME', join(home, '.codex'));
  const grokHome = configuredHome(env, 'GROK_HOME', join(home, '.grok'));
  const piHome = configuredHome(env, 'PI_CODING_AGENT_DIR', join(home, '.pi', 'agent'));
  const codexConfig = readCodexConfig(join(codexHome, 'config.toml'));

  const agents: {
    agent: SetupAgent;
    cli: string;
    home: string;
    configPath: string;
    trust: AgentTrust;
    nativeMemory: NativeMemory | null;
  }[] = [
    {
      agent: 'claude',
      cli: 'claude',
      home: claudeHome,
      configPath: join(claudeHome, 'settings.json'),
      trust: 'n/a',
      nativeMemory: claudeMemoryEnabled(claudeHome) ? 'claude_auto_memory' : null,
    },
    {
      agent: 'codex',
      cli: 'codex',
      home: codexHome,
      configPath: join(codexHome, 'hooks.json'),
      trust: codexTrust(join(codexHome, 'hooks.json'), codexConfig),
      nativeMemory: codexMemoryEnabled(codexHome, codexConfig) ? 'codex_memories' : null,
    },
    {
      agent: 'grok',
      cli: 'grok',
      home: grokHome,
      configPath: join(grokHome, 'hooks', 'oboete.json'),
      trust: existsSync(join(grokHome, 'hooks', 'oboete.json')) ? 'wired' : 'absent',
      nativeMemory: existsSync(join(grokHome, 'memory')) ? 'grok_native_memory' : null,
    },
    {
      agent: 'pi',
      cli: 'pi',
      home: piHome,
      configPath: join(piHome, 'extensions', 'oboete.js'),
      trust: existsSync(join(piHome, 'extensions', 'oboete.js')) ? 'wired' : 'absent',
      nativeMemory: null,
    },
  ];

  const onPath = agents.map(({ cli }) => resolvesOnPath(cli, env));
  const versions = agents.map(({ cli }, index) =>
    onPath[index] ? readVersion(cli, env, spawnFn) : undefined,
  );
  return agents.map((entry, index) => ({
    agent: entry.agent,
    installed: onPath[index] === true || existsSync(entry.home),
    ...(versions[index] === undefined ? {} : { version: versions[index] }),
    configPath: entry.configPath,
    trust: entry.trust,
    nativeMemory: entry.nativeMemory,
  }));
}

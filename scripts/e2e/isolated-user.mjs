#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs as parseNodeArgs } from "node:util";
import { fileURLToPath } from "node:url";

import {
  GROK_ISOLATION_ENV,
  childEnv,
  copyMode,
  finalText,
  gitInit,
  redactValue,
  runTimed,
  shellQuote,
} from "./probe-lib/agents.mjs";

export const AGENTS = ["claude", "codex", "grok", "pi"];

const AGENT_SET = new Set(AGENTS);
const TOTAL_PAIRS = AGENTS.length * (AGENTS.length - 1);
const DEFAULT_TIMEOUT_MS = 120_000;
const SYNTHETIC_REMOTE = "https://example.invalid/oboete-e2e.git";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");

class PreconditionError extends Error {
  constructor(message) {
    super(message);
    this.name = "PreconditionError";
  }
}

function usage() {
  return `Usage: node scripts/e2e/isolated-user.mjs [options]

Options:
  --pairs all|A:B[,A:B...]  Ordered agent pairs (default: all).
  --no-credentials          Remove oboete provider credentials and use fallback summaries.
  --daily                   Append this run to docs/evidence/m1-dogfood.md.
  --timeout <s>             Agent and summary deadline in seconds (default: 120).
  --run-dir <path>          Store this run at an explicit path.
  -h, --help                Show this help.
`;
}

export function enumeratePairs(spec) {
  if (spec === "all") {
    return AGENTS.flatMap((from) => AGENTS.filter((to) => to !== from).map((to) => ({ from, to })));
  }
  if (typeof spec !== "string" || spec.trim() === "") {
    throw new Error("--pairs must be 'all' or a comma-separated A:B list");
  }

  const pairs = [];
  const seen = new Set();
  for (const item of spec.split(",")) {
    const parts = item.split(":").map((value) => value.trim().toLowerCase());
    if (parts.length !== 2 || parts.some((value) => value === "")) {
      throw new Error(`invalid pair '${item}'; expected A:B`);
    }
    const [from, to] = parts;
    if (!AGENT_SET.has(from) || !AGENT_SET.has(to)) {
      throw new Error(`unknown agent in pair '${item}'; use ${AGENTS.join(", ")}`);
    }
    if (from === to) throw new Error(`pair '${item}' must name two distinct agents`);
    const key = `${from}:${to}`;
    if (seen.has(key)) throw new Error(`duplicate pair '${key}'`);
    seen.add(key);
    pairs.push({ from, to });
  }
  return pairs;
}

export function parseArguments(argv) {
  // main() turns anything thrown here into the usage message and exit 2, so the message Node's
  // own parseArgs writes for an unknown option is the one the developer sees.
  const { values } = parseNodeArgs({
    args: argv,
    strict: true,
    options: {
      pairs: { type: "string", default: "all" },
      "no-credentials": { type: "boolean", default: false },
      daily: { type: "boolean", default: false },
      timeout: { type: "string", default: String(DEFAULT_TIMEOUT_MS / 1000) },
      "run-dir": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (!/^[1-9]\d*$/.test(values.timeout)) {
    throw new Error("--timeout must be a positive integer number of seconds");
  }
  const timeoutMs = Number(values.timeout) * 1000;
  if (!Number.isSafeInteger(timeoutMs)) {
    throw new Error("--timeout must be a positive integer number of seconds");
  }
  if (values["run-dir"] !== undefined && values["run-dir"].trim() === "") {
    throw new Error("--run-dir must not be empty");
  }

  return {
    pairs: enumeratePairs(values.pairs),
    noCredentials: values["no-credentials"],
    daily: values.daily,
    timeoutMs,
    runDir: values["run-dir"] ?? null,
    help: values.help,
  };
}

export function buildFactSeedingPrompt(facts) {
  if (!Array.isArray(facts) || facts.length !== 3 || facts.some((fact) => typeof fact !== "string" || fact === "")) {
    throw new TypeError("fact seeding requires exactly three non-empty strings");
  }
  const command = `printf '%s\\n' ${facts.map(shellQuote).join(" ")} >> NOTES.md`;
  return [
    "These three exact strings are durable facts about this repository. Preserve them verbatim:",
    ...facts,
    "Use exactly one tool call and no other tools. In that one call, use the shell tool to run:",
    command,
    "After the tool result, reply on one line with the same three exact strings joined by |.",
  ].join("\n");
}

export function assertAgentOutput(output, facts, { requireDegraded = false } = {}) {
  const text = String(output).normalize("NFC");
  const normalize = (value) => String(value).normalize("NFC").replace(/\s+/gu, " ").trim();
  const normalizedOutput = normalize(text);
  const missingFacts = facts.filter((fact) => !normalizedOutput.includes(normalize(fact)));
  const degradedMarker = text
    .split(/\r?\n/u)
    .some((line) => /^>\s*degraded:\s+.*\brule-based notes\.\s*$/iu.test(line.trim()));
  return {
    pass: missingFacts.length === 0 && (!requireDegraded || degradedMarker),
    missingFacts,
    degradedMarker,
  };
}

function factSet(runId, pair) {
  const stem = `fact-${runId}-${pair.from}-to-${pair.to}`;
  return [
    `${stem}-1: the build token is cedar.`,
    `${stem}-2: the release bird is heron.`,
    `${stem}-3: 配布色は琥珀。`,
  ];
}

function recallPrompt(agent, noCredentials) {
  const tool = {
    claude: "Use the Read tool exactly once on NOTES.md.",
    codex: "Use the shell tool exactly once to run: sed -n '1,20p' NOTES.md",
    grok: "Use the read_file tool exactly once on NOTES.md.",
    pi: "Use the read tool exactly once on NOTES.md.",
  }[agent];
  const timing =
    agent === "grok"
      ? "The oboete memory context is delivered with that first tool result; use the fact lines inside its markers."
      : "Before the tool call, remember the fact lines already present inside the oboete memory context markers.";
  return [
    timing,
    tool,
    "Make no other tool call.",
    "After the result, reply with every remembered fact line verbatim, joined by |. Do not derive the answer from NOTES.md.",
    ...(noCredentials
      ? ["Also copy the complete > degraded: line from the oboete memory context onto its own line."]
      : []),
  ].join("\n");
}

export function createReport({
  runId,
  runDir,
  startedAt,
  finishedAt,
  noCredentials,
  timeoutMs,
  daily = false,
  requestedPairs,
  results,
}) {
  const passed = results.filter((result) => result.status === "pass").length;
  const report = {
    runId,
    runDir,
    started_at: startedAt,
    finished_at: finishedAt,
    no_credentials: noCredentials,
    daily,
    timeout_seconds: timeoutMs / 1000,
    requested_pairs: requestedPairs,
    total_pairs: TOTAL_PAIRS,
    // SC-001 is the twelve-pair run, so only a twelve-pair run may report against twelve; a
    // shorter run says so, because this line is what --daily writes into the evidence file.
    summary:
      requestedPairs === TOTAL_PAIRS
        ? `${passed} of ${TOTAL_PAIRS} pairs pass`
        : `${passed} of ${requestedPairs} requested pairs pass (partial run; SC-001 needs all ${TOTAL_PAIRS})`,
    pairs: results.map((result) => ({
      agents: { seed: result.from, receive: result.to },
      elapsed_ms: result.elapsedMs,
      status: result.status,
      missing_facts: result.missingFacts,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(result.degradedMarker === undefined ? {} : { degraded_marker: result.degradedMarker }),
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(result.searchAttempts === undefined ? {} : { search_attempts: result.searchAttempts }),
    })),
  };
  return redactValue(report, runDir, "<run>");
}

function configuredHome(env, name, fallback) {
  const value = env[name]?.trim();
  return value ? path.resolve(value) : fallback;
}

export function resolveSourceHomes(env, home) {
  const homes = {
    oboete: configuredHome(env, "OBOETE_HOME", path.join(home, ".oboete")),
    claude: configuredHome(env, "CLAUDE_CONFIG_DIR", path.join(home, ".claude")),
    codex: configuredHome(env, "CODEX_HOME", path.join(home, ".codex")),
    grok: configuredHome(env, "GROK_HOME", path.join(home, ".grok")),
    pi: configuredHome(env, "PI_CODING_AGENT_DIR", path.join(home, ".pi", "agent")),
  };
  const realHome = fs.realpathSync(home);
  for (const [name, configured] of Object.entries(homes)) {
    const target = fs.existsSync(configured) ? fs.realpathSync(configured) : path.resolve(configured);
    const relative = path.relative(realHome, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new PreconditionError(`${name} setup home escapes the isolated account: ${configured}`);
    }
  }
  return homes;
}

/**
 * A Codex trust key is `<absolute hooks.json path>:<snake_case event>:<group>:<handler>` and the
 * hash covers the handler group alone (src/setup/codex-trust.ts), so the copy of the developer's
 * config.toml keeps the trust setup wrote once each key names the copy of hooks.json. Without this
 * every copied row still names the original path, no row can ever match, and Codex skips the oboete
 * hooks in silence (FR-031). That is what --dangerously-bypass-hook-trust used to hide, and hiding
 * it meant the dogfood run could not see a trust regression at all.
 */
export function retargetCodexTrust(configText, sourceHooksPath, destinationHooksPath) {
  // A TOML basic string takes the escapes JSON produces, which is how setup wrote the key.
  const from = JSON.stringify(sourceHooksPath).slice(1, -1);
  const to = JSON.stringify(destinationHooksPath).slice(1, -1);
  let rows = 0;
  const retargeted = configText.replace(
    /^([ \t]*\[hooks\.state\.")(.*)("\][ \t]*)$/gmu,
    (line, head, key, tail) => {
      if (!key.startsWith(`${from}:`)) return line;
      rows += 1;
      return `${head}${to}${key.slice(from.length)}${tail}`;
    },
  );
  if (rows === 0) {
    throw new PreconditionError(
      `no Codex trust row names ${sourceHooksPath}; run oboete setup in the isolated account`,
    );
  }
  return retargeted;
}

function copySetupFile(source, destination, required = false) {
  if (!fs.existsSync(source)) {
    if (required) throw new PreconditionError(`missing setup file: ${source}`);
    return;
  }
  copyMode(source, destination, fs.statSync(source).mode & 0o7777);
}

function prepareOboeteHome(destination, source) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  copySetupFile(path.join(source, "config.toml"), path.join(destination, "config.toml"), true);
}

function prepareAgent(agent, directory, homes, prompt, repo) {
  const config = path.join(directory, "agent-home");
  switch (agent) {
    case "claude": {
      const settings = path.join(config, "settings.json");
      copySetupFile(path.join(homes.claude, "settings.json"), settings, true);
      return {
        argv: [
          "claude",
          "-p",
          prompt,
          "--settings",
          settings,
          "--dangerously-skip-permissions",
          "--output-format",
          "json",
        ],
        env: {},
      };
    }
    case "codex": {
      for (const file of ["auth.json", "config.toml", "hooks.json"]) {
        copySetupFile(path.join(homes.codex, file), path.join(config, file), file !== "auth.json");
      }
      const configToml = path.join(config, "config.toml");
      fs.writeFileSync(
        configToml,
        retargetCodexTrust(
          fs.readFileSync(configToml, "utf8"),
          path.join(homes.codex, "hooks.json"),
          path.join(config, "hooks.json"),
        ),
      );
      return {
        argv: [
          "codex",
          "exec",
          "--dangerously-bypass-approvals-and-sandbox",
          "--skip-git-repo-check",
          "--json",
          "-C",
          repo,
          prompt,
        ],
        env: { CODEX_HOME: config },
      };
    }
    case "grok": {
      copySetupFile(path.join(homes.grok, "auth.json"), path.join(config, "auth.json"));
      copySetupFile(path.join(homes.grok, "config.toml"), path.join(config, "config.toml"), true);
      copySetupFile(
        path.join(homes.grok, "hooks", "oboete.json"),
        path.join(config, "hooks", "oboete.json"),
        true,
      );
      return {
        argv: ["grok", "-p", prompt, "--always-approve", "--output-format", "json", "--cwd", repo],
        env: { GROK_HOME: config, ...GROK_ISOLATION_ENV },
      };
    }
    case "pi": {
      for (const file of ["auth.json", "settings.json", "models-store.json"]) {
        copySetupFile(path.join(homes.pi, file), path.join(config, file));
      }
      copySetupFile(
        path.join(homes.pi, "extensions", "oboete.js"),
        path.join(config, "extensions", "oboete.js"),
        true,
      );
      const sessions = path.join(directory, "pi-sessions");
      fs.mkdirSync(sessions, { recursive: true });
      return {
        argv: ["pi", "-p", prompt, "--mode", "json", "--session-dir", sessions],
        env: { PI_CODING_AGENT_DIR: config },
      };
    }
    default:
      throw new Error(`unknown agent: ${agent}`);
  }
}

async function launchAgent(agent, directory, repo, prompt, options, homes, dependencies, oboeteHome) {
  fs.mkdirSync(directory, { recursive: true });
  const prepared = prepareAgent(agent, directory, homes, prompt, repo);
  const stdoutPath = path.join(directory, "stdout.txt");
  const stderrPath = path.join(directory, "stderr.txt");
  const proc = await dependencies.runTimed(prepared.argv, {
    cwd: repo,
    // An agent CLI runs the developer's shell tools; childEnv keeps the credentials out of it.
    env: dependencies.childEnv({ OBOETE_HOME: oboeteHome, ...prepared.env }),
    stdoutPath,
    stderrPath,
    timeoutMs: options.timeoutMs,
  });
  return { ...proc, stdoutPath, stderrPath };
}

/** `oboete search --json` always answers with `{ memories: [...] }` (src/memories-cli.ts). */
function searchContainsFacts(output, facts) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return false;
  }
  return (parsed?.memories ?? []).some((row) => assertAgentOutput(JSON.stringify(row), facts).pass);
}

async function waitForSummary(repo, directory, facts, options, dependencies, env) {
  fs.mkdirSync(directory, { recursive: true });
  const stdoutPath = path.join(directory, "stdout.txt");
  const stderrPath = path.join(directory, "stderr.txt");
  const deadline = dependencies.now() + options.timeoutMs;
  let attempts = 0;
  while (dependencies.now() < deadline) {
    attempts += 1;
    const remaining = deadline - dependencies.now();
    const result = await dependencies.runTimed(["oboete", "search", facts[0], "--json"], {
      cwd: repo,
      env,
      stdoutPath,
      stderrPath,
      timeoutMs: Math.min(15_000, remaining),
    });
    if (result.exitCode === 0 && searchContainsFacts(result.stdout, facts)) {
      return { found: true, attempts };
    }
    if (result.exitCode === 3) return { found: false, attempts };
    const wait = Math.min(1_000, deadline - dependencies.now());
    if (wait > 0) await dependencies.sleep(wait);
  }
  return { found: false, attempts };
}

function resultPaths(pairDir) {
  return {
    stdout: {
      seed: path.join(pairDir, "seed", "stdout.txt"),
      receive: path.join(pairDir, "receive", "stdout.txt"),
    },
    stderr: {
      seed: path.join(pairDir, "seed", "stderr.txt"),
      receive: path.join(pairDir, "receive", "stderr.txt"),
    },
  };
}

async function runPair(pair, context) {
  const { options, runId, runDir, homes, dependencies } = context;
  const started = dependencies.now();
  const pairDir = path.join(runDir, `${pair.from}-to-${pair.to}`);
  const paths = resultPaths(pairDir);
  const facts = factSet(runId, pair);
  const finish = (status, missingFacts, details = {}) => ({
    ...pair,
    elapsedMs: Math.max(0, dependencies.now() - started),
    status,
    missingFacts,
    ...paths,
    ...details,
  });

  try {
    fs.mkdirSync(pairDir, { recursive: true, mode: 0o700 });
    const repo = dependencies.gitInit(path.join(pairDir, "repo"));
    const git = await dependencies.runTimed(["git", "config", "remote.origin.url", SYNTHETIC_REMOTE], {
      cwd: repo,
      env: dependencies.childEnv(),
      stdoutPath: path.join(pairDir, "git.stdout.txt"),
      stderrPath: path.join(pairDir, "git.stderr.txt"),
      timeoutMs: Math.min(15_000, options.timeoutMs),
    });
    if (git.exitCode !== 0) return finish("fail", facts, { reason: `git_remote_exit_${git.exitCode}` });

    const oboeteHome = path.join(pairDir, "oboete-home");
    prepareOboeteHome(oboeteHome, homes.oboete);
    // FR-016: `oboete observe` is the one leg that reaches a provider, so it is the one leg that
    // asks for the credentials; --no-credentials is the run that takes them away from it.
    const env = dependencies.childEnv(
      { OBOETE_HOME: oboeteHome },
      { credentials: !options.noCredentials },
    );

    dependencies.log(`[${pair.from}:${pair.to}] seed`);
    const seeded = await launchAgent(
      pair.from,
      path.join(pairDir, "seed"),
      repo,
      buildFactSeedingPrompt(facts),
      options,
      homes,
      dependencies,
      oboeteHome,
    );
    if (seeded.exitCode !== 0) {
      return finish("fail", facts, { reason: `seed_agent_exit_${seeded.exitCode}` });
    }

    const notes = path.join(repo, "NOTES.md");
    const noteCheck = assertAgentOutput(fs.existsSync(notes) ? fs.readFileSync(notes, "utf8") : "", facts);
    if (!noteCheck.pass) {
      return finish("fail", noteCheck.missingFacts, { reason: "seed_file_missing_facts" });
    }

    const observe = await dependencies.runTimed(["oboete", "observe"], {
      cwd: repo,
      env,
      stdoutPath: path.join(pairDir, "observe.stdout.txt"),
      stderrPath: path.join(pairDir, "observe.stderr.txt"),
      timeoutMs: options.timeoutMs,
    });
    if (![0, 1].includes(observe.exitCode)) {
      return finish("fail", facts, { reason: `observe_exit_${observe.exitCode}` });
    }

    const search = await waitForSummary(repo, path.join(pairDir, "search"), facts, options, dependencies, env);
    if (!search.found) {
      return finish("fail", facts, { reason: "summary_not_found", searchAttempts: search.attempts });
    }

    // B must learn the facts from oboete, not from the required NOTES.md read itself.
    fs.writeFileSync(notes, "The seeded facts are intentionally hidden during the recall check.\n");

    dependencies.log(`[${pair.from}:${pair.to}] receive`);
    const received = await launchAgent(
      pair.to,
      path.join(pairDir, "receive"),
      repo,
      recallPrompt(pair.to, options.noCredentials),
      options,
      homes,
      dependencies,
      oboeteHome,
    );
    if (received.exitCode !== 0) {
      return finish("fail", facts, {
        reason: `receive_agent_exit_${received.exitCode}`,
        searchAttempts: search.attempts,
      });
    }
    const assertion = assertAgentOutput(finalText(pair.to, received, []), facts, {
      requireDegraded: options.noCredentials,
    });
    return finish(assertion.pass ? "pass" : "fail", assertion.missingFacts, {
      ...(assertion.pass
        ? {}
        : {
            reason:
              assertion.missingFacts.length > 0
                ? "facts_missing_from_first_turn"
                : "degraded_marker_missing_from_first_turn",
          }),
      degradedMarker: assertion.degradedMarker,
      searchAttempts: search.attempts,
    });
  } catch (error) {
    return finish(error instanceof PreconditionError ? "skipped" : "fail", facts, {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function runIdNow(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function markdownSection(report) {
  let markdown = `## ${report.started_at.slice(0, 10)} run ${report.runId}\n\n`;
  markdown += `- ${report.summary}\n`;
  markdown += `- No provider credentials: ${report.no_credentials ? "yes" : "no"}\n`;
  markdown += `- Report: ${report.runDir}/report.json\n\n`;
  markdown += "| seed | receive | status | elapsed ms | missing facts |\n|---|---|---:|---:|---|\n";
  for (const pair of report.pairs) {
    markdown += `| ${pair.agents.seed} | ${pair.agents.receive} | ${pair.status} | ${pair.elapsed_ms} | ${pair.missing_facts.join("; ") || "none"} |\n`;
  }
  return `${markdown}\n`;
}

function writeDaily(report, repoRoot) {
  const destination = path.join(repoRoot, "docs", "evidence", "m1-dogfood.md");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const heading = fs.existsSync(destination)
    ? ""
    : "# oboete M1 dogfood evidence\n\nIsolated-user cross-agent runs for SC-001, SC-004, and SC-007.\n\n";
  fs.appendFileSync(destination, heading + markdownSection(report));
}

export async function runHarness(options, overrides = {}) {
  const dependencies = {
    runTimed,
    gitInit,
    childEnv,
    sleep,
    now: Date.now,
    env: process.env,
    home: os.homedir(),
    repoRoot: REPO_ROOT,
    log: (message) => console.error(message),
    ...overrides,
  };
  const started = new Date(dependencies.now());
  const runId = runIdNow(started);
  const runDir = path.resolve(options.runDir ?? path.join(dependencies.home, ".cache", "oboete-e2e", runId));
  const homes = resolveSourceHomes(dependencies.env, dependencies.home);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });

  const results = [];
  const reportNow = () =>
    createReport({
      runId,
      runDir,
      startedAt: started.toISOString(),
      finishedAt: new Date(dependencies.now()).toISOString(),
      noCredentials: options.noCredentials,
      daily: options.daily,
      timeoutMs: options.timeoutMs,
      requestedPairs: options.pairs.length,
      results,
    });
  for (const pair of options.pairs) {
    results.push(await runPair(pair, { options, runId, runDir, homes, dependencies }));
    const report = reportNow();
    fs.writeFileSync(path.join(runDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  }

  const report = reportNow();
  if (options.daily) writeDaily(report, dependencies.repoRoot);
  return report;
}

async function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage()}`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }
  const account = os.userInfo();
  if (account.username !== "oboete-dogfood") {
    process.stderr.write("Refusing to run outside the isolated oboete-dogfood user.\n");
    return 1;
  }
  if (path.resolve(os.homedir()) !== path.resolve(account.homedir)) {
    process.stderr.write("Refusing to run because HOME is not the oboete-dogfood account home; use sudo -H.\n");
    return 1;
  }

  try {
    const report = await runHarness(options);
    process.stdout.write(`${report.summary}\n`);
    return report.pairs.every((pair) => pair.status === "pass") ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}

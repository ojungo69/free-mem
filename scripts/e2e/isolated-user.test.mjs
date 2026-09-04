import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertAgentOutput,
  buildFactSeedingPrompt,
  createReport,
  enumeratePairs,
  parseArguments,
  resolveSourceHomes,
  retargetCodexTrust,
  runHarness,
} from "./isolated-user.mjs";

test("parseArguments accepts the T054 flags", () => {
  const options = parseArguments([
    "--pairs",
    "claude:codex,grok:pi",
    "--no-credentials",
    "--daily",
    "--timeout",
    "45",
    "--run-dir",
    "/tmp/oboete-run",
  ]);

  assert.deepEqual(options.pairs, [
    { from: "claude", to: "codex" },
    { from: "grok", to: "pi" },
  ]);
  assert.equal(options.noCredentials, true);
  assert.equal(options.daily, true);
  assert.equal(options.timeoutMs, 45_000);
  assert.equal(options.runDir, "/tmp/oboete-run");
});

test("parseArguments defaults to all pairs and rejects invalid usage", () => {
  assert.equal(parseArguments([]).pairs.length, 12);
  assert.throws(() => parseArguments(["--timeout", "0"]), /positive integer/);
  assert.throws(() => parseArguments(["--wat"]), /Unknown option/);
});

test("resolveSourceHomes keeps every configured source inside the isolated account", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oboete-isolated-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  assert.equal(resolveSourceHomes({ CODEX_HOME: path.join(home, "codex") }, home).codex, path.join(home, "codex"));
  assert.throws(
    () => resolveSourceHomes({ GROK_HOME: path.resolve(home, "..", "maintainer-grok") }, home),
    /escapes the isolated account/,
  );
});

test("enumeratePairs returns all 12 ordered cross-agent pairs", () => {
  assert.deepEqual(enumeratePairs("all"), [
    { from: "claude", to: "codex" },
    { from: "claude", to: "grok" },
    { from: "claude", to: "pi" },
    { from: "codex", to: "claude" },
    { from: "codex", to: "grok" },
    { from: "codex", to: "pi" },
    { from: "grok", to: "claude" },
    { from: "grok", to: "codex" },
    { from: "grok", to: "pi" },
    { from: "pi", to: "claude" },
    { from: "pi", to: "codex" },
    { from: "pi", to: "grok" },
  ]);
  assert.throws(() => enumeratePairs("claude:claude"), /distinct agents/);
  assert.throws(() => enumeratePairs("claude:codex,claude:codex"), /duplicate pair/);
});

test("buildFactSeedingPrompt asks for one append tool call and preserves every fact", () => {
  const facts = [
    "fact-run-1: the build token is cedar",
    "fact-run-2: the release bird is heron",
    "fact-run-3: 配布色は琥珀",
  ];
  const prompt = buildFactSeedingPrompt(facts);

  assert.match(prompt, /exactly one tool call/i);
  assert.match(prompt, />> NOTES\.md/);
  for (const fact of facts) assert.ok(prompt.includes(fact), fact);
});

test("assertAgentOutput reports only facts absent from normalized output", () => {
  const facts = ["fact-one: cedar", "fact-two: heron", "fact-three: 琥珀"];

  assert.deepEqual(
    assertAgentOutput("fact-one: cedar\nfact-two:   heron\nfact-three: 琥珀", facts),
    { pass: true, missingFacts: [], degradedMarker: false },
  );
  assert.deepEqual(assertAgentOutput("fact-one: cedar; fact-three: 琥珀", facts), {
    pass: false,
    missingFacts: ["fact-two: heron"],
    degradedMarker: false,
  });
  assert.deepEqual(
    assertAgentOutput("fact-one: cedar; fact-two: heron; fact-three: 琥珀", facts, {
      requireDegraded: true,
    }),
    { pass: false, missingFacts: [], degradedMarker: false },
  );
  assert.deepEqual(
    assertAgentOutput(
      "fact-one: cedar; fact-two: heron; fact-three: 琥珀\n> degraded: No summarizer is configured, so these are rule-based notes.",
      facts,
      { requireDegraded: true },
    ),
    { pass: true, missingFacts: [], degradedMarker: true },
  );
  assert.equal(
    assertAgentOutput(
      "fact-one: cedar; fact-two: heron; fact-three: 琥珀\nNo > degraded: line with rule-based notes was present.",
      facts,
      { requireDegraded: true },
    ).pass,
    false,
  );
});

test("createReport records degraded-marker evidence when supplied", () => {
  const report = createReport({
    runId: "run",
    runDir: "/tmp/run",
    startedAt: "2026-09-04T12:00:00.000Z",
    finishedAt: "2026-09-04T12:00:01.000Z",
    noCredentials: true,
    timeoutMs: 120_000,
    requestedPairs: 1,
    results: [
      {
        from: "claude",
        to: "grok",
        elapsedMs: 1_000,
        status: "pass",
        missingFacts: [],
        degradedMarker: true,
        stdout: {},
        stderr: {},
      },
    ],
  });

  assert.equal(report.pairs[0].degraded_marker, true);
});

test("createReport has the required pair shape and redacts the run directory", () => {
  const report = createReport({
    runId: "2026-09-04T12-00-00-000Z",
    runDir: "/tmp/private-run",
    startedAt: "2026-09-04T12:00:00.000Z",
    finishedAt: "2026-09-04T12:00:03.000Z",
    noCredentials: false,
    timeoutMs: 120_000,
    requestedPairs: 2,
    results: [
      {
        from: "claude",
        to: "codex",
        elapsedMs: 3_000,
        status: "pass",
        missingFacts: [],
        stdout: {
          seed: "/tmp/private-run/claude-to-codex/seed/stdout.txt",
          receive: "/tmp/private-run/claude-to-codex/receive/stdout.txt",
        },
        stderr: {
          seed: "/tmp/private-run/claude-to-codex/seed/stderr.txt",
          receive: "/tmp/private-run/claude-to-codex/receive/stderr.txt",
        },
      },
    ],
  });

  assert.equal(report.runDir, "<run>");
  assert.equal(report.summary, "1 of 2 requested pairs pass (partial run; SC-001 needs all 12)");
  assert.deepEqual(report.pairs[0].agents, { seed: "claude", receive: "codex" });
  assert.equal(report.pairs[0].elapsed_ms, 3_000);
  assert.equal(report.pairs[0].status, "pass");
  assert.deepEqual(report.pairs[0].missing_facts, []);
  assert.equal(report.pairs[0].stdout.seed, "<run>/claude-to-codex/seed/stdout.txt");
  assert.ok(!JSON.stringify(report).includes("/tmp/private-run"));
});

test("createReport counts the pairs the run asked for and keeps 12 as the SC-001 target", () => {
  const result = (index) => ({
    from: "claude",
    to: "codex",
    elapsedMs: index,
    status: "pass",
    missingFacts: [],
    stdout: {},
    stderr: {},
  });
  const base = {
    runId: "run",
    runDir: "/tmp/run",
    startedAt: "2026-09-04T12:00:00.000Z",
    finishedAt: "2026-09-04T12:00:01.000Z",
    noCredentials: false,
    timeoutMs: 120_000,
  };

  const full = createReport({
    ...base,
    requestedPairs: 12,
    results: Array.from({ length: 12 }, (unused, index) => result(index)),
  });
  assert.equal(full.summary, "12 of 12 pairs pass");
  assert.equal(full.requested_pairs, 12);

  // Mid-run report of that same full run: honest about the denominator it is still working towards.
  const partial = createReport({
    ...base,
    requestedPairs: 12,
    results: [result(0), result(1)],
  });
  assert.equal(partial.summary, "2 of 12 pairs pass");

  const single = createReport({ ...base, requestedPairs: 1, results: [result(0)] });
  assert.equal(single.summary, "1 of 1 requested pairs pass (partial run; SC-001 needs all 12)");
  assert.equal(single.requested_pairs, 1);
  assert.equal(single.total_pairs, 12);
});

test("retargetCodexTrust points the copied trust rows at the copied hooks.json", () => {
  const source = "/home/oboete-dogfood/.codex/hooks.json";
  const copy = "/run/pair/seed/agent-home/hooks.json";
  const config = [
    "[mcp_servers.oboete]",
    'command = "node"',
    "",
    `[hooks.state."${source}:session_start:0:0"]`,
    'trusted_hash = "sha256:aaa"',
    "",
    `[hooks.state."${source}:pre_tool_use:1:0"]`,
    'trusted_hash = "sha256:bbb"',
    "",
    '[hooks.state."/home/oboete-dogfood/.codex/other-hooks.json:stop:0:0"]',
    'trusted_hash = "sha256:ccc"',
    "",
  ].join("\n");

  const retargeted = retargetCodexTrust(config, source, copy);

  assert.ok(retargeted.includes(`[hooks.state."${copy}:session_start:0:0"]`));
  assert.ok(retargeted.includes(`[hooks.state."${copy}:pre_tool_use:1:0"]`));
  // The hash covers the handler group alone, so the rows keep the value setup computed.
  assert.ok(retargeted.includes('trusted_hash = "sha256:aaa"'));
  assert.ok(!retargeted.includes(`"${source}:`));
  // A row naming a different hooks file is not this harness's to move.
  assert.ok(retargeted.includes('[hooks.state."/home/oboete-dogfood/.codex/other-hooks.json:stop:0:0"]'));
  assert.equal(retargeted.split("\n").length, config.split("\n").length);
});

test("retargetCodexTrust refuses a config that trusts no oboete hook", () => {
  assert.throws(
    () => retargetCodexTrust('[mcp_servers.oboete]\ncommand = "node"\n', "/h/.codex/hooks.json", "/run/hooks.json"),
    (error) => error.name === "PreconditionError" && /no Codex trust row names/.test(error.message),
  );
});

/**
 * One isolated account, standing in for the dogfood user: only the files the harness copies.
 * The Codex trust row is the one `oboete setup` writes, keyed by the account's own hooks.json.
 */
function isolatedAccount(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oboete-account-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hooksPath = path.join(home, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(
    hooksPath,
    JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "oboete hook" }], oboete: true }] },
    }),
  );
  fs.writeFileSync(
    path.join(home, ".codex", "config.toml"),
    `[mcp_servers.oboete]\ncommand = "node"\n\n[hooks.state."${hooksPath}:session_start:0:0"]\ntrusted_hash = "sha256:aaa"\n`,
  );
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}\n");
  fs.mkdirSync(path.join(home, ".oboete"), { recursive: true });
  fs.writeFileSync(path.join(home, ".oboete", "config.toml"), "[observer]\npreset = \"nim\"\n");
  return { home, hooksPath };
}

/** Every child the harness would spawn, recorded; the agents behave the way a passing pair does. */
function recordingDependencies(home) {
  const calls = [];
  let facts = [];
  return {
    calls,
    gitInit: (repo) => {
      fs.mkdirSync(repo, { recursive: true });
      return repo;
    },
    childEnv: (extra = {}) => ({
      PATH: "/usr/bin",
      HOME: home,
      OBOETE_NIM_API_KEY: "nim-secret",
      OBOETE_CF_API_TOKEN: "cf-secret",
      OBOETE_CF_ACCOUNT_ID: "cf-account",
      ...extra,
    }),
    runTimed: async (argv, options) => {
      calls.push({ argv, env: options.env, cwd: options.cwd });
      const prompt = argv.find((word) => word.includes("durable facts about this repository"));
      if (prompt) {
        facts = prompt.split("\n").slice(1, 4);
        fs.writeFileSync(path.join(options.cwd, "NOTES.md"), `${facts.join("\n")}\n`);
      }
      const stdout =
        argv[0] === "oboete" && argv[1] === "search"
          ? JSON.stringify([{ text: facts.join(" ") }])
          : JSON.stringify({ result: facts.join(" | ") });
      return { exitCode: 0, signal: null, elapsedMs: 1, stdout, stderr: "" };
    },
    sleep: async () => {},
    now: () => Date.parse("2026-09-05T09:00:00.000Z"),
    env: {},
    home,
    repoRoot: home,
    log: () => {},
  };
}

test("runHarness keeps oboete credentials off every agent and trusts the copied Codex hooks", async (t) => {
  const account = isolatedAccount(t);
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "oboete-run-"));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const dependencies = recordingDependencies(account.home);

  const report = await runHarness(
    {
      pairs: [{ from: "codex", to: "claude" }],
      noCredentials: false,
      daily: false,
      timeoutMs: 120_000,
      runDir,
    },
    dependencies,
  );

  assert.equal(report.pairs[0].status, "pass", JSON.stringify(report.pairs[0].reason));
  assert.equal(report.summary, "1 of 1 requested pairs pass (partial run; SC-001 needs all 12)");

  // FR-016: an agent CLI never sees oboete's provider credentials, credentials or not in this run.
  for (const agent of ["codex", "claude"]) {
    const call = dependencies.calls.find((entry) => entry.argv[0] === agent);
    assert.ok(call, agent);
    assert.equal(call.env.OBOETE_NIM_API_KEY, undefined, agent);
    assert.equal(call.env.OBOETE_CF_API_TOKEN, undefined, agent);
    assert.equal(call.env.OBOETE_CF_ACCOUNT_ID, undefined, agent);
    assert.ok(call.env.OBOETE_HOME, agent);
  }
  // The oboete legs are the only ones that need them, so this run still exercises the provider.
  const observe = dependencies.calls.find((entry) => entry.argv[0] === "oboete" && entry.argv[1] === "observe");
  assert.equal(observe.env.OBOETE_NIM_API_KEY, "nim-secret");
  assert.equal(observe.env.OBOETE_CF_ACCOUNT_ID, "cf-account");

  // The copied Codex home carries its own trust, so the run gates the trust rule instead of it.
  const codex = dependencies.calls.find((entry) => entry.argv[0] === "codex");
  assert.ok(!codex.argv.includes("--dangerously-bypass-hook-trust"));
  const agentHome = path.join(runDir, "codex-to-claude", "seed", "agent-home");
  const copied = fs.readFileSync(path.join(agentHome, "config.toml"), "utf8");
  assert.ok(copied.includes(`[hooks.state."${path.join(agentHome, "hooks.json")}:session_start:0:0"]`));
  assert.ok(!copied.includes(account.hooksPath));
  assert.equal(codex.env.CODEX_HOME, agentHome);
});

// ponytail: pins the harness inside the instrumented step because Sonar charges lines_to_cover for
// every file under sonar.sources whether or not lcov names it; delete the ci.yml half once
// sonar.coverage.exclusions=scripts/e2e/** lands in sonar-project.properties.
test("every harness test file is run by npm test and by the instrumented CI step", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const files = fs
    .readdirSync(path.join(root, "scripts", "e2e"), { recursive: true })
    .filter((entry) => entry.endsWith(".test.mjs"))
    .map((entry) => `scripts/e2e/${entry.split(path.sep).join("/")}`);
  assert.ok(
    files.some((file) => file.split("/").length > 3),
    "expected a harness test below scripts/e2e/, otherwise the ** in the globs is untested",
  );

  const { scripts } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const coverageStep = workflow
    .split(/^ *- name: /m)
    .find((step) => step.includes("--experimental-test-coverage") && step.includes("coverage/lcov.info"));
  assert.ok(coverageStep, "ci.yml has no instrumented step writing coverage/lcov.info");

  for (const [label, command] of [["npm test", scripts.test], ["the CI coverage step", coverageStep]]) {
    const globs = [...command.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    for (const file of files) {
      assert.ok(
        globs.some((glob) => path.matchesGlob(file, glob)),
        `${label} does not run ${file} (globs: ${globs.join(" ")})`,
      );
    }
  }
});

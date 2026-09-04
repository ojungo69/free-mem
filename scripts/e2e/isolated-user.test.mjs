import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertAgentOutput,
  buildFactSeedingPrompt,
  createReport,
  enumeratePairs,
  parseArguments,
  resolveSourceHomes,
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
  assert.equal(report.summary, "1 of 12 pairs pass");
  assert.deepEqual(report.pairs[0].agents, { seed: "claude", receive: "codex" });
  assert.equal(report.pairs[0].elapsed_ms, 3_000);
  assert.equal(report.pairs[0].status, "pass");
  assert.deepEqual(report.pairs[0].missing_facts, []);
  assert.equal(report.pairs[0].stdout.seed, "<run>/claude-to-codex/seed/stdout.txt");
  assert.ok(!JSON.stringify(report).includes("/tmp/private-run"));
});

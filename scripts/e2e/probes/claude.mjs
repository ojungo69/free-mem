import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_EVENTS,
  binVersion,
  childEnv,
  finalText,
  gitInit,
  oversizedOutcome,
  oversizedPrompt,
  pairFor,
  parseEvents,
  redactValue,
  shapeProbe,
  topKeys,
  toolUsePrompt,
  writeFixture,
} from "../probe-lib/agents.mjs";
import { tmuxSession } from "../probe-lib/tmux.mjs";

const ROW_SHAPES = "Native tool payload shapes for read/write/edit/bash on all four agents";
const ROW_OVER = "Hook runner behaviour when the hook exits with unread stdin above 1 MB";
const ROW_COMPACT = "Compaction identity and order per agent";
const ROW_STOP = "Codex and Grok `PostCompact` payload (summary text field); Grok `Stop` `lastAssistantMessage` field";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SRC = path.join(HERE, "../probe-lib/hook.mjs");
const ECHO_PROMPT =
  "Reply with exactly the word DONE followed by every marker token you have seen. Do not use tools.";
const TUI_MANUAL = [
  "manual TUI: as oboete-dogfood, in a throwaway git repo run: claude --settings <settings.json> --dangerously-skip-permissions",
  "first TUI launch on this user hits theme picker then login-method; complete that interactively (headless -p already has credentials; do not start a second OAuth from the probe)",
  "type a short prompt, wait for the reply, type /compact, wait for PostCompact in events.jsonl, type /compact again",
  "compare the two PostCompact stdin payloads for a distinguisher besides compact_summary; record order vs SessionStart source=compact",
];

const EXPECTED = {
  Read: {
    file: "read.json",
    normalized: "read",
    input: ["file_path"],
    output: ["type", "file"],
    path: "tool_input.file_path (absolute); echoed back at tool_response.file.filePath (camelCase)",
  },
  Write: {
    file: "write.json",
    normalized: "write",
    input: ["file_path", "content"],
    output: ["type", "filePath", "content", "structuredPatch", "originalFile", "userModified"],
    path: "tool_input.file_path ; tool_response.filePath",
  },
  Edit: {
    file: "edit.json",
    normalized: "edit",
    input: ["file_path", "old_string", "new_string", "replace_all"],
    output: ["filePath", "oldString", "newString", "originalFile", "structuredPatch", "userModified", "replaceAll"],
    path: "tool_input.file_path ; tool_response.filePath",
  },
  Bash: {
    file: "bash.json",
    normalized: "bash",
    input: ["command", "description"],
    output: ["stdout", "stderr", "interrupted", "isImage", "noOutputExpected"],
    path: "tool_input.command ; tool_response has NO command echo — Pre/Post must be joined by tool_use_id",
  },
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ssSource(events) {
  const ev = events.find((e) => e.event === "SessionStart");
  return ev?.stdin?.source ?? null;
}

function markerFlags(token) {
  return { hookFlags: { SessionStart: ["--plain", `'Note: ${token}'`] } };
}

function compactRelated(events) {
  return events
    .filter((e) =>
      ["PreCompact", "PostCompact", "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(
        e.event,
      ),
    )
    .map((e) => {
      const src = e.event === "SessionStart" ? e.stdin?.source : e.stdin?.trigger;
      const tool = e.stdin?.tool_name || e.stdin?.toolName;
      const err = e.event === "PostToolUseFailure" && e.stdin?.error ? String(e.stdin.error).split("\n")[0] : "";
      return `${e.event}${src ? ":" + src : ""}${tool ? ":" + tool : ""}${err ? ":" + err : ""}@${e.at || "?"}`;
    });
}

function postCompacts(events) {
  return events.filter((e) => e.event === "PostCompact");
}

function evalA(posts) {
  const payloads = posts.map((e) => (e.stdin && typeof e.stdin === "object" ? e.stdin : {}));
  const keys = [...new Set(payloads.flatMap((p) => Object.keys(p)))];
  const envelope = new Set([
    "session_id",
    "transcript_path",
    "cwd",
    "hook_event_name",
    "permission_mode",
    "prompt_id",
    "trigger",
    "compact_summary",
  ]);
  const native = keys.filter(
    (k) => !envelope.has(k) && /(^id$|compaction_id|compact_id|counter|seq|ordinal|uuid|timestamp|^at$|^time$|index)/i.test(k),
  );
  const summaries = payloads.map((p) =>
    typeof p.compact_summary === "string" ? p.compact_summary.length : p.compact_summary == null ? "absent" : typeof p.compact_summary,
  );
  let unique = false;
  if (payloads.length >= 2 && native.length) {
    const sig = payloads.map((p) => native.map((k) => JSON.stringify(p[k])).join("|"));
    unique = new Set(sig).size === payloads.length;
  }
  return {
    n: payloads.length,
    keys,
    native,
    unique,
    ok: payloads.length >= 2 && native.length > 0 && unique,
    triggers: payloads.map((p) => p.trigger ?? null),
    summary_len: summaries,
  };
}

function evalB(events) {
  const posts = events.map((e, i) => ({ i, e })).filter((x) => x.e.event === "PostCompact");
  const inj = events
    .map((e, i) => ({ i, e }))
    .filter(
      (x) =>
        (x.e.event === "SessionStart" && x.e.stdin?.source === "compact") || x.e.event === "UserPromptSubmit",
    );
  if (!posts.length) return { ok: null, details: ["no PostCompact"] };
  const details = [];
  let ok = true;
  for (const p of posts) {
    const prevPost = [...posts].reverse().find((q) => q.i < p.i);
    const lo = prevPost ? prevPost.i : -1;
    const before = inj.find((x) => x.i > lo && x.i < p.i && x.e.event === "SessionStart");
    const after = inj.find((x) => x.i > p.i);
    if (before) {
      ok = false;
      details.push(
        `injection SessionStart:${before.e.stdin?.source} idx ${before.i} BEFORE PostCompact idx ${p.i} (at ${before.e.at} vs ${p.e.at})`,
      );
    } else if (after) {
      details.push(`PostCompact idx ${p.i} @${p.e.at} before ${after.e.event}:${after.e.stdin?.source || ""} idx ${after.i} @${after.e.at}`);
    } else {
      details.push(`PostCompact idx ${p.i} @${p.e.at} with no later injection hook`);
    }
  }
  return { ok, details };
}

function usageOf(r) {
  try {
    const j = JSON.parse((r.stdout || "").trim());
    return j.usage || null;
  } catch {
    return null;
  }
}

function writeBigTxt(file) {
  const r = spawnSync("head", ["-c", "600000", "/dev/urandom"], { maxBuffer: 800000 });
  if (r.status !== 0) throw new Error("head /dev/urandom failed: " + (r.stderr || r.status));
  const b64 = Buffer.from(r.stdout).toString("base64").replace(/(.{76})/g, "$1\n");
  fs.writeFileSync(file, b64.endsWith("\n") ? b64 : b64 + "\n");
  return fs.statSync(file).size;
}

async function waitPostCompact(eventsPath, n, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const ev = parseEvents(eventsPath);
    if (postCompacts(ev).length >= n) return ev;
    await sleep(400);
  }
  return parseEvents(eventsPath);
}

function writeClaudeSettings(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const hookPath = path.join(dir, "hook.mjs");
  fs.copyFileSync(HOOK_SRC, hookPath);
  const eventsPath = path.join(dir, "events.jsonl");
  fs.writeFileSync(eventsPath, "");
  const hooks = {};
  for (const event of CLAUDE_EVENTS) {
    const timeout = event === "SessionEnd" ? 10 : 20;
    const command = `PROBE_EVENTS='${eventsPath.replace(/'/g, `'\\''`)}' node '${hookPath.replace(/'/g, `'\\''`)}' ${event}`;
    hooks[event] = [{ hooks: [{ type: "command", command, timeout }] }];
  }
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks }, null, 2));
  return { settingsPath, eventsPath };
}

function paneLoginWall(pane) {
  return /Select login method|Paste code here if prompted|Browser didn't open|oauth\/authorize/i.test(pane);
}

function paneOnboarding(pane) {
  return /Choose the text style|Let's get started|looks best with your terminal|Press enter to continue|Do you trust|Yes, I trust/i.test(
    pane,
  );
}

function paneReady(pane) {
  if (paneLoginWall(pane) || paneOnboarding(pane)) return false;
  return /\/help|\/compact|\/exit|Ask Claude|Write a message|Type a (task|message)|shift\+tab/i.test(pane);
}

async function dismissOnboarding(tmux, eventsPath) {
  const start = Date.now();
  let enters = 0;
  while (Date.now() - start < 90_000 && enters < 14) {
    const pane = tmux.capture();
    if (paneLoginWall(pane)) throw new Error("tui login wall (not sending keys)");
    if (paneReady(pane) && parseEvents(eventsPath).some((e) => e.event === "SessionStart")) return pane;
    if (paneOnboarding(pane)) {
      tmux.send("");
      enters++;
      await sleep(1500);
      continue;
    }
    if (paneReady(pane)) return pane;
    await sleep(600);
  }
  return tmux.capture();
}

async function tuiTwoCompacts(dir, repo) {
  const { settingsPath, eventsPath } = writeClaudeSettings(dir);
  const launch = path.join(dir, "tui.sh");
  fs.writeFileSync(
    launch,
    `#!/bin/bash\nexport PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"\nexec claude --settings ${JSON.stringify(settingsPath)} --dangerously-skip-permissions\n`,
    { mode: 0o755 },
  );
  const name = `pbc${process.pid}${Date.now().toString(36)}`.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);
  const tmux = tmuxSession({
    name,
    command: launch,
    cwd: repo,
    env: childEnv({ TERM: "xterm-256color" }),
  });
  const paneLog = path.join(dir, "tmux-pane.txt");
  const dump = (label) => {
    try {
      fs.appendFileSync(paneLog, `\n----- ${label} -----\n` + tmux.capture() + "\n");
    } catch {
      /* ignore */
    }
  };
  try {
    await sleep(2000);
    const afterOnboard = await dismissOnboarding(tmux, eventsPath);
    dump("after-onboard");
    if (!paneReady(afterOnboard) && !parseEvents(eventsPath).some((e) => e.event === "SessionStart")) {
      throw new Error("tui still on onboarding pane=" + afterOnboard.slice(-300));
    }
    tmux.send("Reply with exactly the word DONE. Do not use tools.");
    await tmux.waitFor(/\bDONE\b/, 120_000);
    dump("after-done");
    await sleep(2000);
    tmux.send("/compact");
    await sleep(1500);
    if (/compact this conversation|Are you sure|Yes/i.test(tmux.capture())) tmux.send("");
    let events = await waitPostCompact(eventsPath, 1, 120_000);
    dump("after-compact-1");
    if (postCompacts(events).length < 1) {
      tmux.send("");
      events = await waitPostCompact(eventsPath, 1, 60_000);
    }
    tmux.send("/compact");
    await sleep(1500);
    if (/compact this conversation|Are you sure|Yes/i.test(tmux.capture())) tmux.send("");
    events = await waitPostCompact(eventsPath, 2, 120_000);
    dump("after-compact-2");
    const pane = tmux.capture();
    tmux.send("/exit");
    await sleep(1500);
    return { events: parseEvents(eventsPath), pane, eventsPath };
  } catch (e) {
    let pane = "";
    try {
      pane = tmux.capture();
    } catch {
      pane = "";
    }
    dump("error");
    fs.appendFileSync(paneLog, "\n" + String(e && e.message ? e.message : e) + "\n");
    return {
      events: parseEvents(eventsPath),
      pane,
      error: String(e && e.message ? e.message : e),
      eventsPath,
    };
  } finally {
    try {
      tmux.kill();
    } catch {
      /* ignore */
    }
  }
}

export const probes = [
  {
    id: "claude-payload-shapes",
    agent: "claude",
    row: ROW_SHAPES,
    run: shapeProbe({
      agent: "claude",
      expected: EXPECTED,
      launch: (ctx) => ctx.claude(ctx.dir, { prompt: toolUsePrompt("claude") }),
      fixtureDir: "claude",
    }),
  },
  {
    id: "claude-oversized-stdin",
    agent: "claude",
    row: ROW_OVER,
    async run(ctx) {
      const hooks = [
        ...CLAUDE_EVENTS.filter((e) => e !== "PostToolUse"),
        { event: "PostToolUse", flags: ["--no-read"], label: "PostToolUse-noread" },
        { event: "PostToolUse", flags: [], label: "PostToolUse" },
      ];
      return oversizedOutcome(await ctx.claude(ctx.dir, { prompt: oversizedPrompt("Bash"), hooks }), ctx.dir);
    },
  },
  {
    id: "claude-session-start-sources",
    agent: "claude",
    row: ROW_COMPACT,
    async run(ctx) {
      const prompt = ECHO_PROMPT;
      const a = await ctx.claude(path.join(ctx.dir, "a"), {
        prompt,
        ...markerFlags("PROBE-SS-startup"),
      });
      const evidence = [
        `A exit=${a.exitCode} source=${ssSource(a.events)} session=${a.sessionId || "none"} elapsed_s=${(a.elapsedMs / 1000).toFixed(1)}`,
      ];
      if (!a.sessionId) {
        evidence.push(`A stdout_head=${(a.stdout || "").slice(0, 300).replace(/\s+/g, " ")}`);
        evidence.push(`A events=${a.events.map((e) => e.event).join(",") || "none"}`);
        return { status: "fail", evidence, data: { a: { source: ssSource(a.events), sessionId: a.sessionId } } };
      }
      const b = await ctx.claude(path.join(ctx.dir, "b"), {
        prompt,
        repo: a.repo,
        extraArgs: ["--resume", a.sessionId],
        ...markerFlags("PROBE-SS-resume"),
      });
      const c = await ctx.claude(path.join(ctx.dir, "c"), {
        prompt,
        repo: a.repo,
        extraArgs: ["--resume", a.sessionId, "--fork-session"],
        ...markerFlags("PROBE-SS-fork"),
      });
      const runs = [
        { name: "A", token: "PROBE-SS-startup", expect: "startup", r: a },
        { name: "B", token: "PROBE-SS-resume", expect: "resume", r: b },
        { name: "C", token: "PROBE-SS-fork", expect: "fork", r: c },
      ];
      const data = {};
      for (const run of runs) {
        const source = ssSource(run.r.events);
        const text = finalText("claude", run.r, run.r.events) || "";
        const delivered = text.includes(run.token);
        data[run.name] = {
          source,
          sessionId: run.r.sessionId || null,
          delivered,
          text: text.slice(0, 400),
        };
        evidence.push(
          `${run.name} source=${source} expected=${run.expect} session=${run.r.sessionId || "none"} marker_delivered=${delivered} answer=${text.slice(0, 200).replace(/\s+/g, " ")}`,
        );
      }
      const sourcesOk = data.A.source === "startup" && data.B.source === "resume" && data.C.source === "fork";
      const idOk = data.A.sessionId && data.A.sessionId === data.B.sessionId && data.C.sessionId && data.C.sessionId !== data.A.sessionId;
      evidence.push(`id_continuity A==B=${data.A.sessionId === data.B.sessionId} C!=A=${data.C.sessionId !== data.A.sessionId}`);
      evidence.push(`sources_ok=${sourcesOk} id_ok=${idOk}`);
      return { status: sourcesOk && idOk ? "pass" : "fail", evidence, data };
    },
  },
  {
    id: "claude-tool-failure",
    agent: "claude",
    row: ROW_SHAPES,
    async run(ctx) {
      const prompt = [
        "Do these three steps in order, without asking for confirmation. Each step names the exact tool to use; use that tool and no other. Do not substitute shell commands for the file tools. Do both tool calls even if they fail.",
        "1. Use the Bash tool to run exactly this command: echo fail-stderr >&2; exit 3",
        "2. Use the Read tool on missing-probe-file-does-not-exist.txt in the current directory.",
        "3. Reply with exactly the word DONE.",
      ].join(" ");
      const r = await ctx.claude(ctx.dir, { prompt });
      const version = binVersion("claude");
      const captured_at = new Date().toISOString();
      const evidence = [`exit=${r.exitCode} elapsed_s=${(r.elapsedMs / 1000).toFixed(1)} session=${r.sessionId || "none"}`];
      const missing = [];
      for (const [native, file, normalized] of [
        ["Bash", "bash-failure.json", "bash"],
        ["Read", "read-failure.json", "read"],
      ]) {
        const failPair = pairFor(r.events, native, "PreToolUse", "PostToolUseFailure");
        const postPair = pairFor(r.events, native, "PreToolUse", "PostToolUse");
        const fail = failPair.post;
        const alsoPost = Boolean(postPair.post);
        if (!failPair.pre || !fail) {
          missing.push(native);
          evidence.push(
            `${native}: missing ${!failPair.pre ? "PreToolUse" : ""}${!fail ? "PostToolUseFailure" : ""}; PostToolUse=${alsoPost}; events=${r.events
              .filter((e) => ["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(e.event))
              .map((e) => `${e.event}:${e.stdin?.tool_name || e.stdin?.toolName || "?"}`)
              .join(",")}`,
          );
          continue;
        }
        const failKeys = topKeys(fail.stdin);
        const err = fail.stdin?.error;
        const errKeys = err && typeof err === "object" ? topKeys(err) : typeof err;
        evidence.push(
          `${native} PostToolUseFailure keys=[${failKeys.join(",")}] error_field=${errKeys} PostToolUse_also=${alsoPost}`,
        );
        writeFixture(ctx.repoRoot, `test/contracts/claude/${file}`, {
          agent: "claude",
          agent_version: version,
          captured_at,
          native_tool: native,
          normalized_tool: normalized,
          events: {
            PreToolUse: redactValue(failPair.pre.stdin, r.repo),
            PostToolUseFailure: redactValue(fail.stdin, r.repo),
          },
          notes: `PostToolUse also fires for this failed call: ${alsoPost}; error is ${typeof err}${typeof err === "string" ? " (string)" : ""}`,
        });
      }
      return { status: missing.length ? "fail" : "pass", evidence, data: { missing, sessionId: r.sessionId } };
    },
  },
  {
    id: "claude-stop-message",
    agent: "claude",
    row: ROW_STOP,
    async run(ctx) {
      const r = await ctx.claude(ctx.dir, {
        prompt: "Reply with exactly the word DONE. Do not use tools.",
      });
      const text = finalText("claude", r, r.events) || "";
      const stop = r.events.find((e) => e.event === "Stop");
      const stdin = stop?.stdin && typeof stop.stdin === "object" ? stop.stdin : {};
      const last = stdin.last_assistant_message;
      const keys = topKeys(stdin);
      const equal = String(last ?? "") === String(text);
      const equalTrim = String(last ?? "").trim() === String(text).trim();
      return {
        status: stop && equalTrim ? "pass" : "fail",
        evidence: [
          `exit=${r.exitCode}`,
          `Stop=${Boolean(stop)}`,
          `equal=${equal} equal_trim=${equalTrim}`,
          `stop_hook_active=${Object.prototype.hasOwnProperty.call(stdin, "stop_hook_active") ? JSON.stringify(stdin.stop_hook_active) : "absent"}`,
          `background_tasks_key=${Object.prototype.hasOwnProperty.call(stdin, "background_tasks")}`,
          `session_crons_key=${Object.prototype.hasOwnProperty.call(stdin, "session_crons")}`,
          `Stop.keys=[${keys.join(",")}]`,
          `result=${JSON.stringify(text).slice(0, 200)}`,
          `last_assistant_message=${JSON.stringify(last).slice(0, 200)}`,
        ],
        data: { equal, equalTrim, keys, stop_hook_active: stdin.stop_hook_active ?? null },
      };
    },
  },
  {
    id: "claude-postcompact-payload",
    agent: "claude",
    row: ROW_COMPACT,
    async run(ctx) {
      const evidence = [];
      const autoDir = path.join(ctx.dir, "auto");
      const repo = gitInit(path.join(autoDir, "repo"));
      const big = path.join(repo, "big.txt");
      const bytes = writeBigTxt(big);
      evidence.push(`big.txt_bytes=${bytes}`);
      const autoEnv = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000" };
      const autoPrompt = [
        "Use the Read tool on big.txt, then Use the Read tool on big.txt again, then reply with exactly the word DONE.",
        "Do not substitute the Bash tool for Read.",
        "A whole-file Read exceeds the 256KB / 25000-token cap; you MUST pass offset and limit.",
        "Use limit 200. Do Reads at offsets 0, 200, 400, 600, 800, 1000, 1200, then the same seven offsets again (14 Reads).",
        "Do not stop after a few chunks.",
      ].join(" ");
      let auto = await ctx.claude(autoDir, { repo, prompt: autoPrompt, env: autoEnv });
      if (!postCompacts(auto.events).length && auto.sessionId) {
        const auto2 = await ctx.claude(path.join(ctx.dir, "auto2"), {
          repo,
          prompt: "Reply with exactly the word DONE. Do not use tools.",
          extraArgs: ["--resume", auto.sessionId],
          env: autoEnv,
        });
        auto = {
          ...auto2,
          events: [...auto.events, ...auto2.events],
          elapsedMs: auto.elapsedMs + auto2.elapsedMs,
        };
        evidence.push(`auto2 resume exit=${auto2.exitCode} PostCompact=${postCompacts(auto2.events).length} elapsed_s=${(auto2.elapsedMs / 1000).toFixed(1)}`);
      }
      const usage = usageOf(auto);
      evidence.push(
        `auto exit=${auto.exitCode} elapsed_s=${(auto.elapsedMs / 1000).toFixed(1)} PostCompact=${postCompacts(auto.events).length} PreCompact=${auto.events.filter((e) => e.event === "PreCompact").length} usage=${usage ? JSON.stringify(usage) : "none"}`,
      );
      evidence.push(`auto seq=${compactRelated(auto.events).join(" | ") || "none"}`);
      for (const ev of auto.events.filter((e) => e.event === "PreCompact" || e.event === "PostCompact")) {
        const s = ev.stdin && typeof ev.stdin === "object" ? ev.stdin : {};
        evidence.push(
          `auto ${ev.event} keys=[${topKeys(s).join(",")}] trigger=${s.trigger ?? "absent"} compact_summary=${typeof s.compact_summary === "string" ? "len=" + s.compact_summary.length : s.compact_summary == null ? "absent" : typeof s.compact_summary}`,
        );
      }

      let tui = { events: [], error: "not-run", pane: "" };
      try {
        tui = await tuiTwoCompacts(path.join(ctx.dir, "tui"), gitInit(path.join(ctx.dir, "tui-repo")));
      } catch (e) {
        tui = { events: [], error: String(e && e.message ? e.message : e), pane: "" };
      }
      evidence.push(
        `tui PostCompact=${postCompacts(tui.events).length} PreCompact=${tui.events.filter((e) => e.event === "PreCompact").length} error=${tui.error || "none"} pane_chars=${(tui.pane || "").length}`,
      );
      evidence.push(`tui seq=${compactRelated(tui.events).join(" | ") || "none"}`);
      if (tui.error) evidence.push(`tui_error=${tui.error.replace(/https:\S+/g, "<url>").slice(0, 400)}`);
      if (tui.pane) evidence.push(`tui_pane=${tui.pane.replace(/https:\S+/g, "<url>").slice(-500).replace(/\s+/g, " ")}`);
      for (const ev of tui.events.filter((e) => e.event === "PreCompact" || e.event === "PostCompact")) {
        const s = ev.stdin && typeof ev.stdin === "object" ? ev.stdin : {};
        evidence.push(
          `tui ${ev.event} keys=[${topKeys(s).join(",")}] trigger=${s.trigger ?? "absent"} compact_summary=${typeof s.compact_summary === "string" ? "len=" + s.compact_summary.length : s.compact_summary == null ? "absent" : typeof s.compact_summary}`,
        );
      }

      const autoPosts = postCompacts(auto.events);
      const tuiPosts = postCompacts(tui.events);
      const posts = tuiPosts.length >= 2 ? tuiPosts : autoPosts.length >= 2 ? autoPosts : [...autoPosts, ...tuiPosts];
      const a = evalA(posts);
      const bAuto = evalB(auto.events);
      const bTui = evalB(tui.events);
      const bOk = (autoPosts.length ? bAuto.ok : true) && (tuiPosts.length ? bTui.ok : true);
      evidence.push(
        `(a) n=${a.n} keys=[${a.keys.join(",")}] native_distinguisher=[${a.native.join(",")}] unique=${a.unique} triggers=${a.triggers.join(",")} summary_len=${a.summary_len.join(",")} ok=${a.ok}`,
      );
      evidence.push(`(b) auto=${bAuto.ok} ${bAuto.details.join(" | ")}`);
      evidence.push(`(b) tui=${bTui.ok} ${bTui.details.join(" | ")}`);

      if (!autoPosts.length && !tuiPosts.length) {
        evidence.push(...TUI_MANUAL);
        return {
          status: "blocked",
          evidence,
          data: { a, bAuto, bTui, usage, autoTokens: usage, tuiError: tui.error || null },
        };
      }
      const status = a.ok && bOk ? "pass" : "fail";
      return { status, evidence, data: { a, bAuto, bTui, usage } };
    },
  },
];

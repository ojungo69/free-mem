import {
  GROK_EVENTS,
  oversizedOutcome,
  oversizedPrompt,
  shapeProbe,
  toolUsePrompt,
} from "../probe-lib/agents.mjs";

const ROW_SHAPES = "Native tool payload shapes for read/write/edit/bash on all four agents";
const ROW_OVER = "Hook runner behaviour when the hook exits with unread stdin above 1 MB";

const EXPECTED = {
  read_file: {
    file: "read_file.json",
    normalized: "read",
    input: ["target_file"],
    output: ["type", "FileContent"],
    path: "toolInput.target_file (relative); absolute at toolResult.FileContent.absolute_path",
  },
  write: {
    file: "write.json",
    normalized: "write",
    input: ["file_path", "content"],
    output: ["type", "EditsApplied"],
    path: "toolInput.file_path (relative); absolute at toolResult.EditsApplied.absolute_path; toolResult.type is SearchReplace",
  },
  search_replace: {
    file: "search_replace.json",
    normalized: "edit",
    input: ["file_path", "old_string", "new_string"],
    output: ["type", "EditsApplied"],
    path: "toolInput.file_path (relative); absolute at toolResult.EditsApplied.absolute_path",
  },
  run_terminal_command: {
    file: "run_terminal_command.json",
    normalized: "bash",
    input: ["command", "description"],
    output: [
      "type",
      "output",
      "output_for_prompt",
      "exit_code",
      "command",
      "truncated",
      "signal",
      "timed_out",
      "description",
      "current_dir",
      "output_file",
      "total_bytes",
      "was_bare_echo",
    ],
    path: "toolInput.command; output is a byte array, output_for_prompt is the string",
  },
};

export const probes = [
  {
    id: "grok-payload-shapes",
    agent: "grok",
    row: ROW_SHAPES,
    run: shapeProbe({
      agent: "grok",
      expected: EXPECTED,
      launch: (ctx) => ctx.grok(ctx.dir, { prompt: toolUsePrompt("grok"), grokSeed: ctx.grokSeed }),
      fixtureDir: "grok",
    }),
  },
  {
    id: "grok-oversized-stdin",
    agent: "grok",
    row: ROW_OVER,
    async run(ctx) {
      const hooks = [
        ...GROK_EVENTS.filter((e) => e !== "PostToolUse"),
        { event: "PostToolUse", flags: ["--no-read"], label: "PostToolUse-noread" },
        { event: "PostToolUse", flags: [], label: "PostToolUse" },
      ];
      return oversizedOutcome(
        await ctx.grok(ctx.dir, { prompt: oversizedPrompt("run_terminal_command"), hooks, grokSeed: ctx.grokSeed }),
        ctx.dir,
      );
    },
  },
];

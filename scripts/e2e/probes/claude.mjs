import {
  CLAUDE_EVENTS,
  oversizedOutcome,
  oversizedPrompt,
  shapeProbe,
  toolUsePrompt,
} from "../probe-lib/agents.mjs";

const ROW_SHAPES = "Native tool payload shapes for read/write/edit/bash on all four agents";
const ROW_OVER = "Hook runner behaviour when the hook exits with unread stdin above 1 MB";

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
];

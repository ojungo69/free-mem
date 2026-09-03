import { shapeProbe, toolUsePrompt } from "../probe-lib/agents.mjs";

const ROW_SHAPES = "Native tool payload shapes for read/write/edit/bash on all four agents";
const ROW_OVER = "Hook runner behaviour when the hook exits with unread stdin above 1 MB";

const EXPECTED = {
  read: { file: "read.json", normalized: "read", input: ["path"], output: ["content"], path: "input.path" },
  write: { file: "write.json", normalized: "write", input: ["path", "content"], output: ["content"], path: "input.path" },
  edit: {
    file: "edit.json",
    normalized: "edit",
    input: ["path", "edits"],
    output: ["content", "details"],
    path: "input.path (edits is [{oldText,newText}])",
  },
  bash: { file: "bash.json", normalized: "bash", input: ["command"], output: ["content"], path: "input.command" },
};

export const probes = [
  {
    id: "pi-payload-shapes",
    agent: "pi",
    row: ROW_SHAPES,
    run: shapeProbe({
      agent: "pi",
      expected: EXPECTED,
      launch: (ctx) => ctx.pi(ctx.dir, { prompt: toolUsePrompt("pi") }),
      preEvent: "tool_call",
      postEvent: "tool_result",
      fixtureDir: "pi",
    }),
  },
  {
    id: "pi-oversized-stdin",
    agent: "pi",
    row: ROW_OVER,
    async run() {
      return {
        status: "skipped",
        evidence: [
          "Pi has no hook process; the equivalent is oboete's own capture child, probed after the child exists",
        ],
      };
    },
  },
];

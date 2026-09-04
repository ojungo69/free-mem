import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TMUX_SOCKET, tmux, tmuxSession } from "./tmux.mjs";

const hasTmux = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;

// FR-016: the pane environment comes from the tmux server, and a server left running by an earlier
// probe was started before this rule existed, so a filtered launcher environment is not enough.
test("a pane sees no credential a running server carries", { skip: !hasTmux }, async () => {
  const name = "oboete-tmux-test-" + process.pid;
  const dir = mkdtempSync(join(tmpdir(), "oboete-tmux-test-"));
  const out = join(dir, "seen.txt");
  // A server has to be running for its environment to be the one a new pane reads, which is the
  // situation this covers: the server outlives the probe that started it.
  const holder = "oboete-tmux-test-holder-" + process.pid;
  tmux(["new-session", "-d", "-s", holder, "bash"]);
  // Put the credential where only the server can hand it on: its own global environment.
  tmux(["set-environment", "-g", "OBOETE_CF_API_TOKEN", "leak-marker"]);
  const session = tmuxSession({ name, command: "bash", cwd: dir });
  try {
    // The pane echoes the command as well as its output, so the marker carries the exit status:
    // `done-$?` is what was typed, `done-0` or `done-1` is what the shell answered.
    session.send(`printenv OBOETE_CF_API_TOKEN > ${out}; echo done-$?`);
    await session.waitFor(/done-[01]/);
    assert.equal(readFileSync(out, "utf8").includes("leak-marker"), false);
  } finally {
    session.kill();
    spawnSync("tmux", ["-L", TMUX_SOCKET, "kill-session", "-t", holder]);
    spawnSync("tmux", ["-L", TMUX_SOCKET, "set-environment", "-g", "-u", "OBOETE_CF_API_TOKEN"]);
    rmSync(dir, { recursive: true, force: true });
  }
});

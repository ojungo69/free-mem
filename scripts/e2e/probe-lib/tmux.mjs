import { spawnSync } from "node:child_process";

export function tmuxSession({ name, command, cwd, env } = {}) {
  if (!name) throw new Error("tmuxSession: name required");
  const args = ["new-session", "-d", "-s", name, "-x", "200", "-y", "50"];
  if (cwd) args.push("-c", cwd);
  args.push(command || "bash");
  const r = spawnSync("tmux", args, { encoding: "utf8", env: { ...process.env, ...(env || {}) } });
  if (r.status !== 0) throw new Error("tmux new-session: " + (r.stderr || r.stdout || "fail"));
  return {
    send(keys) {
      spawnSync("tmux", ["send-keys", "-t", name, String(keys), "Enter"], { encoding: "utf8" });
    },
    capture() {
      const c = spawnSync("tmux", ["capture-pane", "-p", "-t", name], { encoding: "utf8" });
      return c.stdout || "";
    },
    async waitFor(regex, ms = 5000) {
      const re = regex instanceof RegExp ? regex : new RegExp(regex);
      const start = Date.now();
      while (Date.now() - start < ms) {
        if (re.test(this.capture())) return true;
        await new Promise((res) => setTimeout(res, 80));
      }
      throw new Error("waitFor timeout " + re + " pane=" + this.capture().slice(-200));
    },
    kill() {
      spawnSync("tmux", ["kill-session", "-t", name], { encoding: "utf8" });
    },
  };
}

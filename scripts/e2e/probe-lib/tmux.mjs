import { spawnSync } from "node:child_process";

export const TMUX_SOCKET = "oboete-probes";

export function tmux(args, opts = {}) {
  const { env, ...rest } = opts;
  return spawnSync("tmux", ["-L", TMUX_SOCKET, ...args], {
    encoding: "utf8",
    ...rest,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
}

export function tmuxSession({ name, command, cwd, env } = {}) {
  if (!name) throw new Error("tmuxSession: name required");
  const args = ["new-session", "-d", "-s", name, "-x", "200", "-y", "50"];
  if (cwd) args.push("-c", cwd);
  const extraEnv = env || {};
  for (const [k, v] of Object.entries(extraEnv)) {
    args.push("-e", `${k}=${v}`);
  }
  args.push(command || "bash");
  const r = tmux(args, { env: extraEnv });
  if (r.status !== 0) throw new Error("tmux new-session: " + (r.stderr || r.stdout || "fail"));
  return {
    send(keys) {
      tmux(["send-keys", "-t", name, String(keys), "Enter"]);
    },
    capture() {
      const c = tmux(["capture-pane", "-p", "-t", name]);
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
      tmux(["kill-session", "-t", name]);
    },
  };
}

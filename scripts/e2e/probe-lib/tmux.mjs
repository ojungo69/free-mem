import { spawnSync } from "node:child_process";

import { isCredentialVariable } from "./agents.mjs";

export const TMUX_SOCKET = "oboete-probes";

/**
 * FR-016: a tmux pane inherits the environment of the server, not of the client that asked for the
 * session, so filtering the launcher's own environment is not enough -- the server is started here
 * and the credentials have to be gone from it. `agents.mjs childEnv` states the same rule for the
 * children a probe spawns directly.
 */
function withoutCredentials(env) {
  const clean = { ...env };
  for (const name of Object.keys(clean)) if (isCredentialVariable(name)) delete clean[name];
  return clean;
}

export function tmux(args, opts = {}) {
  const { env, ...rest } = opts;
  return spawnSync("tmux", ["-L", TMUX_SOCKET, ...args], {
    encoding: "utf8",
    ...rest,
    env: withoutCredentials({ ...process.env, ...(env ?? {}) }),
  });
}

/**
 * A pane also inherits the environment of a server that was already running, which the filter
 * above cannot reach: that server was started by whoever ran the first probe. Panes read the
 * server's global environment, so the credentials are removed from it before a session is created.
 */
function scrubServerEnvironment() {
  const shown = tmux(["show-environment", "-g"]);
  // No server yet: the next tmux command starts one from the filtered environment above.
  if (shown.status !== 0) return;
  for (const line of (shown.stdout || "").split("\n")) {
    const name = (line.startsWith("-") ? line.slice(1) : line.split("=")[0]).trim();
    if (name && isCredentialVariable(name)) tmux(["set-environment", "-g", "-u", name]);
  }
}

export function tmuxSession({ name, command, cwd, env } = {}) {
  if (!name) throw new Error("tmuxSession: name required");
  scrubServerEnvironment();
  const args = ["new-session", "-d", "-s", name, "-x", "200", "-y", "50"];
  if (cwd) args.push("-c", cwd);
  const extraEnv = withoutCredentials(env || {});
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

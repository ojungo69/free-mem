import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const bundledRuntime = join(scriptDir, "hook-runtime.mjs");
if (existsSync(bundledRuntime)) {
  spawnSync(process.execPath, [bundledRuntime, "codex-hook-inject"], {
    stdio: "inherit",
    timeout: 4500
  });
  process.exit(0);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function printContinue(extra = {}) {
  process.stdout.write(JSON.stringify({ continue: true, ...extra }));
}

function readPinnedVersion(pluginRoot) {
  try {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
    return typeof manifest.version === "string" && manifest.version.trim()
      ? manifest.version.trim()
      : "latest";
  } catch {
    return "latest";
  }
}

function runInject(command, args, timeout) {
  const result = spawnSync(command, args, {
    input: payload,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
    timeout
  });
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(String(result.stdout ?? "").trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const payload = await readStdin();
if (!payload.trim()) {
  printContinue();
  process.exit(0);
}
if (["1", "true", "yes", "on"].includes((process.env.CODEMEM_PLUGIN_IGNORE ?? "").toLowerCase())) {
  printContinue();
  process.exit(0);
}
if (["1", "true", "yes", "on"].includes((process.env.CODEMEM_CODEX_PLUGIN_SMOKE ?? "").toLowerCase())) {
  printContinue({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "CODEMEM_CODEX_PLUGIN_SMOKE: codemem Codex plugin hook executed."
    }
  });
  process.exit(0);
}

const pluginRoot = process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || dirname(scriptDir);
const injected =
  runInject("codemem", ["codex-hook-inject"], 2000) ??
  runInject("npx", ["-y", `codemem@${readPinnedVersion(pluginRoot)}`, "codex-hook-inject"], 2000);

if (injected) process.stdout.write(JSON.stringify(injected));
else printContinue();

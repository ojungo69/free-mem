import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const bundledRuntime = join(scriptDir, "hook-runtime.mjs");
if (existsSync(bundledRuntime)) {
  spawnSync(process.execPath, [bundledRuntime, "codex-hook-ingest"], {
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

const payload = await readStdin();
if (!payload.trim()) process.exit(0);
if (["1", "true", "yes", "on"].includes((process.env.CODEMEM_PLUGIN_IGNORE ?? "").toLowerCase())) {
  process.exit(0);
}

const pluginRoot = process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || dirname(scriptDir);

function resolvePinnedVersion() {
  try {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
    return typeof manifest.version === "string" && manifest.version.trim()
      ? manifest.version.trim()
      : "latest";
  } catch {
    return "latest";
  }
}

function run(command, args) {
  return spawnSync(command, args, {
    input: payload,
    encoding: "utf8",
    stdio: ["pipe", "ignore", "ignore"],
    timeout: 2000
  }).status === 0;
}

if (run("codemem", ["codex-hook-ingest"])) process.exit(0);
run("npx", ["-y", `codemem@${resolvePinnedVersion()}`, "codex-hook-ingest"]);
process.exit(0);

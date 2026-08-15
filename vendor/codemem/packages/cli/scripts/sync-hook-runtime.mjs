import { chmodSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const source = resolve(repositoryRoot, "packages/cli/dist/hook-runtime.js");

for (const target of [
	resolve(repositoryRoot, "plugins/claude/scripts/hook-runtime.mjs"),
	resolve(repositoryRoot, "plugins/codex/scripts/hook-runtime.mjs"),
]) {
	copyFileSync(source, target);
	chmodSync(target, 0o644);
}

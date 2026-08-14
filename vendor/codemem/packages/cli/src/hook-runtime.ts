#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildClaudeFileContext } from "./commands/claude-hook-file-context.js";
import { ingestClaudeHookPayload } from "./commands/claude-hook-ingest.js";
import { buildClaudeHookInjection } from "./commands/claude-hook-inject.js";
import { ingestCodexHookPayload } from "./commands/codex-hook-ingest.js";
import { buildCodexHookInjection } from "./commands/codex-hook-inject.js";

export const HOOK_RUNTIME_INPUT_MAX_BYTES = 256 * 1024;

const CONTINUE = '{"continue":true}';
const COMMANDS = new Set([
	"claude-hook-file-context",
	"claude-hook-ingest",
	"claude-hook-inject",
	"codex-hook-ingest",
	"codex-hook-inject",
]);

function fallback(command: string): string {
	return command === "claude-hook-ingest" ? "" : CONTINUE;
}

function disabled(): boolean {
	return ["1", "true", "yes", "on"].includes(
		String(process.env.CODEMEM_PLUGIN_IGNORE ?? "")
			.trim()
			.toLowerCase(),
	);
}

export async function runHookRuntime(command: string, raw: string): Promise<string> {
	if (!COMMANDS.has(command)) throw new Error("unsupported hook command");
	if (disabled() || Buffer.byteLength(raw, "utf8") > HOOK_RUNTIME_INPUT_MAX_BYTES) {
		return fallback(command);
	}
	let payload: Record<string, unknown>;
	try {
		const parsed = JSON.parse(raw.trim()) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback(command);
		payload = parsed as Record<string, unknown>;
	} catch {
		return fallback(command);
	}

	try {
		if (command === "claude-hook-ingest") {
			await ingestClaudeHookPayload(payload, { host: "127.0.0.1", port: 38888 });
			return "";
		}
		if (command === "codex-hook-ingest") {
			await ingestCodexHookPayload(payload, { host: "127.0.0.1", port: 38888 });
			return CONTINUE;
		}
		if (command === "claude-hook-inject") {
			return JSON.stringify(await buildClaudeHookInjection(payload, {}));
		}
		if (command === "codex-hook-inject") {
			return JSON.stringify(await buildCodexHookInjection(payload, {}));
		}
		return JSON.stringify(await buildClaudeFileContext(payload, {}));
	} catch {
		return fallback(command);
	}
}

async function readStdin(): Promise<string | null> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		const buffer = Buffer.from(chunk);
		size += buffer.length;
		if (size > HOOK_RUNTIME_INPUT_MAX_BYTES) return null;
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
	const command = process.argv[2] ?? "";
	if (!COMMANDS.has(command)) {
		process.exitCode = 2;
		return;
	}
	const raw = await readStdin();
	const output = raw === null ? fallback(command) : await runHookRuntime(command, raw);
	if (output) process.stdout.write(output);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	await main();
}

import { describe, expect, it } from "vitest";
import { HOOK_RUNTIME_INPUT_MAX_BYTES, runHookRuntime } from "./hook-runtime.js";

describe("bundled hook runtime", () => {
	it("fails open without persisting invalid or oversized input", async () => {
		await expect(runHookRuntime("claude-hook-ingest", "not-json")).resolves.toBe("");
		await expect(runHookRuntime("codex-hook-ingest", "not-json")).resolves.toBe(
			'{"continue":true}',
		);
		await expect(
			runHookRuntime("claude-hook-inject", "x".repeat(HOOK_RUNTIME_INPUT_MAX_BYTES + 1)),
		).resolves.toBe('{"continue":true}');
	});

	it("rejects commands outside the hook-only allowlist", async () => {
		await expect(runHookRuntime("memory-forget", "{}")).rejects.toThrow("unsupported hook command");
	});
});

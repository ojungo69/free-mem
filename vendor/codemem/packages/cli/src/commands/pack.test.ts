import type { PackTrace } from "@codemem/core";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const request = vi.fn();
vi.mock("@codemem/mcp", () => ({
	createMcpRpcClient: () => ({ request }),
}));

import { packCommand, renderPackTrace } from "./pack.js";

const pack = {
	items: [],
	pack_text: "RPC PACK",
	metrics: {
		total_items: 0,
		pack_tokens: 2,
		fallback_used: false,
		sources: { fts: 0, semantic: 0, fuzzy: 0 },
	},
};

const trace = {
	version: 1,
	inputs: {
		query: "continue work",
		project: "demo",
		working_set_files: [],
		token_budget: null,
		limit: 10,
	},
	mode: { selected: "task", reasons: [] },
	retrieval: { candidate_count: 0, candidates: [] },
	assembly: {
		deduped_ids: [],
		collapsed_groups: [],
		compressed_clusters: [],
		trimmed_ids: [],
		trim_reasons: [],
		sections: { summary: [], timeline: [], observations: [] },
	},
	output: {
		estimated_tokens: 2,
		truncated: false,
		section_counts: { summary: 0, timeline: 0, observations: 0 },
		pack_text: "RPC PACK",
	},
} as PackTrace;

afterEach(() => {
	request.mockReset();
	process.exitCode = 0;
	vi.restoreAllMocks();
});

async function parsePackCommand(args: string[]): Promise<void> {
	const root = new Command("codemem").enablePositionalOptions().addCommand(packCommand);
	await root.parseAsync(["pack", ...args], { from: "user" });
}

describe("pack command", () => {
	it("registers trace as a pack subcommand with shared options", () => {
		const nested = packCommand.commands.find((command) => command.name() === "trace");
		expect(nested?.options.map((option) => option.long)).toEqual(
			expect.arrayContaining([
				"--db-path",
				"--json",
				"--working-set-file",
				"--project",
				"--all-projects",
			]),
		);
	});

	it("supports the main pack commander path with json output", async () => {
		request.mockResolvedValue({ ok: true, result: { pack } });
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parsePackCommand([
			"continue work",
			"--json",
			"--project",
			"demo",
			"--token-budget",
			"90",
		]);

		expect(request).toHaveBeenCalledWith("POST /v1/context/pack", {
			requestId: expect.any(String),
			context: "continue work",
			limit: 10,
			tokenBudget: 90,
			filters: { project: "demo" },
			trace: false,
		});
		expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
			pack_text: "RPC PACK",
		});
	});

	it("routes trace flags to the trace subcommand after the positional context", async () => {
		request.mockResolvedValue({ ok: true, result: { pack, trace } });
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parsePackCommand(["trace", "continue work", "--json", "--all-projects"]);
		expect(request.mock.calls[0]?.[1]).toMatchObject({
			context: "continue work",
			filters: {},
			trace: true,
		});
		expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
			version: 1,
			mode: { selected: "task" },
		});
	});

	it("emits structured json errors for pack failures", async () => {
		request.mockResolvedValue({
			ok: false,
			error: { code: "daemon_unavailable", message: "daemon down", retryable: true },
		});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parsePackCommand(["continue work", "--json"]);
		expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
			error: "daemon_unavailable",
			message: "daemon down",
		});
		expect(process.exitCode).toBe(1);
	});

	it("renders grouped human-readable trace text", () => {
		expect(renderPackTrace(trace)).toContain("Final pack\nRPC PACK");
	});
});

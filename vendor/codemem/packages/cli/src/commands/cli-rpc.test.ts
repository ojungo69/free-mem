import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashMutationPayload, NORMALIZED_SCHEMA_VERSION, startDaemon } from "@codemem/core";
import { createMcpRpcClient } from "@codemem/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { distillCommand } from "./distill.js";
import { embedCommand } from "./embed.js";
import {
	forgetMemoryCommand,
	memoryCommand,
	rememberMemoryCommand,
	showMemoryCommand,
} from "./memory.js";
import { packCommand } from "./pack.js";
import { recentCommand } from "./recent.js";
import { searchCommand } from "./search.js";
import { statsCommand } from "./stats.js";
import { createStatusCommand } from "./status.js";

const cleanup: string[] = [];
const originalDataDir = process.env.CODEMEM_DATA_DIR;
const originalTrace = process.env.CODEMEM_DB_OPEN_TRACE;

afterEach(() => {
	if (originalDataDir === undefined) delete process.env.CODEMEM_DATA_DIR;
	else process.env.CODEMEM_DATA_DIR = originalDataDir;
	if (originalTrace === undefined) delete process.env.CODEMEM_DB_OPEN_TRACE;
	else process.env.CODEMEM_DB_OPEN_TRACE = originalTrace;
	for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
	process.exitCode = 0;
	vi.restoreAllMocks();
});

function fixture(prefix: string): { root: string; dataDir: string } {
	const root = mkdtempSync(join(tmpdir(), prefix));
	cleanup.push(root);
	mkdirSync(join(root, ".git"));
	return { root, dataDir: join(root, "data") };
}

describe("Phase 1 CLI RPC cutover", () => {
	it("P1-T044-01-cli-rpc-map", async () => {
		const { root, dataDir } = fixture("codemem-cli-rpc-map-");
		process.env.CODEMEM_DATA_DIR = dataDir;
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
		vi.spyOn(console, "error").mockImplementation(() => {});
		const daemon = await startDaemon({ dataDir });
		try {
			const client = createMcpRpcClient({ dataDir, cwd: () => root });
			await rememberMemoryCommand.parseAsync(
				[
					"--kind",
					"decision",
					"--title",
					"Use daemon RPC",
					"--body",
					"CLI commands do not open SQLite.",
					"--project",
					"demo",
					"--json",
				],
				{ from: "user" },
			);
			const id = Number((JSON.parse(output.at(-1) ?? "{}") as { id?: number }).id);
			expect(id).toBeGreaterThan(0);

			await showMemoryCommand.parseAsync([String(id), "--json"], { from: "user" });
			expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({ id });
			await packCommand.parseAsync(["daemon rpc", "--json", "--all-projects"], {
				from: "user",
			});
			expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({ pack_text: expect.any(String) });
			await searchCommand.parseAsync(["daemon rpc", "--json", "--all-projects"], {
				from: "user",
			});
			expect(JSON.parse(output.at(-1) ?? "[]")).toEqual(expect.any(Array));
			await recentCommand.parseAsync(["--json", "--all-projects"], { from: "user" });
			expect(JSON.parse(output.at(-1) ?? "[]")).toEqual(expect.any(Array));
			await statsCommand.parseAsync(["--json"], { from: "user" });
			expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({ database: expect.any(Object) });
			await createStatusCommand().parseAsync(["--json"], { from: "user" });
			expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
				daemon: { state: "running" },
				database: { state: "ready" },
			});

			const event = {
				schemaVersion: NORMALIZED_SCHEMA_VERSION,
				eventId: randomUUID(),
				idempotencyKey: randomUUID(),
				agent: "opencode",
				nativeSessionId: "session-t044",
				projectKey: "demo",
				workspaceKey: root,
				cwd: root,
				kind: "user_prompted",
				occurredAt: new Date().toISOString(),
				payload: { text: "safe prompt" },
				sourceHash: hashMutationPayload({ text: "safe prompt" }),
				sensitivity: "normal",
			};
			expect(
				await client.requestWithSpool("POST /v1/events", {
					idempotencyKey: event.idempotencyKey,
					event,
				}),
			).toMatchObject({ ok: true, result: { receiptId: expect.any(String) } });
			await forgetMemoryCommand.parseAsync([String(id), "--json"], { from: "user" });
			expect(JSON.parse(output.at(-1) ?? "{}")).toEqual({ id, status: "forgotten" });
		} finally {
			await daemon.stop();
		}
	});

	it("P1-T044-02-cli-typed-stubs", async () => {
		const output: unknown[] = [];
		vi.spyOn(console, "log").mockImplementation((value) => output.push(value));
		vi.spyOn(console, "error").mockImplementation(() => {});
		const extractionReplay = memoryCommand.commands.find(
			(command) => command.name() === "extraction-replay",
		);
		const extractionBenchmark = memoryCommand.commands.find(
			(command) => command.name() === "extraction-benchmark",
		);
		if (!extractionReplay || !extractionBenchmark) throw new Error("typed stub command missing");

		await distillCommand.parseAsync(["--json"], { from: "user" });
		await embedCommand.parseAsync(["--json"], { from: "user" });
		await extractionReplay.parseAsync(["--batch-id", "1", "--scenario", "x", "--json"], {
			from: "user",
		});
		await extractionBenchmark.parseAsync(["--benchmark", "x", "--json"], { from: "user" });

		expect(output.map((value) => JSON.parse(String(value)))).toEqual([
			expect.objectContaining({ code: "feature_unavailable", phase: 6 }),
			expect.objectContaining({ code: "feature_unavailable", phase: 7 }),
			expect.objectContaining({ code: "feature_unavailable", phase: 6 }),
			expect.objectContaining({ code: "feature_unavailable", phase: 6 }),
		]);
	});

	it("P1-T044-03-cli-no-db-fallback", async () => {
		const { root, dataDir } = fixture("codemem-cli-no-db-");
		const tracePath = join(root, "db-open.jsonl");
		process.env.CODEMEM_DATA_DIR = dataDir;
		process.env.CODEMEM_DB_OPEN_TRACE = tracePath;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const inject = memoryCommand.commands.find((command) => command.name() === "inject");
		if (!inject) throw new Error("inject command missing");

		const commands: Array<() => Promise<unknown>> = [
			() => searchCommand.parseAsync(["query", "--json"], { from: "user" }),
			() => recentCommand.parseAsync(["--json"], { from: "user" }),
			() => statsCommand.parseAsync(["--json"], { from: "user" }),
			() => packCommand.parseAsync(["query", "--json"], { from: "user" }),
			() => showMemoryCommand.parseAsync(["1", "--json"], { from: "user" }),
			() => forgetMemoryCommand.parseAsync(["1", "--json"], { from: "user" }),
			() => inject.parseAsync(["query"], { from: "user" }),
			() => createStatusCommand().parseAsync(["--json"], { from: "user" }),
			() =>
				rememberMemoryCommand.parseAsync(
					["--kind", "decision", "--title", "queued", "--body", "safe", "--json"],
					{ from: "user" },
				),
		];
		for (const run of commands) {
			process.exitCode = 0;
			await run();
		}

		const paths = readdirSync(root, { recursive: true }).map(String);
		expect(paths).not.toContain("db-open.jsonl");
		expect(paths.filter((path) => /\.sqlite(?:3)?$/.test(path))).toEqual([]);
		expect(paths.some((path) => path.includes("control/spool/ready"))).toBe(true);
	});
});

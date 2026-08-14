import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import {
	callDaemonRpc,
	hashMutationPayload,
	initDatabase,
	LOCAL_API_VERSION,
	MemoryStore,
	NORMALIZED_SCHEMA_VERSION,
	ReadOnlyActor,
	RPC_CAPABILITY_HASH,
	readCurrentDatabasePointer,
	resolveStorageLayout,
	startDaemon,
} from "@codemem/core";
import { describe, expect, it, vi } from "vitest";
import { dbCommand } from "./db.js";

describe("db command", () => {
	it("registers backfill-tags maintenance subcommand", () => {
		const backfill = dbCommand.commands.find((command) => command.name() === "backfill-tags");
		expect(backfill).toBeDefined();
		const longs = backfill?.options.map((option) => option.long) ?? [];
		expect(longs).toContain("--db");
		expect(longs).toContain("--db-path");
		expect(longs).toContain("--limit");
		expect(longs).toContain("--since");
		expect(longs).toContain("--project");
		expect(longs).toContain("--all-projects");
		expect(longs).toContain("--inactive");
		expect(longs).toContain("--dry-run");
		expect(longs).toContain("--json");
	});

	it("registers prune-observations and prune-memories subcommands", () => {
		const pruneObs = dbCommand.commands.find((command) => command.name() === "prune-observations");
		const pruneMem = dbCommand.commands.find((command) => command.name() === "prune-memories");
		expect(pruneObs).toBeDefined();
		expect(pruneMem).toBeDefined();

		const pruneObsLongs = pruneObs?.options.map((option) => option.long) ?? [];
		expect(pruneObsLongs).toContain("--limit");
		expect(pruneObsLongs).toContain("--dry-run");
		expect(pruneObsLongs).toContain("--json");

		const pruneMemLongs = pruneMem?.options.map((option) => option.long) ?? [];
		expect(pruneMemLongs).toContain("--limit");
		expect(pruneMemLongs).toContain("--kinds");
		expect(pruneMemLongs).toContain("--dry-run");
		expect(pruneMemLongs).toContain("--json");
	});

	it("registers dedup-memories, backfill-dedup-keys, backfill-narrative, and ai-backfill-structured subcommands", () => {
		const dedup = dbCommand.commands.find((command) => command.name() === "dedup-memories");
		const dedupKeys = dbCommand.commands.find(
			(command) => command.name() === "backfill-dedup-keys",
		);
		const narrative = dbCommand.commands.find((command) => command.name() === "backfill-narrative");
		const aiStructured = dbCommand.commands.find(
			(command) => command.name() === "ai-backfill-structured",
		);
		expect(dedup).toBeDefined();
		expect(dedupKeys).toBeDefined();
		expect(narrative).toBeDefined();
		expect(aiStructured).toBeDefined();

		const dedupLongs = dedup?.options.map((option) => option.long) ?? [];
		expect(dedupLongs).toContain("--window");
		expect(dedupLongs).toContain("--limit");
		expect(dedupLongs).toContain("--dry-run");
		expect(dedupLongs).toContain("--json");

		const dedupKeysLongs = dedupKeys?.options.map((option) => option.long) ?? [];
		expect(dedupKeysLongs).toContain("--limit");
		expect(dedupKeysLongs).toContain("--dry-run");
		expect(dedupKeysLongs).toContain("--json");

		const narrativeLongs = narrative?.options.map((option) => option.long) ?? [];
		expect(narrativeLongs).toContain("--limit");
		expect(narrativeLongs).toContain("--dry-run");
		expect(narrativeLongs).toContain("--json");

		const aiLongs = aiStructured?.options.map((option) => option.long) ?? [];
		expect(aiLongs).toContain("--limit");
		expect(aiLongs).toContain("--kinds");
		expect(aiLongs).toContain("--overwrite");
		expect(aiLongs).toContain("--dry-run");
		expect(aiLongs).toContain("--json");
	});

	it("registers prune-raw-events subcommand with age-based options", () => {
		const pruneRaw = dbCommand.commands.find((command) => command.name() === "prune-raw-events");
		expect(pruneRaw).toBeDefined();
		const longs = pruneRaw?.options.map((option) => option.long) ?? [];
		expect(longs).toContain("--db-path");
		expect(longs).toContain("--dry-run");
		expect(longs).toContain("--max-age-days");
		expect(longs).toContain("--vacuum");
		// Age-based only: no size-budget/batch options.
		expect(longs).not.toContain("--max-size-mb");
		expect(longs).not.toContain("--batch-ops");
	});

	function seedRawEvent(store: MemoryStore, sessionId: string, eventId: string, tsWallMs: number) {
		store.recordRawEvent({
			opencodeSessionId: sessionId,
			eventId,
			eventType: "user_prompt",
			payload: { type: "user_prompt", prompt_text: `seed ${eventId}` },
			tsWallMs,
		});
	}

	function countRawEvents(dbPath: string): number {
		const store = new MemoryStore(dbPath);
		try {
			const row = store.db.prepare("SELECT COUNT(*) AS cnt FROM raw_events").get() as {
				cnt: number;
			};
			return Number(row.cnt);
		} finally {
			store.close();
		}
	}

	async function seedDaemonRawEvent(
		socketPath: string,
		sessionId: string,
		eventId: string,
		tsWallMs: number,
	): Promise<void> {
		const response = await callDaemonRpc(socketPath, {
			id: randomUUID(),
			method: "POST /v1/events",
			adapter_version: "test",
			native_cli_version: "test",
			normalized_schema_version: NORMALIZED_SCHEMA_VERSION,
			local_api_version: LOCAL_API_VERSION,
			capability_hash: RPC_CAPABILITY_HASH,
			body: {
				idempotencyKey: eventId,
				event: {
					schemaVersion: NORMALIZED_SCHEMA_VERSION,
					eventId,
					idempotencyKey: eventId,
					agent: "opencode",
					nativeSessionId: sessionId,
					projectKey: "db-test",
					workspaceKey: "db-test",
					cwd: process.cwd(),
					kind: "user_prompted",
					occurredAt: new Date(tsWallMs).toISOString(),
					payload: { text: `seed ${eventId}` },
					sourceHash: hashMutationPayload({ eventId }),
					sensitivity: "normal",
				},
			},
		});
		if ("error" in response) throw new Error(response.error.code);
	}

	async function daemonRawEventCount(socketPath: string): Promise<number> {
		const response = await callDaemonRpc(socketPath, {
			id: randomUUID(),
			method: "GET /v1/view",
			adapter_version: "test",
			native_cli_version: "test",
			normalized_schema_version: NORMALIZED_SCHEMA_VERSION,
			local_api_version: LOCAL_API_VERSION,
			capability_hash: RPC_CAPABILITY_HASH,
			body: { collection: "raw-events" },
		});
		if ("error" in response) throw new Error(response.error.code);
		return Number((response.result.body as { pending?: number }).pending ?? 0);
	}

	it("prune-raw-events --dry-run deletes nothing", async () => {
		const pruneRaw = dbCommand.commands.find((command) => command.name() === "prune-raw-events");
		expect(pruneRaw).toBeDefined();
		if (!pruneRaw) throw new Error("expected prune-raw-events command");

		const dataDir = join(mkdtempSync(join(tmpdir(), "codemem-db-prune-raw-")), "data");
		const daemon = await startDaemon({ dataDir });
		const oldTs = Date.now() - 200 * 86_400_000; // well past a 1-day cutoff
		try {
			await seedDaemonRawEvent(daemon.socketPath, "sess-dry", "evt-0", oldTs);
			await seedDaemonRawEvent(daemon.socketPath, "sess-dry", "evt-1", oldTs + 1000);
			expect(await daemonRawEventCount(daemon.socketPath)).toBe(2);

			await pruneRaw.parseAsync(
				[
					"node",
					"prune-raw-events",
					"--db-path",
					join(dataDir, "legacy.sqlite"),
					"--max-age-days",
					"1",
					"--dry-run",
				],
				{ from: "node" },
			);

			expect(await daemonRawEventCount(daemon.socketPath)).toBe(2);
		} finally {
			await daemon.stop();
		}
	});

	it("prune-raw-events deletes events older than the cutoff and keeps newer ones", async () => {
		const pruneRaw = dbCommand.commands.find((command) => command.name() === "prune-raw-events");
		expect(pruneRaw).toBeDefined();
		if (!pruneRaw) throw new Error("expected prune-raw-events command");

		const dataDir = join(mkdtempSync(join(tmpdir(), "codemem-db-prune-raw-")), "data");
		const daemon = await startDaemon({ dataDir });
		const now = Date.now();
		try {
			await seedDaemonRawEvent(daemon.socketPath, "sess-old", "evt-0", now - 10 * 86_400_000);
			await seedDaemonRawEvent(daemon.socketPath, "sess-old", "evt-1", now - 5 * 86_400_000);
			await seedDaemonRawEvent(daemon.socketPath, "sess-new", "evt-2", now - 1000);
			expect(await daemonRawEventCount(daemon.socketPath)).toBe(3);

			await pruneRaw.parseAsync(
				[
					"node",
					"prune-raw-events",
					"--db-path",
					join(dataDir, "legacy.sqlite"),
					"--max-age-days",
					"1",
				],
				{ from: "node" },
			);

			expect(await daemonRawEventCount(daemon.socketPath)).toBe(1);
		} finally {
			await daemon.stop();
		}
		const layout = resolveStorageLayout(dataDir);
		const pointer = readCurrentDatabasePointer(layout);
		if (!pointer) throw new Error("canonical database pointer is missing");
		const reader = ReadOnlyActor.open(join(layout.dbDir, pointer));
		try {
			const remaining = reader.prepare("SELECT event_id FROM raw_events").all() as Array<{
				event_id: string;
			}>;
			expect(remaining.map((row) => row.event_id)).toEqual(["evt-2"]);
		} finally {
			reader.close();
		}
	});

	it("prune-raw-events rejects invalid --max-age-days and deletes nothing", async () => {
		const pruneRaw = dbCommand.commands.find((command) => command.name() === "prune-raw-events");
		expect(pruneRaw).toBeDefined();
		if (!pruneRaw) throw new Error("expected prune-raw-events command");

		const dbPath = join(mkdtempSync(join(tmpdir(), "codemem-db-prune-raw-bad-")), "test.sqlite");
		initDatabase(dbPath);
		const store = new MemoryStore(dbPath);
		seedRawEvent(store, "sess-x", "evt-0", Date.now() - 10 * 86_400_000);
		store.close();
		expect(countRawEvents(dbPath)).toBe(1);

		const logErrorSpy = vi.spyOn(p.log, "error").mockImplementation(() => {});
		const originalExitCode = process.exitCode;
		try {
			// A mistyped age and an explicit 0 must both be rejected — a destructive
			// prune must never run on invalid input. Includes partially-numeric
			// values ("1foo"/"1.5") that Number.parseInt would silently accept as 1.
			for (const bad of ["foo", "0", "1foo", "1.5", "-1", ""]) {
				process.exitCode = undefined;
				await pruneRaw.parseAsync(
					["node", "prune-raw-events", "--db-path", dbPath, "--max-age-days", bad],
					{ from: "node" },
				);
				expect(process.exitCode).toBe(1);
				expect(countRawEvents(dbPath)).toBe(1);
			}
		} finally {
			process.exitCode = originalExitCode;
			logErrorSpy.mockRestore();
		}
	});

	it("prune-raw-events reports a clean error (no uncaught throw) on an unreadable DB", async () => {
		const pruneRaw = dbCommand.commands.find((command) => command.name() === "prune-raw-events");
		expect(pruneRaw).toBeDefined();
		if (!pruneRaw) throw new Error("expected prune-raw-events command");

		// A non-SQLite file makes MemoryStore construction throw; the handler must
		// catch it and set exit code 1 rather than let an uncaught error escape.
		const badDbPath = join(mkdtempSync(join(tmpdir(), "codemem-db-badopen-")), "not-a.sqlite");
		writeFileSync(badDbPath, "this is definitely not a sqlite database");
		const logErrorSpy = vi.spyOn(p.log, "error").mockImplementation(() => {});
		const originalExitCode = process.exitCode;
		process.exitCode = undefined;
		try {
			await expect(
				pruneRaw.parseAsync(
					["node", "prune-raw-events", "--db-path", badDbPath, "--max-age-days", "30"],
					{ from: "node" },
				),
			).resolves.toBeDefined();
			expect(process.exitCode).toBe(1);
		} finally {
			process.exitCode = originalExitCode;
			logErrorSpy.mockRestore();
		}
	});

	it("rejects invalid dedup window input", async () => {
		const dedup = dbCommand.commands.find((command) => command.name() === "dedup-memories");
		expect(dedup).toBeDefined();
		if (!dedup) throw new Error("expected dedup-memories command");

		const dbPath = join(mkdtempSync(join(tmpdir(), "codemem-db-cmd-")), "test.sqlite");
		initDatabase(dbPath);
		const logErrorSpy = vi.spyOn(p.log, "error").mockImplementation(() => {});
		const originalExitCode = process.exitCode;
		process.exitCode = undefined;
		try {
			await dedup.parseAsync(["node", "dedup-memories", "--db-path", dbPath, "--window", "foo"], {
				from: "node",
			});
			expect(process.exitCode).toBe(1);
		} finally {
			process.exitCode = originalExitCode;
			logErrorSpy.mockRestore();
		}
	});
});

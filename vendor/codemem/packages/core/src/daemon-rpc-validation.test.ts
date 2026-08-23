import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type DaemonRpcContext,
	dispatchDaemonRpc,
	LOCAL_API_VERSION,
	NORMALIZED_SCHEMA_VERSION,
	RPC_CAPABILITY_HASH,
} from "./daemon-rpc.js";
import { openTestMemoryStore } from "./test-utils.js";

// Two id guards sit on the same request and are easy to confuse: the envelope
// guard (`id` must be a non-empty string) and requirePositiveInt (`body.ids`
// entries must be positive integers). Each is pinned separately below.
function withContext(run: (ctx: DaemonRpcContext, seededIds: number[]) => Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), "codemem-rpc-id-"));
	const store = openTestMemoryStore(join(dir, "test.sqlite"));
	const db = store.db;
	const sessionId = Number(
		db
			.prepare(
				`INSERT INTO sessions(started_at, cwd, project, user, tool_version, metadata_json, import_key)
				 VALUES ('2026-03-01T10:00:00Z', '/tmp/repo', 'codemem', 'test-user', 'test', '{}', 'rpc-id-session')`,
			)
			.run().lastInsertRowid,
	);
	const seededIds = ["first", "second"].map((slug) =>
		Number(
			db
				.prepare(
					`INSERT INTO memory_items(
						session_id, kind, title, body_text, confidence, tags_text, active,
						created_at, updated_at, metadata_json, rev, visibility, import_key
					 ) VALUES (?, 'decision', ?, 'seeded for id validation', 0.9, '', 1,
						'2026-03-01T10:00:00Z', '2026-03-01T10:00:00Z', '{}', 1, 'shared', ?)`,
				)
				.run(sessionId, `RPC id fixture ${slug}`, `rpc-id-${slug}`).lastInsertRowid,
		),
	);
	const ctx = {
		identity: { pid: process.pid, nonce: "rpc-id-test" },
		dataDir: dir,
		onStop: () => {},
		writer: db,
		store,
		jobs: { isMaintenanceMode: () => false } as never,
	} as DaemonRpcContext;
	return run(ctx, seededIds).finally(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});
}

// Every dispatch needs its own requestId: it becomes the class-A idempotency
// key, so a reused one makes the second accepted call return the first call's
// receipt as a conflict instead of executing.
const getMany = (requestId: string, memoryId: unknown, envelopeId: unknown = requestId) =>
	JSON.stringify({
		id: envelopeId,
		method: "POST /v1/search",
		adapter_version: "test",
		native_cli_version: "test",
		normalized_schema_version: NORMALIZED_SCHEMA_VERSION,
		local_api_version: LOCAL_API_VERSION,
		capability_hash: RPC_CAPABILITY_HASH,
		body: { requestId, mode: "get_many", ids: [memoryId] },
	});

describe("daemon RPC id validation", () => {
	it("parses a canonical positive integer string back to the memory it names", async () => {
		await withContext(async (ctx, seededIds) => {
			// Asks for the SECOND seeded row, so a parser that returns a constant
			// (or the first id) answers with the wrong memory rather than an empty list.
			const [, second] = seededIds;
			const response = await dispatchDaemonRpc(getMany("rpc-id-accept", String(second)), ctx);
			expect(response).toMatchObject({ result: { items: [{ id: second }] } });
			expect((response as { result: { items: unknown[] } }).result.items).toHaveLength(1);
		});
	});

	it("rejects non-canonical id spellings", async () => {
		await withContext(async (ctx) => {
			for (const [index, memoryId] of ["0", "01", "-1", "1.5", "", true].entries()) {
				expect(
					await dispatchDaemonRpc(getMany(`rpc-id-reject-${index}`, memoryId), ctx),
				).toMatchObject({ error: { code: "invalid_request", message: "id is invalid." } });
			}
		});
	});

	it("rejects an envelope whose own id is missing or not a non-empty string", async () => {
		await withContext(async (ctx, seededIds) => {
			const [first] = seededIds;
			for (const [index, envelopeId] of ["", 7, null].entries()) {
				expect(
					await dispatchDaemonRpc(getMany(`rpc-envelope-${index}`, String(first), envelopeId), ctx),
				).toMatchObject({
					error: { code: "invalid_request", message: "RPC request id is required." },
				});
			}
		});
	});
});

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as core from "./index.js";

const created: Array<{ stop: () => Promise<void> }> = [];
const dirs: string[] = [];

function tempDataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "codemem-t036-"));
	dirs.push(dir);
	return join(dir, "data");
}

function handshake(overrides: Partial<core.RpcRequest> = {}): core.RpcRequest {
	return {
		id: "req-1",
		method: "GET /v1/health",
		adapter_version: "1",
		native_cli_version: "1",
		normalized_schema_version: core.NORMALIZED_SCHEMA_VERSION,
		local_api_version: core.LOCAL_API_VERSION,
		capability_hash: core.RPC_CAPABILITY_HASH,
		...overrides,
	};
}

function normalizedEvent(
	overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
	return {
		schemaVersion: core.NORMALIZED_SCHEMA_VERSION,
		eventId: "event-1",
		idempotencyKey: "event-key-1",
		agent: "codex",
		nativeSessionId: "session-1",
		projectKey: "project-1",
		workspaceKey: "workspace-1",
		cwd: "/tmp/project-1",
		kind: "user_prompted",
		occurredAt: "2026-08-13T00:00:00.000Z",
		payload: { text: "hello" },
		sourceHash: "a".repeat(64),
		sensitivity: "normal",
		...overrides,
	};
}

afterEach(async () => {
	for (const handle of created.splice(0)) {
		try {
			await handle.stop();
		} catch {
			// cleanup
		}
	}
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("Phase 1 mutation dispatcher", () => {
	it("P1-T036-01-receipt-schema", async () => {
		const handle = await core.startDaemon({ dataDir: tempDataDir() });
		created.push(handle);
		const reader = core.ReadOnlyActor.open(realpathSync(handle.layout.currentPointerPath));
		try {
			expect(
				reader
					.prepare(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mutation_receipts'",
					)
					.get(),
			).toBeTruthy();
			expect(core.getSchemaVersion(reader)).toBe(core.SCHEMA_VERSION);
		} finally {
			reader.close();
		}
	});

	it("P1-T036-02b-event-id-required", async () => {
		const handle = await core.startDaemon({ dataDir: tempDataDir() });
		created.push(handle);
		const missing = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				method: "POST /v1/events",
				body: {
					idempotencyKey: "evt-missing",
					event: normalizedEvent({ eventId: "", idempotencyKey: "evt-missing" }),
				},
			}),
		);
		expect(missing).toMatchObject({ error: { code: "invalid_request" } });
		const written = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				method: "POST /v1/events",
				id: "req-2",
				body: {
					idempotencyKey: "evt-missing",
					event: normalizedEvent({
						eventId: "e-fixed",
						idempotencyKey: "evt-missing",
					}),
				},
			}),
		);
		expect(written).toMatchObject({ result: { status: "committed" } });
	});

	it("P1-T036-02-events-idempotent", async () => {
		const handle = await core.startDaemon({ dataDir: tempDataDir() });
		created.push(handle);
		const body = {
			idempotencyKey: "evt-1",
			event: normalizedEvent({ eventId: "e1", idempotencyKey: "evt-1" }),
		};
		const first = await core.callDaemonRpc(
			handle.socketPath,
			handshake({ method: "POST /v1/events", body }),
		);
		const second = await core.callDaemonRpc(
			handle.socketPath,
			handshake({ method: "POST /v1/events", id: "req-2", body }),
		);
		expect(first).toMatchObject({ result: { status: "committed" } });
		expect(second).toMatchObject({
			result: { receiptId: (first as core.RpcSuccess).result.receiptId, status: "committed" },
		});
	});

	it("P1-T036-03-events-conflict", async () => {
		const handle = await core.startDaemon({ dataDir: tempDataDir() });
		created.push(handle);
		const first = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				method: "POST /v1/events",
				body: {
					idempotencyKey: "evt-2",
					event: normalizedEvent({
						eventId: "e2a",
						idempotencyKey: "evt-2",
						payload: { n: 1 },
					}),
				},
			}),
		);
		expect(first).toMatchObject({ result: { status: "committed" } });
		const conflict = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				method: "POST /v1/events",
				id: "req-2",
				body: {
					idempotencyKey: "evt-2",
					event: normalizedEvent({
						eventId: "e2b",
						idempotencyKey: "evt-2",
						payload: { n: 2 },
					}),
				},
			}),
		);
		expect(conflict).toMatchObject({ error: { code: "idempotency_conflict" } });
		const reader = core.ReadOnlyActor.open(realpathSync(handle.layout.currentPointerPath));
		try {
			const row = reader
				.prepare(
					"SELECT COUNT(*) AS n FROM mutation_quarantine WHERE method = ? AND idempotency_key LIKE ?",
				)
				.get("POST /v1/events", "%evt-2") as { n: number };
			expect(row.n).toBeGreaterThan(0);
		} finally {
			reader.close();
		}
	});

	it("P1-T038-07-daemon-persists-secret-events-without-secret-body", async () => {
		const handle = await core.startDaemon({ dataDir: tempDataDir() });
		created.push(handle);
		const secret = "AKIAIOSFODNN7EXAMPLE";
		const response = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				method: "POST /v1/events",
				body: {
					idempotencyKey: "secret-event",
					event: normalizedEvent({
						eventId: "secret-event-1",
						idempotencyKey: "secret-event",
						payload: { text: `credential ${secret}` },
					}),
				},
			}),
		);
		expect(response).toMatchObject({ result: { status: "committed" } });

		const reader = core.ReadOnlyActor.open(realpathSync(handle.layout.currentPointerPath));
		try {
			const row = reader
				.prepare("SELECT payload_json FROM raw_events WHERE event_id = ?")
				.get("secret-event-1") as { payload_json: string };
			expect(row.payload_json).not.toContain(secret);
			expect(JSON.parse(row.payload_json)).toMatchObject({
				eventId: "secret-event-1",
				payload: {},
				sensitivity: "secret",
			});
		} finally {
			reader.close();
		}
	});

	it("P1-T036-04-memories-record", async () => {
		const handle = await core.startDaemon({ dataDir: tempDataDir() });
		created.push(handle);
		const createdMemory = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				method: "POST /v1/memories/record",
				body: {
					idempotencyKey: "mem-1",
					kind: "discovery",
					title: "T036 memory",
					body: "dispatcher persist",
					confidence: 0.9,
				},
			}),
		);
		expect(createdMemory).toMatchObject({ result: { receiptId: expect.any(String) } });
		const memoryId = (createdMemory as core.RpcSuccess).result.memoryId;
		expect(typeof memoryId).toBe("number");
		const fetched = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				method: "GET /v1/memories/:id",
				id: "req-2",
				body: { id: memoryId, requestId: "get-1" },
			}),
		);
		expect(fetched).toMatchObject({ result: { item: { title: "T036 memory", confidence: 0.9 } } });
		const badFilter = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				method: "GET /v1/memories/:id",
				id: "req-3",
				body: { id: memoryId, requestId: "get-2", project: 123 },
			}),
		);
		expect(badFilter).toMatchObject({ error: { code: "invalid_request" } });
		const badKind = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				method: "POST /v1/memories/record",
				id: "req-4",
				body: {
					idempotencyKey: "mem-invalid-kind",
					kind: "not-a-memory-kind",
					title: "invalid",
					body: "invalid",
				},
			}),
		);
		expect(badKind).toMatchObject({ error: { code: "invalid_request" } });
		const secretKey = `ghp_${"A".repeat(36)}`;
		const secretIdentifier = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				method: "POST /v1/memories/record",
				id: "req-5",
				body: {
					idempotencyKey: secretKey,
					kind: "discovery",
					title: "must not persist",
					body: "must not persist",
				},
			}),
		);
		expect(secretIdentifier).toMatchObject({ error: { code: "invalid_request" } });
		const reader = core.ReadOnlyActor.open(realpathSync(handle.layout.currentPointerPath));
		try {
			expect(
				reader
					.prepare("SELECT COUNT(*) AS n FROM mutation_receipts WHERE idempotency_key = ?")
					.get(secretKey),
			).toEqual({ n: 0 });
		} finally {
			reader.close();
		}
	});

	it("P1-T036-05-view-search-allowlist", async () => {
		const handle = await core.startDaemon({ dataDir: tempDataDir() });
		created.push(handle);
		const alpha = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				method: "POST /v1/memories/record",
				body: {
					idempotencyKey: "filter-alpha",
					kind: "discovery",
					title: "filter target alpha",
					body: "alpha",
					project: "alpha",
				},
			}),
		);
		await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				method: "POST /v1/memories/record",
				id: "req-beta",
				body: {
					idempotencyKey: "filter-beta",
					kind: "discovery",
					title: "filter target beta",
					body: "beta",
					project: "beta",
				},
			}),
		);
		const view = await core.callDaemonRpc(
			handle.socketPath,
			handshake({ method: "GET /v1/view", body: { collection: "sessions" } }),
		);
		expect(view).toMatchObject({ result: { collection: "sessions" } });
		const search = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				method: "POST /v1/search",
				body: {
					requestId: "search-1",
					mode: "search",
					query: "filter target",
					filters: { project: "alpha" },
				},
			}),
		);
		expect(search).toMatchObject({ result: { retrievalReceiptId: expect.any(String) } });
		expect(
			((search as core.RpcSuccess).result.items as Array<{ id: number }>).map((item) => item.id),
		).toEqual([(alpha as core.RpcSuccess).result.memoryId]);
		const unknown = await core.callDaemonRpc(
			handle.socketPath,
			handshake({ method: "POST /v1/events", body: { idempotencyKey: "x", surprise: 1 } }),
		);
		expect(unknown).toMatchObject({ error: { code: "unknown_field" } });
	});

	it("P1-T036-05b-view-hides-inaccessible-scopes", async () => {
		const dataDir = tempDataDir();
		const first = await core.startDaemon({ dataDir });
		created.push(first);
		const remembered = await core.callDaemonRpc(
			first.socketPath,
			handshake({
				method: "POST /v1/memories/record",
				body: {
					idempotencyKey: "hidden-memory",
					kind: "discovery",
					title: "hidden scope",
					body: "must not appear in viewer reads",
				},
			}),
		);
		const memoryId = (remembered as core.RpcSuccess).result.memoryId;
		await first.stop();

		const db = core.WriterActor.open(realpathSync(first.layout.currentPointerPath));
		try {
			const now = new Date().toISOString();
			db.prepare(
				`INSERT INTO replication_scopes(
					scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
				 ) VALUES ('hidden-team', 'hidden-team', 'team', 'coordinator', 1, 'active', ?, ?)`,
			).run(now, now);
			db.prepare("UPDATE memory_items SET scope_id = 'hidden-team' WHERE id = ?").run(memoryId);
		} finally {
			db.close();
		}

		const second = await core.startDaemon({ dataDir });
		created.push(second);
		for (const [collection, expected] of [
			["memories", []],
			["sessions", []],
			["stats", { memories: 0 }],
		] as const) {
			const response = await core.callDaemonRpc(
				second.socketPath,
				handshake({ method: "GET /v1/view", body: { collection } }),
			);
			expect(response).toMatchObject({ result: { collection, items: expected } });
		}
	});

	it("P1-T036-06-class-b-stub", async () => {
		const handle = await core.startDaemon({ dataDir: tempDataDir() });
		created.push(handle);
		const exported = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				method: "POST /v1/operations/export",
				body: {
					operationId: "exp-1",
					payloadHash: "a".repeat(64),
					outputPath: "/tmp/out.json",
				},
			}),
		);
		expect(exported).toMatchObject({ result: { state: "not_implemented" } });
	});

	it("P1-T036-07-delete-revision-is-part-of-idempotency", async () => {
		const handle = await core.startDaemon({ dataDir: tempDataDir() });
		created.push(handle);
		const remembered = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				method: "POST /v1/memories/record",
				body: {
					idempotencyKey: "delete-memory",
					kind: "discovery",
					title: "delete target",
					body: "delete target",
				},
			}),
		);
		const id = (remembered as core.RpcSuccess).result.memoryId;
		const first = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				method: "DELETE /v1/memories/:id",
				body: { id, requestId: "delete-1", expectedRevision: 1 },
			}),
		);
		expect(first).toMatchObject({ result: { status: "committed" } });
		const conflict = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				method: "DELETE /v1/memories/:id",
				id: "req-delete-conflict",
				body: { id, requestId: "delete-1", expectedRevision: 2 },
			}),
		);
		expect(conflict).toMatchObject({ error: { code: "idempotency_conflict" } });
	});

	it("P1-T036-08-side-effect-and-receipt-share-one-transaction", () => {
		const db = core.WriterActor.open(":memory:");
		try {
			core.ensureMutationReceiptSchema(db);
			db.exec("CREATE TABLE probe(value TEXT NOT NULL)");
			expect(() =>
				core.dispatchClassA(db, {
					method: "POST /probe",
					idempotencyKey: "rollback-1",
					payload: { value: "nope" },
					apply: () => {
						db.prepare("INSERT INTO probe(value) VALUES (?)").run("nope");
						throw new Error("expected rollback");
					},
				}),
			).toThrow("expected rollback");
			expect(db.prepare("SELECT COUNT(*) AS n FROM probe").get()).toEqual({ n: 0 });
			expect(db.prepare("SELECT COUNT(*) AS n FROM mutation_receipts").get()).toEqual({ n: 0 });

			const first = core.dispatchClassA(db, {
				method: "POST /probe",
				idempotencyKey: "once-1",
				payload: { value: "yes" },
				apply: () => ({ ok: true }),
			});
			const replay = core.dispatchClassA(db, {
				method: "POST /probe",
				idempotencyKey: "once-1",
				payload: { value: "yes" },
				apply: () => ({ ok: false }),
			});
			expect(replay).toMatchObject({
				receiptId: first.receiptId,
				idempotencyKey: "once-1",
				result: { ok: true },
			});
		} finally {
			db.close();
		}
	});
});

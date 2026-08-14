import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as core from "./index.js";

const created: Array<{ stop: () => Promise<void> }> = [];
const dirs: string[] = [];

function tempDataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "codemem-rpc-"));
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

describe("Phase 1 daemon RPC", () => {
	it("P1-T035-01-handshake-version", async () => {
		const handle = await core.startDaemon({ dataDir: tempDataDir() });
		created.push(handle);
		const response = await core.callDaemonRpc(
			handle.socketPath,
			handshake({ local_api_version: core.LOCAL_API_VERSION + 1 }),
		);
		expect(response).toMatchObject({
			error: { code: "protocol_mismatch", retryable: false },
		});
		const schema = await core.callDaemonRpc(
			handle.socketPath,
			handshake({ normalized_schema_version: 0 }),
		);
		expect(schema).toMatchObject({ error: { code: "protocol_mismatch" } });
	});

	it("P1-T035-02-schema-allowlist", async () => {
		const handle = await core.startDaemon({ dataDir: tempDataDir() });
		created.push(handle);
		const unknownMethod = await core.callDaemonRpc(
			handle.socketPath,
			handshake({ method: "POST /v1/not-a-method" }),
		);
		expect(unknownMethod).toMatchObject({ error: { code: "unknown_method" } });
		const unknownField = await core.callDaemonRpc(
			handle.socketPath,
			handshake({ extra: true } as unknown as core.RpcRequest),
		);
		expect(unknownField).toMatchObject({ error: { code: "unknown_field" } });
		const unknownBodyField = await core.callDaemonRpc(
			handle.socketPath,
			handshake({ method: "GET /v1/health", body: { surprise: 1 } }),
		);
		expect(unknownBodyField).toMatchObject({ error: { code: "unknown_field" } });
	});

	it("P1-T035-03-size-and-deadline", async () => {
		const oversized = await new Promise<string>((resolve, reject) => {
			void core.startDaemon({ dataDir: tempDataDir() }).then((handle) => {
				created.push(handle);
				const socket = createConnection(handle.socketPath);
				let buf = "";
				socket.once("error", reject);
				socket.once("connect", () => {
					socket.write(`${"x".repeat(core.RPC_MAX_BYTES + 1)}\n`);
				});
				socket.on("data", (chunk) => {
					buf += chunk.toString("utf8");
					if (buf.includes("\n")) {
						socket.destroy();
						resolve(buf);
					}
				});
				socket.setTimeout(2000, () => reject(new Error("size probe timed out")));
			});
		});
		expect(JSON.parse(oversized)).toMatchObject({ error: { code: "payload_too_large" } });

		let now = 0;
		const handle = await core.startDaemon({
			dataDir: tempDataDir(),
			rpcDeadlineMs: 50,
			now: () => {
				now += 100;
				return now;
			},
		});
		created.push(handle);
		const late = await core.callDaemonRpc(handle.socketPath, handshake());
		expect(late).toMatchObject({ error: { code: "deadline_exceeded", retryable: true } });
	});

	it("P1-T035-04-health-doctor", async () => {
		const handle = await core.startDaemon({ dataDir: tempDataDir() });
		created.push(handle);
		const health = await core.callDaemonRpc(
			handle.socketPath,
			handshake({ method: "GET /v1/health" }),
		);
		expect(health).toMatchObject({
			id: "req-1",
			result: {
				status: "ok",
				instanceId: handle.identity.nonce,
				protocolVersion: {
					localApi: core.LOCAL_API_VERSION,
					normalizedSchema: core.NORMALIZED_SCHEMA_VERSION,
				},
			},
		});
		const doctor = await core.callDaemonRpc(
			handle.socketPath,
			handshake({ method: "GET /v1/doctor" }),
		);
		expect(doctor).toMatchObject({
			result: {
				status: "ok",
				instanceId: handle.identity.nonce,
				protocolVersion: {
					localApi: core.LOCAL_API_VERSION,
					normalizedSchema: core.NORMALIZED_SCHEMA_VERSION,
				},
				diagnostics: {
					lock: "held",
					socket: "listening",
					hookDelivery: {
						implementation: "node-fallback",
						p95TargetMs: 150,
						budgets: core.HOOK_DELIVERY_BUDGETS,
					},
				},
			},
		});
	});

	it("P1-T041-04-file-search stays repository-relative", async () => {
		const handle = await core.startDaemon({ dataDir: tempDataDir() });
		created.push(handle);
		const escaped = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				method: "POST /v1/search",
				body: { requestId: "search-escape", mode: "find_by_file", repositoryPath: "../secret" },
			}),
		);
		expect(escaped).toMatchObject({ error: { code: "invalid_request" } });

		const safe = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				id: "req-safe-file",
				method: "POST /v1/search",
				body: {
					requestId: "search-safe",
					mode: "find_by_file",
					repositoryPath: "src/auth.ts",
				},
			}),
		);
		expect(safe).toMatchObject({ result: { items: [], retrievalReceiptId: expect.any(String) } });
	});

	it("P1-T041-05 records and completes the file-context retrieval ledger in the daemon", async () => {
		const dataDir = tempDataDir();
		const handle = await core.startDaemon({ dataDir });
		created.push(handle);
		const common = {
			startedAt: "2026-08-14T01:00:00.000Z",
			completedAt: "2026-08-14T01:00:00.010Z",
			repositoryPath: "src/auth.ts",
			project: "free-mem",
			sourceSessionId: "claude-session",
		};
		const noResults = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				id: "req-ledger-empty",
				method: "POST /v1/retrieval/file-context",
				body: {
					...common,
					attemptId: "11111111-1111-4111-8111-111111111111",
					retrievalStatus: "no_results",
				},
			}),
		);
		expect(noResults).toMatchObject({ result: { recorded: true } });

		const succeeded = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				id: "req-ledger-success",
				method: "POST /v1/retrieval/file-context",
				body: {
					...common,
					attemptId: "22222222-2222-4222-8222-222222222222",
					retrievalStatus: "succeeded",
					candidateIds: [999],
					candidateCount: 1,
					selectedIds: [999],
				},
			}),
		);
		expect(succeeded).toMatchObject({ result: { recorded: true } });
		const delivered = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				id: "req-ledger-delivery",
				method: "POST /v1/retrieval/file-context/delivery",
				body: {
					attemptId: "22222222-2222-4222-8222-222222222222",
					status: "handed_off",
				},
			}),
		);
		expect(delivered).toMatchObject({ result: { updated: true } });

		const escaped = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				id: "req-ledger-escape",
				method: "POST /v1/retrieval/file-context",
				body: {
					...common,
					attemptId: "33333333-3333-4333-8333-333333333333",
					repositoryPath: "/secret",
					retrievalStatus: "no_results",
				},
			}),
		);
		expect(escaped).toMatchObject({ error: { code: "invalid_request" } });

		await handle.stop();
		const layout = core.resolveStorageLayout(dataDir);
		const pointer = core.readCurrentDatabasePointer(layout);
		const store = new core.MemoryStore(resolve(layout.dbDir, pointer as string));
		try {
			const rows = store.db
				.prepare(
					"SELECT attempt_id, surface, retrieval_status, delivery_status FROM retrieval_attempts ORDER BY attempt_id",
				)
				.all();
			expect(rows).toEqual([
				{
					attempt_id: "11111111-1111-4111-8111-111111111111",
					surface: "file_context",
					retrieval_status: "no_results",
					delivery_status: "not_attempted",
				},
				{
					attempt_id: "22222222-2222-4222-8222-222222222222",
					surface: "file_context",
					retrieval_status: "succeeded",
					delivery_status: "handed_off",
				},
			]);
		} finally {
			store.close();
		}
	});
});

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import * as core from "./index.js";
import { openTestMemoryStore } from "./test-utils.js";

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

async function waitForDaemonJob(
	socketPath: string,
	jobId: string,
): Promise<Record<string, unknown> | null> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const response = await core.callDaemonRpc(
			socketPath,
			handshake({
				id: `job-${jobId}-${attempt}`,
				method: "GET /v1/jobs/:id",
				body: { id: jobId },
			}),
		);
		if ("result" in response) {
			const job = (response.result.job as Record<string, unknown> | null) ?? null;
			if (job?.state === "completed" || job?.state === "failed") return job;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return null;
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

		const oversizedResponse = await new Promise<unknown>((resolve, reject) => {
			const dataDir = tempDataDir();
			const layout = core.resolveStorageLayout(dataDir);
			mkdirSync(layout.controlDir, { recursive: true, mode: 0o700 });
			const server = createServer((socket) => {
				socket.once("data", () => socket.write("x".repeat(core.RPC_MAX_BYTES + 1)));
			});
			server.once("error", reject);
			server.listen(layout.socketPath, () => {
				core
					.callDaemonRpc(layout.socketPath, handshake(), {
						timeoutMs: 1_000,
						maxResponseBytes: core.RPC_MAX_BYTES,
					})
					.then(
						(value) => {
							server.close();
							resolve(value);
						},
						(error: unknown) => {
							server.close();
							resolve(error);
						},
					);
			});
		});
		expect(oversizedResponse).toBeInstanceOf(Error);
		expect(String(oversizedResponse)).toContain("response exceeds");

		const responseWithTrailingBytes = await new Promise<unknown>((resolve, reject) => {
			const dataDir = tempDataDir();
			const layout = core.resolveStorageLayout(dataDir);
			mkdirSync(layout.controlDir, { recursive: true, mode: 0o700 });
			const response = `${JSON.stringify({ id: "req-1", result: { status: "ok" } })}\n`;
			const server = createServer((socket) => {
				socket.once("data", () => socket.end(`${response}${"x".repeat(core.RPC_MAX_BYTES)}`));
			});
			server.once("error", reject);
			server.listen(layout.socketPath, () => {
				core
					.callDaemonRpc(layout.socketPath, handshake(), {
						timeoutMs: 1_000,
						maxResponseBytes: Buffer.byteLength(response),
					})
					.then(
						(value) => {
							server.close();
							resolve(value);
						},
						(error: unknown) => {
							server.close();
							reject(error);
						},
					);
			});
		});
		expect(responseWithTrailingBytes).toEqual({ id: "req-1", result: { status: "ok" } });

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
					redaction: {
						status: "ok",
						degradedDeliveries: 0,
						workerDeadlineMs: core.REDACTION_WORKER_DEADLINE_MS,
					},
				},
			},
		});
	});

	it("rejects malformed memory adapter redaction metadata", async () => {
		const handle = await core.startDaemon({ dataDir: tempDataDir() });
		created.push(handle);
		const response = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				method: "POST /v1/memories/record",
				body: {
					idempotencyKey: "malformed-memory-redaction",
					kind: "decision",
					title: "Safe title",
					body: "Safe body",
					adapterRedaction: {},
				},
			}),
		);
		expect(response).toMatchObject({
			error: { code: "invalid_request", message: "adapterRedaction is malformed." },
		});
	});

	it("P1-T043-10-daemon-auth-rpc exchanges and verifies sessions through the daemon", async () => {
		const handle = await core.startDaemon({ dataDir: tempDataDir() });
		created.push(handle);
		const nonceResponse = await core.callDaemonRpc(
			handle.socketPath,
			handshake({ method: "POST /v1/viewer/auth/nonce" }),
		);
		if (!("result" in nonceResponse)) throw new Error("nonce RPC failed");
		const nonce = String(nonceResponse.result.nonce);

		const exchange = await core.callDaemonRpc(
			handle.socketPath,
			handshake({ method: "POST /v1/viewer/auth/exchange", body: { nonce } }),
		);
		if (!("result" in exchange)) throw new Error("exchange RPC failed");
		const session = (exchange.result.session as { cookie?: unknown } | null)?.cookie;
		expect(typeof session).toBe("string");

		const verify = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				method: "POST /v1/viewer/auth/verify",
				body: { session },
			}),
		);
		expect(verify).toMatchObject({ result: { authenticated: true } });

		const logout = await core.callDaemonRpc(
			handle.socketPath,
			handshake({ method: "POST /v1/viewer/auth/logout", body: { session } }),
		);
		expect(logout).toMatchObject({ result: { loggedOut: true } });
		const rejected = await core.callDaemonRpc(
			handle.socketPath,
			handshake({ method: "POST /v1/viewer/auth/verify", body: { session } }),
		);
		expect(rejected).toMatchObject({ result: { authenticated: false } });
	});

	it("P1-T043-12-daemon-view-collections serves collections from the daemon store", async () => {
		const handle = await core.startDaemon({ dataDir: tempDataDir() });
		created.push(handle);
		const recorded = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				method: "POST /v1/memories/record",
				body: {
					idempotencyKey: "viewer-seed",
					kind: "discovery",
					title: "Viewer seed",
					body: "Visible through daemon RPC",
					project: "/tmp/viewer-project",
				},
			}),
		);
		expect(recorded).toMatchObject({ result: { memoryId: expect.any(Number) } });
		await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				id: "viewer-summary",
				method: "POST /v1/memories/record",
				body: {
					idempotencyKey: "viewer-summary",
					kind: "session_summary",
					title: "Viewer summary",
					body: "Summary through daemon RPC",
					project: "/tmp/viewer-project",
				},
			}),
		);

		const view = async (collection: string, body: Record<string, unknown> = {}) => {
			const response = await core.callDaemonRpc(
				handle.socketPath,
				handshake({ method: "GET /v1/view", body: { collection, ...body } }),
			);
			if (!("result" in response)) throw new Error(`${collection} view failed`);
			return response.result;
		};

		expect(await view("projects")).toEqual({
			status: 200,
			body: { projects: ["viewer-project"] },
		});
		expect(await view("observations", { limit: 10 })).toMatchObject({
			status: 200,
			body: { items: [{ title: "Viewer seed" }], pagination: { has_more: false } },
		});
		expect(await view("summaries", { limit: 10 })).toMatchObject({
			status: 200,
			body: { items: [{ title: "Viewer summary" }], pagination: { has_more: false } },
		});
		const sessions = await view("sessions");
		expect(sessions).toMatchObject({
			status: 200,
			body: { items: [{ project: "/tmp/viewer-project" }] },
		});
		const sessionId = Number((sessions.body as { items: Array<{ id: number }> }).items[0]?.id);
		expect(await view("artifacts", { sessionId })).toEqual({
			status: 200,
			body: { items: [] },
		});
		expect(await view("session", { project: "/tmp/viewer-project" })).toMatchObject({
			status: 200,
			body: { memories: 2, observations: 1 },
		});
		expect(await view("stats")).toMatchObject({
			status: 200,
			body: { database: { memory_items: 2 }, maintenance_jobs: expect.any(Array) },
		});
		expect(await view("runtime")).toEqual({ status: 200, body: { version: core.VERSION } });
		expect(await view("raw-events")).toMatchObject({
			status: 200,
			body: { pending: 0, sessions: 0 },
		});
		expect(await view("raw-events-status")).toMatchObject({
			status: 200,
			body: { items: [], ingest: { available: false, mode: "daemon_rpc" } },
		});
		expect(await view("observer-status")).toMatchObject({
			status: 200,
			body: { queue: { pending: 0, sessions: 0 } },
		});
		const previousHeaders = process.env.CODEMEM_OBSERVER_HEADERS;
		process.env.CODEMEM_OBSERVER_HEADERS = JSON.stringify({ Authorization: "secret-value" });
		try {
			expect(await view("config")).toMatchObject({
				status: 200,
				body: {
					config: expect.any(Object),
					effective: { observer_headers: "[redacted]" },
					env_overrides: { observer_headers: "CODEMEM_OBSERVER_HEADERS" },
					protected_keys: expect.any(Array),
				},
			});
		} finally {
			if (previousHeaders === undefined) delete process.env.CODEMEM_OBSERVER_HEADERS;
			else process.env.CODEMEM_OBSERVER_HEADERS = previousHeaders;
		}
	});

	it("P1-T045-01-job-id-result", async () => {
		const handle = await core.startDaemon({ dataDir: tempDataDir() });
		created.push(handle);
		const remembered = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				method: "POST /v1/memories/record",
				body: {
					idempotencyKey: "job-memory",
					kind: "session_summary",
					title: "Job seed",
					body: "## Completed\nMigrated hooks\n\n## Learned\nDaemon owns writes",
				},
			}),
		);
		if (!("result" in remembered)) throw new Error("memory seed failed");

		const submitted = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				id: "submit-job",
				method: "POST /v1/jobs",
				body: { kind: "narrative.backfill", args: { limit: 10 } },
			}),
		);
		if (!("result" in submitted)) throw new Error("job submission failed");
		expect(submitted.result).toMatchObject({
			jobId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			state: "queued",
		});

		const jobId = String(submitted.result.jobId);
		const job = await waitForDaemonJob(handle.socketPath, jobId);
		expect(job).toMatchObject({
			jobId,
			kind: "narrative.backfill",
			state: "completed",
			attempts: 1,
			maxAttempts: 1,
			result: { checked: 1, updated: 1, skipped: 0 },
		});

		const memory = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				id: "job-memory-get",
				method: "GET /v1/memories/:id",
				body: { id: remembered.result.memoryId, requestId: "job-memory-get" },
			}),
		);
		if (!("result" in memory)) throw new Error("memory read failed");
		const sessionId = Number((memory.result.item as { session_id: number }).session_id);
		const layout = core.resolveStorageLayout(handle.dataDir);
		const pointer = core.readCurrentDatabasePointer(layout);
		if (!pointer) throw new Error("canonical database pointer is missing");
		const dbPath = join(layout.dbDir, pointer);
		process.env.CODEMEM_EMBEDDING_DISABLED = "1";
		try {
			for (const [kind, args, dryRun] of [
				["db.vacuum", {}],
				["raw-events.prune", { maxAgeDays: 36_500, vacuum: false }, true],
				["raw-events.retry", { limit: 5 }],
				["projects.rename", { oldName: "missing", newName: "renamed" }, true],
				["projects.normalize", {}, true],
				["observations.prune", { limit: 5 }, true],
				["memories.prune", { limit: 5, kinds: ["observation"] }, true],
				["memories.dedup", { limit: 5, windowMs: 3_600_000 }, true],
				["secrets.scan", { limit: 5 }, true],
				["tags.backfill", { limit: 10 }],
				["dedup-keys.backfill", { limit: 10 }],
				["structured.backfill", { limit: 10, kinds: ["discovery"], overwrite: false }],
				["refs.backfill", { batchSize: 10 }],
				["scopes.backfill", { batchSize: 10 }],
				["session-context.backfill", { batchSize: 10 }],
				["summary-dedup.backfill", { batchSize: 10 }],
				["vectors.migrate", { batchSize: 10 }],
				["report.memory-role", { allProjects: true, includeInactive: false, probes: [] }],
				["report.role-compare", { baselineDbPath: dbPath, candidateDbPath: dbPath }],
				["report.artifact", { allProjects: true, includeInactive: false }],
				["report.relink", { allProjects: true, limit: 5 }],
				["plan.relink", { allProjects: true, limit: 5 }],
				[
					"report.extraction",
					{ sessionId, scenarioId: "simple-batch-shape", includeInactive: false },
				],
				["report.raw-events", { limit: 5 }],
				[
					"gate.raw-events",
					{
						minFlushSuccessRate: 0.95,
						maxDroppedEventRate: 0.05,
						minSessionBoundaryAccuracy: 0.9,
						windowHours: 24,
					},
				],
				["report.db-size", { limit: 5 }],
				["db.init", {}],
			] as const) {
				const next = await core.callDaemonRpc(
					handle.socketPath,
					handshake({
						id: `submit-${kind}`,
						method: "POST /v1/jobs",
						body: { kind, args, dryRun: dryRun ?? kind.startsWith("report.") },
					}),
				);
				expect("result" in next, `${kind} submission`).toBe(true);
				if (!("result" in next)) continue;
				const completed = await waitForDaemonJob(handle.socketPath, String(next.result.jobId));
				expect(completed, kind).toMatchObject({
					kind,
					state: "completed",
					attempts: 1,
					maxAttempts: 1,
					result: expect.anything(),
				});
			}
		} finally {
			delete process.env.CODEMEM_EMBEDDING_DISABLED;
		}
	});

	it("P1-T045-03-worker-absorbed", async () => {
		const dataDir = tempDataDir();
		const first = await core.startDaemon({ dataDir });
		created.push(first);
		const remembered = await core.callDaemonRpc(
			first.socketPath,
			handshake({
				method: "POST /v1/memories/record",
				body: {
					idempotencyKey: "legacy-dedup-key",
					kind: "discovery",
					title: "Legacy memory",
					body: "Backfill this row inside the daemon",
				},
			}),
		);
		if (!("result" in remembered)) throw new Error("memory seed failed");
		const memoryId = Number(remembered.result.memoryId);
		await first.stop();

		const layout = core.resolveStorageLayout(dataDir);
		const pointer = core.readCurrentDatabasePointer(layout);
		if (!pointer) throw new Error("canonical database pointer is missing");
		const dbPath = join(layout.dbDir, pointer);
		const seed = connect(dbPath);
		try {
			seed.prepare("UPDATE memory_items SET dedup_key = NULL WHERE id = ?").run(memoryId);
			seed.prepare("DELETE FROM maintenance_jobs WHERE kind = ?").run(core.DEDUP_KEY_BACKFILL_JOB);
		} finally {
			seed.close();
		}

		const second = await core.startDaemon({ dataDir });
		created.push(second);
		let jobs: Array<Record<string, unknown>> = [];
		for (let attempt = 0; attempt < 100; attempt++) {
			const response = await core.callDaemonRpc(
				second.socketPath,
				handshake({
					id: `auto-job-${attempt}`,
					method: "GET /v1/jobs",
					body: { kind: "dedup-keys.backfill" },
				}),
			);
			if ("result" in response) {
				jobs = response.result.jobs as Array<Record<string, unknown>>;
				if (jobs.some((job) => job.state === "completed")) break;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(jobs).toMatchObject([
			{
				kind: "dedup-keys.backfill",
				state: "completed",
				attempts: 1,
				maxAttempts: 1,
			},
		]);

		await second.stop();
		const verify = connect(dbPath);
		try {
			const row = verify
				.prepare("SELECT dedup_key FROM memory_items WHERE id = ?")
				.get(memoryId) as { dedup_key: string | null };
			expect(row.dedup_key).toBeTypeOf("string");
		} finally {
			verify.close();
		}
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

	it("applies search filters to get_many reads", async () => {
		const handle = await core.startDaemon({ dataDir: tempDataDir() });
		created.push(handle);
		const remember = async (id: string, project: string) => {
			const response = await core.callDaemonRpc(
				handle.socketPath,
				handshake({
					id,
					method: "POST /v1/memories/record",
					body: {
						idempotencyKey: id,
						kind: "decision",
						title: `${project} title`,
						body: `${project} body`,
						project,
					},
				}),
			);
			if ("error" in response) throw new Error(response.error.code);
			return Number(response.result.memoryId);
		};
		const demoId = await remember("remember-demo", "demo");
		const otherId = await remember("remember-other", "other");
		const response = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				id: "get-many",
				method: "POST /v1/search",
				body: {
					requestId: "get-many",
					mode: "get_many",
					ids: [demoId, otherId],
					filters: { project: "demo" },
				},
			}),
		);
		expect(response).toMatchObject({ result: { items: [{ id: demoId }] } });
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
		const store = openTestMemoryStore(resolve(layout.dbDir, pointer as string));
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

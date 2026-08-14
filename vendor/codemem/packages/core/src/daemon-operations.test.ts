import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonJobService } from "./daemon-jobs.js";
import { DaemonOperationService } from "./daemon-operations.js";
import { connect } from "./db.js";
import * as core from "./index.js";
import { MemoryStore } from "./store.js";

const handles: Array<{ stop: () => Promise<void> }> = [];
const roots: string[] = [];

function tempDataDir(): string {
	const root = mkdtempSync(join(tmpdir(), "codemem-operations-"));
	roots.push(root);
	return join(root, "data");
}

function handshake(method: core.RpcMethod, body: Record<string, unknown>): core.RpcRequest {
	return {
		id: crypto.randomUUID(),
		method,
		adapter_version: "test",
		native_cli_version: "test",
		normalized_schema_version: core.NORMALIZED_SCHEMA_VERSION,
		local_api_version: core.LOCAL_API_VERSION,
		capability_hash: core.RPC_CAPABILITY_HASH,
		body,
	};
}

async function request(
	handle: { socketPath: string },
	method: core.RpcMethod,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const response = await core.callDaemonRpc(handle.socketPath, handshake(method, body));
	if ("error" in response) throw new Error(`${response.error.code}: ${response.error.message}`);
	return response.result;
}

async function waitForTerminal(
	handle: { socketPath: string },
	operationId: string,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const operation = await request(handle, "GET /v1/operations/:id", { id: operationId });
		if (operation.state === "committed" || operation.state === "failed") return operation;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`operation did not finish: ${operationId}`);
}

afterEach(async () => {
	for (const handle of handles.splice(0)) await handle.stop();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("daemon class B operations", { timeout: 20_000 }, () => {
	it("P1-T047-01-operation-id-conflict", async () => {
		const pendingDataDir = tempDataDir();
		const pendingDb = connect(join(dirname(pendingDataDir), "pending.sqlite"));
		core.initTestSchema(pendingDb);
		const pendingStore = new MemoryStore(pendingDb, { closeConnection: true });
		let scheduled = 0;
		const pendingJobs = {
			isMaintenanceMode: () => false,
			hasPendingWork: () => false,
			schedule: () => {
				scheduled++;
				return new Promise<void>(() => {});
			},
		} as unknown as DaemonJobService;
		try {
			const pendingOperations = new DaemonOperationService(
				pendingStore,
				pendingJobs,
				pendingDataDir,
			);
			const pendingBody = {
				outputPath: join(dirname(pendingDataDir), "pending-export.json"),
				filters: { allProjects: true },
			};
			pendingOperations.submit("export", {
				operationId: "pending-export",
				payloadHash: core.hashMutationPayload(pendingBody),
				...pendingBody,
			});
			expect(scheduled).toBe(1);
			expect(pendingOperations.hasPending()).toBe(true);
			const restoreConflict = await core.dispatchDaemonRpc(
				JSON.stringify(
					handshake("POST /v1/backup/restore", {
						operationId: "pending-restore",
						payloadHash: core.restorePayloadHash("missing-backup"),
						backupId: "missing-backup",
					}),
				),
				{
					identity: { pid: process.pid, nonce: "pending" },
					dataDir: pendingDataDir,
					onStop: () => {},
					writer: pendingDb,
					store: pendingStore,
					viewerAuth: {} as never,
					viewerRead: async () => ({}),
					jobs: pendingJobs,
					operations: pendingOperations,
				} as Parameters<typeof core.dispatchDaemonRpc>[1],
			);
			expect(restoreConflict).toMatchObject({ error: { code: "conflict" } });
		} finally {
			pendingStore.close();
		}

		const scheduledDataDir = tempDataDir();
		const scheduledDb = connect(join(dirname(scheduledDataDir), "scheduled.sqlite"));
		core.initTestSchema(scheduledDb);
		const scheduledStore = new MemoryStore(scheduledDb, { closeConnection: true });
		const scheduledJobs = new DaemonJobService(scheduledStore);
		try {
			const scheduledOperations = new DaemonOperationService(
				scheduledStore,
				scheduledJobs,
				scheduledDataDir,
			);
			const outputPath = join(dirname(scheduledDataDir), "scheduled-export.json");
			const requestBody = { outputPath, filters: { allProjects: true } };
			expect(
				scheduledOperations.submit("export", {
					operationId: "scheduled-export",
					payloadHash: core.hashMutationPayload(requestBody),
					...requestBody,
				}),
			).toEqual({ operationId: "scheduled-export", state: "prepared" });
			expect(scheduledOperations.hasPending()).toBe(true);
			await Promise.resolve();
			expect(existsSync(outputPath)).toBe(false);
			await scheduledJobs.stop();
			expect(existsSync(outputPath)).toBe(true);
		} finally {
			await scheduledJobs.stop();
			scheduledStore.close();
		}

		const dataDir = tempDataDir();
		const handle = await core.startDaemon({ dataDir });
		handles.push(handle);
		const operationId = crypto.randomUUID();
		const firstBody = {
			outputPath: join(dirname(dataDir), "first.json"),
			filters: { allProjects: true },
		};
		const secondBody = {
			outputPath: join(dirname(dataDir), "second.json"),
			filters: { allProjects: true },
		};
		await request(handle, "POST /v1/operations/export", {
			operationId,
			payloadHash: core.hashMutationPayload(firstBody),
			...firstBody,
		});
		const conflict = await core.callDaemonRpc(
			handle.socketPath,
			handshake("POST /v1/operations/export", {
				operationId,
				payloadHash: core.hashMutationPayload(secondBody),
				...secondBody,
			}),
		);
		expect(conflict).toMatchObject({ error: { code: "idempotency_conflict" } });
		expect(await waitForTerminal(handle, operationId)).toMatchObject({ state: "committed" });
		expect(existsSync(secondBody.outputPath)).toBe(false);

		const escapeLink = join(dirname(dataDir), "data-link");
		symlinkSync(dataDir, escapeLink);
		const unsafeBody = {
			outputPath: join(escapeLink, "db", "must-not-write.json"),
			filters: { allProjects: true },
		};
		expect(
			await core.callDaemonRpc(
				handle.socketPath,
				handshake("POST /v1/operations/export", {
					operationId: crypto.randomUUID(),
					payloadHash: core.hashMutationPayload(unsafeBody),
					...unsafeBody,
				}),
			),
		).toMatchObject({ error: { code: "invalid_request" } });
	});

	it("P1-T047-02-operation-result-retrieval", async () => {
		const dataDir = tempDataDir();
		const outputPath = join(dirname(dataDir), "export.json");
		const operationId = crypto.randomUUID();
		const operationBody = { outputPath, filters: { allProjects: true } };
		const first = await core.startDaemon({ dataDir });
		handles.push(first);
		await request(first, "POST /v1/operations/export", {
			operationId,
			payloadHash: core.hashMutationPayload(operationBody),
			...operationBody,
		});
		const completed = await waitForTerminal(first, operationId);
		expect(completed).toMatchObject({
			operationId,
			payloadHash: core.hashMutationPayload(operationBody),
			state: "committed",
			result: { outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
		});
		expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({ version: "1.0" });
		expect(
			await request(first, "POST /v1/operations/export", {
				operationId,
				payloadHash: core.hashMutationPayload(operationBody),
				...operationBody,
			}),
		).toEqual({ operationId, state: "committed" });

		await first.stop();
		const restarted = await core.startDaemon({ dataDir });
		handles.push(restarted);
		expect(await request(restarted, "GET /v1/operations/:id", { id: operationId })).toEqual(
			completed,
		);
	});

	it("P1-T047-03-import-backup-precondition", async () => {
		const dataDir = tempDataDir();
		const inputPath = join(dirname(dataDir), "import.json");
		writeFileSync(
			inputPath,
			JSON.stringify({
				version: "1.0",
				exported_at: "2026-08-14T00:00:00.000Z",
				export_metadata: {
					tool_version: "codemem",
					projects: ["imported"],
					total_memories: 1,
					total_sessions: 1,
					include_inactive: false,
					filters: {},
				},
				sessions: [
					{
						id: 1,
						started_at: "2026-08-14T00:00:00.000Z",
						cwd: "/tmp/imported",
						project: "imported",
						user: "test",
						tool_version: "test",
						metadata_json: {},
						import_key: "session-1",
					},
				],
				memory_items: [
					{
						id: 1,
						session_id: 1,
						kind: "discovery",
						title: "must not import",
						body_text: "backup failed",
						created_at: "2026-08-14T00:00:01.000Z",
						updated_at: "2026-08-14T00:00:01.000Z",
						metadata_json: {},
						import_key: "memory-1",
						scope_id: "local-default",
					},
				],
				session_summaries: [],
				user_prompts: [],
			}),
			{ mode: 0o600 },
		);
		const handle = await core.startDaemon({ dataDir });
		handles.push(handle);
		rmSync(handle.layout.backupsDir, { recursive: true });
		writeFileSync(handle.layout.backupsDir, "backup directory blocked", { mode: 0o600 });

		const operationId = crypto.randomUUID();
		const operationBody = { inputPath };
		await request(handle, "POST /v1/operations/import", {
			operationId,
			payloadHash: core.hashMutationPayload(operationBody),
			...operationBody,
		});
		expect(await waitForTerminal(handle, operationId)).toMatchObject({
			state: "failed",
			error: { code: "backup_failed" },
		});
		const stats = await request(handle, "GET /v1/view", { collection: "stats" });
		expect(stats).toMatchObject({ body: { database: { memory_items: 0 } } });

		rmSync(handle.layout.backupsDir);
		const retryId = crypto.randomUUID();
		await request(handle, "POST /v1/operations/import", {
			operationId: retryId,
			payloadHash: core.hashMutationPayload(operationBody),
			...operationBody,
		});
		const completed = await waitForTerminal(handle, retryId);
		expect(completed).toMatchObject({
			state: "committed",
			result: { memory_items: 1, backupId: expect.any(String) },
		});
		const backupId = String((completed.result as Record<string, unknown>).backupId);
		expect(
			JSON.parse(readFileSync(join(handle.layout.backupsDir, `${backupId}.json`), "utf8")),
		).toMatchObject({ manifest: { retention_class: "manual" } });
		expect(await request(handle, "GET /v1/view", { collection: "stats" })).toMatchObject({
			body: { database: { memory_items: 1 } },
		});
	});
});

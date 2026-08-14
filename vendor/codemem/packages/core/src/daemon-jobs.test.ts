import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonJobService } from "./daemon-jobs.js";
import { type DaemonRpcContext, dispatchDaemonRpc } from "./daemon-rpc.js";
import { LOCAL_API_VERSION, RPC_CAPABILITY_HASH } from "./daemon-rpc-contract.js";
import { connect } from "./db.js";
import { NORMALIZED_SCHEMA_VERSION } from "./normalized-event.js";
import { resolveStorageLayout } from "./storage.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";
import type { WriterActor } from "./writer-actor.js";

describe("daemon jobs", () => {
	let db: WriterActor | null = null;
	let store: MemoryStore | null = null;
	let dir: string | null = null;

	afterEach(() => {
		store?.close();
		store = null;
		if (db?.open) db.close();
		db = null;
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = null;
	});

	it("P1-T045-02-job-no-auto-retry", () => {
		dir = mkdtempSync(join(tmpdir(), "codemem-daemon-jobs-"));
		db = connect(join(dir, "jobs.sqlite"));
		initTestSchema(db);
		const submittedAt = "2026-08-14T00:00:00.000Z";
		db.prepare(
			`INSERT INTO daemon_jobs(
				job_id, kind, args_json, dry_run, state, attempts, max_attempts,
				result_json, error_code, submitted_at, started_at, finished_at
			) VALUES (?, 'narrative.backfill', '{}', 0, 'queued', 0, 1, NULL, NULL, ?, NULL, NULL)`,
		).run("00000000-0000-4000-8000-000000000001", submittedAt);
		db.prepare(
			`INSERT INTO daemon_jobs(
				job_id, kind, args_json, dry_run, state, attempts, max_attempts,
				result_json, error_code, submitted_at, started_at, finished_at
			) VALUES (?, 'narrative.backfill', '{}', 0, 'running', 1, 1, NULL, NULL, ?, ?, NULL)`,
		).run("00000000-0000-4000-8000-000000000002", submittedAt, "2026-08-14T00:00:01.000Z");

		store = new MemoryStore(join(dir, "jobs.sqlite"), { connection: db });
		const service = new DaemonJobService(store);

		expect(service.get("00000000-0000-4000-8000-000000000001")).toMatchObject({
			state: "failed",
			attempts: 0,
			error: { code: "daemon_restarted" },
		});
		expect(service.get("00000000-0000-4000-8000-000000000002")).toMatchObject({
			state: "failed",
			attempts: 1,
			error: { code: "daemon_restarted" },
		});
	});

	it("P1-T046-01-maintenance-mode", async () => {
		dir = mkdtempSync(join(tmpdir(), "codemem-daemon-maintenance-"));
		db = connect(join(dir, "jobs.sqlite"));
		initTestSchema(db);
		store = new MemoryStore(join(dir, "jobs.sqlite"), { connection: db });
		let enterMaintenance = () => {};
		const entered = new Promise<void>((resolve) => {
			enterMaintenance = resolve;
		});
		let releaseMaintenance = () => {};
		const released = new Promise<void>((resolve) => {
			releaseMaintenance = resolve;
		});
		const service = new DaemonJobService(store, {
			dataDir: dir,
			beforeMaintenance: async () => {
				enterMaintenance();
				await released;
			},
		});
		expect(() => service.submit({ kind: "raw-events.retry", args: {}, dryRun: true })).toThrow(
			"raw-events.retry does not support dryRun",
		);
		const waitForTerminal = async (jobId: string) => {
			for (let attempt = 0; attempt < 100; attempt++) {
				const job = service.get(jobId);
				if (job?.state === "completed" || job?.state === "failed") return job;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			return service.get(jobId);
		};

		const submitted = service.submit({ kind: "projects.normalize", args: {}, dryRun: false });
		await entered;
		expect(service.isMaintenanceMode()).toBe(true);
		const response = await dispatchDaemonRpc(
			JSON.stringify({
				id: "maintenance-write",
				method: "POST /v1/memories/record",
				adapter_version: "test",
				native_cli_version: "test",
				normalized_schema_version: NORMALIZED_SCHEMA_VERSION,
				local_api_version: LOCAL_API_VERSION,
				capability_hash: RPC_CAPABILITY_HASH,
				body: {
					idempotencyKey: "maintenance-write",
					kind: "decision",
					title: "must spool",
					body: "do not write during maintenance",
				},
			}),
			{
				identity: { pid: process.pid, startTime: "test", fingerprint: "test", nonce: "test" },
				dataDir: dir,
				onStop: () => {},
				writer: db,
				store,
				viewerAuth: {} as never,
				viewerRead: async () => ({}),
				jobs: service,
			} as DaemonRpcContext,
		);
		expect(response).toMatchObject({
			error: { code: "maintenance_mode", retryable: true },
		});

		releaseMaintenance();
		const completed = await waitForTerminal(submitted.jobId);
		expect(completed).toMatchObject({ state: "completed", attempts: 1 });
		expect(service.isMaintenanceMode()).toBe(false);
		const backupDir = resolveStorageLayout(dir).backupsDir;
		expect(readdirSync(backupDir).sort()).toEqual([
			`maintenance-${submitted.jobId}.json`,
			`maintenance-${submitted.jobId}.sqlite`,
		]);

		db.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)").run(
			"2026-08-14T00:00:00.000Z",
			"team/demo",
		);
		rmSync(backupDir, { recursive: true, force: true });
		writeFileSync(backupDir, "backup directory blocked", { mode: 0o600 });
		const blocked = service.submit({ kind: "projects.normalize", args: {}, dryRun: false });
		expect(await waitForTerminal(blocked.jobId)).toMatchObject({ state: "failed", attempts: 1 });
		expect(
			(
				db.prepare("SELECT project FROM sessions ORDER BY id DESC LIMIT 1").get() as {
					project: string;
				}
			).project,
		).toBe("team/demo");
		await service.stop();
	});
});

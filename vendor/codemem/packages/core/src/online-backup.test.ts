import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import * as core from "./index.js";
import { ReadOnlyActor, WriterActor } from "./writer-actor.js";

const created: Array<{ stop: () => Promise<void> }> = [];
const dirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function reasonHash(reason: string): string {
	return createHash("sha256").update(reason, "utf8").digest("hex");
}

function handshake(overrides: Partial<core.RpcRequest> = {}): core.RpcRequest {
	return {
		id: "req-1",
		method: "POST /v1/backup/create",
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

describe("Phase 1 online backup", () => {
	it("P1-T050-01-db-backup-api", async () => {
		const dir = tempDir("codemem-backup-api-");
		const dbPath = join(dir, "source.sqlite");
		const dest = join(dir, "snapshot.sqlite");
		const db = WriterActor.open(dbPath);
		try {
			expect(typeof db.backup).toBe("function");
			db.pragma("journal_mode = WAL");
			db.exec("CREATE TABLE probe (value TEXT NOT NULL)");
			db.prepare("INSERT INTO probe(value) VALUES (?)").run("before");
			const meta = await db.backup(dest);
			expect(meta.remainingPages).toBe(0);
			expect(meta.totalPages).toBeGreaterThan(0);
			db.prepare("INSERT INTO probe(value) VALUES (?)").run("after");
		} finally {
			db.close();
		}

		expect(existsSync(`${dest}-wal`)).toBe(false);
		const copy = ReadOnlyActor.open(dest);
		try {
			expect(copy.prepare("SELECT value FROM probe ORDER BY value").all()).toEqual([
				{ value: "before" },
			]);
		} finally {
			copy.close();
		}
	});

	it("P1-T050-03-online-backup-consistency", async () => {
		const dir = tempDir("codemem-backup-create-");
		const dbPath = join(dir, "source.sqlite");
		const destDir = join(dir, "backups");
		const db = WriterActor.open(dbPath);
		try {
			db.pragma("journal_mode = WAL");
			db.exec("CREATE TABLE probe (value TEXT NOT NULL)");
			db.prepare("INSERT INTO probe(value) VALUES (?)").run("keep-me");
			const proof = await core.createOnlineBackup({
				db,
				destinationDir: destDir,
				operationId: "pre-mig-1",
				reason: "migration",
			});
			expect(proof.verified).toBe(true);
			expect(proof.evidence.trim().length).toBeGreaterThan(0);
			expect(proof.backupId).toBe("pre-mig-1");
			expect(proof.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
			expect(statSync(destDir).mode & 0o777).toBe(0o700);
			expect(statSync(proof.artifactPath).mode & 0o777).toBe(0o600);
			expect(existsSync(`${proof.artifactPath}-wal`)).toBe(false);
			expect(existsSync(`${proof.artifactPath}-shm`)).toBe(false);

			const check = core.verifyOnlineBackup({
				artifactPath: proof.artifactPath,
				expectedSha256: proof.artifactSha256,
			});
			expect(check).toMatchObject({ valid: true, manifestHash: proof.artifactSha256 });
			const linked = join(destDir, "alias.sqlite");
			symlinkSync(proof.artifactPath, linked);
			expect(
				core.verifyOnlineBackup({
					artifactPath: linked,
					expectedSha256: proof.artifactSha256,
				}).valid,
			).toBe(false);
			writeFileSync(`${proof.artifactPath}-wal`, "torn");
			expect(
				core.verifyOnlineBackup({
					artifactPath: proof.artifactPath,
					expectedSha256: proof.artifactSha256,
				}).valid,
			).toBe(false);
			core.requireVerifiedBackup(proof);
		} finally {
			db.close();
		}
	});

	it("P1-T050-02-backup-failure-blocks", async () => {
		expect(() => core.requireVerifiedBackup({ verified: false, evidence: "nope" })).toThrow(
			/verified backup/i,
		);
		expect(() => core.requireVerifiedBackup({ verified: true, evidence: "   " })).toThrow(
			/verified backup/i,
		);

		const dir = tempDir("codemem-backup-hi25-");
		const destDir = join(dir, "backups");
		const blocked = join(dir, "blocked");
		writeFileSync(blocked, "not-a-directory");
		const dbPath = join(dir, "upgrade.sqlite");
		const db = WriterActor.open(dbPath);
		try {
			db.exec("CREATE TABLE memory_items (id INTEGER PRIMARY KEY)");
			db.exec("CREATE TABLE sessions (id INTEGER PRIMARY KEY)");
			db.pragma("user_version = 6");
			await expect(
				core.runGatedMigration(db, {
					dbPath,
					destinationDir: blocked,
					operationId: "gate-blocked",
					reason: "migration",
				}),
			).rejects.toThrow();
			expect(core.getSchemaVersion(db)).toBe(6);
			expect(core.tableExists(db, "memory_fts")).toBe(false);

			await expect(
				core.runGatedMigration(db, {
					dbPath,
					destinationDir: destDir,
					operationId: "gate-1",
					reason: "migration",
				}),
			).rejects.toThrow();
			expect(existsSync(join(destDir, "gate-1.sqlite"))).toBe(true);
		} finally {
			db.close();
		}
	});

	it("P1-T050-04-rpc-create-verify", async () => {
		const root = tempDir("codemem-backup-rpc-");
		const dataDir = join(root, "data");
		const handle = await core.startDaemon({ dataDir });
		created.push(handle);

		const reason = "migration";
		const createdBackup = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				body: {
					operationId: "rpc-bak-1",
					payloadHash: reasonHash(reason),
					reason,
				},
			}),
		);
		expect(createdBackup).toMatchObject({
			id: "req-1",
			result: {
				operationId: "rpc-bak-1",
				state: "completed",
			},
		});
		const backupId = (createdBackup as core.RpcSuccess).result.backupId as string;
		expect(backupId).toBe("rpc-bak-1");

		const verified = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				method: "POST /v1/backup/verify",
				body: { backupId },
			}),
		);
		expect(verified).toMatchObject({
			result: { backupId, valid: true },
		});
		expect(typeof (verified as core.RpcSuccess).result.manifestHash).toBe("string");
	});

	it("P1-T050-05-payload-hash-and-replay", async () => {
		const root = tempDir("codemem-backup-hash-");
		const dataDir = join(root, "data");
		const handle = await core.startDaemon({ dataDir });
		created.push(handle);

		const reason = "repair";
		const mismatch = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				body: {
					operationId: "rpc-bak-2",
					payloadHash: reasonHash("other"),
					reason,
				},
			}),
		);
		expect(mismatch).toMatchObject({ error: { code: "invalid_request" } });

		const first = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				body: {
					operationId: "rpc-bak-2",
					payloadHash: reasonHash(reason),
					reason,
				},
			}),
		);
		expect(first).toMatchObject({ result: { state: "completed", operationId: "rpc-bak-2" } });

		const replay = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				body: {
					operationId: "rpc-bak-2",
					payloadHash: reasonHash(reason),
					reason,
				},
			}),
		);
		expect(replay).toMatchObject({ result: { state: "completed", operationId: "rpc-bak-2" } });

		const conflict = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				body: {
					operationId: "rpc-bak-2",
					payloadHash: reasonHash("import-merge"),
					reason: "import-merge",
				},
			}),
		);
		expect(conflict).toMatchObject({ error: { code: "conflict" } });

		const secretReason = `ghp_${"A".repeat(36)}`;
		const rejectedSecret = await core.callDaemonRpc(
			handle.socketPath,
			handshake({
				id: "req-secret",
				body: {
					operationId: "rpc-secret-reason",
					payloadHash: reasonHash(secretReason),
					reason: secretReason,
				},
			}),
		);
		expect(rejectedSecret).toMatchObject({ error: { code: "invalid_request" } });
		expect(existsSync(join(handle.layout.backupsDir, "rpc-secret-reason.json"))).toBe(false);
	});

	it("P1-T050-06-fresh-bootstrap-skips-online-backup", async () => {
		const dir = tempDir("codemem-backup-fresh-");
		const destDir = join(dir, "backups");
		const dbPath = join(dir, "fresh.sqlite");
		const db = connect(dbPath);
		try {
			await core.runGatedMigration(db, {
				dbPath,
				destinationDir: destDir,
				operationId: "fresh-1",
				reason: "migration",
			});
			expect(core.getSchemaVersion(db)).toBe(core.SCHEMA_VERSION);
			expect(existsSync(join(destDir, "fresh-1.sqlite"))).toBe(false);
		} finally {
			db.close();
		}
	});

	it("P1-T050-01-backup-before-migration", async () => {
		const dir = tempDir("codemem-backup-v18-");
		const dbPath = join(dir, "v18.sqlite");
		const destDir = join(dir, "backups");
		const db = connect(dbPath);
		try {
			core.runDatabaseMigrations(db, {
				dbPath,
				backupAndVerify: core.verifyFreshDatabase,
			});
			db.exec(`
				DROP TABLE mutation_quarantine;
				DROP TABLE mutation_receipts;
				UPDATE schema_compat_state SET applied_schema_version = 18 WHERE id = 1;
			`);
			db.pragma("user_version = 18");

			expect(core.SCHEMA_VERSION).toBe(20);
			await core.runGatedMigration(db, {
				dbPath,
				destinationDir: destDir,
				operationId: "schema-v19",
				reason: "migration",
			});

			expect(existsSync(join(destDir, "schema-v19.sqlite"))).toBe(true);
			expect(core.tableExists(db, "mutation_receipts")).toBe(true);
			expect(core.tableExists(db, "mutation_quarantine")).toBe(true);
			expect(core.getSchemaVersion(db)).toBe(20);
		} finally {
			db.close();
		}
	});

	it("P1-T052-01-backup-manifest-hash", async () => {
		const root = tempDir("codemem-backup-manifest-");
		const dataDir = join(root, "data");
		const db = WriterActor.open(join(root, "source.sqlite"));
		try {
			db.pragma("journal_mode = WAL");
			db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
			const insert = db.prepare("INSERT INTO probe(value) VALUES (?)");
			const seed = db.transaction(() => {
				for (let index = 0; index < 2_000; index++) insert.run(`seed-${index}-${"x".repeat(512)}`);
			});
			seed();

			let wroteDuringBackup = false;
			const proof = await core.createOnlineBackup({
				db: {
					name: db.name,
					backup: (destinationFile) =>
						db.backup(destinationFile, {
							progress: () => {
								if (!wroteDuringBackup) {
									insert.run("written-while-backup-ran");
									wroteDuringBackup = true;
								}
								return 1;
							},
						}),
				},
				destinationDir: core.resolveStorageLayout(dataDir).backupsDir,
				operationId: "manifest-live-writer",
				reason: "manifest consistency",
			});
			expect(wroteDuringBackup).toBe(true);

			const sidecar = JSON.parse(
				readFileSync(
					join(core.resolveStorageLayout(dataDir).backupsDir, "manifest-live-writer.json"),
					"utf8",
				),
			) as core.BackupSidecarV2;
			expect(sidecar).toMatchObject({
				version: 2,
				authenticity: "hash-only",
				signature: null,
				manifest: {
					manifest_version: 1,
					schema_version: 0,
					sqlite_source_version: expect.any(String),
					fts_schema: {
						normalization_version: core.NORMALIZED_SCHEMA_VERSION,
						sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
					},
					sqlite_vec: null,
					active_embedding_generation_id: null,
					created_watermark: {
						raw_event_id: null,
						raw_event_created_at: null,
					},
					privacy: {
						may_contain_private_or_local_only: true,
						off_device_export: "not_available_in_phase_1",
					},
				},
			});
			expect(sidecar.manifest_hash).toBe(core.hashMutationPayload(sidecar.manifest));
			expect(sidecar.manifest.artifact_sha256).toBe(proof.artifactSha256);
			const snapshot = ReadOnlyActor.open(proof.artifactPath);
			try {
				const row = snapshot.prepare("SELECT COUNT(*) AS count FROM probe").get() as {
					count: number;
				};
				expect(sidecar.manifest.canonical_tables).toContainEqual(
					expect.objectContaining({ name: "probe", row_count: row.count }),
				);
			} finally {
				snapshot.close();
			}
			expect(core.verifyCanonicalBackup({ dataDir, backupId: proof.backupId })).toMatchObject({
				valid: true,
				manifestHash: sidecar.manifest_hash,
			});
			const probeManifest = sidecar.manifest.canonical_tables.find(
				(table) => table.name === "probe",
			);
			expect(probeManifest).toBeTruthy();
			if (!probeManifest) throw new Error("probe manifest is missing");
			probeManifest.row_count++;
			sidecar.manifest_hash = core.hashMutationPayload(sidecar.manifest);
			writeFileSync(
				join(core.resolveStorageLayout(dataDir).backupsDir, "manifest-live-writer.json"),
				`${JSON.stringify(sidecar)}\n`,
			);
			expect(core.verifyCanonicalBackup({ dataDir, backupId: proof.backupId })).toMatchObject({
				valid: false,
				diagnostics: expect.arrayContaining(["backup manifest canonical row mismatch"]),
			});
		} finally {
			db.close();
		}
	});

	it("P1-T052-02-backup-retention-permissions", async () => {
		const root = tempDir("codemem-backup-retention-");
		const dataDir = join(root, "data");
		const backupDir = core.resolveStorageLayout(dataDir).backupsDir;
		const daemon = await core.startDaemon({ dataDir });
		created.push(daemon);
		expect(statSync(realpathSync(daemon.layout.currentPointerPath)).mode & 0o777).toBe(0o600);
		const db = WriterActor.open(join(root, "source.sqlite"));
		try {
			db.exec("CREATE TABLE probe (value TEXT NOT NULL); INSERT INTO probe VALUES ('keep')");
			for (let index = 0; index < 11; index++) {
				const date = new Date(Date.UTC(2026, 0, 1 + index * 7));
				await core.createOnlineBackup({
					db,
					destinationDir: backupDir,
					operationId: `automatic-${String(index).padStart(2, "0")}`,
					reason: "scheduled",
					retentionClass: "automatic",
					now: () => date,
				});
			}
			const daily = await core.createDailyBackup({
				db,
				destinationDir: backupDir,
				now: () => new Date(Date.UTC(2026, 0, 1 + 11 * 7)),
			});
			expect(daily.backupId).toBe("daily-2026-03-19");
			await core.createOnlineBackup({
				db,
				destinationDir: backupDir,
				operationId: "manual-keep",
				reason: "manual",
				retentionClass: "manual",
			});

			const retention = core.pruneBackupRetention(backupDir);
			expect(retention.removed).toEqual([]);
			expect(retention.kept).toHaveLength(11);
			expect(existsSync(join(backupDir, "automatic-00.sqlite"))).toBe(false);
			expect(existsSync(join(backupDir, "manual-keep.sqlite"))).toBe(true);
			expect(statSync(backupDir).mode & 0o777).toBe(0o700);
			for (const file of readdirSync(backupDir)) {
				expect(statSync(join(backupDir, file)).mode & 0o777).toBe(0o600);
			}
		} finally {
			db.close();
		}
	});

	it("P1-T052-03-restore-journal-order", async () => {
		const root = tempDir("codemem-backup-restore-");
		const dataDir = join(root, "data");
		const handle = await core.startDaemon({ dataDir });
		created.push(handle);
		const request = (id: string, method: string, body: Record<string, unknown>) =>
			core.callDaemonRpc(handle.socketPath, handshake({ id, method, body }));

		expect(
			await request("before", "POST /v1/memories/record", {
				idempotencyKey: "restore-before",
				kind: "decision",
				title: "Before restore point",
				body: "This row belongs in the backup.",
			}),
		).toMatchObject({ result: { receiptId: expect.any(String) } });
		const reason = "restore smoke";
		const backedUp = await request("backup", "POST /v1/backup/create", {
			operationId: "restore-source",
			payloadHash: reasonHash(reason),
			reason,
		});
		expect(backedUp).toMatchObject({ result: { backupId: "restore-source" } });
		const canonicalSidecar = JSON.parse(
			readFileSync(join(handle.layout.backupsDir, "restore-source.json"), "utf8"),
		) as core.BackupSidecarV2;
		expect(canonicalSidecar.manifest.sqlite_vec).toMatchObject({
			version: expect.any(String),
			artifact_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			platform: `${process.platform}-${process.arch}`,
		});
		expect(
			await request("after", "POST /v1/memories/record", {
				idempotencyKey: "restore-after",
				kind: "decision",
				title: "After restore point",
				body: "This row must disappear after restore.",
			}),
		).toMatchObject({ result: { receiptId: expect.any(String) } });

		const oldPointer = core.readCurrentDatabasePointer(handle.layout);
		const restored = await request("restore", "POST /v1/backup/restore", {
			operationId: "restore-operation",
			payloadHash: core.restorePayloadHash("restore-source"),
			backupId: "restore-source",
		});
		expect(restored).toMatchObject({
			result: {
				operationId: "restore-operation",
				backupId: "restore-source",
				restartRequired: true,
			},
		});
		for (let attempt = 0; attempt < 100; attempt++) {
			if (core.readDaemonHealth(dataDir).status === "not_running") break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(core.readDaemonHealth(dataDir).status).toBe("not_running");
		expect(existsSync(handle.layout.journalPath)).toBe(false);
		const newPointer = core.readCurrentDatabasePointer(handle.layout);
		expect(newPointer).not.toBe(oldPointer);
		expect(oldPointer && existsSync(join(handle.layout.dbDir, oldPointer))).toBe(true);
		if (!("result" in restored)) throw new Error("restore failed");
		const restoredArtifactSha256 = restored.result.artifactSha256;

		const snapshot = ReadOnlyActor.open(join(handle.layout.dbDir, newPointer as string));
		try {
			expect(snapshot.prepare("SELECT title FROM memory_items ORDER BY id").all()).toEqual([
				{ title: "Before restore point" },
			]);
			expect(
				snapshot.prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH 'before'").all(),
			).toHaveLength(1);
		} finally {
			snapshot.close();
		}

		const heldSource = WriterActor.open(join(root, "held-backup-source.sqlite"));
		core.initTestSchema(heldSource);
		let releaseBackup!: () => void;
		let markBackupEntered!: () => void;
		const backupEntered = new Promise<void>((resolve) => {
			markBackupEntered = resolve;
		});
		const backupHold = new Promise<void>((resolve) => {
			releaseBackup = resolve;
		});
		const heldBackup = core.createOnlineBackup({
			db: {
				name: heldSource.name,
				backup: async (destinationFile) => {
					markBackupEntered();
					await backupHold;
					return heldSource.backup(destinationFile);
				},
			},
			destinationDir: join(root, "held-backups"),
			operationId: "held-backup",
			reason: "held backup",
		});
		await backupEntered;
		try {
			expect(() =>
				core.restoreCanonicalBackup({
					dataDir,
					operationId: "restore-operation",
					payloadHash: core.restorePayloadHash("restore-source"),
					backupId: "restore-source",
				}),
			).toThrow(/backup is active/i);
		} finally {
			releaseBackup();
			await heldBackup;
			heldSource.close();
		}

		const restarted = await core.startDaemon({ dataDir });
		created.push(restarted);
		expect(core.readDaemonHealth(dataDir).status).toBe("ok");
		let maintenanceMode = true;
		for (let attempt = 0; attempt < 200 && maintenanceMode; attempt++) {
			const health = await request(`restarted-health-${attempt}`, "GET /v1/health", {});
			maintenanceMode =
				"result" in health &&
				(health.result as { maintenanceMode?: boolean }).maintenanceMode === true;
			if (maintenanceMode) await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(maintenanceMode).toBe(false);
		expect(
			await request("after-restart", "POST /v1/memories/record", {
				idempotencyKey: "restore-after-restart",
				kind: "decision",
				title: "After restored restart",
				body: "An idempotent replay must not erase this row.",
			}),
		).toMatchObject({ result: { receiptId: expect.any(String) } });
		const replayed = await request("restore-replay", "POST /v1/backup/restore", {
			operationId: "restore-operation",
			payloadHash: core.restorePayloadHash("restore-source"),
			backupId: "restore-source",
		});
		expect(replayed).toMatchObject({
			result: {
				pointer: newPointer,
				artifactSha256: restoredArtifactSha256,
				restartRequired: true,
			},
		});
		for (let attempt = 0; attempt < 100; attempt++) {
			if (core.readDaemonHealth(dataDir).status === "not_running") break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(core.readDaemonHealth(dataDir).status).toBe("not_running");
		expect(core.readCurrentDatabasePointer(handle.layout)).toBe(newPointer);

		const replaySnapshot = ReadOnlyActor.open(join(handle.layout.dbDir, newPointer as string));
		try {
			expect(replaySnapshot.prepare("SELECT title FROM memory_items ORDER BY id").all()).toEqual([
				{ title: "Before restore point" },
				{ title: "After restored restart" },
			]);
		} finally {
			replaySnapshot.close();
		}

		const verifiedRestart = await core.startDaemon({ dataDir });
		created.push(verifiedRestart);
		expect(core.readDaemonHealth(dataDir).status).toBe("ok");
	});
});

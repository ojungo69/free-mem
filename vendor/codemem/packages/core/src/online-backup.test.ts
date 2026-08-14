import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

	it("P1-T050-02-create-and-verify", async () => {
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

	it("P1-T050-03-fail-closed-hi25", async () => {
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

	it("P1-T050-07-v18-receipt-migration-is-backed-up", async () => {
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
});

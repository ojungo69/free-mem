import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
	peekMigrationKind,
	runDatabaseMigrations,
	verifyFreshDatabase,
} from "./migration-runner.js";
import { readCurrentDatabasePointer, resolveStorageLayout, sha256File } from "./storage.js";
import { durableReplaceFile, ensurePrivateDirectory, fsyncPath } from "./storage-platform.js";
import { ReadOnlyActor, WriterActor } from "./writer-actor.js";

export type Backupable = {
	backup(destinationFile: string): Promise<{ totalPages: number; remainingPages: number }>;
	name?: string;
};

export type BackupVerification = {
	verified: boolean;
	evidence: string;
};

export type VerifiedBackup = BackupVerification & {
	verified: true;
	backupId: string;
	artifactPath: string;
	artifactSha256: string;
};

export type BackupCheck = {
	valid: boolean;
	manifestHash: string | null;
	diagnostics: string[];
};

export type BackupErrorCode = "invalid_request" | "conflict" | "not_found";

type BackupSidecar = {
	version: 1;
	operationId: string;
	reason: string;
	payloadHash: string;
	artifactSha256: string;
	createdAt: string;
};

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export class BackupRequestError extends Error {
	readonly code: BackupErrorCode;

	constructor(code: BackupErrorCode, message: string) {
		super(message);
		this.name = "BackupRequestError";
		this.code = code;
	}
}

export function backupPayloadHash(reason: string): string {
	return createHash("sha256").update(reason, "utf8").digest("hex");
}

export function requireVerifiedBackup(proof: BackupVerification): void {
	if (!proof.verified || !proof.evidence.trim()) {
		throw new Error("Destructive operation requires a verified backup.");
	}
}

function backupArtifactPath(destinationDir: string, operationId: string): string {
	return join(destinationDir, `${operationId}.sqlite`);
}

function backupSidecarPath(destinationDir: string, operationId: string): string {
	return join(destinationDir, `${operationId}.json`);
}

function validateOperationId(operationId: string): void {
	if (!OPERATION_ID.test(operationId)) {
		throw new BackupRequestError("invalid_request", "Backup operation ID is invalid.");
	}
}

function readSidecar(path: string): BackupSidecar | null {
	if (!existsSync(path)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const sidecar = parsed as Partial<BackupSidecar>;
	if (
		sidecar.version !== 1 ||
		typeof sidecar.operationId !== "string" ||
		typeof sidecar.reason !== "string" ||
		typeof sidecar.payloadHash !== "string" ||
		typeof sidecar.artifactSha256 !== "string" ||
		typeof sidecar.createdAt !== "string" ||
		!SHA256.test(sidecar.artifactSha256)
	) {
		return null;
	}
	return sidecar as BackupSidecar;
}

export function verifyOnlineBackup(input: {
	artifactPath: string;
	expectedSha256?: string;
	sourcePath?: string;
}): BackupCheck {
	if (!existsSync(input.artifactPath)) {
		return { valid: false, manifestHash: null, diagnostics: ["backup artifact is missing"] };
	}
	try {
		const info = lstatSync(input.artifactPath);
		if (info.isSymbolicLink() || !info.isFile()) {
			return {
				valid: false,
				manifestHash: null,
				diagnostics: ["backup artifact must be a regular file"],
			};
		}
		if (existsSync(`${input.artifactPath}-wal`) || existsSync(`${input.artifactPath}-shm`)) {
			return {
				valid: false,
				manifestHash: null,
				diagnostics: ["backup artifact must not have WAL sidecars"],
			};
		}
		if (input.sourcePath) {
			try {
				const source = lstatSync(input.sourcePath);
				if (source.dev === info.dev && source.ino === info.ino) {
					return {
						valid: false,
						manifestHash: null,
						diagnostics: ["backup artifact must not be the live database"],
					};
				}
			} catch {
				// source may be gone; artifact still has to stand alone
			}
		}
	} catch {
		return { valid: false, manifestHash: null, diagnostics: ["backup artifact is missing"] };
	}
	const manifestHash = sha256File(input.artifactPath);
	if (input.expectedSha256 && manifestHash !== input.expectedSha256) {
		return { valid: false, manifestHash, diagnostics: ["backup hash mismatch"] };
	}
	let db: ReadOnlyActor;
	try {
		db = ReadOnlyActor.open(input.artifactPath);
	} catch (error) {
		return {
			valid: false,
			manifestHash,
			diagnostics: [error instanceof Error ? error.message : "backup artifact could not be opened"],
		};
	}
	try {
		const rows = db.pragma("integrity_check") as Array<Record<string, unknown>>;
		if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok") {
			return { valid: false, manifestHash, diagnostics: ["sqlite integrity check failed"] };
		}
	} finally {
		db.close();
	}
	return { valid: true, manifestHash, diagnostics: [] };
}

let backupQueue: Promise<unknown> = Promise.resolve();

function enqueueBackup<T>(work: () => Promise<T>): Promise<T> {
	const run = backupQueue.then(work, work);
	backupQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

export async function createOnlineBackup(input: {
	db: Backupable;
	destinationDir: string;
	operationId: string;
	reason: string;
	payloadHash?: string;
}): Promise<VerifiedBackup> {
	return enqueueBackup(() => createOnlineBackupUnlocked(input));
}

async function createOnlineBackupUnlocked(input: {
	db: Backupable;
	destinationDir: string;
	operationId: string;
	reason: string;
	payloadHash?: string;
}): Promise<VerifiedBackup> {
	validateOperationId(input.operationId);
	if (typeof input.reason !== "string" || input.reason.length === 0) {
		throw new BackupRequestError("invalid_request", "Backup reason is required.");
	}
	const payloadHash = backupPayloadHash(input.reason);
	if (input.payloadHash !== undefined && input.payloadHash !== payloadHash) {
		throw new BackupRequestError("invalid_request", "Backup payloadHash does not match reason.");
	}

	ensurePrivateDirectory(input.destinationDir);
	const artifactPath = backupArtifactPath(input.destinationDir, input.operationId);
	const sidecarFile = backupSidecarPath(input.destinationDir, input.operationId);
	const sourcePath = input.db.name ?? "";
	const existing = readSidecar(sidecarFile);
	if (existing && existing.payloadHash !== payloadHash) {
		throw new BackupRequestError(
			"conflict",
			"Backup operation ID already exists with a different payload.",
		);
	}
	if (existing && existsSync(artifactPath)) {
		const check = verifyOnlineBackup({
			artifactPath,
			expectedSha256: existing.artifactSha256,
			sourcePath: sourcePath || undefined,
		});
		if (!check.valid || !check.manifestHash) {
			throw new Error("Existing backup failed verification.");
		}
		return {
			verified: true,
			evidence: `existing-online-backup:${input.operationId}:${check.manifestHash}`,
			backupId: input.operationId,
			artifactPath,
			artifactSha256: check.manifestHash,
		};
	}

	const temporaryPath = join(
		input.destinationDir,
		`${input.operationId}.${process.pid}.${randomUUID()}.tmp`,
	);
	try {
		await input.db.backup(temporaryPath);
		finalizeStandaloneBackup(temporaryPath);
		chmodSync(temporaryPath, 0o600);
		fsyncPath(temporaryPath);
		renameSync(temporaryPath, artifactPath);
		chmodSync(artifactPath, 0o600);
		fsyncPath(artifactPath);
		fsyncPath(input.destinationDir);
	} catch (error) {
		try {
			unlinkSync(temporaryPath);
		} catch {
			// tmp may already be gone or never created
		}
		throw error;
	}

	const artifactSha256 = sha256File(artifactPath);
	const check = verifyOnlineBackup({
		artifactPath,
		expectedSha256: artifactSha256,
		sourcePath: sourcePath || undefined,
	});
	if (!check.valid || !check.manifestHash) {
		try {
			unlinkSync(artifactPath);
		} catch {
			// keep the failure; leftover must not look complete
		}
		throw new Error("Online backup failed verification.");
	}
	const sidecar: BackupSidecar = {
		version: 1,
		operationId: input.operationId,
		reason: input.reason,
		payloadHash,
		artifactSha256: check.manifestHash,
		createdAt: new Date().toISOString(),
	};
	durableReplaceFile(sidecarFile, `${JSON.stringify(sidecar)}\n`);
	return {
		verified: true,
		evidence: `online-backup:${input.operationId}:${check.manifestHash}`,
		backupId: input.operationId,
		artifactPath,
		artifactSha256: check.manifestHash,
	};
}

function finalizeStandaloneBackup(path: string): void {
	const copy = WriterActor.open(path);
	try {
		copy.pragma("journal_mode = DELETE");
		copy.pragma("wal_checkpoint(TRUNCATE)");
	} finally {
		copy.close();
	}
	for (const suffix of ["-wal", "-shm"]) {
		try {
			unlinkSync(`${path}${suffix}`);
		} catch {
			// already absent after DELETE journal
		}
	}
}

export async function runGatedMigration(
	db: WriterActor,
	options: {
		dbPath: string;
		destinationDir: string;
		operationId: string;
		reason: string;
	},
): Promise<void> {
	const kind = peekMigrationKind(db);
	if (!kind) return;

	if (kind === "bootstrap") {
		runDatabaseMigrations(db, { dbPath: options.dbPath, backupAndVerify: verifyFreshDatabase });
		return;
	}

	const proof = await createOnlineBackup({
		db,
		destinationDir: options.destinationDir,
		operationId: options.operationId,
		reason: options.reason,
	});
	requireVerifiedBackup(proof);
	const recheck = verifyOnlineBackup({
		artifactPath: proof.artifactPath,
		expectedSha256: proof.artifactSha256,
		sourcePath: db.name,
	});
	if (!recheck.valid) {
		throw new Error("Destructive operation requires a verified backup.");
	}
	runDatabaseMigrations(db, {
		dbPath: options.dbPath,
		backupAndVerify: () => ({ verified: true, evidence: proof.evidence }),
	});
}

export async function createCanonicalBackup(input: {
	dataDir: string;
	operationId: string;
	reason: string;
	payloadHash: string;
}): Promise<VerifiedBackup> {
	const layout = resolveStorageLayout(input.dataDir);
	const pointer = readCurrentDatabasePointer(layout);
	if (!pointer) {
		throw new BackupRequestError("not_found", "No canonical database to back up.");
	}
	const sourcePath = join(layout.dbDir, pointer);
	const source = ReadOnlyActor.open(sourcePath);
	try {
		return await createOnlineBackup({
			db: source,
			destinationDir: layout.backupsDir,
			operationId: input.operationId,
			reason: input.reason,
			payloadHash: input.payloadHash,
		});
	} finally {
		source.close();
	}
}

export function verifyCanonicalBackup(input: {
	dataDir: string;
	backupId: string;
}): BackupCheck & { backupId: string } {
	validateOperationId(input.backupId);
	const layout = resolveStorageLayout(input.dataDir);
	const artifactPath = backupArtifactPath(layout.backupsDir, input.backupId);
	const sidecar = readSidecar(backupSidecarPath(layout.backupsDir, input.backupId));
	if (!sidecar) {
		return {
			backupId: input.backupId,
			valid: false,
			manifestHash: null,
			diagnostics: ["backup sidecar is missing"],
		};
	}
	const pointer = readCurrentDatabasePointer(layout);
	const sourcePath = pointer ? join(layout.dbDir, pointer) : undefined;
	const check = verifyOnlineBackup({
		artifactPath,
		expectedSha256: sidecar.artifactSha256,
		sourcePath,
	});
	return { ...check, backupId: input.backupId };
}

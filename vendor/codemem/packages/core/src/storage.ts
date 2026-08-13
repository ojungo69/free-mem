import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	lstatSync,
	openSync,
	readFileSync,
	readlinkSync,
	readSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
	durableCopyFile,
	durableRemoveFile,
	durableReplaceFile,
	durableReplaceSymlink,
	ensurePrivateDirectory,
	fsyncPath,
} from "./storage-platform.js";
import { ReadOnlyActor } from "./writer-actor.js";

export const DEFAULT_DATA_DIR = join(homedir(), ".codemem");

export interface StorageLayout {
	dataDir: string;
	controlDir: string;
	dbDir: string;
	versionsDir: string;
	currentPointerPath: string;
	journalPath: string;
	lockPath: string;
	identityPath: string;
	socketPath: string;
	backupsDir: string;
}

export type StorageJournalState = "prepared" | "switched" | "committed";

export interface StorageJournal {
	version: 1;
	operationId: string;
	state: StorageJournalState;
	oldPointer: string | null;
	newPointer: string;
	artifactSha256: string;
}

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ARTIFACT_POINTER = /^versions\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.sqlite$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function resolveStorageLayout(dataDir: string = DEFAULT_DATA_DIR): StorageLayout {
	const root = resolve(dataDir);
	const controlDir = join(root, "control");
	const dbDir = join(root, "db");
	return {
		dataDir: root,
		controlDir,
		dbDir,
		versionsDir: join(dbDir, "versions"),
		currentPointerPath: join(dbDir, "current"),
		journalPath: join(controlDir, "restore-journal.json"),
		lockPath: join(controlDir, "lock.db"),
		identityPath: join(controlDir, "identity.json"),
		socketPath: join(controlDir, "daemon.sock"),
		backupsDir: join(controlDir, "backups"),
	};
}

export function ensureStorageLayout(layout: StorageLayout): void {
	ensurePrivateDirectory(layout.dataDir);
	ensurePrivateDirectory(layout.controlDir);
	ensurePrivateDirectory(layout.dbDir);
	ensurePrivateDirectory(layout.versionsDir);
	ensurePrivateDirectory(layout.backupsDir);
}

function validateOperationId(operationId: string): void {
	if (!OPERATION_ID.test(operationId)) {
		throw new Error("Storage operation ID contains unsupported characters.");
	}
}

function validatePointer(pointer: string): void {
	if (isAbsolute(pointer) || !ARTIFACT_POINTER.test(pointer)) {
		throw new Error(`Invalid database artifact pointer: ${pointer}`);
	}
}

function artifactPath(layout: StorageLayout, pointer: string): string {
	validatePointer(pointer);
	const path = resolve(layout.dbDir, pointer);
	if (!path.startsWith(`${layout.versionsDir}/`)) {
		throw new Error(`Database artifact escapes the versions directory: ${pointer}`);
	}
	return path;
}

function validateJournal(value: unknown): StorageJournal {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Storage journal must be a JSON object.");
	}
	const journal = value as Partial<StorageJournal>;
	if (journal.version !== 1) throw new Error("Unsupported storage journal version.");
	if (typeof journal.operationId !== "string")
		throw new Error("Storage journal has no operation ID.");
	validateOperationId(journal.operationId);
	if (
		journal.state !== "prepared" &&
		journal.state !== "switched" &&
		journal.state !== "committed"
	) {
		throw new Error("Storage journal has an invalid state.");
	}
	if (journal.oldPointer !== null && typeof journal.oldPointer !== "string") {
		throw new Error("Storage journal has an invalid old pointer.");
	}
	if (journal.oldPointer !== null) validatePointer(journal.oldPointer);
	if (typeof journal.newPointer !== "string")
		throw new Error("Storage journal has no new pointer.");
	validatePointer(journal.newPointer);
	if (typeof journal.artifactSha256 !== "string" || !SHA256.test(journal.artifactSha256)) {
		throw new Error("Storage journal has an invalid artifact hash.");
	}
	return journal as StorageJournal;
}

export function writeStorageJournal(layout: StorageLayout, journal: StorageJournal): void {
	ensureStorageLayout(layout);
	const validated = validateJournal(journal);
	durableReplaceFile(layout.journalPath, `${JSON.stringify(validated)}\n`);
}

function readStorageJournal(layout: StorageLayout): StorageJournal | null {
	if (!existsSync(layout.journalPath)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(layout.journalPath, "utf8"));
	} catch (error) {
		throw new Error("Storage journal is unreadable or malformed.", { cause: error });
	}
	return validateJournal(parsed);
}

export function readCurrentDatabasePointer(layout: StorageLayout): string | null {
	try {
		const info = lstatSync(layout.currentPointerPath);
		if (!info.isSymbolicLink()) throw new Error("Database current pointer is not a symbolic link.");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	const pointer = readlinkSync(layout.currentPointerPath);
	validatePointer(pointer);
	return pointer;
}

export function sha256File(path: string): string {
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(1024 * 1024);
	const fd = openSync(path, "r");
	try {
		for (;;) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			hash.update(buffer.subarray(0, bytesRead));
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}

function verifyArtifact(layout: StorageLayout, pointer: string, expectedSha256: string): void {
	const path = artifactPath(layout, pointer);
	if (!existsSync(path)) throw new Error(`Database artifact is missing: ${pointer}`);
	if (sha256File(path) !== expectedSha256) {
		throw new Error(`Database artifact hash mismatch: ${pointer}`);
	}
	const db = ReadOnlyActor.open(path);
	try {
		const rows = db.pragma("integrity_check") as Array<Record<string, unknown>>;
		if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok") {
			throw new Error(`SQLite integrity check failed: ${pointer}`);
		}
	} finally {
		db.close();
	}
}

function restorePointer(layout: StorageLayout, pointer: string | null): void {
	if (pointer === null) {
		durableRemoveFile(layout.currentPointerPath);
		return;
	}
	if (!existsSync(artifactPath(layout, pointer))) {
		throw new Error(`Cannot recover missing previous database artifact: ${pointer}`);
	}
	if (readCurrentDatabasePointer(layout) !== pointer) {
		durableReplaceSymlink(layout.currentPointerPath, pointer);
	}
}

export function recoverStorageJournal(
	layout: StorageLayout,
): { action: "none" } | { action: "rolled_back" | "completed"; state: StorageJournalState } {
	ensureStorageLayout(layout);
	const journal = readStorageJournal(layout);
	if (!journal) return { action: "none" };

	const current = readCurrentDatabasePointer(layout);
	if (current !== journal.oldPointer && current !== journal.newPointer) {
		throw new Error("Storage journal does not identify the current database pointer.");
	}

	if (journal.state === "committed") {
		if (current !== journal.newPointer) {
			throw new Error("Committed storage journal does not point at the committed artifact.");
		}
		verifyArtifact(layout, journal.newPointer, journal.artifactSha256);
		durableRemoveFile(layout.journalPath);
		return { action: "completed", state: journal.state };
	}

	restorePointer(layout, journal.oldPointer);
	durableRemoveFile(layout.journalPath);
	return { action: "rolled_back", state: journal.state };
}

export function activateDatabaseArtifact(
	layout: StorageLayout,
	input: { operationId: string; pointer: string; artifactSha256: string },
): void {
	ensureStorageLayout(layout);
	validateOperationId(input.operationId);
	validatePointer(input.pointer);
	if (!SHA256.test(input.artifactSha256)) throw new Error("Invalid database artifact hash.");
	if (readStorageJournal(layout)) throw new Error("A storage journal already requires recovery.");

	const oldPointer = readCurrentDatabasePointer(layout);
	const journal: StorageJournal = {
		version: 1,
		operationId: input.operationId,
		state: "prepared",
		oldPointer,
		newPointer: input.pointer,
		artifactSha256: input.artifactSha256,
	};
	writeStorageJournal(layout, journal);
	fsyncPath(artifactPath(layout, input.pointer));
	fsyncPath(layout.versionsDir);

	try {
		durableReplaceSymlink(layout.currentPointerPath, input.pointer);
		writeStorageJournal(layout, { ...journal, state: "switched" });
		verifyArtifact(layout, input.pointer, input.artifactSha256);
		writeStorageJournal(layout, { ...journal, state: "committed" });
		durableRemoveFile(layout.journalPath);
	} catch (error) {
		try {
			if (recoverStorageJournal(layout).action === "completed") return;
		} catch (recoveryError) {
			throw new AggregateError(
				[error, recoveryError],
				"Database activation failed and storage recovery did not complete.",
			);
		}
		throw error;
	}
}

/**
 * Publish a backup already verified by the T050/T051 cutover preconditions.
 * This function is deliberately not called automatically before T051.
 */
export function runLegacyMigration(input: {
	layout: StorageLayout;
	operationId: string;
	verifiedBackupPath: string;
	verifiedBackupSha256: string;
}): void {
	ensureStorageLayout(input.layout);
	validateOperationId(input.operationId);
	if (!SHA256.test(input.verifiedBackupSha256)) throw new Error("Invalid verified backup hash.");
	if (sha256File(input.verifiedBackupPath) !== input.verifiedBackupSha256) {
		throw new Error("Verified legacy backup hash no longer matches its artifact.");
	}
	if (readCurrentDatabasePointer(input.layout) !== null) {
		throw new Error("Legacy migration refuses to replace an existing current database pointer.");
	}

	const pointer = `versions/${input.operationId}.sqlite`;
	const destination = artifactPath(input.layout, pointer);
	durableCopyFile(input.verifiedBackupPath, destination);
	activateDatabaseArtifact(input.layout, {
		operationId: input.operationId,
		pointer,
		artifactSha256: input.verifiedBackupSha256,
	});
}

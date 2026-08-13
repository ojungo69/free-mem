import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { connect } from "./db.js";
import { runGatedMigration } from "./online-backup.js";
import {
	activateDatabaseArtifact,
	readCurrentDatabasePointer,
	type StorageLayout,
	sha256File,
} from "./storage.js";
import { MemoryStore } from "./store.js";
import type { WriterActor } from "./writer-actor.js";

export type CanonicalWriter = {
	db: WriterActor;
	dbPath: string;
	store: MemoryStore;
};

export async function openCanonicalWriter(layout: StorageLayout): Promise<CanonicalWriter> {
	const existing = readCurrentDatabasePointer(layout);
	const operationId = existing ? `schema-${randomUUID()}` : `init-${randomUUID()}`;
	const pointer = existing ?? `versions/${operationId}.sqlite`;
	const dbPath = join(layout.dbDir, pointer);
	const db = connect(dbPath);
	try {
		await runGatedMigration(db, {
			dbPath,
			destinationDir: layout.backupsDir,
			operationId,
			reason: "migration",
		});
		if (!existing) {
			db.pragma("wal_checkpoint(TRUNCATE)");
			activateDatabaseArtifact(layout, {
				operationId,
				pointer,
				artifactSha256: sha256File(dbPath),
			});
		}
		const store = new MemoryStore(dbPath, { connection: db });
		return { db, dbPath, store };
	} catch (error) {
		db.close();
		throw error;
	}
}

import {
	assertSchemaReady,
	ensureAdditiveSchemaCompatibility,
	getSchemaVersion,
	isSchemaCompatibilityCurrent,
	SCHEMA_VERSION,
	tableExists,
} from "./db.js";
import { bootstrapSchema, canAutoBootstrapSchema } from "./schema-bootstrap.js";
import type { WriterActor } from "./writer-actor.js";

export interface MigrationBackupContext {
	db: WriterActor;
	dbPath: string;
	schemaVersion: number;
	kind: "bootstrap" | "upgrade";
}

export interface MigrationBackupVerification {
	verified: boolean;
	evidence: string;
}

export type MigrationBackupVerifier = (
	context: MigrationBackupContext,
) => MigrationBackupVerification;

export interface RunDatabaseMigrationsOptions {
	dbPath: string;
	backupAndVerify: MigrationBackupVerifier;
}

export function peekMigrationKind(db: WriterActor): "bootstrap" | "upgrade" | null {
	const version = getSchemaVersion(db);
	if (canAutoBootstrapSchema(db)) return "bootstrap";
	if (version === 0) {
		throw new Error("Refusing to migrate a non-empty database without a codemem schema.");
	}
	if (!tableExists(db, "memory_items") || !tableExists(db, "sessions")) {
		throw new Error("Refusing to migrate an unrecognized or partial codemem database.");
	}
	if (version > SCHEMA_VERSION || isSchemaCompatibilityCurrent(db)) return null;
	return "upgrade";
}

/** Run schema changes only after the supplied backup proof succeeds. */
export function runDatabaseMigrations(
	db: WriterActor,
	options: RunDatabaseMigrationsOptions,
): void {
	const kind = peekMigrationKind(db);
	if (!kind) return;

	const verification = options.backupAndVerify({
		db,
		dbPath: options.dbPath,
		schemaVersion: getSchemaVersion(db),
		kind,
	});
	if (!verification.verified || !verification.evidence.trim()) {
		throw new Error("Database migration requires a verified backup before schema changes begin.");
	}

	if (kind === "bootstrap") bootstrapSchema(db);
	ensureAdditiveSchemaCompatibility(db);
	assertSchemaReady(db);
}

/** Fresh empty databases have no prior state to preserve. */
export const verifyFreshDatabase: MigrationBackupVerifier = ({ db }) => {
	const verified = canAutoBootstrapSchema(db);
	return { verified, evidence: verified ? "fresh-empty-database" : "" };
};

import { columnExists, type Database, tableExists } from "./db.js";
import { VECTOR_MODEL_MIGRATION_JOB } from "./vector-migration.js";

export type OperationalMaintenanceState = "idle" | "running" | "failed" | "unknown";
export type OperationalSemanticState = "healthy" | "pending" | "degraded" | "failed" | "unknown";

export interface OperationalStatusSnapshot {
	capability: Record<string, unknown> | null;
	maintenance: {
		state: OperationalMaintenanceState;
		running: number;
		failed: number;
	};
	semantic_index: {
		state: OperationalSemanticState;
		vector_table_present: boolean;
	};
	raw_events: {
		available: boolean;
		pending: number;
		failed_batches: number;
	};
	observer: {
		available: boolean;
		failed_batches: number;
		backoff_batches: number;
	};
}

function count(row: { count?: unknown } | undefined): number {
	const value = Number(row?.count ?? 0);
	return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function aggregateCount(
	db: Database,
	table: string,
	query: string,
	params: unknown[] = [],
): number | null {
	if (!tableExists(db, table)) return null;
	try {
		return count(db.prepare(query).get(...params) as { count?: unknown } | undefined);
	} catch {
		return null;
	}
}

function collectMaintenance(db: Database): OperationalStatusSnapshot["maintenance"] {
	if (!tableExists(db, "maintenance_jobs")) {
		return { state: "unknown", running: 0, failed: 0 };
	}
	try {
		const row = db
			.prepare(
				`SELECT
					SUM(CASE WHEN status IN ('pending', 'running') THEN 1 ELSE 0 END) AS running,
					SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
				 FROM maintenance_jobs
				 WHERE kind <> ?`,
			)
			.get(VECTOR_MODEL_MIGRATION_JOB) as { running?: unknown; failed?: unknown } | undefined;
		const running = count({ count: row?.running });
		const failed = count({ count: row?.failed });
		return { state: failed > 0 ? "failed" : running > 0 ? "running" : "idle", running, failed };
	} catch {
		return { state: "unknown", running: 0, failed: 0 };
	}
}

function collectSemanticIndex(
	db: Database,
	embeddingDisabled: boolean,
): OperationalStatusSnapshot["semantic_index"] {
	const vectorTablePresent = tableExists(db, "memory_vectors");
	if (!tableExists(db, "maintenance_jobs")) {
		return {
			state: embeddingDisabled || !vectorTablePresent ? "degraded" : "unknown",
			vector_table_present: vectorTablePresent,
		};
	}
	try {
		const row = db
			.prepare("SELECT status FROM maintenance_jobs WHERE kind = ?")
			.get(VECTOR_MODEL_MIGRATION_JOB) as { status?: unknown } | undefined;
		const status = typeof row?.status === "string" ? row.status : null;
		const state: OperationalSemanticState =
			status === "failed"
				? "failed"
				: embeddingDisabled || !vectorTablePresent
					? "degraded"
					: status === "pending" || status === "running"
						? "pending"
						: "healthy";
		return { state, vector_table_present: vectorTablePresent };
	} catch {
		return {
			state: embeddingDisabled || !vectorTablePresent ? "degraded" : "unknown",
			vector_table_present: vectorTablePresent,
		};
	}
}

function collectRawEvents(
	db: Database,
	recentFailureCutoff?: string,
): OperationalStatusSnapshot["raw_events"] {
	const sessionsTablePresent = tableExists(db, "raw_event_sessions");
	const eventsTablePresent = tableExists(db, "raw_events");
	const batchesTablePresent = tableExists(db, "raw_event_flush_batches");
	let pending = 0;
	if (sessionsTablePresent && eventsTablePresent) {
		try {
			pending = count(
				db
					.prepare(
						`SELECT COALESCE(SUM(max_seq - last_flushed_event_seq), 0) AS count
						 FROM (
							SELECT s.last_flushed_event_seq,
								(SELECT MAX(e.event_seq)
								 FROM raw_events e
								 WHERE e.source = s.source AND e.stream_id = s.stream_id) AS max_seq
							FROM raw_event_sessions s
						 )
						 WHERE max_seq > last_flushed_event_seq`,
					)
					.get() as { count?: unknown } | undefined,
			);
		} catch {
			pending = 0;
		}
	}
	return {
		available: sessionsTablePresent && eventsTablePresent && batchesTablePresent,
		pending,
		failed_batches:
			aggregateCount(
				db,
				"raw_event_flush_batches",
				recentFailureCutoff
					? "SELECT COUNT(*) AS count FROM raw_event_flush_batches WHERE status = 'gave_up' AND updated_at >= ?"
					: "SELECT COUNT(*) AS count FROM raw_event_flush_batches WHERE status = 'gave_up'",
				recentFailureCutoff ? [recentFailureCutoff] : [],
			) ?? 0,
	};
}

function collectObserver(
	db: Database,
	recentFailureCutoff?: string,
): OperationalStatusSnapshot["observer"] {
	const available =
		tableExists(db, "raw_event_flush_batches") &&
		columnExists(db, "raw_event_flush_batches", "observer_error_code");
	if (!available) return { available: false, failed_batches: 0, backoff_batches: 0 };
	return {
		available,
		failed_batches:
			aggregateCount(
				db,
				"raw_event_flush_batches",
				recentFailureCutoff
					? `SELECT COUNT(*) AS count FROM raw_event_flush_batches
				 WHERE status = 'gave_up' AND updated_at >= ?
				   AND observer_error_code IS NOT NULL
				   AND TRIM(observer_error_code) != ''`
					: `SELECT COUNT(*) AS count FROM raw_event_flush_batches
				 WHERE status = 'gave_up'
				   AND observer_error_code IS NOT NULL
				   AND TRIM(observer_error_code) != ''`,
				recentFailureCutoff ? [recentFailureCutoff] : [],
			) ?? 0,
		backoff_batches:
			aggregateCount(
				db,
				"raw_event_flush_batches",
				`SELECT COUNT(*) AS count FROM raw_event_flush_batches
				 WHERE status IN ('error', 'failed')
				   AND observer_error_code IS NOT NULL
				   AND TRIM(observer_error_code) != ''`,
			) ?? 0,
	};
}

/** Collect bounded operational aggregates from an already-open database without writing schema. */
export function collectOperationalStatus(
	db: Database,
	options: {
		embeddingDisabled?: boolean;
		recentFailureCutoff?: string;
		capability?: Record<string, unknown>;
	} = {},
): OperationalStatusSnapshot {
	const embeddingDisabled =
		options.embeddingDisabled === true ||
		(options.capability !== undefined &&
			(options.capability.embeddingProvider as { state?: unknown } | null | undefined)?.state !==
				"enabled");
	return {
		capability: options.capability ?? null,
		maintenance: collectMaintenance(db),
		semantic_index: collectSemanticIndex(db, embeddingDisabled),
		raw_events: collectRawEvents(db, options.recentFailureCutoff),
		observer: collectObserver(db, options.recentFailureCutoff),
	};
}

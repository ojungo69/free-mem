import { desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Hono } from "hono";
import { parseStrictInteger } from "../integers.js";
import { schema } from "../schema.js";
import type { MemoryStore } from "../store.js";

export function rawEventReadRoutes(getStore: () => MemoryStore) {
	const app = new Hono();

	app.get("/api/raw-events", (c) => c.json(getStore().rawEventBacklogTotals()));

	app.get("/api/raw-events/status", (c) => {
		const store = getStore();
		const limit = parseStrictInteger(c.req.query("limit")) ?? 25;
		const rows = drizzle(store.db, { schema })
			.select({
				source: schema.rawEventSessions.source,
				stream_id: schema.rawEventSessions.stream_id,
				opencode_session_id: schema.rawEventSessions.opencode_session_id,
				cwd: schema.rawEventSessions.cwd,
				project: schema.rawEventSessions.project,
				started_at: schema.rawEventSessions.started_at,
				last_seen_ts_wall_ms: schema.rawEventSessions.last_seen_ts_wall_ms,
				last_received_event_seq: schema.rawEventSessions.last_received_event_seq,
				last_flushed_event_seq: schema.rawEventSessions.last_flushed_event_seq,
				updated_at: schema.rawEventSessions.updated_at,
			})
			.from(schema.rawEventSessions)
			.orderBy(desc(schema.rawEventSessions.updated_at))
			.limit(limit)
			.all();
		const items = rows.map((row) => {
			const streamId = String(row.stream_id ?? row.opencode_session_id ?? "");
			return { ...row, session_stream_id: streamId, session_id: streamId };
		});
		return c.json({
			items,
			totals: store.rawEventBacklogTotals(),
			ingest: { available: false, mode: "daemon_rpc", max_body_bytes: 0 },
		});
	});

	return app;
}

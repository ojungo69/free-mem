import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';

import type { Destination, Sensitivity } from '../privacy/egress.js';
import { searchCandidates } from '../retrieval/query.js';
import { normalizeBm25, rrfFuse } from '../retrieval/rank.js';

export type ReviewState = 'unreviewed' | 'reviewed' | 'imported';
export type SummaryState = 'pending' | 'done' | 'no_content';

/** The `memories` columns as stored (0002_memory_search.sql). */
export type MemoryRow = {
  id: string;
  repo_id: string;
  type: string;
  title: string | null;
  body: string | null;
  concepts: string | null;
  cjk_bigrams: string | null;
  material_hash: string | null;
  content_hash: string;
  sensitivity: Sensitivity;
  review_state: ReviewState;
  degraded_reason: string | null;
  source_session_id: string | null;
  source_batch_id: string | null;
  valid_from: number | null;
  valid_to: number | null;
  superseded_by: string | null;
  pinned_at: number | null;
  pin_order: number | null;
  last_injected_at: number | null;
  citations_head: string | null;
  citations_ok: number | null;
  deleted_at: number | null;
  created_at: number | null;
};

/** A `WHERE` fragment over the alias `m` plus its parameters, in that order. */
export type MemoryScope = { where: string; params: SQLInputValue[] };

export type TimelineTurn = {
  id: string;
  ordinal: number;
  started_at: number | null;
  ended_at: number | null;
};

export type TimelineSession = {
  id: string;
  agent: string;
  started_at: number | null;
  ended_at: number | null;
  status: string;
  turn_count: number;
  summary_state: SummaryState | null;
  turns: TimelineTurn[];
  memory_ids: string[];
};

export type SessionState = {
  sessionId: string;
  summaryState: SummaryState | null;
  endedAt: number | null;
};

/**
 * The one filter every reader appends: retrieval, injection, the command line, MCP and the viewer.
 * No caller writes its own repository, sensitivity, review state, tombstone or validity condition
 * (docs/dev/conventions.md "Sensitivity and egress").
 */
export function memoryScope(
  db: DatabaseSync,
  input: { repoId: string; destination: Destination },
): MemoryScope {
  if (input.destination === 'sync') {
    // Synchronization is M2 (plan.md "Constitution Check" V); refusing beats a silent wider scope.
    throw new Error('Synchronization is not available in M1.');
  }

  // data-model "destination_rules": one seeded table governs every egress decision, so the list is
  // read here and never hardcoded. privacy/egress.ts evaluates the same table row by row on the
  // observer path. Secret is excluded because the table allows it nowhere (FR-020).
  const allowed = db
    .prepare(
      'SELECT sensitivity AS sensitivity FROM destination_rules WHERE destination = ? AND allowed = 1 ORDER BY sensitivity',
    )
    .all(input.destination)
    .map((row) => String(row.sensitivity));

  const conditions = [
    'm.repo_id = ?', // FR-044: the same repository is the only scope in M1.
    'm.deleted_at IS NULL', // FR-035: a tombstone never surfaces again.
    'm.valid_to IS NULL', // data-model "memories": a superseded row never surfaces.
    "m.review_state <> 'imported'", // R12 "Export/import": imported rows stay quarantined.
    // Fails closed: with no allowed sensitivity the fragment matches no row at all.
    allowed.length === 0 ? '0' : `m.sensitivity IN (${allowed.map(() => '?').join(', ')})`,
  ];

  return { where: `(${conditions.join(' AND ')})`, params: [input.repoId, ...allowed] };
}

/** Null for a missing id and for one outside the scope alike (contracts/cli.md, contracts/mcp.md). */
export function getMemory(db: DatabaseSync, id: string, scope: MemoryScope): MemoryRow | null {
  const row = db
    .prepare(`SELECT m.* FROM memories m WHERE ${scope.where} AND m.id = ?`)
    .get(...scope.params, id);
  return row === undefined ? null : asMemoryRows([row])[0];
}

export function listMemories(
  db: DatabaseSync,
  scope: MemoryScope,
  options: { limit: number; offset?: number },
): MemoryRow[] {
  return asMemoryRows(
    db
      .prepare(
        `SELECT m.* FROM memories m WHERE ${scope.where}
         ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...scope.params, options.limit, options.offset ?? 0),
  );
}

export function pinnedMemories(db: DatabaseSync, scope: MemoryScope): MemoryRow[] {
  return asMemoryRows(
    db
      .prepare(
        `SELECT m.* FROM memories m WHERE ${scope.where} AND m.pinned_at IS NOT NULL
         ORDER BY m.pin_order, m.pinned_at, m.id`,
      )
      .all(...scope.params),
  );
}

/**
 * The session summary a fresh session injects (FR-024). A summary that is secret, deleted or
 * superseded is filtered out by the injection scope, so the next older one is used instead.
 */
export function latestSessionSummary(db: DatabaseSync, repoId: string): MemoryRow | null {
  const scope = memoryScope(db, { repoId, destination: 'injection' });
  const row = db
    .prepare(
      `SELECT m.* FROM sessions s JOIN memories m ON m.id = s.latest_summary_memory_id
       WHERE ${scope.where} AND s.repo_id = ? AND s.status = 'ended' AND s.summary_state = 'done'
       ORDER BY s.ended_at DESC, s.id DESC LIMIT 1`,
    )
    .get(...scope.params, repoId);
  return row === undefined ? null : asMemoryRows([row])[0];
}

/** Lets the pack builder tell a pending summary from a session that had nothing to summarize. */
export function latestSessionState(db: DatabaseSync, repoId: string): SessionState | null {
  const row = db
    .prepare(
      `SELECT id AS id, summary_state AS summary_state, ended_at AS ended_at FROM sessions
       WHERE repo_id = ? AND status = 'ended' ORDER BY ended_at DESC, id DESC LIMIT 1`,
    )
    .get(repoId);
  if (row === undefined) return null;
  return {
    sessionId: String(row.id),
    summaryState: (row.summary_state as SummaryState | null) ?? null,
    endedAt: (row.ended_at as number | null) ?? null,
  };
}

/** Sessions of the repository with their turns and the memories that reach the reader. */
export function timeline(
  db: DatabaseSync,
  repoId: string,
  options: { sessionId?: string; limit: number },
): TimelineSession[] {
  const scope = memoryScope(db, { repoId, destination: 'injection' });
  const sessionFilter = options.sessionId === undefined ? '' : 'AND s.id = ?';
  const sessionParams: SQLInputValue[] =
    options.sessionId === undefined
      ? [repoId, options.limit]
      : [repoId, options.sessionId, options.limit];

  const sessions = db
    .prepare(
      `SELECT s.id AS id, s.agent AS agent, s.started_at AS started_at, s.ended_at AS ended_at,
              s.status AS status, s.turn_count AS turn_count, s.summary_state AS summary_state
       FROM sessions s WHERE s.repo_id = ? ${sessionFilter}
       ORDER BY s.started_at DESC, s.id DESC LIMIT ?`,
    )
    .all(...sessionParams);

  const turnsOf = db.prepare(
    `SELECT t.id AS id, t.ordinal AS ordinal, t.started_at AS started_at, t.ended_at AS ended_at
     FROM turns t WHERE t.session_id = ? ORDER BY t.ordinal`,
  );

  // ponytail: one turn query and one memory query per session; the listing caps at 50 (contracts/cli.md).
  return sessions.map((session) => {
    const sessionId = String(session.id);
    return {
      id: sessionId,
      agent: String(session.agent),
      started_at: (session.started_at as number | null) ?? null,
      ended_at: (session.ended_at as number | null) ?? null,
      status: String(session.status),
      turn_count: Number(session.turn_count),
      summary_state: (session.summary_state as SummaryState | null) ?? null,
      turns: turnsOf.all(sessionId).map((turn) => ({
        id: String(turn.id),
        ordinal: Number(turn.ordinal),
        started_at: (turn.started_at as number | null) ?? null,
        ended_at: (turn.ended_at as number | null) ?? null,
      })),
      memory_ids: memoriesForSession(db, sessionId, scope).map((memory) => memory.id),
    };
  });
}

/** The memories a session produced, through the sources that link them to the session's events. */
export function memoriesForSession(
  db: DatabaseSync,
  sessionId: string,
  scope: MemoryScope,
): MemoryRow[] {
  return asMemoryRows(
    db
      .prepare(
        `SELECT DISTINCT m.* FROM memories m
         JOIN memory_sources ms ON ms.memory_id = m.id
         JOIN raw_events e ON e.id = ms.raw_event_id
         WHERE ${scope.where} AND e.session_id = ?
         ORDER BY m.created_at DESC, m.id DESC`,
      )
      .all(...scope.params, sessionId),
  );
}

/** Records delivery for the 90-day retirement (data-model "memories"). */
export function markInjected(db: DatabaseSync, ids: string[], now: number): void {
  // Hooks write this outside the worker lease, so it is a plain UPDATE and not a fenced one
  // (docs/dev/conventions.md "Database access").
  const update = db.prepare('UPDATE memories SET last_injected_at = ? WHERE id = ?');
  for (const id of ids) {
    update.run(now, id);
  }
}

// The columns are the ones the migration defines; SQLite gives them back untyped.
function asMemoryRows(rows: Record<string, SQLOutputValue>[]): MemoryRow[] {
  return rows as unknown as MemoryRow[];
}

/**
 * A classification candidate: a memory of the same repository as the batch, tombstones and
 * superseded rows included (R10, contracts/observer.md "Worker rules after either path").
 */
export type NearbyCandidate = {
  id: string;
  repo_id: string;
  type: string;
  title: string;
  body: string;
  content_hash: string;
  deleted: boolean;
  sensitivity: Sensitivity;
};

/**
 * The top `limit` same-repository memories for the batch text (R10: top 8, tombstones included).
 * The scope is deliberately the repository alone: `memoryScope` hides tombstoned and superseded
 * rows, which are exactly the rows the tombstone check and an `update` decision need (FR-035).
 * Sensitivity travels with each row so `observer/request.ts` can drop what a destination may not
 * receive; this function never decides egress itself.
 */
export function nearbyCandidates(
  db: DatabaseSync,
  input: { repoId: string; text: string; limit?: number },
): NearbyCandidate[] {
  const limit = input.limit ?? 8;
  const found = searchCandidates(db, {
    text: input.text,
    scope: { where: 'm.repo_id = ?', params: [input.repoId] },
    limit,
  });
  const ranked = rrfFuse(normalizeBm25(normalizeBm25(found.rows, 'scoreTrigram'), 'scoreCjk'))
    .sort((left, right) => (right.score_rrf ?? 0) - (left.score_rrf ?? 0) || (left.id < right.id ? -1 : 1))
    .slice(0, limit);
  if (ranked.length === 0) return [];

  const byId = new Map<string, NearbyCandidate>();
  const rows = db
    .prepare(
      `SELECT m.id, m.repo_id, m.type, m.title, m.body, m.content_hash, m.sensitivity, m.deleted_at
       FROM memories m WHERE m.id IN (${ranked.map(() => '?').join(', ')})`,
    )
    .all(...ranked.map((row) => row.id));
  for (const row of rows) {
    byId.set(String(row.id), {
      id: String(row.id),
      repo_id: String(row.repo_id),
      type: String(row.type),
      title: typeof row.title === 'string' ? row.title : '',
      body: typeof row.body === 'string' ? row.body : '',
      content_hash: String(row.content_hash),
      deleted: row.deleted_at !== null,
      sensitivity: row.sensitivity as Sensitivity,
    });
  }
  // The search decided the order; the second query only fills the columns it does not return.
  return ranked.map((row) => byId.get(row.id)).filter((row): row is NearbyCandidate => row !== undefined);
}

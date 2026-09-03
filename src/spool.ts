// The overflow spool: one sanitized file per event, written to a temporary name and renamed.
// Sources: research.md R6 ("Spool entries are one sanitized file per event (write-then-rename)"),
// data-model.md "Spool entry", spec FR-002 and FR-003.
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { eventSchema, type NormalizedEvent } from './events.js';
import type { OboetePaths } from './paths.js';

/** The columns the hook already decided and the worker must not decide again on recovery. */
export type SpoolColumns = {
  repoId: string;
  sensitivity: string;
  classificationState: string;
  truncated: 0 | 1;
  contentHash: string | null;
};

// A spool file is read back by the worker, so it is validated like any other input; a file that
// does not match is not trusted into the database (R4 fails closed on what it cannot classify).
export const spoolEntrySchema = z.strictObject({
  id: z.string().min(1),
  repo_id: z.string().min(1),
  sensitivity: z.string().min(1),
  classification_state: z.string().min(1),
  truncated: z.union([z.literal(0), z.literal(1)]),
  content_hash: z.string().nullable(),
  event: eventSchema,
});

export type SpoolEntry = z.infer<typeof spoolEntrySchema>;

/**
 * Writes one already redacted event to `spool/<captured_at>-<event id>.json`. The detector has run
 * before this call on every path that reaches it (FR-018), and an event whose detector run failed
 * is never spooled (data-model "Spool entry"), so a spool file never holds unsanitized content.
 */
export function spoolEvent(
  paths: OboetePaths,
  event: NormalizedEvent & { id: string },
  columns: SpoolColumns,
): void {
  const { id, ...normalized } = event;
  const entry: SpoolEntry = {
    id,
    repo_id: columns.repoId,
    sensitivity: columns.sensitivity,
    classification_state: columns.classificationState,
    truncated: columns.truncated,
    content_hash: columns.contentHash,
    event: normalized as NormalizedEvent,
  };

  const target = join(paths.spool, `${event.captured_at}-${id}.json`);
  // The temporary name carries a fresh uuid so two hooks writing the same event cannot interleave,
  // and it is not `.json`, so a half-written file is never listed as an entry.
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(entry), { mode: 0o600 });
  renameSync(temporary, target);
}

/** The entries in name order, which is capture order because the name starts with `captured_at`. */
export function listSpool(paths: OboetePaths): string[] {
  if (!existsSync(paths.spool)) return [];
  return readdirSync(paths.spool)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

/** One entry, or null when it is gone or does not match the schema. */
export function readSpoolEntry(paths: OboetePaths, name: string): SpoolEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(paths.spool, name), 'utf8'));
  } catch {
    return null;
  }
  const parsed = spoolEntrySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Removing an entry that is already gone is not an error: recovery must be idempotent (FR-003). */
export function removeSpoolEntry(paths: OboetePaths, name: string): void {
  rmSync(join(paths.spool, name), { force: true });
}

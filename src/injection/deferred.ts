// Grok Build's deferred delivery (FR-045, contracts/agents.md "Grok Build deferred delivery", the
// five numbered rules). Grok has no channel that reaches the model before a turn starts, so the
// pack is stored `pending` and attached to every tool call until one of them actually runs.
// Amendment A15 (R13 probe: `additionalContext` arrives once per call) makes per-call duplicates
// inside one parallel batch accepted and counted rather than suppressed.
import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import { runtimeStateGet, runtimeStateSet } from '../worker/purge.js';
import { transactionImmediate } from '../worker/lease.js';
import {
  confirmDeliveryIn,
  omitInjection,
  parseAttempts,
  type DegradedReason,
  type ItemReason,
  type WhyAttempt,
} from './ledger.js';
import { renderPack, type BuiltPack } from './pack.js';

/**
 * The rendered pack of the pending record. `injections` stores the hash, not the text, so the text
 * lives in `runtime_state` next to it (data-model.md runtime_state) and is deleted with the record.
 */
type PendingPack = {
  injectionId: string;
  repositoryLine: string;
  degraded: DegradedReason | null;
  blocks: { memoryId: string | null; rawEventId: string | null; lines: string[] }[];
  text: string;
};

// ponytail: one row per conversation, deleted on delivery and at Stop; a conversation that never
// stops leaves its row behind, and the worker's purge can sweep them if that ever adds up.
function packKey(conversationId: string): string {
  return `injection_pending:${conversationId}`;
}

function readPending(db: DatabaseSync, conversationId: string): PendingPack | null {
  const stored = runtimeStateGet(db, packKey(conversationId));
  if (stored === undefined) return null;
  try {
    return JSON.parse(stored) as PendingPack;
  } catch {
    // A damaged entry means the text is gone; the record then delivers nothing and is closed.
    return null;
  }
}

function writePending(
  db: DatabaseSync,
  conversationId: string,
  pending: PendingPack,
  now: number,
): void {
  runtimeStateSet(db, packKey(conversationId), JSON.stringify(pending), now);
}

function clearPending(db: DatabaseSync, conversationId: string): void {
  db.prepare('DELETE FROM runtime_state WHERE key = ?').run(packKey(conversationId));
}

type InjectionRecord = Record<string, SQLOutputValue>;

/**
 * The one record of the conversation that has not been delivered yet (rule 1). The oldest one wins,
 * because that is the record every later pack merges into.
 */
function liveRecord(
  db: DatabaseSync,
  conversationId: string,
  excludeId?: string,
): InjectionRecord | null {
  const row = db
    .prepare(
      `SELECT * FROM injections WHERE conversation_id = ? AND state IN ('pending', 'attempted')
         AND id <> ?
       ORDER BY created_at, id LIMIT 1`,
    )
    .get(conversationId, excludeId ?? '');
  return row === undefined ? null : (row as InjectionRecord);
}

/** The record a tool hook reports about: the live one, or the one that was just delivered. */
function reportedRecord(db: DatabaseSync, conversationId: string): InjectionRecord | null {
  const live = liveRecord(db, conversationId);
  if (live !== null) return live;
  const row = db
    .prepare(
      `SELECT * FROM injections WHERE conversation_id = ? AND state = 'emitted'
       ORDER BY emitted_at DESC, id DESC LIMIT 1`,
    )
    .get(conversationId);
  return row === undefined ? null : (row as InjectionRecord);
}

function saveAttempts(db: DatabaseSync, injectionId: string, attempts: WhyAttempt[]): void {
  db.prepare('UPDATE injections SET attempts_json = ? WHERE id = ?').run(
    JSON.stringify(attempts),
    injectionId,
  );
}

function omitItem(
  db: DatabaseSync,
  injectionId: string,
  item: { memoryId: string | null; rawEventId: string | null },
  reason: ItemReason,
): void {
  db.prepare(
    `UPDATE injection_items SET decision = 'omitted', reason = ?
     WHERE injection_id = ? AND decision = 'planned' AND memory_id IS ? AND raw_event_id IS ?`,
  ).run(reason, injectionId, item.memoryId, item.rawEventId);
}

function blockCost(lines: readonly string[]): number {
  return lines.join('\n').length + 1;
}

/**
 * Rule 1: the built pack becomes the conversation's pending record. An existing live record is not
 * replaced: its planned items stay, the new ones are added under the same budget, and the merged
 * record gets a new `pack_hash`. Returns the id of the record that now holds the pack.
 */
export function storePending(
  db: DatabaseSync,
  input: { conversationId: string; epoch: number; pack: BuiltPack; now: number },
): string {
  return transactionImmediate(db, () => {
    const planned = input.pack.items.filter((item) => item.decision === 'planned');
    const live = liveRecord(db, input.conversationId, input.pack.injectionId);

    if (live === null) {
      db.prepare(`UPDATE injections SET state = 'pending' WHERE id = ?`).run(
        input.pack.injectionId,
      );
      writePending(
        db,
        input.conversationId,
        {
          injectionId: input.pack.injectionId,
          repositoryLine: input.pack.repositoryLine,
          degraded: input.pack.degraded,
          blocks: planned.map((item) => ({
            memoryId: item.memoryId,
            rawEventId: item.rawEventId,
            lines: item.lines,
          })),
          text: input.pack.text,
        },
        input.now,
      );
      return input.pack.injectionId;
    }

    const liveId = String(live.id);
    const previous = readPending(db, input.conversationId) ?? {
      injectionId: liveId,
      repositoryLine: input.pack.repositoryLine,
      degraded: input.pack.degraded,
      blocks: [],
      text: '',
    };
    const degraded = previous.degraded ?? input.pack.degraded;
    const budget = Number(live.char_budget ?? input.pack.charBudget);

    const blocks = [...previous.blocks];
    const known = new Set(
      blocks.map((block) => block.memoryId).filter((id): id is string => id !== null),
    );
    let used = renderPack({
      repositoryLine: previous.repositoryLine,
      blocks: blocks.map((block) => block.lines),
      degraded,
    }).length;

    // The omissions are written on the new pack's own rows, so the live record's planned row for
    // the same memory keeps standing: it is the copy that is rendered and delivered (FR-026).
    for (const item of planned) {
      if (item.memoryId !== null && known.has(item.memoryId)) {
        omitItem(db, input.pack.injectionId, item, 'duplicate_in_conversation');
        continue;
      }
      const cost = blockCost(item.lines);
      if (used + cost > budget) {
        omitItem(db, input.pack.injectionId, item, 'budget');
        continue;
      }
      used += cost;
      blocks.push({ memoryId: item.memoryId, rawEventId: item.rawEventId, lines: item.lines });
      if (item.memoryId !== null) known.add(item.memoryId);
    }

    // The ledger keeps every row of the merged-away pack, so its omissions stay in `why`.
    db.prepare('UPDATE injection_items SET injection_id = ? WHERE injection_id = ?').run(
      liveId,
      input.pack.injectionId,
    );
    db.prepare('DELETE FROM injections WHERE id = ?').run(input.pack.injectionId);

    const text = renderPack({
      repositoryLine: previous.repositoryLine,
      blocks: blocks.map((block) => block.lines),
      degraded,
    });
    db.prepare(
      'UPDATE injections SET pack_hash = ?, chars_used = ?, degraded_reason = ? WHERE id = ?',
    ).run(createHash('sha256').update(text, 'utf8').digest('hex'), text.length, degraded, liveId);
    writePending(
      db,
      input.conversationId,
      { injectionId: liveId, repositoryLine: previous.repositoryLine, degraded, blocks, text },
      input.now,
    );
    return liveId;
  });
}

/**
 * Rule 2: while the record is not delivered, every `PreToolUse` carries the pack and records the
 * attempt. Returns the text to emit as `additionalContext`, or null when there is nothing pending.
 */
export function attachOnPreToolUse(
  db: DatabaseSync,
  input: { conversationId: string; toolCallId: string; now: number },
): string | null {
  return transactionImmediate(db, () => {
    const live = liveRecord(db, input.conversationId);
    if (live === null) return null;
    const pending = readPending(db, input.conversationId);
    if (pending === null) return null;

    const attempts = parseAttempts(live.attempts_json);
    if (!attempts.some((attempt) => attempt.tool_call_id === input.toolCallId)) {
      attempts.push({
        tool_call_id: input.toolCallId,
        execution: 'pending',
        delivery: 'pending',
        at: input.now,
      });
      saveAttempts(db, String(live.id), attempts);
    }
    db.prepare(
      `UPDATE injections SET state = 'attempted', attempted_at = COALESCE(attempted_at, ?)
       WHERE id = ?`,
    ).run(input.now, String(live.id));
    return pending.text;
  });
}

export type DeferredDelivery = {
  status: 'emitted' | 'already' | 'none';
  /** Set only when this hook has to print the pack itself (rule 3). */
  text: string | null;
};

/**
 * Rule 3: the call ran, so the pack reached the model. The first delivered attempt makes the record
 * `emitted` and its items `included`; a later attempt of the same parallel batch only raises
 * `delivery_count` (A15). A `PostToolUse` with no attempt of its own means oboete's `PreToolUse`
 * handler did not complete, so the pack is emitted from here instead.
 */
export function confirmOnPostToolUse(
  db: DatabaseSync,
  input: { conversationId: string; toolCallId: string; exitCode?: number; now: number },
): DeferredDelivery {
  // The R13 probe: a failed shell call arrives here with its exit code, and the context was
  // delivered all the same.
  const execution = (input.exitCode ?? 0) === 0 ? 'ran' : 'failed';
  return deliver(db, { ...input, execution });
}

/**
 * Rule 4: `PostToolUseFailure` is a delivered attempt of a call that failed; `PermissionDenied`
 * (which Grok fires only for a permission-rule deny) delivered nothing, so the record stays open
 * and the next `PreToolUse` attaches the pack again.
 */
export function markFailure(
  db: DatabaseSync,
  input: {
    conversationId: string;
    toolCallId: string;
    kind: 'PostToolUseFailure' | 'PermissionDenied';
    now: number;
  },
): 'emitted' | 'attempted' | 'none' {
  if (input.kind === 'PostToolUseFailure') {
    return deliver(db, { ...input, execution: 'failed' }).status === 'none' ? 'none' : 'emitted';
  }

  return transactionImmediate(db, () => {
    const live = liveRecord(db, input.conversationId);
    if (live === null) return 'none';
    const attempts = parseAttempts(live.attempts_json);
    const attempt = attempts.find((entry) => entry.tool_call_id === input.toolCallId);
    if (attempt === undefined) {
      attempts.push({
        tool_call_id: input.toolCallId,
        execution: 'denied',
        delivery: 'dropped',
        at: input.now,
      });
    } else {
      attempt.execution = 'denied';
      attempt.delivery = 'dropped';
    }
    saveAttempts(db, String(live.id), attempts);
    return 'attempted';
  });
}

function deliver(
  db: DatabaseSync,
  input: {
    conversationId: string;
    toolCallId: string;
    execution: 'ran' | 'failed';
    now: number;
  },
): DeferredDelivery {
  return transactionImmediate(db, () => {
    const record = reportedRecord(db, input.conversationId);
    if (record === null) return { status: 'none', text: null };

    const injectionId = String(record.id);
    const emitted = record.state === 'emitted';
    const attempts = parseAttempts(record.attempts_json);
    const attempt = attempts.find((entry) => entry.tool_call_id === input.toolCallId);
    let text: string | null = null;

    if (attempt !== undefined && attempt.delivery === 'delivered') {
      return { status: 'already', text: null };
    }
    if (attempt === undefined) {
      attempts.push({
        tool_call_id: input.toolCallId,
        execution: input.execution,
        delivery: 'delivered',
        at: input.now,
      });
      // Rule 3: the pack was never attached, so this hook prints it.
      if (!emitted) text = readPending(db, input.conversationId)?.text ?? null;
    } else {
      attempt.execution = input.execution;
      attempt.delivery = 'delivered';
    }

    saveAttempts(db, injectionId, attempts);
    db.prepare('UPDATE injections SET delivery_count = COALESCE(delivery_count, 0) + 1 WHERE id = ?').run(
      injectionId,
    );
    if (emitted) return { status: 'already', text: null };

    confirmDeliveryIn(db, injectionId, input.now);
    clearPending(db, input.conversationId);
    return { status: 'emitted', text };
  });
}

/**
 * Rule 5: at `Stop` a record that was never delivered is closed. Its items become `omitted` /
 * `not_delivered`, so the memories stay injectable in the next turn (FR-045, FR-026).
 */
export function closeOnStop(
  db: DatabaseSync,
  input: { conversationId: string; sawAnyToolHook: boolean; now: number },
): 'omitted' | 'none' {
  return transactionImmediate(db, () => {
    const live = liveRecord(db, input.conversationId);
    if (live === null) return 'none';

    const attempts = parseAttempts(live.attempts_json);
    for (const attempt of attempts) {
      if (attempt.delivery === 'pending') attempt.delivery = 'dropped';
    }
    saveAttempts(db, String(live.id), attempts);
    db.prepare(
      `UPDATE injection_items SET decision = 'omitted', reason = 'not_delivered'
       WHERE injection_id = ? AND decision = 'planned'`,
    ).run(String(live.id));
    // "All denied" is not distinguishable from a chain an earlier handler stopped, so it is not
    // claimed: with no tool hook at all the reason is no_tool_call, otherwise not_delivered.
    omitInjection(db, String(live.id), input.sawAnyToolHook ? 'not_delivered' : 'no_tool_call');
    clearPending(db, input.conversationId);
    return 'omitted';
  });
}

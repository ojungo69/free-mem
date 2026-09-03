import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { NormalizedEvent } from '../../src/events.js';
import { ensureDirectories, oboetePaths } from '../../src/paths.js';
import { listSpool, readSpoolEntry, removeSpoolEntry, spoolEvent } from '../../src/spool.js';
import { withTempHome } from '../helpers/home.js';

const CAPTURED_AT = 1_757_000_000_000;

function promptEvent(capturedAt: number, text: string): NormalizedEvent {
  return {
    agent: 'claude',
    native_session_id: 'session-1',
    cwd: '/repo',
    captured_at: capturedAt,
    kind: 'prompt',
    text,
    input_source: 'user',
  };
}

const COLUMNS = {
  repoId: 'a1b2c3d4e5f60718',
  sensitivity: 'local_only',
  classificationState: 'done',
  truncated: 0,
  contentHash: 'f'.repeat(64),
} as const;

test('spoolEvent renames into place and leaves no temporary file behind', async () => {
  await withTempHome(async (home) => {
    const paths = oboetePaths(home);
    ensureDirectories(paths);
    const event = promptEvent(CAPTURED_AT, 'the deployment notes');

    spoolEvent(paths, { ...event, id: 'event-1' }, COLUMNS);

    const names = readdirSync(paths.spool).filter((name) => name !== 'pi-ack');
    assert.deepEqual(names, [`${CAPTURED_AT}-event-1.json`]);
    const written = JSON.parse(readFileSync(join(paths.spool, names[0] as string), 'utf8')) as Record<
      string,
      unknown
    >;
    assert.equal(written.id, 'event-1');
    assert.equal(written.repo_id, COLUMNS.repoId);
    assert.equal(written.sensitivity, 'local_only');
    assert.equal(written.classification_state, 'done');
    assert.equal(written.truncated, 0);
    assert.equal(written.content_hash, COLUMNS.contentHash);
    assert.deepEqual(written.event, event);
  });
});

test('listSpool returns the entries in name order', async () => {
  await withTempHome(async (home) => {
    const paths = oboetePaths(home);
    ensureDirectories(paths);
    for (const [capturedAt, id] of [
      [CAPTURED_AT + 2, 'c'],
      [CAPTURED_AT, 'a'],
      [CAPTURED_AT + 1, 'b'],
    ] as const) {
      spoolEvent(paths, { ...promptEvent(capturedAt, id), id }, COLUMNS);
    }

    assert.deepEqual(listSpool(paths), [
      `${CAPTURED_AT}-a.json`,
      `${CAPTURED_AT + 1}-b.json`,
      `${CAPTURED_AT + 2}-c.json`,
    ]);
  });
});

test('readSpoolEntry and removeSpoolEntry round trip one entry', async () => {
  await withTempHome(async (home) => {
    const paths = oboetePaths(home);
    ensureDirectories(paths);
    const event = promptEvent(CAPTURED_AT, 'a note about the migration');
    spoolEvent(paths, { ...event, id: 'event-1' }, COLUMNS);
    const [name] = listSpool(paths);
    assert.ok(name !== undefined);

    const entry = readSpoolEntry(paths, name);
    assert.notEqual(entry, null);
    assert.equal(entry?.id, 'event-1');
    assert.deepEqual(entry?.event, event);
    assert.equal(entry?.repo_id, COLUMNS.repoId);

    removeSpoolEntry(paths, name);
    assert.deepEqual(listSpool(paths), []);
    // Recovery is idempotent, so removing an entry that is already gone is not an error (R6).
    removeSpoolEntry(paths, name);
  });
});

test('readSpoolEntry refuses an entry that does not match the schema', async () => {
  await withTempHome(async (home) => {
    const paths = oboetePaths(home);
    ensureDirectories(paths);
    writeFileSync(join(paths.spool, '1-broken.json'), '{"id":"1","event":{"kind":"nonsense"}}');

    assert.equal(readSpoolEntry(paths, '1-broken.json'), null);
    assert.equal(readSpoolEntry(paths, '1-missing.json'), null);
  });
});

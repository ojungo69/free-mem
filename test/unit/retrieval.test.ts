import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { openDatabase } from '../../src/db/open.js';
import { oboetePaths } from '../../src/paths.js';
import { cjkBigrams, isCjk, segmentQuery } from '../../src/retrieval/fts.js';
import { searchCandidates } from '../../src/retrieval/query.js';
import type { RankRow } from '../../src/retrieval/rank.js';
import {
  applyThreshold,
  charTrigramCosine,
  cutToBudget,
  mmrSelect,
  normalizeBm25,
  rankCandidates,
  rrfFuse,
} from '../../src/retrieval/rank.js';
import { withTempHome } from '../helpers/home.js';

const SCOPE_A = { where: 'm.repo_id = ? AND m.deleted_at IS NULL', params: ['repo_a'] };

function row(partial: Partial<RankRow> & Pick<RankRow, 'id'>): RankRow {
  return {
    title: partial.title ?? 't',
    body: partial.body ?? 'b',
    scoreTrigram: partial.scoreTrigram ?? null,
    scoreCjk: partial.scoreCjk ?? null,
    viaLike: partial.viaLike ?? false,
    pinned_at: partial.pinned_at ?? null,
    created_at: partial.created_at ?? 1,
    ...partial,
  };
}

function insertRepo(db: DatabaseSync, id: string, identity: string): void {
  db.prepare(
    `INSERT INTO repos (id, identity_kind, normalized_identity, created_at, last_seen_at)
     VALUES (?, 'common_dir', ?, 1, 1)`,
  ).run(id, identity);
}

function insertMemory(
  db: DatabaseSync,
  memory: { id: string; repoId: string; title: string; body: string; createdAt?: number },
): void {
  const cjk = cjkBigrams(`${memory.title} ${memory.body}`);
  db.prepare(
    `INSERT INTO memories (id, repo_id, type, title, body, cjk_bigrams, content_hash, sensitivity, created_at)
     VALUES (?, ?, 'discovery', ?, ?, ?, ?, 'local_only', ?)`,
  ).run(
    memory.id,
    memory.repoId,
    memory.title,
    memory.body,
    cjk,
    `hash_${memory.id}`,
    memory.createdAt ?? 1,
  );
}

function seedSearchDb(db: DatabaseSync): void {
  insertRepo(db, 'repo_a', '/tmp/oboete-a');
  insertRepo(db, 'repo_b', '/tmp/oboete-b');
  insertMemory(db, {
    id: 'm_en_1',
    repoId: 'repo_a',
    title: 'SQLite busy timeout',
    body: 'The busy timeout is 5000 ms.',
    createdAt: 10,
  });
  insertMemory(db, {
    id: 'm_en_2',
    repoId: 'repo_a',
    title: 'SQLite busy timeout handling',
    body: 'The busy timeout is 5000 ms.',
    createdAt: 11,
  });
  insertMemory(db, {
    id: 'm_en_3',
    repoId: 'repo_a',
    title: 'Open WAL journal',
    body: 'Write-ahead logging is ok for readers.',
    createdAt: 12,
  });
  insertMemory(db, {
    id: 'm_ja_1',
    repoId: 'repo_a',
    title: 'データベース接続',
    body: '接続プールを実装する。',
    createdAt: 20,
  });
  insertMemory(db, {
    id: 'm_ja_2',
    repoId: 'repo_a',
    title: '文字コード',
    body: 'UTF-8 で保存する実装。',
    createdAt: 21,
  });
  insertMemory(db, {
    id: 'm_ja_3',
    repoId: 'repo_a',
    title: 'トリガー',
    body: '挿入時に索引を更新する実装。',
    createdAt: 22,
  });
  insertMemory(db, {
    id: 'm_b_1',
    repoId: 'repo_b',
    title: 'SQLite busy timeout',
    body: 'Should not appear in repo A search.',
    createdAt: 30,
  });
}

test('cjkBigrams indexes CJK runs and ignores latin words', () => {
  const terms = cjkBigrams('SQLite の busy timeout');
  assert.equal(terms.includes('busy'), false);
  assert.equal(terms, 'の');
});

test('cjkBigrams emits overlapping bigrams for a Japanese compound', () => {
  assert.equal(cjkBigrams('データベース接続'), 'デー ータ タベ ベー ース ス接 接続');
});

test('cjkBigrams treats prolonged sound, iteration and middle-dot as CJK', () => {
  assert.equal(isCjk('ー'), true);
  assert.equal(isCjk('々'), true);
  assert.equal(isCjk('・'), true);
  assert.equal(cjkBigrams('ー々・'), 'ー々 々・');
});

test('segmentQuery sends latin words of three or more characters to trigram', () => {
  assert.deepEqual(segmentQuery('sqlite busy timeout'), {
    trigram: ['sqlite', 'busy', 'timeout'],
    cjk: [],
    like: [],
  });
});

test('segmentQuery keeps sqlite as trigram, bigrams the remaining Japanese, and drops の', () => {
  assert.deepEqual(segmentQuery('SQLiteのビジータイムアウト'), {
    trigram: ['sqlite'],
    cjk: ['ビジ', 'ジー', 'タイ', 'イム', 'アウ', 'ウト'],
    like: [],
  });
});

test('segmentQuery sends a two-letter word to LIKE only', () => {
  assert.deepEqual(segmentQuery('ok'), { trigram: [], cjk: [], like: ['ok'] });
});

test('segmentQuery counts non-CJK length in code points', () => {
  assert.deepEqual(segmentQuery('𐍈𐍈'), { trigram: [], cjk: [], like: ['𐍈𐍈'] });
});

test('segmentQuery drops particles and leaves every list empty', () => {
  assert.deepEqual(segmentQuery('は が を に で と の も へ や か ね よ な'), {
    trigram: [],
    cjk: [],
    like: [],
  });
});

test('searchCandidates finds English rows of repo A only', async () => {
  await withTempHome((home) => {
    const opened = openDatabase({ path: oboetePaths(home).db, timeoutMs: 1000 });
    try {
      seedSearchDb(opened.db);
      const result = searchCandidates(opened.db, {
        text: 'sqlite busy timeout',
        scope: SCOPE_A,
      });
      const ids = result.rows.map((item) => item.id).sort();
      assert.equal(result.usedLike, false);
      assert.deepEqual(result.terms.trigram, ['sqlite', 'busy', 'timeout']);
      assert.ok(ids.includes('m_en_1'));
      assert.ok(ids.includes('m_en_2'));
      assert.equal(ids.includes('m_en_3'), false);
      assert.equal(ids.includes('m_b_1'), false);
      assert.equal(ids.some((id) => id.startsWith('m_ja_')), false);
    } finally {
      opened.db.close();
    }
  });
});

test('searchCandidates finds Japanese rows for a Japanese query', async () => {
  await withTempHome((home) => {
    const opened = openDatabase({ path: oboetePaths(home).db, timeoutMs: 1000 });
    try {
      seedSearchDb(opened.db);
      const result = searchCandidates(opened.db, { text: '実装', scope: SCOPE_A });
      const ids = result.rows.map((item) => item.id).sort();
      assert.equal(result.usedLike, false);
      assert.deepEqual(ids, ['m_ja_1', 'm_ja_2', 'm_ja_3']);
      assert.ok(result.rows.every((item) => item.scoreCjk !== null && item.viaLike === false));
    } finally {
      opened.db.close();
    }
  });
});

test('searchCandidates uses LIKE for a two-letter query', async () => {
  await withTempHome((home) => {
    const opened = openDatabase({ path: oboetePaths(home).db, timeoutMs: 1000 });
    try {
      seedSearchDb(opened.db);
      const result = searchCandidates(opened.db, { text: 'ok', scope: SCOPE_A });
      assert.equal(result.usedLike, true);
      assert.deepEqual(result.rows.map((item) => item.id), ['m_en_3']);
      assert.equal(result.rows[0]?.viaLike, true);
      assert.equal(result.rows[0]?.scoreTrigram, null);
      assert.equal(result.rows[0]?.scoreCjk, null);
    } finally {
      opened.db.close();
    }
  });
});

test('searchCandidates returns nothing for a particle-only query', async () => {
  await withTempHome((home) => {
    const opened = openDatabase({ path: oboetePaths(home).db, timeoutMs: 1000 });
    try {
      seedSearchDb(opened.db);
      const result = searchCandidates(opened.db, { text: 'は が を', scope: SCOPE_A });
      assert.equal(result.usedLike, false);
      assert.deepEqual(result.rows, []);
      assert.deepEqual(result.terms, { trigram: [], cjk: [], like: [] });
    } finally {
      opened.db.close();
    }
  });
});

test('searchCandidates does not throw on a quote character and a percent sign', async () => {
  await withTempHome((home) => {
    const opened = openDatabase({ path: oboetePaths(home).db, timeoutMs: 1000 });
    try {
      seedSearchDb(opened.db);
      assert.doesNotThrow(() =>
        searchCandidates(opened.db, { text: 'busy "timeout" 10%', scope: SCOPE_A }),
      );
    } finally {
      opened.db.close();
    }
  });
});

test('normalizeBm25 gives 1.0 to the best score', () => {
  const out = normalizeBm25(
    [
      row({ id: 'best', scoreTrigram: -10 }),
      row({ id: 'mid', scoreTrigram: -5 }),
      row({ id: 'weak', scoreTrigram: -2 }),
    ],
    'scoreTrigram',
  );
  assert.equal(out.find((item) => item.id === 'best')?.normTrigram, 1);
  assert.equal(out.find((item) => item.id === 'mid')?.normTrigram, 0.5);
  assert.equal(out.find((item) => item.id === 'weak')?.normTrigram, 0.2);
});

test('applyThreshold drops a row below 0.3 and keeps LIKE-only last', () => {
  const normalized = normalizeBm25(
    [
      row({ id: 'best', scoreTrigram: -10 }),
      row({ id: 'weak', scoreTrigram: -2 }),
      row({ id: 'like', viaLike: true, title: 'ok', body: 'ok' }),
    ],
    'scoreTrigram',
  );
  const { kept, dropped } = applyThreshold(normalized, 0.3);
  assert.deepEqual(
    dropped.map((item) => item.id),
    ['weak'],
  );
  assert.deepEqual(
    kept.map((item) => item.id),
    ['best', 'like'],
  );
});

test('rrfFuse ranks a row present in both tables above a row in one', () => {
  const fused = rrfFuse([
    row({
      id: 'both',
      scoreTrigram: -10,
      scoreCjk: -8,
      normTrigram: 1,
      normCjk: 1,
    }),
    row({
      id: 'one',
      scoreTrigram: -9,
      scoreCjk: null,
      normTrigram: 0.9,
      normCjk: 0,
    }),
    row({ id: 'like', viaLike: true, title: 'ok', body: 'ok' }),
  ]);
  const both = fused.find((item) => item.id === 'both')?.score_rrf ?? 0;
  const one = fused.find((item) => item.id === 'one')?.score_rrf ?? 0;
  assert.ok(both > one);
  assert.equal(both, 1 / 61 + 1 / 61);
  assert.equal(one, 1 / 62);
  assert.equal(fused.find((item) => item.id === 'like')?.score_rrf, 0);
});

test('mmrSelect rejects a near-duplicate with reason mmr_redundant', () => {
  const original = row({
    id: 'orig',
    title: 'sqlite busy timeout',
    body: 'the busy timeout is five seconds',
    score_rrf: 0.03,
    scoreTrigram: -10,
  });
  const duplicate = row({
    id: 'dup',
    title: 'sqlite busy timeout',
    body: 'the busy timeout is five seconds',
    score_rrf: 0.029,
    scoreTrigram: -9,
  });
  const other = row({
    id: 'other',
    title: 'wal mode readers',
    body: 'writers append to the log',
    score_rrf: 0.02,
    scoreTrigram: -4,
  });
  assert.ok(charTrigramCosine(`${original.title} ${original.body}`, `${duplicate.title} ${duplicate.body}`) > 0.99);
  const { selected, rejected } = mmrSelect([original, duplicate, other], { lambda: 0.5, limit: 3 });
  assert.deepEqual(
    selected.map((item) => item.id),
    ['orig', 'other'],
  );
  assert.deepEqual(
    rejected.map((item) => ({ id: item.row.id, reason: item.reason })),
    [{ id: 'dup', reason: 'mmr_redundant' }],
  );
});

test('mmrSelect keeps multiple LIKE-only rows up to the limit', () => {
  const first = row({
    id: 'like_a',
    title: 'ok one',
    body: 'alpha',
    viaLike: true,
    score_rrf: 0,
  });
  const second = row({
    id: 'like_b',
    title: 'ok two',
    body: 'omega',
    viaLike: true,
    score_rrf: 0,
  });
  const { selected, rejected } = mmrSelect([first, second], { lambda: 0.5, limit: 2 });
  assert.deepEqual(
    selected.map((item) => item.id).sort(),
    ['like_a', 'like_b'],
  );
  assert.deepEqual(rejected, []);
});

test('cutToBudget omits overflow rows with reason budget', () => {
  const first = row({ id: 'first', title: 'aa', body: 'bb' });
  const second = row({ id: 'second', title: 'cccc', body: 'dddd' });
  const { included, omitted } = cutToBudget([first, second], 8);
  assert.deepEqual(
    included.map((item) => item.id),
    ['first'],
  );
  assert.deepEqual(
    omitted.map((item) => ({ id: item.row.id, reason: item.reason })),
    [{ id: 'second', reason: 'budget' }],
  );
});

test('rankCandidates returns bm25, rrf and mmr scores on included rows', () => {
  const result = rankCandidates(
    [
      row({ id: 'both', title: 'alpha one', body: 'unique alpha body', scoreTrigram: -10, scoreCjk: -8 }),
      row({ id: 'weak', title: 'zzzz', body: 'no overlap here', scoreTrigram: -1, scoreCjk: null }),
      row({
        id: 'dup',
        title: 'alpha one',
        body: 'unique alpha body',
        scoreTrigram: -9,
        scoreCjk: -7,
      }),
    ],
    { threshold: 0.3, lambda: 0.5, budgetChars: 10_000, limit: 10 },
  );
  assert.ok(result.included.length >= 1);
  for (const item of result.included) {
    assert.equal(typeof item.score_bm25, 'number');
    assert.equal(typeof item.score_rrf, 'number');
    assert.equal(typeof item.score_mmr, 'number');
  }
  assert.ok(result.included.every((item) => item.id !== 'weak'));
  assert.ok(result.omitted.some((item) => item.id === 'weak' && item.reason === 'below_threshold'));
  assert.ok(result.omitted.some((item) => item.id === 'dup' && item.reason === 'mmr_redundant'));
});

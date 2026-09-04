import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';

import type { SecretLintCoreConfig } from '@secretlint/types';

import {
  MAX_REPO_SECRET_PATHS,
  MAX_REPO_SECRET_PATH_LENGTH,
  RepoConfigError,
  loadRepoRules,
} from '../../src/config.js';
import { openDatabase } from '../../src/db/open.js';
import { promoteSensitivity, strictest } from '../../src/privacy/classify.js';
import {
  detectInWorker,
  detectSync,
  compileGlob,
  matchSecretPath,
  redactSecrets,
  stripPrivate,
} from '../../src/privacy/detect.js';
import type { DetectorInput, DetectorResult } from '../../src/privacy/detect.js';
import { filterEgress, isAllowed, loadDestinationRules } from '../../src/privacy/egress.js';
import type { Destination, Sensitivity } from '../../src/privacy/egress.js';
import { withTempHome } from '../helpers/home.js';

type CorpusLine = { id: string; kind: string; text: string; secret: string | null };

// The corpus is the SC-005 fixture: it is data, so the test reads it instead of restating it.
const corpus: CorpusLine[] = readFileSync(resolve(process.cwd(), 'test/corpus/secrets.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as CorpusLine);

const SENSITIVITIES: Sensitivity[] = ['eligible', 'local_only', 'private', 'secret'];
const DESTINATIONS: Destination[] = ['remote_observer', 'local_observer', 'injection', 'sync'];

// data-model.md "destination_rules (seeded)", written out here so the test fails when the seed changes.
const EXPECTED_EGRESS: { destination: Destination; sameRepo: Sensitivity[]; otherRepo: Sensitivity[] }[] = [
  { destination: 'remote_observer', sameRepo: ['eligible'], otherRepo: ['eligible'] },
  { destination: 'local_observer', sameRepo: ['eligible', 'local_only', 'private'], otherRepo: [] },
  { destination: 'injection', sameRepo: ['eligible', 'local_only', 'private'], otherRepo: [] },
  {
    destination: 'sync',
    sameRepo: ['eligible', 'local_only', 'private'],
    otherRepo: ['eligible', 'local_only', 'private'],
  },
];

const CLEAN_TEXT = [
  'export function loadUser(id: string) {',
  '  return fetch(`https://api.example.com/v1/users/${id}`).then((response) => response.json());',
  '}',
  'The regression appeared in commit 9c1f4b7e2a8d3f60b5c7e9a1d2f4b6c8e0a3d5f7 and the run identifier',
  'was 3f2504e0-4f89-11d3-9a0c-0305e82c3301 on the second attempt.',
  '{"status":"ok","items":[1,2,3],"note":"nothing confidential in this payload"}',
].join('\n');

function detectorInput(text: string): DetectorInput {
  return { text, paths: [], repoRoot: null, secretPaths: [] };
}

/** Secret-shaped literals live in the corpus, never in this file, so the secret scanners stay useful. */
function corpusLine(id: string): CorpusLine {
  const line = corpus.find((entry) => entry.id === id);
  if (line === undefined) assert.fail(`the corpus is missing the line ${id}`);
  return line;
}

/**
 * A run of eight secret characters is already enough to be worth stealing, so a partial redaction
 * counts as a leak: checking only the whole secret would pass while most of it survived.
 */
function assertNoSecretRun(text: string, secret: string, message: string): void {
  for (let start = 0; start + 8 <= secret.length; start += 1) {
    const run = secret.slice(start, start + 8);
    assert.ok(!text.includes(run), `${message} survived redaction at offset ${start}: ${text}`);
  }
}

function assertDetected(result: DetectorResult, message: string): Extract<DetectorResult, { ok: true }> {
  if (!result.ok) assert.fail(`${message}: the detector failed with reason ${result.reason}`);
  return result;
}

test('fail-closed: every secret of the corpus is redacted and classified secret', async () => {
  assert.ok(corpus.length >= 30, 'the corpus is the SC-005 fixture and stays at 30 lines or more');
  for (const line of corpus) {
    if (line.secret === null) continue;
    const detected = assertDetected(await detectSync(detectorInput(line.text)), line.id);
    assert.equal(detected.sensitivity, 'secret', `${line.id} (${line.kind}) must be classified secret`);
    assert.ok(detected.redactions.length > 0, `${line.id} (${line.kind}) must record a redaction`);
    assert.ok(
      !detected.text.includes(line.secret),
      `${line.id} (${line.kind}) survived redaction: ${detected.text}`,
    );
    assertNoSecretRun(detected.text, line.secret, `${line.id} (${line.kind})`);
  }
});

test('fail-open: the corpus negatives stay local_only and byte-identical', async () => {
  const negatives = corpus.filter((line) => line.secret === null);
  assert.ok(negatives.length >= 5, 'the corpus keeps at least five negative lines');
  for (const line of negatives) {
    const detected = assertDetected(await detectSync(detectorInput(line.text)), line.id);
    assert.equal(detected.sensitivity, 'local_only', `${line.id} (${line.kind}) must stay local_only`);
    assert.equal(detected.text, line.text, `${line.id} (${line.kind}) must not be rewritten`);
    assert.deepEqual(detected.redactions, []);
  }
});

test('fail-open: clean content comes back byte-identical with no redaction', async () => {
  const detected = assertDetected(await detectSync(detectorInput(CLEAN_TEXT)), 'clean text');
  assert.equal(detected.text, CLEAN_TEXT);
  assert.equal(detected.sensitivity, 'local_only');
  assert.deepEqual(detected.redactions, []);
  assert.equal(detected.privateRemoved, 0);
  assert.equal(detected.pathRule, null);
});

test('fail-closed: stripPrivate removes every private span, including an unclosed tag', () => {
  assert.deepEqual(stripPrivate('<private>a</private>b'), { text: 'b', removed: 1 });
  assert.deepEqual(stripPrivate('before <PRIVATE >x</ Private >after'), {
    text: 'before after',
    removed: 1,
  });
  // FR-019: an unclosed tag removes everything after it, so nothing unreviewed is kept.
  assert.deepEqual(stripPrivate('keep this <private>drop the rest'), {
    text: 'keep this ',
    removed: 1,
  });
  // Nested tags are one span from the first open tag to its matching close tag.
  assert.deepEqual(stripPrivate('<private>a<private>b</private>c</private>d'), { text: 'd', removed: 1 });
  assert.deepEqual(stripPrivate('one <private>x</private> two <private>y</private> three'), {
    text: 'one  two  three',
    removed: 2,
  });
  assert.deepEqual(stripPrivate('no tag here'), { text: 'no tag here', removed: 0 });
});

test('fail-closed: a private span never reaches the detector result', async () => {
  const wrapped = corpusLine('github-classic-pat').secret;
  const detected = assertDetected(
    await detectSync(detectorInput(`public note <private>${wrapped}</private> end`)),
    'private span',
  );
  assert.equal(detected.text, 'public note  end');
  assert.equal(detected.privateRemoved, 1);
  assert.equal(detected.sensitivity, 'local_only');
});

test('compileGlob follows gitignore semantics and keeps a single star inside one path segment', () => {
  // A rule without a slash matches the file name at any depth, which is how the same rule is
  // written in .gitignore and how an agent sends the path (FR-039, R4).
  assert.equal(compileGlob('*.pem').test('server.pem'), true);
  assert.equal(compileGlob('*.pem').test('config/server.pem'), true);
  assert.equal(compileGlob('*.pem').test('a/x.pem'), true);
  assert.equal(compileGlob('*.pem').test('x.pem.bak'), false);
  assert.equal(compileGlob('**/.env').test('.env'), true);
  assert.equal(compileGlob('**/.env').test('app/.env'), true);
  assert.equal(compileGlob('**/*.pem').test('x.pem'), true);
  assert.equal(compileGlob('deploy/**/key.pem').test('deploy/key.pem'), true);
  assert.equal(compileGlob('deploy/**/key.pem').test('deploy/eu/west/key.pem'), true);
  assert.equal(compileGlob('secrets/**').test('secrets/k.txt'), true);
  assert.equal(compileGlob('secrets/**').test('secrets/aws/key.json'), true);
  assert.equal(compileGlob('secrets/**').test('other/secrets/key.json'), false);
  assert.equal(compileGlob('.env*').test('.env.local'), true);
  assert.equal(compileGlob('.env*').test('app.env'), false);
  assert.equal(compileGlob('key?.pem').test('key1.pem'), true);
  assert.equal(compileGlob('key?.pem').test('key10.pem'), false);
  assert.equal(compileGlob('key[0-9].pem').test('key7.pem'), true);
  assert.equal(compileGlob('key[0-9].pem').test('keyx.pem'), false);
  // Regular expression metacharacters in a glob are literal text.
  assert.equal(compileGlob('note(1)+.txt').test('note(1)+.txt'), true);
  assert.equal(compileGlob('note(1)+.txt').test('note(1).txt'), false);
});

test('fail-closed: a path rule matches the repository-relative and the raw form', () => {
  const rules = ['secrets/**', '*.pem', '.env*'];
  const root = '/home/dev/repo';
  assert.equal(matchSecretPath('/home/dev/repo/secrets/aws.json', rules, root), 'secrets/**');
  assert.equal(matchSecretPath('/home/dev/repo/server.pem', rules, root), '*.pem');
  assert.equal(matchSecretPath('/home/dev/repo/.env.local', rules, root), '.env*');
  assert.equal(matchSecretPath('/home/dev/repo/src/app.ts', rules, root), null);
  // A relative path is what the agents actually send, and it is the form a rule is written in.
  assert.equal(matchSecretPath('.env', ['**/.env'], root), '**/.env');
  assert.equal(matchSecretPath('a/x.pem', ['*.pem'], root), '*.pem');
  assert.equal(matchSecretPath('secrets/k.txt', ['secrets/**'], root), 'secrets/**');
  assert.equal(matchSecretPath('other/secrets/k.txt', ['secrets/**'], root), null);
  assert.equal(matchSecretPath('README.md', ['*.pem', '**/.env'], root), null);
  // Without a repository root only the raw form is tested.
  assert.equal(matchSecretPath('/etc/ssl/server.pem', ['/etc/**'], null), '/etc/**');
  assert.equal(matchSecretPath('/etc/ssl/server.pem', ['*.pem'], null), '*.pem');
  assert.equal(matchSecretPath('server.pem', [], root), null);
});

test('a full repository rule list keeps one path match bounded', () => {
  // R4: `.oboete.toml` is repository-supplied, so its rules may be written to be expensive. The
  // list is bounded by loadRepoRules and the matcher sweeps the path once per token, so the work
  // stays linear instead of backtracking over every way to split the path.
  // The shape is the declared bound, so raising either constant is measured here rather than
  // silently spending more of the capture deadline (CAPTURE_DEADLINE_MS is 300 ms).
  const stars = MAX_REPO_SECRET_PATH_LENGTH - 1;
  const rules = Array.from({ length: MAX_REPO_SECRET_PATHS }, (_, index) =>
    index % 2 === 0 ? `${'*'.repeat(stars)}x` : `${'a*'.repeat(Math.floor(stars / 2))}x`,
  );
  // A path with no slash is the expensive shape: every `*` can reach every position of it. 1 KiB
  // keeps the sweep (rules x rule length x path length) short enough for coverage-instrumented CI.
  const path = `${'a'.repeat(1_023)}b`;
  const started = process.hrtime.bigint();
  assert.equal(matchSecretPath(path, rules, null), null);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  // What is measured is linear against exponential: the same rules compiled into one backtracking
  // expression do not finish at all. Measured at about 70 ms here and about twenty times slower
  // under coverage instrumentation, so the bound only has to fail a return to backtracking.
  assert.ok(
    elapsedMs < 10_000,
    `matching ${MAX_REPO_SECRET_PATHS} rules against a 1 KiB path took ${elapsedMs.toFixed(0)} ms`,
  );
});

test('fail-closed: a path rule hit keeps metadata only, even for harmless text', async () => {
  const detected = assertDetected(
    await detectSync({
      text: 'the deployment notes mention nothing confidential',
      paths: ['/home/dev/repo/secrets/aws.json'],
      repoRoot: '/home/dev/repo',
      secretPaths: ['secrets/**'],
    }),
    'path rule',
  );
  assert.equal(detected.sensitivity, 'secret');
  assert.equal(detected.pathRule, 'secrets/**');
  // R4 and data-model raw_events.content: a path-rule hit stores no content at all.
  assert.equal(detected.text, '');
});

test('fail-closed: a detector failure returns detector_error and carries no text', async () => {
  const throwingRules = {
    rules: [
      {
        id: 'oboete-detector-failure',
        rule: {
          meta: {
            id: 'oboete-detector-failure',
            recommended: false,
            type: 'scanner',
            supportedContentTypes: ['text'],
          },
          messages: {},
          create: () => ({
            file: () => {
              throw new Error('the detector failed on purpose');
            },
          }),
        },
      },
    ],
  } as unknown as SecretLintCoreConfig;

  const line = corpusLine('github-classic-pat');
  const result = await detectSync(detectorInput(line.text), { rules: throwingRules });
  assert.deepEqual(result, { ok: false, reason: 'detector_error' });
  assert.ok(!JSON.stringify(result).includes(line.secret ?? ''));
});

test('fail-closed: a malformed .oboete.toml yields no rule set, so capture cannot classify', async () => {
  await withTempHome((home) => {
    writeFileSync(join(home, '.oboete.toml'), '[privacy\nsecret_paths = ["secrets/**"]\n');
    assert.throws(() => loadRepoRules(home), RepoConfigError);
  });
  await withTempHome((home) => {
    writeFileSync(join(home, '.oboete.toml'), '[observer]\npreset = "workers-ai"\n');
    assert.throws(() => loadRepoRules(home), RepoConfigError);
  });
});

test('fail-closed: redaction is idempotent', async () => {
  for (const line of corpus) {
    const once = await redactSecrets(line.text);
    const twice = await redactSecrets(once.text);
    assert.equal(twice.text, once.text, `${line.id} changed on the second pass`);
    if (line.secret !== null) assert.deepEqual(twice.hits, [], `${line.id} reported a hit on redacted text`);
  }
});

test('fail-closed: a detector that never answers is cut off at the deadline', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'oboete-detector-'));
  try {
    const script = join(directory, 'never-answers.mjs');
    writeFileSync(
      script,
      [
        "import { workerData } from 'node:worker_threads';",
        'setInterval(() => {',
        '  Atomics.add(workerData.input.beat, 0, 1);',
        '}, 5);',
        '',
      ].join('\n'),
    );

    const beat = new Int32Array(new SharedArrayBuffer(4));
    const input = { ...detectorInput(''), beat } as unknown as DetectorInput;
    const started = Date.now();
    const result = await detectInWorker(input, { cutoffMs: 50, workerScript: script });
    const elapsed = Date.now() - started;

    assert.deepEqual(result, { ok: false, reason: 'deadline' });
    assert.ok(elapsed < 200, `the call returned after ${elapsed} ms`);

    // The Worker is terminated, so nothing in it keeps running once the deadline has passed. How
    // many times it ticked before that is machine-dependent and only reported.
    await new Promise((done) => setTimeout(done, 60));
    const afterTermination = Atomics.load(beat, 0);
    await new Promise((done) => setTimeout(done, 120));
    assert.equal(Atomics.load(beat, 0), afterTermination, 'the worker kept running after the cutoff');
    t.diagnostic(`the worker ticked ${afterTermination} times before it was terminated`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fail-open: the engine bundle worker returns what detectSync returns', async () => {
  const bundle = resolve(process.cwd(), 'dist/oboete.mjs');
  for (const text of [corpusLine('github-classic-pat').text, CLEAN_TEXT]) {
    const inWorker = await detectInWorker(detectorInput(text), { cutoffMs: 5_000, workerScript: bundle });
    assert.deepEqual(inWorker, await detectSync(detectorInput(text)));
  }
});

test('fail-closed: the engine bundle stays silent in a worker it does not recognize', async () => {
  // FR-021: the hook writes nothing but the pack to stdout, so a worker carrying a role this build
  // does not know must not fall through to the CLI dispatch.
  const worker = new Worker(resolve(process.cwd(), 'dist/oboete.mjs'), {
    workerData: { role: 'a role from a newer build' },
    stdout: true,
  });
  const chunks: Buffer[] = [];
  worker.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  const code = await new Promise<number>((resolveExit, rejectExit) => {
    worker.on('exit', resolveExit);
    worker.on('error', rejectExit);
  });
  assert.equal(code, 0);
  assert.equal(Buffer.concat(chunks).toString('utf8'), '');
});

test('egress: the seeded destination_rules table decides every combination', async () => {
  await withTempHome(async (home) => {
    const opened = openDatabase({ path: join(home, 'memory.db'), timeoutMs: 2_000 });
    try {
      const rules = loadDestinationRules(opened.db);
      for (const expected of EXPECTED_EGRESS) {
        for (const sensitivity of SENSITIVITIES) {
          assert.equal(
            isAllowed(rules, expected.destination, sensitivity, true),
            expected.sameRepo.includes(sensitivity),
            `${expected.destination} / ${sensitivity} / same repository`,
          );
          assert.equal(
            isAllowed(rules, expected.destination, sensitivity, false),
            expected.otherRepo.includes(sensitivity),
            `${expected.destination} / ${sensitivity} / other repository`,
          );
        }
      }
      // FR-020: a secret row is refused at every destination.
      for (const destination of DESTINATIONS) {
        assert.equal(isAllowed(rules, destination, 'secret', true), false);
        assert.equal(isAllowed(rules, destination, 'secret', false), false);
      }
    } finally {
      opened.db.close();
    }
  });
});

test('fail-closed: secret stays refused even when the table says it is allowed', async () => {
  await withTempHome(async (home) => {
    const opened = openDatabase({ path: join(home, 'memory.db'), timeoutMs: 2_000 });
    try {
      opened.db.exec("UPDATE destination_rules SET allowed = 1 WHERE sensitivity = 'secret'");
      const tampered = loadDestinationRules(opened.db);
      for (const destination of DESTINATIONS) {
        assert.equal(isAllowed(tampered, destination, 'secret', true), false, destination);
      }
      const { allowed, blocked } = filterEgress(
        tampered,
        'local_observer',
        [{ sensitivity: 'secret', repoId: 'repo-a' }],
        'repo-a',
      );
      assert.deepEqual(allowed, []);
      assert.equal(blocked.length, 1);
      assert.equal(blocked[0]?.reason, 'sensitivity');
    } finally {
      opened.db.close();
    }
  });
});

test('egress: filterEgress reports the blocked rows with their reason', async () => {
  await withTempHome(async (home) => {
    const opened = openDatabase({ path: join(home, 'memory.db'), timeoutMs: 2_000 });
    try {
      const rules = loadDestinationRules(opened.db);
      const rows = [
        { sensitivity: 'eligible' as Sensitivity, repoId: 'repo-a' },
        { sensitivity: 'local_only' as Sensitivity, repoId: 'repo-a' },
        { sensitivity: 'secret' as Sensitivity, repoId: 'repo-a' },
        { sensitivity: 'eligible' as Sensitivity, repoId: 'repo-b' },
      ];

      const injection = filterEgress(rules, 'injection', rows, 'repo-a');
      assert.deepEqual(injection.allowed, [rows[0], rows[1]]);
      assert.deepEqual(injection.blocked, [
        { row: rows[2], reason: 'sensitivity' },
        { row: rows[3], reason: 'repository' },
      ]);

      const remote = filterEgress(rules, 'remote_observer', rows, 'repo-a');
      // FR-020: the remote observer receives eligible rows from any repository and nothing else.
      assert.deepEqual(remote.allowed, [rows[0], rows[3]]);
      assert.deepEqual(remote.blocked, [
        { row: rows[1], reason: 'sensitivity' },
        { row: rows[2], reason: 'sensitivity' },
      ]);
    } finally {
      opened.db.close();
    }
  });
});

test('promotion: the worker promotes only a clean, complete, local-only row', () => {
  const clean: DetectorResult = {
    ok: true,
    text: 'note',
    texts: [],
    redactions: [],
    privateRemoved: 0,
    sensitivity: 'local_only',
    pathRule: null,
  };
  const hit: DetectorResult = {
    ...clean,
    redactions: [{ rule: 'github', count: 1 }],
    sensitivity: 'secret',
  };
  const failed: DetectorResult = { ok: false, reason: 'detector_error' };
  const cutOff: DetectorResult = { ok: false, reason: 'deadline' };

  const table: { current: Sensitivity; detector: DetectorResult; state: 'done' | 'partial' | 'failed'; expected: Sensitivity }[] = [
    { current: 'local_only', detector: clean, state: 'done', expected: 'eligible' },
    { current: 'local_only', detector: hit, state: 'done', expected: 'secret' },
    { current: 'local_only', detector: failed, state: 'done', expected: 'local_only' },
    { current: 'local_only', detector: cutOff, state: 'done', expected: 'local_only' },
    { current: 'local_only', detector: clean, state: 'partial', expected: 'local_only' },
    { current: 'local_only', detector: clean, state: 'failed', expected: 'local_only' },
    { current: 'local_only', detector: hit, state: 'partial', expected: 'local_only' },
    { current: 'eligible', detector: clean, state: 'done', expected: 'eligible' },
    { current: 'eligible', detector: hit, state: 'done', expected: 'secret' },
    { current: 'private', detector: clean, state: 'done', expected: 'private' },
    { current: 'private', detector: hit, state: 'done', expected: 'private' },
    { current: 'secret', detector: clean, state: 'done', expected: 'secret' },
    { current: 'secret', detector: hit, state: 'done', expected: 'secret' },
  ];

  for (const row of table) {
    assert.equal(
      promoteSensitivity(row.current, row.detector, row.state),
      row.expected,
      `${row.current} / ${row.state} / ${row.detector.ok ? row.detector.sensitivity : row.detector.reason}`,
    );
  }
});

test('strictest keeps the stricter class of the lattice', () => {
  assert.equal(strictest('eligible', 'local_only'), 'local_only');
  assert.equal(strictest('local_only', 'private'), 'private');
  assert.equal(strictest('private', 'secret'), 'secret');
  assert.equal(strictest('eligible'), 'eligible');
  assert.equal(strictest('eligible', 'eligible', 'eligible'), 'eligible');
  assert.equal(strictest('secret', 'eligible', 'private'), 'secret');
});

// SC-006: the producing agent is provenance only. `filterEgress` takes rows without an agent field,
// so a compile error here is the assertion that no egress decision can read one.
export type EgressRowKeys = keyof Parameters<typeof filterEgress>[2][number];
export type NoAgentInEgressRow = [EgressRowKeys] extends ['sensitivity' | 'repoId'] ? true : false;
const noAgentInEgressRow: NoAgentInEgressRow = true;

test('SC-006: changing only the producing agent changes no decision', async () => {
  assert.equal(noAgentInEgressRow, true);
  const line = corpusLine('generic-hex-entropy');

  const forClaude = { ...detectorInput(line.text), agent: 'claude' } as unknown as DetectorInput;
  const forGrok = { ...detectorInput(line.text), agent: 'grok' } as unknown as DetectorInput;

  const claudeDetected = await detectSync(forClaude);
  const grokDetected = await detectSync(forGrok);
  assert.deepEqual(claudeDetected, grokDetected);

  assert.equal(
    promoteSensitivity('local_only', claudeDetected, 'done'),
    promoteSensitivity('local_only', grokDetected, 'done'),
  );

  await withTempHome(async (home) => {
    const opened = openDatabase({ path: join(home, 'memory.db'), timeoutMs: 2_000 });
    try {
      const rules = loadDestinationRules(opened.db);
      const claudeRows = [{ sensitivity: 'eligible' as Sensitivity, repoId: 'repo-a', agent: 'claude' }];
      const grokRows = [{ sensitivity: 'eligible' as Sensitivity, repoId: 'repo-a', agent: 'grok' }];
      const claudeEgress = filterEgress(rules, 'remote_observer', claudeRows, 'repo-a');
      const grokEgress = filterEgress(rules, 'remote_observer', grokRows, 'repo-a');
      assert.deepEqual(
        claudeEgress.allowed.map((row) => row.sensitivity),
        grokEgress.allowed.map((row) => row.sensitivity),
      );
      assert.deepEqual(claudeEgress.blocked, []);
      assert.deepEqual(grokEgress.blocked, []);
    } finally {
      opened.db.close();
    }
  });
});

test('the detector wall time on large clean payloads is reported for the capture budget', async (t) => {
  const paragraph = `${CLEAN_TEXT}\n`;
  for (const size of [200_000, 1_000_000]) {
    const text = paragraph.repeat(Math.ceil(size / paragraph.length)).slice(0, size);
    const started = performance.now();
    const detected = assertDetected(await detectSync(detectorInput(text)), `${size} bytes`);
    const elapsed = performance.now() - started;
    assert.equal(detected.sensitivity, 'local_only');
    t.diagnostic(
      `detectSync on ${size} characters took ${elapsed.toFixed(1)} ms on Node ${process.versions.node}`,
    );
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  excerptInput,
  observerOutputJsonSchema,
  observerOutputSchema,
  shortenDisplayPath,
  trimObservation,
  validateObserverOutput,
  type Observation,
  type ObserverInput,
} from '../../src/observer/contract.js';

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    type: 'change',
    title: 'edited src/cli.ts',
    body: 'write src/cli.ts (+12/-3)',
    concepts: ['what-changed'],
    citations: {
      files_read: [],
      files_modified: ['src/cli.ts'],
      commits: [],
    },
    source_event_ids: ['e1'],
    classification: { decision: 'add', target: null, reason: 'new' },
    ...overrides,
  };
}

function output(observations: Observation[] = [observation()]) {
  return { observations };
}

const events: ObserverInput['events'] = [
  { id: 'e1', kind: 'prompt', text: 'fix the parser' },
  { id: 'e2', kind: 'tool_result', output: 'ok', tool_name: 'edit' },
];

const nearby: ObserverInput['nearby'] = [
  {
    id: 'm1',
    type: 'decision',
    title: 'keep zod',
    body: 'one schema both paths',
    deleted: false,
  },
];

test('valid output parses', () => {
  const parsed = observerOutputSchema.safeParse(output());
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.observations.length, 1);
    assert.equal(parsed.data.observations[0]?.title, 'edited src/cli.ts');
  }
});

test('21 observations are rejected', () => {
  const parsed = observerOutputSchema.safeParse(
    output(Array.from({ length: 21 }, () => observation())),
  );
  assert.equal(parsed.success, false);
});

test('unknown key is rejected', () => {
  const parsed = observerOutputSchema.safeParse({
    observations: [observation()],
    extra: true,
  });
  assert.equal(parsed.success, false);
});

test('title of 121 characters is rejected', () => {
  const parsed = observerOutputSchema.safeParse(
    output([observation({ title: 't'.repeat(121) })]),
  );
  assert.equal(parsed.success, false);
});

test('empty source_event_ids is rejected', () => {
  const parsed = observerOutputSchema.safeParse(
    output([observation({ source_event_ids: [] })]),
  );
  assert.equal(parsed.success, false);
});

test('validateObserverOutput rejects a foreign source id as unusable_output', () => {
  const result = validateObserverOutput(
    output([observation({ source_event_ids: ['foreign-id'] })]),
    { events, nearby },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'unusable_output');
    assert.match(result.detail, /foreign-id/);
  }
});

test('validateObserverOutput rewrites a missing nearby target to add/null', () => {
  const result = validateObserverOutput(
    output([
      observation({
        classification: {
          decision: 'update',
          target: 'm-missing',
          reason: 'looked similar',
        },
      }),
    ]),
    { events, nearby },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.output.observations[0]?.classification.decision, 'add');
    assert.equal(result.output.observations[0]?.classification.target, null);
  }
});

test('validateObserverOutput turns delete with empty reason into noop', () => {
  const result = validateObserverOutput(
    output([
      observation({
        classification: { decision: 'delete', target: 'm1', reason: '' },
      }),
    ]),
    { events, nearby },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.output.observations[0]?.classification.decision, 'noop');
    assert.equal(result.output.observations[0]?.classification.target, 'm1');
  }
});

test('validateObserverOutput returns ok with the same observations', () => {
  const raw = output([
    observation({
      classification: { decision: 'update', target: 'm1', reason: 'same fact' },
    }),
  ]);
  const result = validateObserverOutput(raw, { events, nearby });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.output.observations, raw.observations);
  }
});

test('trimObservation shortens a 60-line body and keeps 20 paths', () => {
  const line = 'b'.repeat(100);
  const body = Array.from({ length: 60 }, () => line).join('\n');
  const paths = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`);
  const trimmed = trimObservation(
    observation({
      body,
      citations: {
        files_read: paths,
        files_modified: paths,
        commits: [],
      },
    }),
  );
  assert.ok(trimmed.body.length <= 2000);
  assert.match(trimmed.body, /\.\.\. \(\+\d+ omitted\)$/);
  assert.ok(trimmed.body.startsWith(line));
  assert.equal(trimmed.citations.files_read.length, 20);
  assert.equal(trimmed.citations.files_modified.length, 20);
  assert.deepEqual(trimmed.citations.files_read, paths.slice(0, 20));
});

test('shortenDisplayPath of a 200-character path is 61 characters', () => {
  const path = 'p'.repeat(200);
  const short = shortenDisplayPath(path);
  assert.equal(short.length, 61);
  assert.equal(short.startsWith('…'), true);
  assert.ok(short.endsWith(path.slice(-60)));
});

test('excerptInput keeps summaries and prompts and the newest tool events', () => {
  const toolEvents: ObserverInput['events'] = [];
  for (let i = 0; i < 30; i += 1) {
    toolEvents.push({
      id: `t${i}`,
      kind: 'tool_result',
      tool_name: 'read',
      output: 'x'.repeat(900),
    });
  }
  const input: ObserverInput = {
    repo_ref: 'repo-1',
    session: {
      started_at: 1,
      turns: [{ ordinal: 0, started_at: 1, ended_at: 2 }],
    },
    events: [
      { id: 'p1', kind: 'prompt', text: 'first prompt' },
      ...toolEvents.slice(0, 20),
      { id: 'p2', kind: 'prompt', text: 'second prompt' },
      ...toolEvents.slice(20),
    ],
    free_summaries: {
      last_assistant_message: 'assistant kept',
      compaction_summary: 'compaction kept',
    },
    nearby: [],
    language_hint: 'en',
  };

  const before = JSON.stringify(input).length;
  assert.ok(before > 25_000);
  assert.ok(before < 40_000);

  const { input: excerpted, excerpted: didExcerpt } = excerptInput(input);
  const after = JSON.stringify(excerpted).length;
  assert.equal(didExcerpt, true);
  assert.ok(after <= 12_000);
  assert.equal(excerpted.free_summaries.last_assistant_message, 'assistant kept');
  assert.equal(excerpted.free_summaries.compaction_summary, 'compaction kept');

  const ids = excerpted.events.map((event) => event.id);
  assert.ok(ids.includes('p1'));
  assert.ok(ids.includes('p2'));

  const survivingTools = excerpted.events
    .filter((event) => event.kind === 'tool_result')
    .map((event) => event.id);
  assert.ok(survivingTools.length > 0);
  assert.ok(survivingTools.length < 30);
  const expected = Array.from({ length: 30 }, (_, i) => `t${i}`).slice(
    30 - survivingTools.length,
  );
  assert.deepEqual(survivingTools, expected);
});

test('observerOutputJsonSchema serializes and contains observations', () => {
  const encoded = JSON.stringify(observerOutputJsonSchema);
  assert.ok(encoded.length > 0);
  const parsed = JSON.parse(encoded) as {
    properties?: { observations?: unknown };
  };
  assert.ok(parsed.properties?.observations);
});

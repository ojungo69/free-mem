import * as z from 'zod';

export const OBSERVATION_TYPES = [
  'bugfix',
  'feature',
  'refactor',
  'change',
  'discovery',
  'decision',
  'security_alert',
  'security_note',
] as const;

export const CONCEPTS = [
  'how-it-works',
  'why-it-exists',
  'what-changed',
  'problem-solution',
  'gotcha',
  'pattern',
  'trade-off',
] as const;

export const DECISIONS = ['add', 'update', 'delete', 'noop'] as const;

export const MAX_OBSERVATIONS = 20;
export const MAX_SOURCE_EVENT_IDS = 50;
export const MAX_CITATION_LENGTH = 512;
export const MAX_PATHS = 20;
export const MAX_COMMITS = 10;
export const MAX_TITLE = 120;
export const MAX_BODY = 2000;
export const MAX_INPUT_CHARS = 12_000;
export const DISPLAY_PATH_TAIL = 60;

const observationTypeSchema = z.enum(OBSERVATION_TYPES);
const conceptSchema = z.enum(CONCEPTS);
const decisionSchema = z.enum(DECISIONS);
const observerEventKindSchema = z.enum([
  'prompt',
  'tool_call',
  'tool_result',
  'tool_failure',
  'last_assistant_message',
  'compaction_summary',
]);

const citationPathSchema = z.string().max(MAX_CITATION_LENGTH);
const commitIdSchema = z
  .string()
  .max(MAX_CITATION_LENGTH)
  .regex(/^[0-9a-f]{7,64}$/);

export const observerInputSchema = z
  .object({
    repo_ref: z.string(),
    session: z
      .object({
        started_at: z.number(),
        turns: z.array(
          z
            .object({
              ordinal: z.number(),
              started_at: z.number(),
              ended_at: z.number().nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
    events: z.array(
      z
        .object({
          id: z.string(),
          kind: observerEventKindSchema,
          text: z.string().optional(),
          tool_name: z.string().optional(),
          input: z.unknown().optional(),
          output: z.string().optional(),
          error: z.string().optional(),
          is_error: z.boolean().optional(),
        })
        .strict(),
    ),
    free_summaries: z
      .object({
        last_assistant_message: z.string().optional(),
        compaction_summary: z.string().optional(),
      })
      .strict(),
    nearby: z.array(
      z
        .object({
          id: z.string(),
          type: z.string(),
          title: z.string(),
          body: z.string(),
          deleted: z.boolean(),
        })
        .strict(),
    ),
    language_hint: z.enum(['ja', 'en', 'other']),
  })
  .strict();

export const observationSchema = z
  .object({
    type: observationTypeSchema,
    title: z.string().min(1).max(MAX_TITLE),
    body: z.string().max(MAX_BODY),
    concepts: z
      .array(conceptSchema)
      .max(7)
      .refine((items) => new Set(items).size === items.length, {
        message: 'concepts must be unique',
      }),
    citations: z
      .object({
        files_read: z.array(citationPathSchema).max(MAX_PATHS),
        files_modified: z.array(citationPathSchema).max(MAX_PATHS),
        commits: z.array(commitIdSchema).max(MAX_COMMITS),
      })
      .strict(),
    source_event_ids: z.array(z.string()).min(1).max(MAX_SOURCE_EVENT_IDS),
    classification: z
      .object({
        decision: decisionSchema,
        target: z.string().nullable(),
        reason: z.string().max(200),
      })
      .strict(),
  })
  .strict();

export const observerOutputSchema = z
  .object({
    observations: z.array(observationSchema).max(MAX_OBSERVATIONS),
  })
  .strict();

export const observerOutputJsonSchema = z.toJSONSchema(observerOutputSchema);

export type ObserverInput = z.infer<typeof observerInputSchema>;
export type ObserverOutput = z.infer<typeof observerOutputSchema>;
export type Observation = z.infer<typeof observationSchema>;
export type ObservationType = z.infer<typeof observationTypeSchema>;
export type Decision = z.infer<typeof decisionSchema>;

const TOOL_EVENT_KINDS = new Set([
  'tool_call',
  'tool_result',
  'tool_failure',
]);

function serializedSize(value: unknown): number {
  return JSON.stringify(value).length;
}

function isToolEventKind(kind: ObserverInput['events'][number]['kind']): boolean {
  return TOOL_EVENT_KINDS.has(kind);
}

export function validateObserverOutput(
  raw: unknown,
  input: Pick<ObserverInput, 'events' | 'nearby'>,
):
  | { ok: true; output: ObserverOutput }
  | { ok: false; reason: 'unusable_output'; detail: string } {
  const parsed = observerOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'unusable_output',
      detail: z.prettifyError(parsed.error),
    };
  }

  const eventIds = new Set(input.events.map((event) => event.id));
  for (const [index, observation] of parsed.data.observations.entries()) {
    for (const id of observation.source_event_ids) {
      if (!eventIds.has(id)) {
        return {
          ok: false,
          reason: 'unusable_output',
          detail: `observation ${index} source_event_ids ${id}`,
        };
      }
    }
  }

  const nearbyIds = new Set(input.nearby.map((row) => row.id));
  const observations = parsed.data.observations.map((observation) => {
    let { decision, target } = observation.classification;
    const { reason } = observation.classification;
    // contracts/observer.md: unknown nearby target is add, not an error
    if (target !== null && !nearbyIds.has(target)) {
      target = null;
      decision = 'add';
    }
    // contracts/observer.md: delete only with a reason
    if (decision === 'delete' && reason.length === 0) {
      decision = 'noop';
    }
    if (
      decision === observation.classification.decision &&
      target === observation.classification.target
    ) {
      return observation;
    }
    return {
      ...observation,
      classification: { decision, target, reason },
    };
  });

  return { ok: true, output: { observations } };
}

function trimBody(body: string): string {
  if (body.length <= MAX_BODY) return body;
  const lines = body.split('\n');
  for (let keep = lines.length - 1; keep >= 0; keep -= 1) {
    const omitted = lines.length - keep;
    const suffix = `... (+${omitted} omitted)`;
    const next = keep === 0 ? suffix : `${lines.slice(0, keep).join('\n')}\n${suffix}`;
    if (next.length <= MAX_BODY) return next;
  }
  return `... (+${lines.length} omitted)`.slice(0, MAX_BODY);
}

export function shortenDisplayPath(path: string): string {
  if (path.length <= DISPLAY_PATH_TAIL) return path;
  return `…${path.slice(-DISPLAY_PATH_TAIL)}`;
}

export function trimObservation(observation: Observation): Observation {
  return {
    ...observation,
    title: observation.title.slice(0, MAX_TITLE),
    body: trimBody(observation.body),
    citations: {
      files_read: observation.citations.files_read.slice(0, MAX_PATHS),
      files_modified: observation.citations.files_modified.slice(0, MAX_PATHS),
      commits: observation.citations.commits.slice(0, MAX_COMMITS),
    },
  };
}

function truncateFromEnd(
  root: ObserverInput,
  value: string | undefined,
  assign: (next: string) => void,
): boolean {
  if (value === undefined || value.length === 0) return false;
  if (serializedSize(root) <= MAX_INPUT_CHARS) return false;
  let current = value;
  let changed = false;
  while (current.length > 0 && serializedSize(root) > MAX_INPUT_CHARS) {
    const over = serializedSize(root) - MAX_INPUT_CHARS;
    current = current.slice(0, Math.max(0, current.length - Math.max(1, over)));
    assign(current);
    changed = true;
  }
  return changed;
}

export function excerptInput(
  input: ObserverInput,
): { input: ObserverInput; excerpted: boolean } {
  if (serializedSize(input) <= MAX_INPUT_CHARS) {
    return { input, excerpted: false };
  }

  const next = structuredClone(input);
  let excerpted = false;

  while (serializedSize(next) > MAX_INPUT_CHARS) {
    const index = next.events.findIndex((event) => isToolEventKind(event.kind));
    if (index === -1) break;
    next.events.splice(index, 1);
    excerpted = true;
  }

  if (serializedSize(next) <= MAX_INPUT_CHARS) {
    return { input: next, excerpted };
  }

  for (const event of next.events) {
    if (serializedSize(next) <= MAX_INPUT_CHARS) break;
    excerpted =
      truncateFromEnd(next, event.text, (value) => {
        event.text = value;
      }) || excerpted;
    excerpted =
      truncateFromEnd(next, event.output, (value) => {
        event.output = value;
      }) || excerpted;
  }

  return { input: next, excerpted };
}

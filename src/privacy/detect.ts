import { Worker, parentPort, workerData } from 'node:worker_threads';
import { isAbsolute, relative, resolve } from 'node:path';

import { lintSource } from '@secretlint/core';
import { rules as recommendedRules } from '@secretlint/secretlint-rule-preset-recommend';
import type { SecretLintCoreConfig } from '@secretlint/types';

const FILTER_COMMENTS_RULE = '@secretlint/secretlint-rule-filter-comments';
const AWS_RULE = '@secretlint/secretlint-rule-aws';
const RULE_ID_PREFIX = '@secretlint/secretlint-rule-';

/**
 * The recommend preset, registered rule by rule (R4). Two deviations from the preset defaults, both
 * because the defaults fail open on captured content:
 * - the comment filter is left out, because a `secretlint-disable` comment inside captured text
 *   would switch redaction off for the rest of the payload (FR-018 redacts before the first write);
 * - the AWS rule scans access key ids, which its `enableIDScanRule` option leaves off by default.
 */
const RECOMMENDED_SECRET_RULES: SecretLintCoreConfig = {
  rules: recommendedRules
    .filter((rule) => rule.meta.id !== FILTER_COMMENTS_RULE)
    .map((rule) => ({
      id: rule.meta.id,
      rule,
      options: rule.meta.id === AWS_RULE ? { enableIDScanRule: true } : undefined,
    })),
};

export type Redaction = { rule: string; count: number };

export type DetectorInput = {
  text: string;
  /**
   * Extra strings redacted separately in the same run and returned in `texts`, one per field. The
   * capture hook (T027) needs the redacted value of every event field back where it came from:
   * storing one redacted concatenation would lose which event each string belongs to.
   */
  fields?: string[];
  paths: string[];
  repoRoot: string | null;
  secretPaths: string[];
};

export type DetectorResult =
  | {
      ok: true;
      text: string;
      /** The redacted `fields`, in order; empty when the caller passed none. */
      texts: string[];
      redactions: Redaction[];
      privateRemoved: number;
      sensitivity: 'local_only' | 'secret';
      pathRule: string | null;
    }
  | { ok: false; reason: 'deadline' | 'detector_error' };

/**
 * Removes every `<private>...</private>` span (FR-019). Nested tags are one span from the first
 * open tag to its matching close tag, and an unclosed tag removes everything to the end of the
 * text. The removed text is never part of the result.
 */
export function stripPrivate(text: string): { text: string; removed: number } {
  const tag = /<\s*(\/?)\s*private\s*>/gi;
  let depth = 0;
  let kept = '';
  let cursor = 0;
  let removed = 0;

  for (let match = tag.exec(text); match !== null; match = tag.exec(text)) {
    if (match[1] !== '/') {
      if (depth === 0) kept += text.slice(cursor, match.index);
      depth += 1;
      continue;
    }
    // A close tag with no open tag before it wraps nothing, so it is not a span.
    if (depth === 0) continue;
    depth -= 1;
    if (depth === 0) {
      cursor = tag.lastIndex;
      removed += 1;
    }
  }

  // FR-019: an unclosed tag removes the rest of the text rather than keeping it unreviewed.
  if (depth > 0) return { text: kept, removed: removed + 1 };
  return { text: kept + text.slice(cursor), removed };
}

/**
 * Compiles one `.oboete.toml` path rule with gitignore semantics, because that is the form the
 * rules are written in: a pattern without a slash matches the file name at any depth, `**` crosses
 * directories (`**\/x` matches `x` at the root too), and `*` and `?` never cross one.
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = glob.includes('/') ? '' : '(?:.*/)?';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index] as string;
    if (character === '*') {
      if (glob[index + 1] === '*') {
        // `**/` is zero or more directories, so `a/**/b` matches `a/b` as well as `a/x/b`.
        if (glob[index + 2] === '/') {
          pattern += '(?:.*/)?';
          index += 2;
        } else {
          pattern += '.*';
          index += 1;
        }
      } else {
        pattern += '[^/]*';
      }
      continue;
    }
    if (character === '?') {
      pattern += '[^/]';
      continue;
    }
    if (character === '[') {
      const end = glob.indexOf(']', index + 1);
      if (end !== -1) {
        pattern += `[${glob.slice(index + 1, end).replace(/^[!^]/, '^')}]`;
        index = end;
        continue;
      }
    }
    pattern += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}

/** FR-039: a rule is written with forward slashes, so a Windows path is compared in that form. */
function withForwardSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

/**
 * The repository path rule that this path matches, or null. The path is tested in its
 * repository-relative form (when it lies inside the repository) and in its raw form; a match makes
 * the whole event a path-rule hit, which is stored as metadata only (R4).
 */
export function matchSecretPath(
  pathValue: string,
  rules: string[],
  repoRoot: string | null,
): string | null {
  if (rules.length === 0) return null;

  const candidates = [withForwardSlashes(pathValue)];
  if (repoRoot !== null) {
    const inside = relative(resolve(repoRoot), resolve(pathValue));
    // A path outside the repository has no repository-relative form to compare.
    if (inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)) {
      candidates.push(withForwardSlashes(inside));
    }
  }

  for (const rule of rules) {
    const pattern = globToRegExp(withForwardSlashes(rule));
    if (candidates.some((candidate) => pattern.test(candidate))) return rule;
  }
  return null;
}

type Span = { start: number; end: number; rule: string };

// The characters a secret is made of. A reported range that ends inside such a run is extended to
// the end of the run (see redactSecrets).
const SECRET_CHARACTER = /[A-Za-z0-9+/=_-]/;

const CANDIDATE_PATTERNS = [
  /(?:api[_-]?key|token|secret|password|passwd|pwd|auth|credential|bearer)\s*[:=]\s*["']?([A-Za-z0-9+/=_.-]{16,})/gi,
  /\bBearer\s+([A-Za-z0-9+/=_.-]{16,})/g,
];

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    bits -= probability * Math.log2(probability);
  }
  return bits;
}

/**
 * R4: entropy decides only on candidates a credential-shaped pattern captured, and never on a bare
 * word, a UUID or a path.
 */
function isHighEntropySecret(value: string): boolean {
  if (value.length < 32) return false;
  if (value.includes('/') || value.includes('\\')) return false;
  if (UUID.test(value)) return false;
  if (/^[A-Za-z]+$/.test(value)) return false;
  if (/^[0-9a-fA-F]+$/.test(value)) return shannonEntropy(value) >= 3;
  return shannonEntropy(value) >= 4;
}

function entropySpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const pattern of CANDIDATE_PATTERNS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      const value = match[1] as string;
      if (!isHighEntropySecret(value)) continue;
      const start = match.index + match[0].lastIndexOf(value);
      spans.push({ start, end: start + value.length, rule: 'entropy' });
    }
  }
  return spans;
}

function replaceSpans(text: string, spans: Span[]): { text: string; hits: Redaction[] } {
  const sorted = [...spans].sort(
    (left, right) => left.start - right.start || right.end - left.end || left.rule.localeCompare(right.rule),
  );

  // Two rules can report overlapping ranges, and one marker must replace one region.
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }

  // The pieces between the spans are collected in one pass, so every offset is read from the
  // original text and a payload with thousands of hits still costs one copy.
  const counts = new Map<string, number>();
  const pieces: string[] = [];
  let cursor = 0;
  for (const span of merged) {
    pieces.push(text.slice(cursor, span.start), `[REDACTED:${span.rule}]`);
    cursor = span.end;
    counts.set(span.rule, (counts.get(span.rule) ?? 0) + 1);
  }
  pieces.push(text.slice(cursor));
  const redacted = pieces.join('');

  const hits = [...counts.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((left, right) => left.rule.localeCompare(right.rule));
  return { text: redacted, hits };
}

/**
 * FR-018: replaces every secret with `[REDACTED:<rule>]`, first the ranges the secretlint rules
 * report and then the gated entropy candidates. Deterministic and idempotent.
 */
export async function redactSecrets(
  text: string,
  options?: { rules?: SecretLintCoreConfig },
): Promise<{ text: string; hits: Redaction[] }> {
  const linted = await lintSource({
    source: { filePath: 'oboete-event.txt', content: text, contentType: 'text', ext: '.txt' },
    options: { config: options?.rules ?? RECOMMENDED_SECRET_RULES, noPhysicFilePath: true },
  });

  const ruleSpans = linted.messages.map((message) => {
    // Some preset rules report the offset of the whole match with the length of the captured value
    // only (the AWS secret key and the npm token rules do), which would leave the tail of the
    // secret in the text. The end is extended over the rest of the secret's characters.
    let end = message.range[1];
    while (end < text.length && SECRET_CHARACTER.test(text[end] as string)) end += 1;
    return { start: message.range[0], end, rule: message.ruleId.replace(RULE_ID_PREFIX, '') };
  });

  const afterRules = replaceSpans(text, ruleSpans);
  const afterEntropy = replaceSpans(afterRules.text, entropySpans(afterRules.text));
  return {
    text: afterEntropy.text,
    hits: [...afterRules.hits, ...afterEntropy.hits].sort((left, right) =>
      left.rule.localeCompare(right.rule),
    ),
  };
}

/** One entry per rule with the counts of every text summed, ordered by rule name. */
function mergeRedactions(hits: Redaction[]): Redaction[] {
  const counts = new Map<string, number>();
  for (const hit of hits) counts.set(hit.rule, (counts.get(hit.rule) ?? 0) + hit.count);
  return [...counts.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((left, right) => left.rule.localeCompare(right.rule));
}

/**
 * The detector in the R4 order: private strip, repository path rules, secretlint plus gated
 * entropy. Any failure fails closed, and the unsanitized text is never part of the result.
 * `options` exists so a test can supply a rule set; capture calls this with one argument.
 */
export async function detectSync(
  input: DetectorInput,
  options?: { rules?: SecretLintCoreConfig },
): Promise<DetectorResult> {
  try {
    const stripped = stripPrivate(input.text);
    const strippedFields = (input.fields ?? []).map((field) => stripPrivate(field));
    let privateRemoved = stripped.removed;
    for (const field of strippedFields) privateRemoved += field.removed;

    for (const path of input.paths) {
      const pathRule = matchSecretPath(path, input.secretPaths, input.repoRoot);
      // R4: a path-rule hit stores metadata only, so the content does not travel any further.
      if (pathRule !== null) {
        return {
          ok: true,
          text: '',
          texts: [],
          redactions: [],
          privateRemoved,
          sensitivity: 'secret',
          pathRule,
        };
      }
    }

    // A caller that passes fields only (the hook does) must not pay for linting an empty string.
    const redacted =
      stripped.text === '' ? { text: '', hits: [] } : await redactSecrets(stripped.text, options);
    const hits = [...redacted.hits];
    const texts: string[] = [];
    for (const field of strippedFields) {
      const redactedField = field.text === '' ? { text: '', hits: [] } : await redactSecrets(field.text, options);
      texts.push(redactedField.text);
      hits.push(...redactedField.hits);
    }

    return {
      ok: true,
      text: redacted.text,
      texts,
      redactions: mergeRedactions(hits),
      privateRemoved,
      // FR-017: local_only by default; a rule or entropy hit classifies the row as secret here,
      // and promotion to eligible is the worker's decision (privacy/classify.ts).
      sensitivity: hits.length > 0 ? 'secret' : 'local_only',
      pathRule: null,
    };
  } catch {
    // R4: a detector or configuration failure is a classification failure, never a stored payload.
    return { ok: false, reason: 'detector_error' };
  }
}

/**
 * Runs the detector in a `worker_threads` Worker and gives up at `cutoffMs`, so the hook's wall
 * time stays bounded even when the detector never returns (contracts/agents.md hook SLAs). A
 * terminated run is a detector failure with reason `deadline`.
 */
export function detectInWorker(
  input: DetectorInput,
  options: { cutoffMs: number; workerScript: string },
): Promise<DetectorResult> {
  return new Promise((settle) => {
    const worker = new Worker(options.workerScript, {
      workerData: { role: 'oboete-detector', input },
    });

    let done = false;
    const finish = (result: DetectorResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      settle(result);
    };

    const timer = setTimeout(() => finish({ ok: false, reason: 'deadline' }), options.cutoffMs);
    worker.on('message', (message: DetectorResult) => finish(message));
    worker.on('error', () => finish({ ok: false, reason: 'detector_error' }));
    // An exit without a message means the worker died before it could answer.
    worker.on('exit', () => finish({ ok: false, reason: 'detector_error' }));
  });
}

/** The entry the engine bundle runs when it is started as the detector Worker (see src/cli.ts). */
export async function detectorWorkerMain(): Promise<void> {
  const { input } = workerData as { input: DetectorInput };
  parentPort?.postMessage(await detectSync(input));
}

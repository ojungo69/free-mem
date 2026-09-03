// Agent payload adapters. This directory is the only place that decides which payload fields become
// oboete content, which is why plan.md ("Structure Decision") keeps it security-owned: everything a
// payload carries and an adapter does not name here never reaches the detector, the database or a
// pack. Sources: contracts/agents.md ("Normalized events", "Agent identity", "Capture and injection
// per agent", "Size cap"), research.md R7 and R13 row 1, docs/research/oboete-contracts-probes.md
// ("Findings 2026-09-03", "R13 evaluation"), and the fixtures under test/contracts/<agent>/.
//
// Every function exported from this module is a function declaration on purpose: the per-agent
// modules import it and are imported by it, and only a hoisted declaration is safe to read from
// their module bodies inside that cycle.
import {
  MAX_TEXT,
  MAX_TOOL_INPUT_PATHS,
  MAX_TOOL_INPUT_TEXT,
  type AgentName,
  type Envelope,
  type NormalizedEvent,
  type ToolInput,
  type ToolName,
} from '../events.js';
import { adaptClaude } from './claude.js';
import { adaptCodex } from './codex.js';
import { adaptGrok } from './grok.js';
import { adaptPi } from './pi.js';

/** The four agents that have an adapter; `unknown` invocations never reach one (FR-006). */
export type AdapterAgent = Exclude<AgentName, 'unknown'>;

export type AdapterInput = {
  agent: AdapterAgent;
  /** The fixed `--event` argument setup writes, cross-checked by the caller, never by the payload. */
  eventName: string;
  payload: unknown;
  capturedAt: number;
};

/** Exactly the text and paths the privacy detector scans before the first write (FR-018, R4). */
export type DetectorContent = { text: string; paths: string[] };

export type UnmappedReason = 'unmapped_payload' | 'event_not_captured' | 'payload_invalid';

export type UnmappedMetadata = {
  nativeSessionId: string | null;
  toolName: string | null;
  eventName: string;
};

export type AdapterOutput =
  | { kind: 'events'; events: NormalizedEvent[]; contentForDetector: DetectorContent }
  | { kind: 'unmapped'; reason: UnmappedReason; metadata: UnmappedMetadata };

/** One native tool of one agent. A tool without an entry is stored metadata-only (R13 row 1). */
export type ToolMapping = {
  input: (raw: Record<string, unknown> | null) => ToolInput;
  output: (response: unknown) => string;
  /** Set where the native name alone is not the normalized name (Codex `apply_patch`). */
  name?: (raw: Record<string, unknown> | null) => ToolName;
};

// Where each agent spells the fields the A7 bounded scan, the metadata-only rows and the event-name
// cross-check need.
const AGENT_KEYS: Record<AdapterAgent, { session: string; tool: string; event: string }> = {
  claude: { session: 'session_id', tool: 'tool_name', event: 'hook_event_name' },
  codex: { session: 'session_id', tool: 'tool_name', event: 'hook_event_name' },
  grok: { session: 'sessionId', tool: 'toolName', event: 'hookEventName' },
  // The Pi capture child wraps the extension event in oboete's own envelope (piEnvelopeSchema).
  pi: { session: 'session_id', tool: 'toolName', event: 'event' },
};

// Fields that hold a path in one of the four agents' tool inputs. A `pattern` is a search
// expression, not a path, so it is deliberately absent (contracts/agents.md "Size cap").
const PATH_KEYS = ['file_path', 'filePath', 'path', 'target_file', 'notebook_path'];

// A JSON string value: an escaped character counts as one, so a Windows path (`C:\\repo\\.env`)
// is captured whole instead of ending at its first backslash.
const JSON_VALUE = '"((?:[^"\\\\]|\\\\.){1,4096})"';

const PATH_SCAN = new RegExp(`"(?:${PATH_KEYS.join('|')})"\\s*:\\s*${JSON_VALUE}`, 'g');

/** The JSON escapes a path or an identifier can carry; the others cannot appear in one. */
function unescapeJson(value: string): string {
  return value.replace(/\\([\\/"])/g, '$1');
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function readRecord(
  source: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  if (source === null || !Object.hasOwn(source, key)) return null;
  return asRecord(source[key]);
}

/** A non-empty string, for fields that identify something (ids, paths, names). */
export function readString(source: Record<string, unknown> | null, key: string): string | undefined {
  if (source === null || !Object.hasOwn(source, key)) return undefined;
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A string field that may legitimately be empty (prompt text, command, file content). */
export function readContent(
  source: Record<string, unknown> | null,
  key: string,
): string | undefined {
  if (source === null || !Object.hasOwn(source, key)) return undefined;
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

export function capText(value: string): string {
  return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;
}

export function capToolText(value: string): string {
  return value.length > MAX_TOOL_INPUT_TEXT ? value.slice(0, MAX_TOOL_INPUT_TEXT) : value;
}

export function capPaths(values: (string | undefined)[]): string[] {
  const paths: string[] = [];
  for (const value of values) {
    if (value === undefined || value === '' || paths.includes(value)) continue;
    if (paths.length === MAX_TOOL_INPUT_PATHS) break;
    paths.push(value);
  }
  return paths;
}

/** Lines of a text block, so that a trailing newline does not count as an extra line. */
export function countLines(value: string): number {
  if (value === '') return 0;
  const newlines = value.split('\n').length - 1;
  return value.endsWith('\n') ? newlines : newlines + 1;
}

function renderJson(value: unknown, limit: number): string {
  const encoded = JSON.stringify(value) ?? '';
  return encoded.length > limit ? encoded.slice(0, limit) : encoded;
}

/** The fallback tool input: the named path fields plus the input rendered as JSON. */
function describeToolInput(raw: Record<string, unknown> | null): ToolInput {
  return {
    paths: capPaths(PATH_KEYS.map((key) => readString(raw, key))),
    text: renderJson(raw ?? {}, MAX_TOOL_INPUT_TEXT),
  };
}

/** The fallback tool output: a shape no fixture describes is kept as JSON, size-capped. */
export function describeToolOutput(response: unknown): string {
  // A missing result is no output at all; the words `null` and `undefined` are not tool output.
  if (response === null || response === undefined) return '';
  return renderJson(response, MAX_TEXT);
}

/** The mapping for a tool whose arguments are a plain object: path fields plus the input as JSON. */
export function genericTool(): ToolMapping {
  return { input: describeToolInput, output: describeToolOutput };
}

export function promptRef(promptId: string | undefined): { prompt_id?: string } {
  return promptId === undefined ? {} : { prompt_id: promptId };
}

export function buildEnvelope(
  input: AdapterInput,
  fields: {
    sessionId: string | undefined;
    cwd: string | undefined;
    model?: string;
    agentId?: string;
    agentType?: string;
  },
): Envelope | null {
  // Without a session id or a working directory the event cannot be placed in a conversation or a
  // repository, and oboete never invents either (FR-004).
  if (fields.sessionId === undefined || fields.cwd === undefined) return null;
  const envelope: Envelope = {
    agent: input.agent,
    native_session_id: fields.sessionId,
    cwd: fields.cwd,
    captured_at: Math.trunc(input.capturedAt),
  };
  if (fields.agentId !== undefined) envelope.agent_id = fields.agentId;
  if (fields.agentType !== undefined) envelope.agent_type = fields.agentType;
  if (fields.model !== undefined) envelope.model = fields.model;
  return envelope;
}

/** A row that keeps its metadata and none of its payload (R13 row 1, contracts/agents.md). */
export function metadataOnly(
  input: AdapterInput,
  reason: UnmappedReason,
  toolName?: string,
): AdapterOutput {
  const payload = asRecord(input.payload);
  const keys = AGENT_KEYS[input.agent];
  return {
    kind: 'unmapped',
    reason,
    metadata: {
      nativeSessionId: readString(payload, keys.session) ?? null,
      toolName: toolName ?? readString(payload, keys.tool) ?? null,
      eventName: input.eventName,
    },
  };
}

function eventContent(event: NormalizedEvent): { texts: string[]; paths: string[] } {
  switch (event.kind) {
    case 'prompt':
    case 'compaction_summary':
    case 'last_assistant_message':
      return { texts: [event.text], paths: [] };
    case 'tool_call':
      return {
        texts: [event.input.command, event.input.text].filter((value) => value !== undefined),
        paths: event.input.paths,
      };
    case 'tool_result':
      return { texts: [event.output], paths: [] };
    case 'tool_failure':
      return { texts: [event.error], paths: [] };
    case 'turn_end':
    case 'session_end':
      // The reason is a short payload string, so it is scanned like any other stored text.
      return { texts: [event.reason], paths: [] };
    default:
      return { texts: [], paths: [] };
  }
}

/**
 * Wraps the events an adapter produced with the content the detector must see first (FR-018).
 * `namedPaths` are paths the adapter read from the payload that no event field carries, such as the
 * file a tool result is the body of: without them a repository path rule could never classify that
 * row (FR-017, R4).
 */
export function toEvents(events: NormalizedEvent[], namedPaths: string[] = []): AdapterOutput {
  const texts: string[] = [];
  const paths: (string | undefined)[] = [...namedPaths];
  for (const event of events) {
    const content = eventContent(event);
    texts.push(...content.texts);
    paths.push(...content.paths);
  }
  return { kind: 'events', events, contentForDetector: { text: texts.join('\n'), paths: capPaths(paths) } };
}

/**
 * The agent behind an invocation, from the fixed selector setup wrote into the handler command and
 * never from the payload (FR-006, contracts/agents.md "Agent identity").
 */
export function resolveAgent(selector: string | undefined, env: NodeJS.ProcessEnv): AgentName {
  if (selector === 'codex') return 'codex';
  if (selector === 'pi') return 'pi';
  if (selector === 'claude-or-grok') {
    // Grok Build also runs the Claude-compatible handlers from $HOME, so only its own environment
    // variables tell the two apart.
    const grok = (env.GROK_HOOK_EVENT ?? '') !== '' || (env.GROK_SESSION_ID ?? '') !== '';
    return grok ? 'grok' : 'claude';
  }
  return 'unknown';
}

/**
 * The bounded scan of a payload prefix that was cut at the 1 MB stdin bound (A7): the session id,
 * the tool name and the path fields, and nothing else of the text.
 */
export function scanPartialPrefix(
  agent: AdapterAgent,
  prefix: string,
): { nativeSessionId: string | null; paths: string[]; toolName: string | null } {
  const keys = AGENT_KEYS[agent];
  const paths: string[] = [];
  for (const match of prefix.matchAll(PATH_SCAN)) {
    const path = match[1] === undefined ? undefined : unescapeJson(match[1]);
    if (path !== undefined && !paths.includes(path)) paths.push(path);
    if (paths.length === MAX_TOOL_INPUT_PATHS) break;
  }
  return {
    nativeSessionId: scanKey(prefix, keys.session),
    toolName: scanKey(prefix, keys.tool),
    paths,
  };
}

function scanKey(prefix: string, key: string): string | null {
  // The key is one of oboete's own constants, so it is never a pattern from a payload.
  const match = new RegExp(`"${key}"\\s*:\\s*${JSON_VALUE}`).exec(prefix);
  return match?.[1] === undefined ? null : unescapeJson(match[1]);
}

/** `pre_tool_use` and `PreToolUse` are the same hook; Grok writes the first spelling. */
function sameEventName(left: string, right: string): boolean {
  return left.replaceAll('_', '').toLowerCase() === right.replaceAll('_', '').toLowerCase();
}

/**
 * The one entry point capture uses. It never throws: a payload it cannot read becomes a
 * metadata-only row, so a malformed event can neither lose the hook nor smuggle content through.
 */
export function adapt(input: AdapterInput): AdapterOutput {
  try {
    // contracts/agents.md "Normalized events": the kind comes from the fixed `--event` argument
    // and is cross-checked against the payload whenever the payload names a hook of its own.
    const declared = readString(asRecord(input.payload), AGENT_KEYS[input.agent].event);
    if (declared !== undefined && !sameEventName(declared, input.eventName)) {
      return metadataOnly(input, 'payload_invalid');
    }
    switch (input.agent) {
      case 'claude':
        return adaptClaude(input);
      case 'codex':
        return adaptCodex(input);
      case 'grok':
        return adaptGrok(input);
      case 'pi':
        return adaptPi(input);
    }
  } catch {
    return metadataOnly(input, 'payload_invalid');
  }
}

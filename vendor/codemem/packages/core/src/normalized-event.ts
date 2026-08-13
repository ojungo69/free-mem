export const NORMALIZED_SCHEMA_VERSION = 1;

export const NORMALIZED_EVENT_FIELDS = [
	"schemaVersion",
	"eventId",
	"idempotencyKey",
	"agent",
	"agentInstanceId",
	"parentSessionId",
	"nativeSessionId",
	"nativeTurnId",
	"nativeToolUseId",
	"nativeSequence",
	"projectKey",
	"workspaceKey",
	"branchKey",
	"cwd",
	"gitHeadSha",
	"dirtyTreeFingerprint",
	"kind",
	"occurredAt",
	"model",
	"payload",
	"sourceHash",
	"sensitivity",
	"injectedContextIds",
] as const;

const AGENTS = new Set(["claude-code", "codex", "opencode", "pi", "kimi"]);

const KINDS = new Set([
	"session_started",
	"user_prompted",
	"assistant_completed",
	"tool_started",
	"tool_completed",
	"tool_failed",
	"turn_completed",
	"pre_compact",
	"post_compact",
	"session_idle",
	"session_interrupted",
	"session_ended",
]);

const SENSITIVITIES = new Set(["normal", "private", "secret"]);

const FIELDS = new Set<string>(NORMALIZED_EVENT_FIELDS);

export function isNormalizedEventKind(value: string): boolean {
	return KINDS.has(value);
}

function requiredString(event: Record<string, unknown>, field: string): string {
	const value = event[field];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`event.${field} is required.`);
	}
	return value;
}

export function validateNormalizedEvent(
	event: Record<string, unknown>,
	schemaVersion = NORMALIZED_SCHEMA_VERSION,
): {
	eventId: string;
	idempotencyKey: string;
	agent: string;
	kind: string;
	sensitivity: "normal" | "private" | "secret";
	occurredAt: string;
	sourceHash: string;
} {
	if (Object.keys(event).some((field) => !FIELDS.has(field))) {
		throw new Error("event contains an unsupported field.");
	}
	if (!Object.hasOwn(event, "payload")) throw new Error("event.payload is required.");
	if (event.schemaVersion !== schemaVersion)
		throw new Error("event.schemaVersion is incompatible.");
	const eventId = requiredString(event, "eventId");
	const idempotencyKey = requiredString(event, "idempotencyKey");
	const agent = requiredString(event, "agent");
	const kind = requiredString(event, "kind");
	const sensitivity = requiredString(event, "sensitivity");
	const occurredAt = requiredString(event, "occurredAt");
	const sourceHash = requiredString(event, "sourceHash");
	for (const field of ["nativeSessionId", "projectKey", "workspaceKey", "cwd"]) {
		requiredString(event, field);
	}
	if (!AGENTS.has(agent)) throw new Error("event.agent is unsupported.");
	if (!isNormalizedEventKind(kind)) throw new Error("event.kind is unsupported.");
	if (!SENSITIVITIES.has(sensitivity)) throw new Error("event.sensitivity is unsupported.");
	if (!Number.isFinite(Date.parse(occurredAt))) throw new Error("event.occurredAt is invalid.");
	if (!/^[a-f0-9]{64}$/.test(sourceHash)) {
		throw new Error("event.sourceHash must be a SHA-256 hex digest.");
	}
	for (const field of [
		"agentInstanceId",
		"parentSessionId",
		"nativeTurnId",
		"nativeToolUseId",
		"branchKey",
		"gitHeadSha",
		"dirtyTreeFingerprint",
		"model",
	]) {
		if (event[field] !== undefined && typeof event[field] !== "string") {
			throw new Error(`event.${field} must be a string.`);
		}
	}
	if (
		event.nativeSequence !== undefined &&
		(!Number.isInteger(event.nativeSequence) || Number(event.nativeSequence) < 0)
	) {
		throw new Error("event.nativeSequence must be a non-negative integer.");
	}
	if (
		event.injectedContextIds !== undefined &&
		(!Array.isArray(event.injectedContextIds) ||
			!event.injectedContextIds.every((value) => typeof value === "string"))
	) {
		throw new Error("event.injectedContextIds must be an array of strings.");
	}
	return {
		eventId,
		idempotencyKey,
		agent,
		kind,
		sensitivity: sensitivity as "normal" | "private" | "secret",
		occurredAt,
		sourceHash,
	};
}

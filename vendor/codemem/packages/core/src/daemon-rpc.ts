import type { Socket } from "node:net";
import {
	type FileContextRetrievalAttempt,
	HOOK_DELIVERY_BUDGETS,
	LOCAL_API_VERSION,
	RPC_CAPABILITY_HASH,
	RPC_DEFAULT_DEADLINE_MS,
	RPC_MAX_BYTES,
	RPC_METHODS,
	type RpcMethod,
	type RpcRequest,
	type RpcSuccess,
	type TypedRpcError,
} from "./daemon-rpc-contract.js";
import { buildFilterClausesWithContext } from "./filters.js";
import { validateMemoryKind } from "./memory-kinds.js";
import { dispatchClassA, MutationConflictError } from "./mutation-dispatcher.js";
import {
	NORMALIZED_EVENT_FIELDS,
	NORMALIZED_SCHEMA_VERSION,
	validateNormalizedEvent,
} from "./normalized-event.js";

export { NORMALIZED_SCHEMA_VERSION } from "./normalized-event.js";

import {
	BackupRequestError,
	createCanonicalBackup,
	verifyCanonicalBackup,
} from "./online-backup.js";
import { applyDaemonIntake, type RedactionResult } from "./redaction-pipeline.js";
import { tryUpdateRetrievalDelivery } from "./retrieval-ledger.js";
import { recordRetrievalSurface, resolveRetrievalSession } from "./retrieval-surface-ledger.js";
import {
	readSpoolStatus,
	type SpoolEntry,
	type SpoolImportOutcome,
	type SpoolRedactionMetadata,
	validateSpoolRedaction,
} from "./spool.js";
import type { MemoryStore } from "./store.js";
import type { MemoryFilters } from "./types.js";
import type { WriterActor } from "./writer-actor.js";

type RpcIdentity = { pid: number; nonce: string };

function spoolHealth(dataDir: string): Record<string, unknown> {
	try {
		const status = readSpoolStatus(dataDir);
		return {
			status: status.critical ? "critical" : status.warnings.length > 0 ? "warning" : "ok",
			critical: status.critical,
			warnings: status.warnings,
			droppedTotal: status.dropped.total,
			droppedByKind: status.dropped.byKind,
			firstDroppedAt: status.dropped.firstDroppedAt,
			lastDroppedAt: status.dropped.lastDroppedAt,
			quarantineRejected: status.dropped.quarantineRejected,
			normalBytes: status.normalBytes,
			reservedBytes: status.reservedBytes,
			quarantineBytes: status.quarantineBytes,
		};
	} catch {
		return {
			status: "unavailable",
			critical: true,
			warnings: ["spool status unavailable"],
		};
	}
}

export type {
	FileContextRetrievalAttempt,
	RpcMethod,
	RpcRequest,
	RpcSuccess,
	TypedRpcError,
} from "./daemon-rpc-contract.js";
export {
	callDaemonRpc,
	HOOK_DELIVERY_BUDGETS,
	LOCAL_API_VERSION,
	RPC_CAPABILITY_HASH,
	RPC_DEFAULT_DEADLINE_MS,
	RPC_MAX_BYTES,
	RPC_METHODS,
} from "./daemon-rpc-contract.js";

const TOP_LEVEL_FIELDS = new Set([
	"id",
	"method",
	"adapter_version",
	"native_cli_version",
	"normalized_schema_version",
	"local_api_version",
	"capability_hash",
	"body",
]);

const METHOD_BODY_FIELDS: Record<RpcMethod, readonly string[]> = {
	"GET /v1/health": [],
	"GET /v1/doctor": [],
	"POST /v1/events": ["idempotencyKey", "event", "adapterRedaction"],
	"POST /v1/events/batch": ["items"],
	"POST /v1/context/pack": ["requestId", "context", "limit", "tokenBudget", "filters", "trace"],
	"POST /v1/search": [
		"requestId",
		"mode",
		"query",
		"repositoryPath",
		"ids",
		"memoryId",
		"depthBefore",
		"depthAfter",
		"includePackContext",
		"filters",
		"limit",
	],
	"POST /v1/retrieval/file-context": [
		"attemptId",
		"startedAt",
		"completedAt",
		"retrievalStatus",
		"candidateIds",
		"candidateCount",
		"selectedIds",
		"failureCode",
		"failureStage",
		"project",
		"repositoryPath",
		"sourceSessionId",
	],
	"POST /v1/retrieval/file-context/delivery": ["attemptId", "status"],
	"GET /v1/memories/:id": ["id", "requestId", "project", "kind"],
	"POST /v1/memories/record": ["idempotencyKey", "kind", "title", "body", "confidence", "project"],
	"DELETE /v1/memories/:id": ["id", "requestId", "expectedRevision"],
	"GET /v1/checkpoints": ["project", "state", "limit"],
	"GET /v1/view": ["collection", "id", "sessionId", "project", "kind", "limit"],
	"POST /v1/backup/create": ["operationId", "payloadHash", "reason"],
	"POST /v1/backup/verify": ["backupId"],
	"POST /v1/backup/restore": ["operationId", "payloadHash", "backupId"],
	"POST /v1/operations/export": ["operationId", "payloadHash", "outputPath", "filters"],
	"POST /v1/operations/import": [
		"operationId",
		"payloadHash",
		"inputPath",
		"remapProject",
		"dryRun",
	],
	"GET /v1/operations/:id": ["id"],
	"POST /v1/jobs": ["kind", "args", "dryRun"],
	"GET /v1/jobs": ["kind", "state", "submittedAfter"],
	"GET /v1/jobs/:id": ["id"],
};

const METHOD_REQUIRED_FIELDS: Record<RpcMethod, readonly string[]> = {
	"GET /v1/health": [],
	"GET /v1/doctor": [],
	"POST /v1/events": ["idempotencyKey", "event"],
	"POST /v1/events/batch": ["items"],
	"POST /v1/context/pack": ["requestId", "context"],
	"POST /v1/search": ["requestId", "mode"],
	"POST /v1/retrieval/file-context": ["attemptId", "startedAt", "completedAt", "retrievalStatus"],
	"POST /v1/retrieval/file-context/delivery": ["attemptId", "status"],
	"GET /v1/memories/:id": ["id", "requestId"],
	"POST /v1/memories/record": ["idempotencyKey", "kind", "title", "body"],
	"DELETE /v1/memories/:id": ["id", "requestId"],
	"GET /v1/checkpoints": [],
	"GET /v1/view": ["collection"],
	"POST /v1/backup/create": ["operationId", "payloadHash", "reason"],
	"POST /v1/backup/verify": ["backupId"],
	"POST /v1/backup/restore": ["operationId", "payloadHash", "backupId"],
	"POST /v1/operations/export": ["operationId", "payloadHash", "outputPath"],
	"POST /v1/operations/import": ["operationId", "payloadHash", "inputPath"],
	"GET /v1/operations/:id": ["id"],
	"POST /v1/jobs": ["kind"],
	"GET /v1/jobs": [],
	"GET /v1/jobs/:id": ["id"],
};

const VIEW_COLLECTIONS = new Set([
	"sessions",
	"projects",
	"memories",
	"observations",
	"summaries",
	"session",
	"memory",
	"artifacts",
	"raw-events",
	"raw-events-status",
	"stats",
	"runtime",
	"usage",
	"observer-status",
	"config",
]);

const PERSISTED_ID_FIELDS = new Set(["idempotencyKey", "requestId", "operationId", "backupId"]);

const FILTER_FIELDS = new Set([
	"kind",
	"session_id",
	"since",
	"working_set_paths",
	"project",
	"scope_id",
	"include_scope_ids",
	"exclude_scope_ids",
	"visibility",
	"include_visibility",
	"exclude_visibility",
	"include_workspace_ids",
	"exclude_workspace_ids",
	"include_workspace_kinds",
	"exclude_workspace_kinds",
	"include_actor_ids",
	"exclude_actor_ids",
	"include_trust_states",
	"exclude_trust_states",
	"ownership_scope",
	"personal_first",
	"trust_bias",
	"widen_shared_when_weak",
	"widen_shared_min_personal_results",
	"widen_shared_min_personal_score",
	"widen_project_when_weak",
	"widen_project_min_results",
	"widen_project_min_score",
	"widen_project_max_results",
]);
const STRING_FILTER_FIELDS = new Set(["kind", "since", "project", "ownership_scope", "trust_bias"]);
const STRING_ARRAY_FILTER_FIELDS = new Set([
	"working_set_paths",
	"include_scope_ids",
	"exclude_scope_ids",
	"include_visibility",
	"exclude_visibility",
	"include_workspace_ids",
	"exclude_workspace_ids",
	"include_workspace_kinds",
	"exclude_workspace_kinds",
	"include_actor_ids",
	"exclude_actor_ids",
	"include_trust_states",
	"exclude_trust_states",
]);
const STRING_OR_ARRAY_FILTER_FIELDS = new Set(["scope_id", "visibility"]);
const BOOLEAN_OR_STRING_FILTER_FIELDS = new Set([
	"personal_first",
	"widen_shared_when_weak",
	"widen_project_when_weak",
]);
const NUMBER_FILTER_FIELDS = new Set([
	"widen_shared_min_personal_results",
	"widen_shared_min_personal_score",
	"widen_project_min_results",
	"widen_project_min_score",
	"widen_project_max_results",
]);

class RpcRequestError extends Error {
	readonly code = "invalid_request";

	constructor(message: string) {
		super(message);
		this.name = "RpcRequestError";
	}
}

export type ProtocolVersions = {
	localApi: number;
	normalizedSchema: number;
};

export type DaemonRpcContext = {
	identity: RpcIdentity;
	dataDir: string;
	deadlineMs?: number;
	now?: () => number;
	onStop: () => void;
	writer: WriterActor;
	store: MemoryStore;
};

export function mapPeerConnectError(error: NodeJS.ErrnoException): TypedRpcError {
	if (error.code === "EACCES") {
		return typedError("peer_denied", "Peer is not allowed to connect to the daemon socket.");
	}
	if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
		return typedError("daemon_unavailable", "Daemon is not running.", true);
	}
	return typedError("peer_denied", error.message || "Peer connection failed.");
}

function typedError(code: string, message: string, retryable = false): TypedRpcError {
	return { error: { code, message, retryable } };
}

function isSafePersistedText(value: unknown, maxBytes: number): value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		Buffer.byteLength(value, "utf8") > maxBytes
	) {
		return false;
	}
	const intake = applyDaemonIntake({ id: value }, { allowlist: ["id"] });
	return intake.sensitivity === "normal" && intake.payload.id === value;
}

function unknownFields(
	value: Record<string, unknown>,
	allowed: ReadonlySet<string> | readonly string[],
): string[] {
	const allow = allowed instanceof Set ? allowed : new Set(allowed);
	return Object.keys(value).filter((key) => !allow.has(key));
}

function parseRequest(raw: string): RpcRequest | TypedRpcError {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return typedError("invalid_json", "RPC request is not valid JSON.");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return typedError("invalid_json", "RPC request must be a JSON object.");
	}
	const object = parsed as Record<string, unknown>;
	const extra = unknownFields(object, TOP_LEVEL_FIELDS);
	if (extra.length > 0) {
		return typedError("unknown_field", `Unknown RPC field: ${extra[0]}`);
	}
	if (typeof object.id !== "string" || object.id.length === 0) {
		return typedError("invalid_request", "RPC request id is required.");
	}
	if (typeof object.method !== "string") {
		return typedError("unknown_method", "RPC method is required.");
	}
	if (
		typeof object.adapter_version !== "string" ||
		typeof object.native_cli_version !== "string" ||
		typeof object.normalized_schema_version !== "number" ||
		typeof object.local_api_version !== "number" ||
		typeof object.capability_hash !== "string"
	) {
		return typedError("protocol_mismatch", "RPC handshake fields are missing or mistyped.");
	}
	if (
		object.body !== undefined &&
		(typeof object.body !== "object" || object.body === null || Array.isArray(object.body))
	) {
		return typedError("invalid_request", "RPC body must be an object.");
	}
	return object as RpcRequest;
}

function handshakeError(request: RpcRequest): TypedRpcError | null {
	if (request.local_api_version !== LOCAL_API_VERSION) {
		return typedError("protocol_mismatch", "local_api_version is incompatible.");
	}
	if (request.normalized_schema_version !== NORMALIZED_SCHEMA_VERSION) {
		return typedError("protocol_mismatch", "normalized_schema_version is incompatible.");
	}
	if (request.capability_hash !== RPC_CAPABILITY_HASH) {
		return typedError("protocol_mismatch", "capability_hash is incompatible.");
	}
	return null;
}

function isRpcMethod(method: string): method is RpcMethod {
	return (RPC_METHODS as readonly string[]).includes(method);
}

function protocolVersions(): ProtocolVersions {
	return { localApi: LOCAL_API_VERSION, normalizedSchema: NORMALIZED_SCHEMA_VERSION };
}

async function handleMethod(
	method: RpcMethod,
	body: Record<string, unknown>,
	ctx: DaemonRpcContext,
	normalizedSchemaVersion: number,
): Promise<Record<string, unknown>> {
	if (method === "GET /v1/health") {
		return {
			status: "ok",
			instanceId: ctx.identity.nonce,
			protocolVersion: protocolVersions(),
			spool: spoolHealth(ctx.dataDir),
		};
	}
	if (method === "GET /v1/doctor") {
		return {
			status: "ok",
			instanceId: ctx.identity.nonce,
			protocolVersion: protocolVersions(),
			diagnostics: {
				pid: ctx.identity.pid,
				dataDir: ctx.dataDir,
				lock: "held",
				socket: "listening",
				platform: process.platform,
				spool: spoolHealth(ctx.dataDir),
				hookDelivery: {
					implementation: "node-fallback",
					p95TargetMs: 150,
					budgets: HOOK_DELIVERY_BUDGETS,
				},
			},
		};
	}
	if (method === "POST /v1/backup/create") {
		const proof = await createCanonicalBackup({
			dataDir: ctx.dataDir,
			operationId: String(body.operationId),
			reason: String(body.reason),
			payloadHash: String(body.payloadHash),
		});
		return {
			operationId: proof.backupId,
			backupId: proof.backupId,
			state: "completed",
			artifactSha256: proof.artifactSha256,
		};
	}
	if (method === "POST /v1/backup/verify") {
		const check = verifyCanonicalBackup({
			dataDir: ctx.dataDir,
			backupId: String(body.backupId),
		});
		return {
			backupId: check.backupId,
			valid: check.valid,
			manifestHash: check.manifestHash,
			diagnostics: check.diagnostics,
		};
	}
	if (method === "POST /v1/events") {
		let adapterRedaction: SpoolRedactionMetadata | undefined;
		try {
			adapterRedaction =
				body.adapterRedaction === undefined
					? undefined
					: validateSpoolRedaction(body.adapterRedaction);
		} catch {
			throw new RpcRequestError("adapterRedaction is malformed.");
		}
		return handleEvent(ctx, body, normalizedSchemaVersion, adapterRedaction);
	}
	if (method === "POST /v1/events/batch") {
		return handleEventBatch(ctx, body, normalizedSchemaVersion);
	}
	if (method === "POST /v1/memories/record") {
		return handleRemember(ctx, body);
	}
	if (method === "DELETE /v1/memories/:id") {
		return handleForget(ctx, body);
	}
	if (method === "POST /v1/context/pack") {
		return handlePack(ctx, body);
	}
	if (method === "POST /v1/search") {
		return handleSearch(ctx, body);
	}
	if (method === "POST /v1/retrieval/file-context") {
		return handleFileContextRetrieval(ctx, body as FileContextRetrievalAttempt);
	}
	if (method === "POST /v1/retrieval/file-context/delivery") {
		return handleFileContextDelivery(ctx, body);
	}
	if (method === "GET /v1/memories/:id") {
		return handleMemoryGet(ctx, body);
	}
	if (method === "GET /v1/checkpoints") {
		return { checkpoints: [] };
	}
	if (method === "GET /v1/view") {
		return handleView(ctx, body);
	}
	if (method === "POST /v1/jobs") {
		return { jobId: null, state: "not_implemented", kind: body.kind };
	}
	if (method === "GET /v1/jobs") {
		return { jobs: [] };
	}
	if (method === "GET /v1/jobs/:id") {
		return { job: null, id: body.id };
	}
	return {
		operationId: body.operationId ?? body.id,
		state: "not_implemented",
	};
}

function strongestSensitivity(
	claimed: "normal" | "private" | "secret",
	detected: "normal" | "private" | "secret",
): "normal" | "private" | "secret" {
	if (claimed === "secret" || detected === "secret") return "secret";
	if (claimed === "private" || detected === "private") return "private";
	return "normal";
}

function mergedRedaction(
	intake: RedactionResult,
	previous?: SpoolRedactionMetadata,
	claimed: SpoolRedactionMetadata["sensitivity"] = "normal",
): SpoolRedactionMetadata {
	const versions = [...new Set([intake.secret_rules_version, previous?.secret_rules_version])]
		.filter((value): value is string => typeof value === "string")
		.sort();
	return {
		sensitivity: strongestSensitivity(
			strongestSensitivity(claimed, intake.sensitivity),
			previous?.sensitivity ?? "normal",
		),
		secret_rules_version: versions.join("+"),
		redaction_degraded: intake.degraded || (previous?.redaction_degraded ?? false),
		private_content_omitted:
			intake.private_content_omitted || (previous?.private_content_omitted ?? false),
		local_only: intake.local_only || (previous?.local_only ?? false),
	};
}

function normalizedEvent(
	body: Record<string, unknown>,
	normalizedSchemaVersion: number,
	previousRedaction?: SpoolRedactionMetadata,
): Record<string, unknown> {
	const event = asObject(body.event);
	try {
		validateNormalizedEvent(event, normalizedSchemaVersion);
	} catch (error) {
		throw new RpcRequestError(error instanceof Error ? error.message : "event is invalid.");
	}
	const intake = applyDaemonIntake(event, {
		allowlist: [...NORMALIZED_EVENT_FIELDS],
		metadataKeys: NORMALIZED_EVENT_FIELDS.filter((field) => field !== "payload"),
	});
	const payload = intake.payload;
	if (!Object.hasOwn(payload, "payload")) payload.payload = {};
	let validated: ReturnType<typeof validateNormalizedEvent>;
	try {
		validated = validateNormalizedEvent(payload, normalizedSchemaVersion);
	} catch (error) {
		throw new RpcRequestError(error instanceof Error ? error.message : "event is invalid.");
	}
	const { eventId, idempotencyKey, sensitivity } = validated;
	if (idempotencyKey !== body.idempotencyKey) {
		throw new RpcRequestError("event.idempotencyKey must match the request envelope.");
	}
	const redaction = mergedRedaction(intake, previousRedaction, sensitivity);
	if (redaction.sensitivity === "secret") payload.payload = {};
	return {
		...payload,
		eventId,
		sensitivity: redaction.sensitivity,
		secret_rules_version: redaction.secret_rules_version,
		redaction_degraded: redaction.redaction_degraded,
		private_content_omitted: redaction.private_content_omitted,
		local_only: redaction.local_only,
	};
}

function handleEvent(
	ctx: DaemonRpcContext,
	body: Record<string, unknown>,
	normalizedSchemaVersion: number,
	previousRedaction?: SpoolRedactionMetadata,
): Record<string, unknown> {
	const event = normalizedEvent(body, normalizedSchemaVersion, previousRedaction);
	const eventId = String(event.eventId);
	const eventType = String(event.kind);
	const nativeSessionId = String(event.nativeSessionId);
	const source = event.agent === "claude-code" ? "claude" : String(event.agent);
	const occurredAtMs = Date.parse(String(event.occurredAt));
	const { payload, ...normalizedMetadata } = event;
	const rawPayload =
		payload && typeof payload === "object" && !Array.isArray(payload)
			? { ...(payload as Record<string, unknown>), ...event, _normalized: normalizedMetadata }
			: { ...event, _normalized: normalizedMetadata };
	const receipt = dispatchClassA(ctx.writer, {
		method: "POST /v1/events",
		idempotencyKey: String(body.idempotencyKey),
		payload: { event },
		apply: () => {
			ctx.store.updateRawEventSessionMeta({
				opencodeSessionId: nativeSessionId,
				source,
				cwd: String(event.cwd),
				project: String(event.projectKey),
				startedAt: eventType === "session_started" ? String(event.occurredAt) : null,
				lastSeenTsWallMs: occurredAtMs,
			});
			const recorded = ctx.store.recordRawEventsBatch(
				nativeSessionId,
				[
					{
						event_id: eventId,
						event_type: eventType,
						payload: rawPayload,
						ts_wall_ms: occurredAtMs,
					},
				],
				source,
			);
			if (recorded.inserted === 0 && recorded.skipped === 0) {
				throw new Error("event was not persisted.");
			}
			return { inserted: recorded.inserted, skipped: recorded.skipped };
		},
	});
	return { receiptId: receipt.receiptId, status: receipt.status };
}

function handleEventBatch(
	ctx: DaemonRpcContext,
	body: Record<string, unknown>,
	normalizedSchemaVersion: number,
): Record<string, unknown> {
	if (!Array.isArray(body.items)) {
		throw new RpcRequestError("items must be an array.");
	}
	if (body.items.length === 0 || body.items.length > 200) {
		throw new RpcRequestError("items must contain between 1 and 200 entries.");
	}
	const rows = body.items.map((item) => {
		const row = asObject(item);
		const extra = unknownFields(row, ["idempotencyKey", "event"]);
		if (extra.length > 0) {
			throw new RpcRequestError(`Unknown batch item field: ${extra[0]}`);
		}
		if (typeof row.idempotencyKey !== "string" || row.idempotencyKey.length === 0) {
			throw new RpcRequestError("idempotencyKey is required for every batch item.");
		}
		if (!isSafePersistedText(row.idempotencyKey, 256)) {
			throw new RpcRequestError("idempotencyKey is invalid for a batch item.");
		}
		asObject(row.event);
		return row;
	});
	const receipts = rows.map((row) => {
		try {
			return handleEvent(
				ctx,
				{
					idempotencyKey: row.idempotencyKey,
					event: row.event,
				},
				normalizedSchemaVersion,
			);
		} catch (error) {
			if (error instanceof MutationConflictError) {
				return { receiptId: error.receipt.receiptId, status: "conflict" };
			}
			throw error;
		}
	});
	return { receipts };
}

function handleRemember(
	ctx: DaemonRpcContext,
	body: Record<string, unknown>,
	previousRedaction?: SpoolRedactionMetadata,
): Record<string, unknown> {
	let kind: string;
	try {
		kind = validateMemoryKind(String(body.kind));
	} catch {
		throw new RpcRequestError("kind is unsupported.");
	}
	if (body.project !== undefined && typeof body.project !== "string") {
		throw new RpcRequestError("project must be a string.");
	}
	const intake = applyDaemonIntake(
		{
			kind: body.kind,
			title: body.title,
			body: body.body,
			confidence: body.confidence,
			project: body.project,
		},
		{
			allowlist: ["kind", "title", "body", "confidence", "project"],
			metadataKeys: ["kind", "confidence", "project"],
		},
	);
	const redaction = mergedRedaction(intake, previousRedaction);
	const payload: Record<string, unknown> = { ...intake.payload, kind };
	if (redaction.sensitivity === "secret") {
		delete payload.title;
		delete payload.body;
	}
	const confidence = payload.confidence ?? 0.5;
	if (
		typeof confidence !== "number" ||
		!Number.isFinite(confidence) ||
		confidence < 0 ||
		confidence > 1
	) {
		throw new RpcRequestError("confidence must be a number between 0 and 1.");
	}
	const receipt = dispatchClassA(ctx.writer, {
		method: "POST /v1/memories/record",
		idempotencyKey: String(body.idempotencyKey),
		payload: { ...payload, redaction },
		apply: () => {
			const sessionId = ensureSession(ctx.writer, optionalString(payload.project));
			const memoryId = ctx.store.remember(
				sessionId,
				kind,
				String(payload.title ?? ""),
				String(payload.body ?? ""),
				confidence,
				undefined,
				redaction,
			);
			return { memoryId };
		},
	});
	return {
		receiptId: receipt.receiptId,
		memoryId: receipt.result.memoryId,
	};
}

export function dispatchSpoolMutation(
	ctx: DaemonRpcContext,
	entry: SpoolEntry,
): SpoolImportOutcome {
	try {
		if (entry.method === "POST /v1/events") {
			handleEvent(ctx, entry.body, NORMALIZED_SCHEMA_VERSION, entry.redaction);
		} else {
			handleRemember(ctx, entry.body, entry.redaction);
		}
		return "committed";
	} catch (error) {
		if (error instanceof MutationConflictError) return "conflict";
		throw error;
	}
}

function handleForget(
	ctx: DaemonRpcContext,
	body: Record<string, unknown>,
): Record<string, unknown> {
	const id = requirePositiveInt(body.id);
	const expectedRevision =
		body.expectedRevision === undefined ? undefined : requirePositiveInt(body.expectedRevision);
	const receipt = dispatchClassA(ctx.writer, {
		method: "DELETE /v1/memories/:id",
		idempotencyKey: String(body.requestId),
		payload: { id, expectedRevision },
		apply: () => {
			if (expectedRevision !== undefined) {
				const current = ctx.writer
					.prepare("SELECT rev FROM memory_items WHERE id = ? LIMIT 1")
					.get(id) as { rev: number } | undefined;
				if (!current || Number(current.rev ?? 0) !== expectedRevision) {
					throw new Error("revision mismatch.");
				}
			}
			ctx.store.forget(id);
			return { forgotten: id };
		},
	});
	return { receiptId: receipt.receiptId, status: receipt.status };
}

function handlePack(ctx: DaemonRpcContext, body: Record<string, unknown>): Record<string, unknown> {
	const filters = parseMemoryFilters(body.filters);
	const limit = parseBoundedInteger(body.limit, 8, 1, 50, "limit");
	const tokenBudget =
		body.tokenBudget === undefined
			? null
			: parseBoundedInteger(body.tokenBudget, 0, 0, Number.MAX_SAFE_INTEGER, "tokenBudget");
	if (body.trace !== undefined && typeof body.trace !== "boolean") {
		throw new RpcRequestError("trace must be a boolean.");
	}
	const receipt = dispatchClassA(ctx.writer, {
		method: "POST /v1/context/pack",
		idempotencyKey: String(body.requestId),
		payload: {
			context: body.context,
			limit: body.limit,
			tokenBudget: body.tokenBudget,
			filters: body.filters,
			trace: body.trace,
		},
		apply: () => ({ recorded: true }),
	});
	const context = String(body.context);
	if (body.trace === true) {
		const artifacts = ctx.store.buildMemoryPackWithTrace(context, limit, tokenBudget, filters);
		return {
			pack: artifacts.response,
			trace: artifacts.trace,
			retrievalReceiptId: receipt.receiptId,
		};
	}
	const pack = ctx.store.buildMemoryPack(context, limit, tokenBudget, filters);
	return {
		pack,
		retrievalReceiptId: receipt.receiptId,
	};
}

const FILE_CONTEXT_ATTEMPT_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILE_CONTEXT_RETRIEVAL_STATUSES = new Set(["succeeded", "no_results", "skipped", "failed"]);

function repositoryRelativePath(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const path = value.trim().replaceAll("\\", "/");
	if (
		!path ||
		!isSafePersistedText(path, 4096) ||
		path.startsWith("/") ||
		/^[A-Za-z]:\//.test(path) ||
		path.split("/").includes("..")
	) {
		return null;
	}
	return path;
}

function fileContextText(value: unknown, field: string, maxBytes: number): string | null {
	if (value === undefined || value === null || value === "") return null;
	if (typeof value !== "string" || !isSafePersistedText(value, maxBytes)) {
		throw new RpcRequestError(`${field} is invalid.`);
	}
	return value;
}

function fileContextTimestamp(value: unknown, field: string): string {
	const timestamp = fileContextText(value, field, 64);
	if (!timestamp || !Number.isFinite(Date.parse(timestamp))) {
		throw new RpcRequestError(`${field} must be an ISO timestamp.`);
	}
	return timestamp;
}

function handleFileContextRetrieval(
	ctx: DaemonRpcContext,
	body: FileContextRetrievalAttempt,
): Record<string, unknown> {
	if (!FILE_CONTEXT_ATTEMPT_ID.test(String(body.attemptId))) {
		throw new RpcRequestError("attemptId is invalid.");
	}
	if (!FILE_CONTEXT_RETRIEVAL_STATUSES.has(String(body.retrievalStatus))) {
		throw new RpcRequestError("retrievalStatus is invalid.");
	}
	const startedAt = fileContextTimestamp(body.startedAt, "startedAt");
	const completedAt = fileContextTimestamp(body.completedAt, "completedAt");
	const startedMs = Date.parse(startedAt);
	const completedMs = Date.parse(completedAt);
	if (completedMs < startedMs) throw new RpcRequestError("completedAt precedes startedAt.");
	const candidateIds = parseIds(body.candidateIds);
	const selectedIds = parseIds(body.selectedIds);
	const candidateCount = parseBoundedInteger(
		body.candidateCount,
		candidateIds.length,
		0,
		200,
		"candidateCount",
	);
	const repositoryPath =
		body.repositoryPath === undefined ? null : repositoryRelativePath(body.repositoryPath);
	if (body.repositoryPath !== undefined && !repositoryPath) {
		throw new RpcRequestError("repositoryPath must be a safe repository-relative path.");
	}
	const project = fileContextText(body.project, "project", 512);
	const sourceSessionId = fileContextText(body.sourceSessionId, "sourceSessionId", 512);
	const failureCode = fileContextText(body.failureCode, "failureCode", 128);
	const failureStage = fileContextText(body.failureStage, "failureStage", 128);
	const outcome = recordRetrievalSurface(ctx.store.db, {
		attemptId: body.attemptId,
		surface: "file_context",
		trigger: "automatic",
		startedAt,
		completedAt,
		retrievalStatus: body.retrievalStatus,
		deliveryStatus: "not_attempted",
		candidateIds,
		candidateCount,
		selectedIds,
		recorderVersion: "claude-file-context-v1",
		sessionId: resolveRetrievalSession(ctx.store.db, "claude", sourceSessionId),
		source: "claude",
		streamId: sourceSessionId,
		sourceSessionId,
		latencyMs: completedMs - startedMs,
		project,
		mode: "claude_pre_tool_use_read",
		filters: project ? { project } : undefined,
		repositoryPaths: repositoryPath ? [repositoryPath] : undefined,
		failureCode,
		failureStage,
	});
	if (!outcome.ok) {
		if (outcome.reason === "invalid_input" || outcome.reason === "idempotency_conflict") {
			throw new RpcRequestError("file-context retrieval attempt is invalid.");
		}
		return { recorded: false, errorCode: outcome.errorCode };
	}
	return { recorded: true, inserted: outcome.value.inserted };
}

function handleFileContextDelivery(
	ctx: DaemonRpcContext,
	body: Record<string, unknown>,
): Record<string, unknown> {
	const attemptId = String(body.attemptId);
	if (!FILE_CONTEXT_ATTEMPT_ID.test(attemptId)) {
		throw new RpcRequestError("attemptId is invalid.");
	}
	const status = String(body.status);
	if (status !== "handed_off" && status !== "failed") {
		throw new RpcRequestError("status is invalid.");
	}
	const outcome = tryUpdateRetrievalDelivery(ctx.store.db, attemptId, status);
	if (!outcome.ok) {
		if (outcome.reason !== "storage_unavailable") {
			throw new RpcRequestError("file-context retrieval delivery is invalid.");
		}
		return { updated: false, errorCode: outcome.errorCode };
	}
	return { updated: outcome.value.changed };
}

function handleSearch(
	ctx: DaemonRpcContext,
	body: Record<string, unknown>,
): Record<string, unknown> {
	const mode = String(body.mode);
	const filters = parseMemoryFilters(body.filters);
	const limit = parseBoundedInteger(body.limit, 10, 1, 100, "limit");
	const ids = parseIds(body.ids);
	const query = typeof body.query === "string" ? body.query : null;
	const repositoryPath = repositoryRelativePath(body.repositoryPath);
	const memoryId = body.memoryId === undefined ? null : requirePositiveInt(body.memoryId);
	const depthBefore = parseBoundedInteger(body.depthBefore, 3, 0, 100, "depthBefore");
	const depthAfter = parseBoundedInteger(body.depthAfter, 3, 0, 100, "depthAfter");
	const supportedMode = [
		"search",
		"search_index",
		"find_by_file",
		"recent",
		"timeline",
		"get_many",
		"explain",
		"expand",
	].includes(mode);
	if (!supportedMode) throw new RpcRequestError(`Unsupported search mode: ${mode}`);
	if ((mode === "search" || mode === "search_index") && !query) {
		throw new RpcRequestError("query is required for search mode.");
	}
	if (mode === "find_by_file" && !repositoryPath) {
		throw new RpcRequestError("repositoryPath must be a safe repository-relative path.");
	}
	if ((mode === "get_many" || mode === "expand") && ids.length === 0) {
		throw new RpcRequestError(`ids are required for ${mode} mode.`);
	}
	if (body.includePackContext !== undefined && typeof body.includePackContext !== "boolean") {
		throw new RpcRequestError("includePackContext must be a boolean.");
	}
	const receipt = dispatchClassA(ctx.writer, {
		method: "POST /v1/search",
		idempotencyKey: String(body.requestId),
		payload: {
			mode: body.mode,
			query: body.query,
			repositoryPath,
			ids: body.ids,
			memoryId,
			depthBefore,
			depthAfter,
			includePackContext: body.includePackContext,
			filters: body.filters,
			limit: body.limit,
		},
		apply: () => ({ recorded: true }),
	});
	let items: unknown;
	if (mode === "search" || mode === "search_index") {
		items = ctx.store.search(query as string, limit, filters);
	} else if (mode === "find_by_file") {
		items = ctx.store.findByFile(repositoryPath as string, {
			limit,
			...(filters?.project ? { project: filters.project } : {}),
		});
	} else if (mode === "recent") {
		items = ctx.store.recent(limit, filters);
	} else if (mode === "timeline") {
		items = ctx.store.timeline(query, memoryId, depthBefore, depthAfter, filters);
	} else if (mode === "get_many") {
		items = ids.flatMap((id) =>
			ctx.store.timeline(null, id, 0, 0, filters).filter((item) => item.id === id),
		);
	} else if (mode === "explain") {
		items = ctx.store.explain(query, ids, limit, filters, {
			includePackContext: body.includePackContext === true,
		});
	} else if (mode === "expand") {
		const seen = new Set<number>();
		items = ids.flatMap((id) => {
			return ctx.store.timeline(null, id, depthBefore, depthAfter, filters).filter((item) => {
				if (seen.has(item.id)) return false;
				seen.add(item.id);
				return true;
			});
		});
	}
	return {
		items,
		retrievalReceiptId: receipt.receiptId,
	};
}

function handleMemoryGet(
	ctx: DaemonRpcContext,
	body: Record<string, unknown>,
): Record<string, unknown> {
	const id = requirePositiveInt(body.id);
	const filters = parseMemoryFilters({
		...(body.project === undefined ? {} : { project: body.project }),
		...(body.kind === undefined ? {} : { kind: body.kind }),
	});
	const receipt = dispatchClassA(ctx.writer, {
		method: "GET /v1/memories/:id",
		idempotencyKey: String(body.requestId),
		payload: { id, project: body.project, kind: body.kind },
		apply: () => ({ recorded: true }),
	});
	let item = ctx.store.get(id);
	if (
		item &&
		((filters?.project !== undefined && item.project !== filters.project) ||
			(filters?.kind !== undefined && item.kind !== filters.kind))
	) {
		item = null;
	}
	return {
		item,
		retrievalReceiptId: receipt.receiptId,
	};
}

function handleView(ctx: DaemonRpcContext, body: Record<string, unknown>): Record<string, unknown> {
	const collection = String(body.collection);
	if (!VIEW_COLLECTIONS.has(collection)) {
		throw new RpcRequestError(`Unknown view collection: ${collection}`);
	}
	const filters = parseMemoryFilters({
		...(body.project === undefined ? {} : { project: body.project }),
		...(body.kind === undefined ? {} : { kind: body.kind }),
		...(body.sessionId === undefined ? {} : { session_id: requirePositiveInt(body.sessionId) }),
	});
	const limit = parseBoundedInteger(body.limit, 100, 1, 100, "limit");
	if (collection === "sessions") {
		const filterResult = buildFilterClausesWithContext(filters, ctx.store.ownershipFilterContext());
		const clauses = [
			"memory_items.session_id = sessions.id",
			"memory_items.active = 1",
			...filterResult.clauses,
		];
		const items = ctx.writer
			.prepare(
				`SELECT sessions.id, sessions.project, sessions.started_at, sessions.cwd
				 FROM sessions
				 WHERE EXISTS (SELECT 1 FROM memory_items WHERE ${clauses.join(" AND ")})
				 ORDER BY sessions.id DESC LIMIT ?`,
			)
			.all(...filterResult.params, limit);
		return { collection, items };
	}
	if (collection === "memories") {
		const items = ctx.store.recent(limit, filters).map(({ id, kind, title, project }) => ({
			id,
			kind,
			title,
			project,
		}));
		return { collection, items };
	}
	if (collection === "stats") {
		return { collection, items: { memories: ctx.store.stats().database.memory_items } };
	}
	return { collection, items: [] };
}

function ensureSession(db: WriterActor, project: string | null): number {
	const existing =
		project === null
			? (db
					.prepare("SELECT id FROM sessions WHERE project IS NULL ORDER BY id DESC LIMIT 1")
					.get() as { id: number } | undefined)
			: (db
					.prepare("SELECT id FROM sessions WHERE project = ? ORDER BY id DESC LIMIT 1")
					.get(project) as { id: number } | undefined);
	if (existing) return existing.id;
	const result = db
		.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
		.run(new Date().toISOString(), project);
	return Number(result.lastInsertRowid);
}

function asObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new RpcRequestError("Expected an object.");
	}
	return value as Record<string, unknown>;
}

function parseMemoryFilters(value: unknown): MemoryFilters | undefined {
	if (value === undefined) return undefined;
	const filters = asObject(value);
	const extra = unknownFields(filters, FILTER_FIELDS);
	if (extra.length > 0) throw new RpcRequestError(`Unknown filter field: ${extra[0]}`);
	for (const [field, item] of Object.entries(filters)) {
		if (STRING_FILTER_FIELDS.has(field) && typeof item !== "string") {
			throw new RpcRequestError(`filters.${field} must be a string.`);
		}
		if (
			STRING_ARRAY_FILTER_FIELDS.has(field) &&
			(!Array.isArray(item) || !item.every((entry) => typeof entry === "string"))
		) {
			throw new RpcRequestError(`filters.${field} must be an array of strings.`);
		}
		if (
			STRING_OR_ARRAY_FILTER_FIELDS.has(field) &&
			typeof item !== "string" &&
			(!Array.isArray(item) || !item.every((entry) => typeof entry === "string"))
		) {
			throw new RpcRequestError(`filters.${field} must be a string or array of strings.`);
		}
		if (
			BOOLEAN_OR_STRING_FILTER_FIELDS.has(field) &&
			typeof item !== "boolean" &&
			typeof item !== "string"
		) {
			throw new RpcRequestError(`filters.${field} must be a boolean or string.`);
		}
		if (NUMBER_FILTER_FIELDS.has(field) && (typeof item !== "number" || !Number.isFinite(item))) {
			throw new RpcRequestError(`filters.${field} must be a finite number.`);
		}
		if (
			field === "session_id" &&
			(typeof item !== "number" || !Number.isInteger(item) || item <= 0)
		) {
			throw new RpcRequestError("filters.session_id must be a positive integer.");
		}
	}
	return filters as MemoryFilters;
}

function parseBoundedInteger(
	value: unknown,
	fallback: number,
	minimum: number,
	maximum: number,
	field: string,
): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
		throw new RpcRequestError(`${field} must be an integer between ${minimum} and ${maximum}.`);
	}
	return value;
}

function parseIds(value: unknown): number[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 200) {
		throw new RpcRequestError("ids must be an array with at most 200 entries.");
	}
	return value.map((entry) => requirePositiveInt(entry));
}

function optionalString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function requirePositiveInt(value: unknown): number {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
	if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
	throw new RpcRequestError("id is invalid.");
}

export async function dispatchDaemonRpc(
	raw: string,
	ctx: DaemonRpcContext,
): Promise<RpcSuccess | TypedRpcError> {
	const started = (ctx.now ?? Date.now)();
	const deadlineMs = ctx.deadlineMs ?? RPC_DEFAULT_DEADLINE_MS;
	const request = parseRequest(raw);
	if ("error" in request) return request;
	const handshake = handshakeError(request);
	if (handshake) return handshake;
	if (!isRpcMethod(request.method)) {
		return typedError("unknown_method", `Unknown RPC method: ${request.method}`);
	}
	const body = request.body ?? {};
	const extra = unknownFields(body, METHOD_BODY_FIELDS[request.method]);
	if (extra.length > 0) {
		return typedError("unknown_field", `Unknown field for ${request.method}: ${extra[0]}`);
	}
	for (const field of METHOD_REQUIRED_FIELDS[request.method]) {
		const value = body[field];
		if (value === undefined || value === null) {
			return typedError("invalid_request", `${field} is required.`);
		}
		if (
			(field === "idempotencyKey" ||
				field === "requestId" ||
				field === "operationId" ||
				field === "payloadHash" ||
				field === "reason" ||
				field === "backupId" ||
				field === "kind" ||
				field === "title" ||
				field === "body" ||
				field === "collection" ||
				field === "mode" ||
				field === "context") &&
			typeof value !== "string"
		) {
			return typedError("invalid_request", `${field} is required.`);
		}
		if (typeof value === "string" && value.length === 0) {
			return typedError("invalid_request", `${field} is required.`);
		}
		if (PERSISTED_ID_FIELDS.has(field) && !isSafePersistedText(value, 256)) {
			return typedError("invalid_request", `${field} is invalid.`);
		}
		if (field === "reason" && !isSafePersistedText(value, 1024)) {
			return typedError("invalid_request", "reason is invalid.");
		}
	}
	const elapsed = (ctx.now ?? Date.now)() - started;
	if (elapsed >= deadlineMs) {
		return typedError("deadline_exceeded", "RPC hard deadline exceeded.", true);
	}
	try {
		return {
			id: request.id,
			result: await handleMethod(request.method, body, ctx, request.normalized_schema_version),
		};
	} catch (error) {
		if (error instanceof RpcRequestError) {
			return typedError(error.code, error.message);
		}
		if (error instanceof BackupRequestError) {
			return typedError(error.code, error.message);
		}
		if (error instanceof MutationConflictError) {
			return typedError(error.code, error.message);
		}
		return typedError("internal_error", "RPC handler failed.");
	}
}

export function attachDaemonRpc(connection: Socket, ctx: DaemonRpcContext): void {
	let buffer = Buffer.alloc(0);
	let done = false;
	const finish = (payload?: RpcSuccess | TypedRpcError) => {
		if (done) return;
		done = true;
		if (payload) {
			try {
				connection.end(`${JSON.stringify(payload)}\n`);
				return;
			} catch {
				// connection already closed
			}
		}
		connection.destroy();
	};
	let dispatching = false;
	connection.on("data", (chunk: Buffer) => {
		if (done || dispatching) return;
		if (buffer.length + chunk.length > RPC_MAX_BYTES) {
			finish(typedError("payload_too_large", `RPC request exceeds ${RPC_MAX_BYTES} bytes.`));
			return;
		}
		buffer = Buffer.concat([buffer, chunk]);
		const newline = buffer.indexOf(0x0a);
		if (newline < 0) return;
		const line = buffer.subarray(0, newline).toString("utf8");
		buffer = buffer.subarray(newline + 1);
		if (line.startsWith("STOP")) {
			const nonce = line.slice(4).trim();
			if (nonce && nonce === ctx.identity.nonce) {
				connection.end(`${JSON.stringify({ status: "stopping" })}\n`);
				ctx.onStop();
			} else {
				connection.end(`${JSON.stringify({ status: "mismatch" })}\n`);
			}
			done = true;
			return;
		}
		dispatching = true;
		void dispatchDaemonRpc(line, ctx).then(finish, () => {
			finish(typedError("internal_error", "RPC handler failed."));
		});
	});
	connection.setTimeout(ctx.deadlineMs ?? RPC_DEFAULT_DEADLINE_MS, () => {
		finish(typedError("deadline_exceeded", "RPC hard deadline exceeded.", true));
	});
}

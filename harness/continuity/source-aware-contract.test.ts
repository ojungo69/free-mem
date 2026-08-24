import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readIJsonFile } from "../schema/jcs.ts";
import { validateContractValue, type JsonSchemaDocument } from "../schema/validate.ts";
import * as contract from "../schema/continuity.ts";

const ROOT_URL = new URL("../schema/continuity.schema.json", import.meta.url);
const CONTRACT_URL = new URL("../schema/source-aware-continuity-contract.v1.json", import.meta.url);
const INVENTORY_URL = new URL("../schema/source-aware-source-inventory.v1.json", import.meta.url);
const CORPUS_URL = new URL("../fixtures/continuity/source-aware-f0-f7.v1.json", import.meta.url);

function loadRequiredJson<T>(url: URL, label: string): T {
  assert.ok(existsSync(fileURLToPath(url)), `${label} is missing`);
  return readIJsonFile<T>(url);
}

test("source-aware S0 machine artifacts exist before contract validation", () => {
  loadRequiredJson<unknown>(CONTRACT_URL, "source-aware contract manifest");
  loadRequiredJson<unknown>(INVENTORY_URL, "source-aware source inventory");
  loadRequiredJson<unknown>(CORPUS_URL, "source-aware F0-F7 corpus");
});

test("continuity schema exposes the source-aware successor bundle", () => {
  const root = loadRequiredJson<JsonSchemaDocument>(ROOT_URL, "continuity schema");
  assert.equal(
    Reflect.get(contract, "SOURCE_AWARE_CONTINUITY_CONTRACT_VERSION"),
    1,
    "TypeScript contract version is missing",
  );
  assert.ok(root.$defs?.SourceAwareContinuityContractV1, "JSON Schema successor bundle is missing");
});

test("source-aware common vocabulary is closed in TypeScript and JSON Schema", () => {
  const root = loadRequiredJson<JsonSchemaDocument>(ROOT_URL, "continuity schema");
  const defs = (root.$defs ?? {}) as Record<string, { enum?: unknown; pattern?: unknown }>;
  const expected = {
    CanonicalClientIdV1: ["claude-code", "codex-cli"],
    SharingScopeV1: ["agent_private", "task_shared", "project_shared", "personal_shared"],
    EgressPolicyV1: ["eligible", "local_only", "prohibited_egress"],
    ResumeProfileV1: ["same_agent", "cross_agent"],
    LegacyMigrationDispositionV1: ["migrate", "legacy_read_only", "quarantine"],
  } as const;
  const runtime = {
    CanonicalClientIdV1: Reflect.get(contract, "CANONICAL_CLIENT_IDS_V1"),
    SharingScopeV1: Reflect.get(contract, "SHARING_SCOPES_V1"),
    EgressPolicyV1: Reflect.get(contract, "EGRESS_POLICIES_V1"),
    ResumeProfileV1: Reflect.get(contract, "RESUME_PROFILES_V1"),
    LegacyMigrationDispositionV1: Reflect.get(contract, "LEGACY_MIGRATION_DISPOSITIONS_V1"),
  };

  assert.deepEqual(runtime, expected);
  for (const [name, values] of Object.entries(expected)) {
    assert.deepEqual(defs[name]?.enum, values, name);
  }
  assert.equal(Reflect.get(contract, "SOURCE_AWARE_SHA256_PATTERN"), "^[0-9a-f]{64}$");
  assert.equal(defs.Sha256Hex?.pattern, "^[0-9a-f]{64}$");
  assert.equal(defs.OpaqueIdV1?.pattern, "^[0-9a-f]{64}$");
});

const US1_FIELDS = {
  OpaqueIdProfileV1: ["algorithm", "keyId", "outputEncoding", "schemaVersion"],
  TaskStateRevisionEnvelopeV1: [
    "committedAt",
    "committedByDaemonId",
    "contentHash",
    "lineageRevisionOrdinal",
    "parentStateRevisions",
    "sourceSessionId",
    "stateRevision",
    "writerEpoch",
  ],
  RevisionCandidateEvaluationV1: [
    "checkpointDisposition",
    "isOrderedHead",
    "lineageRevisionOrdinal",
    "lineageState",
    "reasonCodes",
    "resumeEligible",
    "stateRevision",
    "workspaceCompatibility",
  ],
  ObservedV2: [
    "confidence",
    "evidenceKind",
    "freshness",
    "observedAt",
    "sensitivity",
    "sourceEventIds",
    "truncated",
    "value",
  ],
  ObservedFileV2: [
    "contentHash",
    "existsAtObservation",
    "freshness",
    "observedAt",
    "path",
    "role",
    "sensitivity",
    "sourceEventIds",
  ],
  ObservedCommandV2: [
    "commandDisplay",
    "cwd",
    "evidenceKind",
    "exitCode",
    "observedAt",
    "operationId",
    "sensitivity",
    "sourceEventIds",
    "status",
  ],
  ObservedTestV2: [
    "commandDisplay",
    "evidenceKind",
    "observedAt",
    "operationId",
    "sensitivity",
    "sourceEventIds",
    "status",
    "summary",
    "target",
  ],
  OperationCorrelationV2: [
    "canonicalInputHash",
    "nativeOperationId",
    "operationId",
    "operationMatchKey",
    "sessionId",
    "startEventId",
    "taskLineageId",
    "toolName",
    "turnId",
  ],
  PendingOperationV2: [
    "correlation",
    "description",
    "idempotencyKey",
    "kind",
    "operationId",
    "replayPolicy",
    "sensitivity",
    "sourceEventIds",
    "startLineageRevisionOrdinal",
    "startTurnIdSource",
    "startedAt",
    "status",
    "terminalAt",
    "terminalFingerprint",
    "verificationHint",
  ],
  DroppedEvidenceEntryV2: [
    "adapterDeliveryId",
    "operationId",
    "reason",
    "recordedAtLineageRevisionOrdinal",
    "sensitivity",
    "sourceEventIds",
    "status",
    "terminalFingerprint",
  ],
  DroppedEvidenceReasonWindowV1: [
    "entries",
    "latestRecordedLineageRevisionOrdinal",
    "oldestRetainedLineageRevisionOrdinal",
    "reason",
    "totalOverflowed",
    "totalRecorded",
  ],
  DroppedEvidenceSummaryV1: ["reasonWindows", "totalOverflowed", "totalRecorded"],
  RepositoryStateSnapshotV2: [
    "branchKey",
    "capturedAt",
    "dirtyTreeFingerprint",
    "gitStatusSummary",
    "headSha",
    "repositoryId",
    "upstreamSha",
    "workspaceId",
    "worktreeId",
  ],
  SemanticResumeNoteV2: [
    "blockers",
    "completed",
    "confidence",
    "currentState",
    "goal",
    "modelId",
    "nextActions",
    "promptHash",
    "providerId",
    "schemaVersion",
    "sensitivity",
    "sourceEventIds",
    "unresolvedQuestions",
  ],
} as const;

test("US1 successor primitives expose exact closed shapes", () => {
  const root = loadRequiredJson<JsonSchemaDocument>(ROOT_URL, "continuity schema");
  const defs = (root.$defs ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, expectedFields] of Object.entries(US1_FIELDS)) {
    const def = defs[name];
    assert.ok(def, `${name} definition is missing`);
    assert.equal(def.additionalProperties, false, `${name} must be closed`);
    const properties = def.properties as Record<string, unknown> | undefined;
    assert.deepEqual(Object.keys(properties ?? {}).sort(), [...expectedFields].sort(), name);
  }
  assert.equal((defs.OpaqueIdProfileV1.properties as Record<string, { const?: unknown }>).schemaVersion?.const, 1);
  assert.equal((defs.SemanticResumeNoteV2.properties as Record<string, { const?: unknown }>).schemaVersion?.const, 2);
  assert.equal((defs.DroppedEvidenceReasonWindowV1.properties as Record<string, { maxItems?: number }>).entries?.maxItems, 256);
  assert.equal((defs.SubjectScopeV1.oneOf as unknown[] | undefined)?.length, 7);
  assert.equal((defs.RevisionHeadSelectionContractV1.oneOf as unknown[] | undefined)?.length, 2);
});

test("US1 manual head selection cannot name an older automatic fallback", () => {
  const root = loadRequiredJson<JsonSchemaDocument>(ROOT_URL, "continuity schema");
  const head = "a".repeat(64);
  const older = "b".repeat(64);
  const base = {
    orderingKey: "lineage_revision_ordinal",
    orderedHeadStateRevision: head,
    candidateEvaluations: [
      {
        stateRevision: head,
        lineageRevisionOrdinal: "2",
        isOrderedHead: true,
        workspaceCompatibility: "incompatible",
        checkpointDisposition: "open",
        lineageState: "single",
        resumeEligible: false,
        reasonCodes: ["workspace_incompatible"],
      },
      {
        stateRevision: older,
        lineageRevisionOrdinal: "1",
        isOrderedHead: false,
        workspaceCompatibility: "compatible",
        checkpointDisposition: "open",
        lineageState: "single",
        resumeEligible: true,
        reasonCodes: [],
      },
    ],
    fallbackDisposition: "manual",
  };
  assert.deepEqual(
    validateContractValue("RevisionHeadSelectionContractV1", base, root, contract.CONTINUITY_LIMITS),
    [],
  );
  const invalid = { ...base, automaticResumeHeadStateRevision: older };
  assert.ok(
    validateContractValue("RevisionHeadSelectionContractV1", invalid, root, contract.CONTINUITY_LIMITS).length > 0,
  );
});

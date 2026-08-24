import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalizeJson, readIJsonFile } from "../schema/jcs.ts";
import { validateAgainstSchema, validateContractValue, type JsonSchemaDocument } from "../schema/validate.ts";
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

test("source identity attestation IDs use the opaque profile", () => {
  const root = loadRequiredJson<JsonSchemaDocument>(ROOT_URL, "continuity schema");
  const id = "a".repeat(64);
  const value = {
    clientId: "codex-cli",
    clientVersion: "1",
    adapterId: "codex-hook",
    adapterVersion: "1",
    sessionId: id,
    captureMethod: "hook",
    ingestAttestation: {
      ingestReceiptId: id,
      peerIdentityId: id,
      channel: "rpc",
      attestedAt: "2026-08-24T00:00:00Z",
    },
  };
  assert.deepEqual(validateContractValue("SourceIdentityV1", value, root, contract.CONTINUITY_LIMITS), []);
  assert.ok(
    validateContractValue(
      "SourceIdentityV1",
      { ...value, ingestAttestation: { ...value.ingestAttestation, peerIdentityId: "raw-peer" } },
      root,
      contract.CONTINUITY_LIMITS,
    ).length > 0,
  );
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
  assert.equal((defs.RevisionHeadSelectionContractV1.oneOf as unknown[] | undefined)?.length, 3);
});

function revisionHeadSemanticIssues(value: contract.RevisionHeadSelectionContractV1): string[] {
  const issues: string[] = [];
  const corruptionReasons: contract.RevisionSelectionCorruptionReasonV1[] = [];
  const revisions = value.candidateEvaluations.map(({ stateRevision }) => stateRevision);
  const ordinals = value.candidateEvaluations.map(({ lineageRevisionOrdinal }) => lineageRevisionOrdinal);
  if (new Set(revisions).size !== revisions.length) corruptionReasons.push("duplicate_state_revision");
  if (new Set(ordinals).size !== ordinals.length) corruptionReasons.push("duplicate_lineage_ordinal");
  const ordered = value.candidateEvaluations.filter(({ isOrderedHead }) => isOrderedHead);
  if (ordered.length !== 1) corruptionReasons.push("ordered_head_cardinality");
  const head = ordered[0];
  if (ordered.length === 1 && head?.stateRevision !== value.orderedHeadStateRevision) {
    corruptionReasons.push("ordered_head_reference_mismatch");
  }
  if (
    ordered.length === 1 &&
    head &&
    value.candidateEvaluations.some(
      ({ lineageRevisionOrdinal }) => BigInt(lineageRevisionOrdinal) > BigInt(head.lineageRevisionOrdinal),
    )
  ) {
    corruptionReasons.push("ordered_head_not_greatest");
  }
  for (const candidate of value.candidateEvaluations) {
    const expectedReasons: contract.RevisionEligibilityReasonCodeV1[] = [];
    if (candidate.workspaceCompatibility === "incompatible") expectedReasons.push("workspace_incompatible");
    if (candidate.workspaceCompatibility === "unknown") expectedReasons.push("workspace_unknown");
    if (candidate.checkpointDisposition !== "open") {
      expectedReasons.push(`checkpoint_${candidate.checkpointDisposition}` as contract.RevisionEligibilityReasonCodeV1);
    }
    if (candidate.lineageState === "forked") expectedReasons.push("lineage_forked");
    if (candidate.lineageState === "conflicted") expectedReasons.push("lineage_conflicted");
    const expectedEligible = expectedReasons.length === 0;
    if (candidate.resumeEligible !== expectedEligible) {
      issues.push(`${candidate.stateRevision}: resume eligibility does not match frozen gates`);
    }
    if (candidate.reasonCodes.join() !== expectedReasons.join()) {
      issues.push(`${candidate.stateRevision}: eligibility reasons do not match frozen gates`);
    }
  }
  if (corruptionReasons.length > 0) {
    if (value.fallbackDisposition !== "quarantine") {
      issues.push("selection corruption did not quarantine");
    } else if (value.corruptionReasonCodes.join() !== corruptionReasons.join()) {
      issues.push("selection corruption reasons are not exact");
    }
    return issues;
  }
  if (value.fallbackDisposition === "quarantine") {
    issues.push("valid selection was quarantined");
  } else if ("automaticResumeHeadStateRevision" in value) {
    if (value.automaticResumeHeadStateRevision !== value.orderedHeadStateRevision) {
      issues.push("automatic resume target is not the ordered head");
    }
    if (!head?.resumeEligible) issues.push("automatic resume target is ineligible");
  } else if (head?.resumeEligible) {
    issues.push("eligible ordered head was sent to manual fallback");
  }
  return issues;
}

test("US1 ordered head and automatic resume target remain the same revision", () => {
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
  assert.deepEqual(revisionHeadSemanticIssues(base as contract.RevisionHeadSelectionContractV1), []);
  const invalid = { ...base, automaticResumeHeadStateRevision: older };
  assert.ok(
    validateContractValue("RevisionHeadSelectionContractV1", invalid, root, contract.CONTINUITY_LIMITS).length > 0,
  );

  const automatic = {
    ...base,
    candidateEvaluations: base.candidateEvaluations.map((candidate) =>
      candidate.stateRevision === head
        ? { ...candidate, workspaceCompatibility: "compatible", resumeEligible: true, reasonCodes: [] }
        : { ...candidate, checkpointDisposition: "superseded", resumeEligible: false, reasonCodes: ["checkpoint_superseded"] },
    ),
    automaticResumeHeadStateRevision: older,
    fallbackDisposition: "none",
  } as const;
  assert.deepEqual(
    validateContractValue("RevisionHeadSelectionContractV1", automatic, root, contract.CONTINUITY_LIMITS),
    [],
  );
  assert.ok(revisionHeadSemanticIssues(automatic as contract.RevisionHeadSelectionContractV1).length > 0);

  const duplicateOrdinal = structuredClone(base) as unknown as contract.RevisionHeadSelectionContractV1;
  (duplicateOrdinal.candidateEvaluations[1] as unknown as { lineageRevisionOrdinal: string }).lineageRevisionOrdinal = "2";
  assert.ok(revisionHeadSemanticIssues(duplicateOrdinal).length > 0);
  const quarantinedDuplicate = {
    ...duplicateOrdinal,
    fallbackDisposition: "quarantine",
    corruptionReasonCodes: ["duplicate_lineage_ordinal"],
  } as contract.RevisionHeadSelectionContractV1;
  assert.deepEqual(
    validateContractValue("RevisionHeadSelectionContractV1", quarantinedDuplicate, root, contract.CONTINUITY_LIMITS),
    [],
  );
  assert.deepEqual(revisionHeadSemanticIssues(quarantinedDuplicate), []);

  const multipleHeads = structuredClone(base) as unknown as contract.RevisionHeadSelectionContractV1;
  (multipleHeads.candidateEvaluations[1] as unknown as { isOrderedHead: boolean }).isOrderedHead = true;
  const quarantinedMultiple = {
    ...multipleHeads,
    fallbackDisposition: "quarantine",
    corruptionReasonCodes: ["ordered_head_cardinality"],
  } as contract.RevisionHeadSelectionContractV1;
  assert.deepEqual(revisionHeadSemanticIssues(quarantinedMultiple), []);
  const reversedMultiple = {
    ...quarantinedMultiple,
    candidateEvaluations: [...quarantinedMultiple.candidateEvaluations].reverse(),
  };
  assert.deepEqual(revisionHeadSemanticIssues(reversedMultiple), []);

  const trustedFlag = structuredClone(base) as unknown as contract.RevisionHeadSelectionContractV1;
  const incompatibleHead = trustedFlag.candidateEvaluations[0] as unknown as {
    resumeEligible: boolean;
    reasonCodes: contract.RevisionEligibilityReasonCodeV1[];
  };
  incompatibleHead.resumeEligible = true;
  incompatibleHead.reasonCodes = [];
  assert.ok(revisionHeadSemanticIssues(trustedFlag).length > 0);
});

function droppedEvidenceSemanticIssues(value: contract.DroppedEvidenceSummaryV1): string[] {
  const issues: string[] = [];
  const reasons = value.reasonWindows.map(({ reason }) => reason);
  if (reasons.join() !== contract.DROPPED_EVIDENCE_REASONS_V1.join()) {
    issues.push("dropped-evidence reason windows are not the exact ordered set");
  }
  if (new Set(reasons).size !== reasons.length) issues.push("dropped-evidence reason windows are duplicated");
  for (const window of value.reasonWindows) {
    if (window.entries.some(({ reason }) => reason !== window.reason)) {
      issues.push(`${window.reason}: entry reason does not match its window`);
    }
  }
  return issues;
}

test("US1 dropped evidence retains one independent window per reason", () => {
  const summary: contract.DroppedEvidenceSummaryV1 = {
    totalRecorded: "0",
    totalOverflowed: "0",
    reasonWindows: contract.DROPPED_EVIDENCE_REASONS_V1.map((reason) => ({
      reason,
      totalRecorded: "0",
      totalOverflowed: "0",
      entries: [],
    })),
  };
  assert.deepEqual(droppedEvidenceSemanticIssues(summary), []);
  const duplicate = structuredClone(summary) as unknown as contract.DroppedEvidenceSummaryV1;
  (duplicate.reasonWindows[1] as unknown as { reason: contract.DroppedEvidenceReasonV1 }).reason = "evicted";
  assert.ok(droppedEvidenceSemanticIssues(duplicate).length > 0);
  const missing = structuredClone(summary) as unknown as { reasonWindows: contract.DroppedEvidenceReasonWindowV1[] };
  missing.reasonWindows.pop();
  assert.ok(droppedEvidenceSemanticIssues(missing as unknown as contract.DroppedEvidenceSummaryV1).length > 0);
});

const US4_FIELDS = {
  SourceIdentityV1: [
    "adapterId",
    "adapterVersion",
    "capabilityHash",
    "captureMethod",
    "clientId",
    "clientVersion",
    "deviceId",
    "ingestAttestation",
    "sessionId",
  ],
  LineageSourceSummaryV1: [
    "lastContributingSourceEventId",
    "lineageOriginSourceEventId",
    "participantSourceEventIds",
  ],
  SharedTaskStateV1: [
    "activeFiles",
    "constraints",
    "droppedEvidence",
    "egressPolicy",
    "goal",
    "modifiedFiles",
    "pendingOperations",
    "recentCommands",
    "recentTests",
    "repositoryState",
    "semanticResumeNote",
    "sensitivity",
    "sharingDecisionEventIds",
    "sharingScope",
  ],
  AgentLocalStateV1: [
    "clientId",
    "egressPolicy",
    "hostMetadata",
    "lastAssistantConclusion",
    "latestSubstantivePrompt",
    "nativePlanState",
    "nativeTodoState",
    "sensitivity",
    "sessionId",
    "sharingScope",
    "sourceIdentityEventId",
  ],
  CanonicalWorkStateV2: [
    "agentLocalStates",
    "lineageSourceSummary",
    "opaqueIdProfile",
    "revision",
    "schemaVersion",
    "sensitivity",
    "sharedTaskState",
    "subjectScope",
  ],
  ContinuationCheckpointV3: [
    "canonicalState",
    "checkpointCreatedBySourceEventId",
    "checkpointRevision",
    "contentHash",
    "createdAt",
    "expiresAt",
    "id",
    "kind",
    "memoryWatermark",
    "parentCheckpointId",
    "parentCheckpointRevision",
    "schemaVersion",
    "sensitivity",
    "sourceSessionId",
  ],
  ResumeDestinationV1: [
    "capabilityHash",
    "clientId",
    "clientVersion",
    "privateEligible",
    "sessionId",
  ],
  ResumeCapsuleV2: [
    "ageSeconds",
    "checkpointCreatedBySourceEventId",
    "checkpointId",
    "checkpointRevision",
    "destination",
    "destinationAgentLocalState",
    "injectionId",
    "lineageSourceSummary",
    "reconciliation",
    "resumeProfile",
    "schemaVersion",
    "selectedMemoryIds",
    "sharedTaskState",
    "subjectScope",
    "warnings",
    "workStateRevision",
  ],
  CanonicalMemoryEntityV1: [
    "canonicalContent",
    "canonicalFactId",
    "contentHash",
    "createdAt",
    "durability",
    "egressPolicy",
    "evidenceSnapshotIds",
    "expiresAt",
    "kind",
    "lifecycle",
    "memoryId",
    "memoryRevision",
    "parentMemoryRevision",
    "normalizationProfileId",
    "opaqueIdProfile",
    "schemaVersion",
    "sensitivity",
    "sharingDecisionEventIds",
    "sharingScope",
    "sourceEventIds",
    "subjectScope",
    "truthState",
    "updatedAt",
    "validFrom",
    "validTo",
  ],
  RawIdentifierEvidencePolicyV1: [
    "allowedRawReaders",
    "externalEgress",
    "migrationScratch",
    "newIntakePersistence",
    "postTransaction",
    "quarantinedArtifactRetention",
    "rawDiagnostics",
    "rawExport",
    "schemaVersion",
    "scratchRetention",
  ],
  ContinuityP0ObservationContractV1: ["entries", "schemaVersion"],
} as const;

test("US4 successor projection and memory schemas expose exact closed shapes", () => {
  const root = loadRequiredJson<JsonSchemaDocument>(ROOT_URL, "continuity schema");
  const defs = (root.$defs ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, expectedFields] of Object.entries(US4_FIELDS)) {
    const def = defs[name];
    assert.ok(def, `${name} definition is missing`);
    assert.equal(def.additionalProperties, false, `${name} must be closed`);
    const properties = def.properties as Record<string, unknown> | undefined;
    assert.deepEqual(Object.keys(properties ?? {}).sort(), [...expectedFields].sort(), name);
  }
  for (const [name, version] of [
    ["CanonicalWorkStateV2", 2],
    ["ContinuationCheckpointV3", 3],
    ["ResumeCapsuleV2", 2],
    ["CanonicalMemoryEntityV1", 1],
    ["RawIdentifierEvidencePolicyV1", 1],
    ["ContinuityP0ObservationContractV1", 1],
  ] as const) {
    const properties = defs[name]?.properties as Record<string, { const?: unknown }> | undefined;
    assert.equal(properties?.schemaVersion?.const, version, name);
  }
});

test("successor observed text fields reject non-string and overlong values", () => {
  const root = loadRequiredJson<JsonSchemaDocument>(ROOT_URL, "continuity schema");
  const defs = (root.$defs ?? {}) as Record<string, { properties?: Record<string, unknown> }>;
  const observed = {
    value: "ok",
    sourceEventIds: ["a".repeat(64)],
    observedAt: "2026-08-24T00:00:00Z",
    evidenceKind: "native",
    confidence: 1,
    freshness: "current",
    truncated: false,
    sensitivity: "normal",
  };
  const schemas = [
    defs.SharedTaskStateV1?.properties?.goal,
    (defs.SharedTaskStateV1?.properties?.constraints as { items?: unknown } | undefined)?.items,
    defs.AgentLocalStateV1?.properties?.latestSubstantivePrompt,
    defs.AgentLocalStateV1?.properties?.lastAssistantConclusion,
  ];
  for (const schema of schemas) {
    assert.ok(schema);
    assert.deepEqual(validateAgainstSchema(observed, schema, root), []);
    assert.ok(validateAgainstSchema({ ...observed, value: 1 }, schema, root).length > 0);
    assert.ok(validateAgainstSchema({ ...observed, value: "x".repeat(8193) }, schema, root).length > 0);
  }
});

test("US4 machine artifacts freeze the inventory and exact F0-F7 set", () => {
  const inventory = loadRequiredJson<{
    inventoryVersion: number;
    baselineCommit: string;
    searches: { id: string; lineCount: number; sha256: string }[];
  }>(INVENTORY_URL, "source-aware source inventory");
  const corpus = loadRequiredJson<{ corpusVersion: number; cases: { id: string }[] }>(
    CORPUS_URL,
    "source-aware F0-F7 corpus",
  );
  const manifest = loadRequiredJson<{
    contractVersion: number;
    artifactSchemas: { name: string; schemaVersion: number }[];
    fixtureCaseIds: string[];
  }>(CONTRACT_URL, "source-aware contract manifest");

  assert.equal(inventory.inventoryVersion, 1);
  assert.equal(inventory.baselineCommit, "cdf90f39f642753a9d72297e3fad41c0deeaaafd");
  assert.equal(inventory.searches.length, 4);
  assert.deepEqual(corpus.cases.map(({ id }) => id), ["F0", "F1", "F2", "F3", "F4", "F5", "F6", "F7"]);
  assert.equal(corpus.corpusVersion, 1);
  assert.deepEqual(manifest.fixtureCaseIds, ["F0", "F1", "F2", "F3", "F4", "F5", "F6", "F7"]);
  assert.deepEqual(manifest.artifactSchemas, [
    { name: "CanonicalWorkStateV2", schemaVersion: 2 },
    { name: "ContinuationCheckpointV3", schemaVersion: 3 },
    { name: "ResumeCapsuleV2", schemaVersion: 2 },
    { name: "CanonicalMemoryEntityV1", schemaVersion: 1 },
  ]);
});

test("US4 raw identifier policy forbids persistence, diagnostics, export, and egress", () => {
  const manifest = loadRequiredJson<{ rawIdentifierEvidencePolicy: Record<string, unknown> }>(
    CONTRACT_URL,
    "source-aware contract manifest",
  );
  assert.deepEqual(manifest.rawIdentifierEvidencePolicy, {
    schemaVersion: 1,
    newIntakePersistence: "none",
    migrationScratch: "memory_only",
    scratchRetention: "transaction",
    quarantinedArtifactRetention: "until_user_repair_or_discard",
    allowedRawReaders: ["daemon_validator", "daemon_migrator"],
    rawDiagnostics: "never",
    rawExport: "never",
    externalEgress: "prohibited",
    postTransaction: "zeroize",
  });
});

const CASE_IDS = ["F0", "F1", "F2", "F3", "F4", "F5", "F6", "F7"] as const;
const P0_ISSUES = [46, 49, 53, 61, 62, 56, 57, 32, 58] as const;
const EXPECTED_P0_OBSERVATION_HASHES: Readonly<Record<number, string>> = {
  46: "b342269952b5f3e8023f8498ff2028c76cbda4fb82b2bc5826036fef39c53968",
  49: "fd12a79a19603b8119b6c0cbd450b9d475f68e79257306d95abe973274d8b947",
  53: "5b1bd6726ec40ac5ebf0c0984c437ac66de01ec8761fcbe261739a2a97fe534b",
  61: "2e3cc879ae69ba383b61ae4aca5eb1b27bf0ed15712b30c45f54352a107d9746",
  62: "5524ddf667888f07797cf0be741ab1edaae60597e7df7781d1ae72246559f0dd",
  56: "af3c1869cbdc0cd57d048461f6ada5300ecb0243f19b0ccca557d35affccdfa2",
  57: "f13b8c3d9631e8da08ee1afd8c5daeb25b5be93895fd5c48aa51098db9fdebf1",
  32: "e738d0f70bef3b484dd325169d9fc25b2526c898a20796056bbad35931f7567e",
  58: "3976713e648161c10750ffed74791d478040d05a1ed519f591ac0908dff54149",
};

function corpusSemanticIssues(corpus: contract.SourceAwareContractCorpusV1): string[] {
  const issues: string[] = [];
  const caseIds = corpus.cases.map(({ id }) => id);
  if (JSON.stringify(caseIds) !== JSON.stringify(CASE_IDS)) issues.push("case IDs are not exact F0-F7");
  if (new Set(caseIds).size !== caseIds.length) issues.push("case IDs are duplicated");

  for (const item of corpus.cases) {
    const sourceIds = new Set(item.input.sources.map(({ id }) => id));
    const sourceAuthenticated = new Map(item.input.sources.map(({ id, authenticated }) => [id, authenticated]));
    const recordIds = new Set(item.input.records.map(({ id }) => id));
    const sharingDecisions = new Map(item.input.sharingDecisions.map((decision) => [decision.id, decision]));
    if (sharingDecisions.size !== item.input.sharingDecisions.length) issues.push(`${item.id}: sharing decisions are duplicated`);
    if (!sourceIds.has(item.input.destination.sourceId)) issues.push(`${item.id}: destination source is missing`);
    for (const record of item.input.records) {
      if (!sourceIds.has(record.sourceId)) issues.push(`${item.id}: record source ${record.sourceId} is missing`);
      const decisionIds = record.sharingDecisionEventIds ?? [];
      if ([...decisionIds].sort().join() !== decisionIds.join() || new Set(decisionIds).size !== decisionIds.length) {
        issues.push(`${item.id}: ${record.id} sharing-decision refs are not sorted unique`);
      }
      for (const decisionId of decisionIds) {
        if (!sharingDecisions.has(decisionId)) issues.push(`${item.id}: ${record.id} sharing decision is missing`);
      }
    }
    for (const decision of item.input.sharingDecisions) {
      if (decision.authorityKind !== "user" || decision.decision !== "grant") {
        issues.push(`${item.id}: sharing decision is not an explicit user grant`);
      }
      if (
        decision.target.kind === "shared_task_projection" &&
        decision.target.taskLineageId !== decision.subjectScope.taskLineageId
      ) {
        issues.push(`${item.id}: sharing decision target is outside its subject scope`);
      }
    }
    for (const transition of item.input.transitions) {
      if (!sourceIds.has(transition.actorSourceId)) issues.push(`${item.id}: transition source is missing`);
    }
    for (const id of [
      ...item.successor.automaticFullRecordIds,
      ...item.successor.hintOrManualRecordIds,
      ...item.successor.agentLocalRecordIds,
    ]) {
      if (!recordIds.has(id)) issues.push(`${item.id}: delivery record ${id} is missing`);
    }
    for (const id of item.successor.automaticFullRecordIds) {
      const record = item.input.records.find((candidate) => candidate.id === id);
      if (record?.sharingScope !== "agent_private") {
        const recordScope = record?.subjectScope ?? item.input.scope;
        const validDecision = record?.sharingDecisionEventIds?.some((decisionId) => {
          const decision = sharingDecisions.get(decisionId);
          const targetMatches = record?.canonicalFactId
            ? decision?.target.kind === "canonical_memory_entity" &&
              decision.target.canonicalFactId === record.canonicalFactId
            : decision?.target.kind === "shared_task_projection" &&
              decision.target.taskLineageId === recordScope.taskLineageId;
          return (
            decision?.authenticated === true &&
            decision.authorityKind === "user" &&
            decision.decision === "grant" &&
            decision.sharingScope === record?.sharingScope &&
            targetMatches &&
            canonicalizeJson(decision.subjectScope) === canonicalizeJson(recordScope)
          );
        });
        if (!validDecision) issues.push(`${item.id}: automatic shared record ${id} lacks valid consent evidence`);
      }
    }
    for (const evidence of item.successor.sourceEvidence) {
      if (!recordIds.has(evidence.recordId)) issues.push(`${item.id}: evidence record is missing`);
      for (const id of evidence.sourceIds) if (!sourceIds.has(id)) issues.push(`${item.id}: evidence source is missing`);
    }
    for (const id of [
      item.successor.lineage.originSourceId,
      item.successor.lineage.lastContributorSourceId,
      item.successor.lineage.checkpointCreatorSourceId,
      ...item.successor.lineage.participantSourceIds,
      item.successor.authority.authenticatedSourceId,
    ]) {
      if (!sourceIds.has(id)) issues.push(`${item.id}: lineage/authority source ${id} is missing`);
    }
    for (const id of [
      item.successor.lineage.originSourceId,
      item.successor.lineage.lastContributorSourceId,
      item.successor.lineage.checkpointCreatorSourceId,
      ...item.successor.lineage.participantSourceIds,
    ]) {
      if (sourceAuthenticated.get(id) !== true) issues.push(`${item.id}: authoritative lineage uses unverified source ${id}`);
    }
    for (const memory of item.successor.memoryEntities) {
      for (const id of memory.sourceIds) if (!sourceIds.has(id)) issues.push(`${item.id}: memory source is missing`);
    }
    for (const profile of item.successor.retrievalProfiles) {
      for (const id of profile.recordIds) if (!recordIds.has(id)) issues.push(`${item.id}: retrieval record is missing`);
    }
  }

  const byId = new Map(corpus.cases.map((item) => [item.id, item]));
  if (byId.get("F0")?.successor.agentLocalRecordIds.join() !== "native-todo") issues.push("F0 local lane changed");
  if (byId.get("F1")?.successor.automaticFullRecordIds.join() !== "goal,pending-operation") {
    issues.push("F1 shared projection changed");
  }
  if (byId.get("F2")?.successor.sourceEvidence[0]?.sourceIds.join() !== "source-claude") {
    issues.push("F2 relabelled Claude evidence");
  }
  const f3 = byId.get("F3")?.successor.lineage;
  if (
    f3?.originSourceId !== "source-claude" ||
    f3.lastContributorSourceId !== "source-claude" ||
    f3.participantSourceIds.join() !== "source-claude,source-codex" ||
    f3.checkpointCreatorSourceId !== "source-claude"
  ) {
    issues.push("F3 lineage summary changed");
  }
  const f4 = byId.get("F4")?.successor.memoryEntities;
  if (f4?.length !== 1 || f4[0]?.sourceIds.join() !== "source-claude,source-codex") {
    issues.push("F4 is not one entity with two source branches");
  }
  const f5 = byId.get("F5")?.successor.retrievalProfiles;
  if (f5?.map(({ profile }) => profile).join() !== "all_source_project,current_source,named_source,active_task_shared") {
    issues.push("F5 retrieval profiles changed");
  }
  if (
    f5?.some(({ recordIds }) => recordIds.includes("wrong-project")) ||
    byId.get("F6")?.successor.authority.authenticatedSourceId !== "source-codex" ||
    byId.get("F6")?.successor.authority.automaticResumeAuthorized !== false
  ) {
    issues.push("F5/F6 scope or authority changed");
  }
  const f5WrongProject = byId.get("F5")?.input.records.find(({ id }) => id === "wrong-project")?.subjectScope;
  if (
    f5WrongProject?.personalVaultId !== "vault-a" ||
    f5WrongProject.projectId !== "project-b" ||
    f5WrongProject.workspaceId !== "workspace-b"
  ) {
    issues.push("F5 wrong-project scope is not explicit");
  }
  const f6 = byId.get("F6");
  const f6Source = f6?.input.sources[0];
  if (
    f6?.input.sources.length !== 1 ||
    f6Source?.canonicalClientId !== "codex-cli" ||
    f6Source.claimedClientId !== "claude-code" ||
    !f6Source.authenticated ||
    f6.successor.sourceEvidence[0]?.sourceIds.join() !== "source-codex" ||
    f6.successor.lineage.originSourceId !== "source-codex" ||
    f6.successor.lineage.lastContributorSourceId !== "source-codex" ||
    f6.successor.lineage.participantSourceIds.join() !== "source-codex" ||
    f6.successor.lineage.checkpointCreatorSourceId !== "source-codex"
  ) {
    issues.push("F6 caller claim became authoritative provenance");
  }
  const f7 = byId.get("F7");
  const f7Delivered = new Set([
    ...(f7?.successor.automaticFullRecordIds ?? []),
    ...(f7?.successor.hintOrManualRecordIds ?? []),
  ]);
  for (const denied of [
    "private-record",
    "private-no-consent",
    "secret-record",
    "local-only-record",
    "wrong-vault",
    "wrong-project",
    "wrong-workspace",
  ]) {
    if (f7Delivered.has(denied)) issues.push(`F7 delivered denied record ${denied}`);
  }
  const f7Private = f7?.input.records.find(({ id }) => id === "private-record");
  const f7NoConsent = f7?.input.records.find(({ id }) => id === "private-no-consent");
  if (!f7Private?.sharingDecisionEventIds?.length || f7NoConsent?.sharingDecisionEventIds?.length) {
    issues.push("F7 does not separate privateEligible failure from missing consent");
  }
  const f7Scopes = new Map(
    f7?.input.records.filter(({ subjectScope }) => subjectScope).map(({ id, subjectScope }) => [id, subjectScope]),
  );
  if (
    f7Scopes.get("wrong-vault")?.personalVaultId !== "vault-b" ||
    f7Scopes.get("wrong-project")?.projectId !== "project-b" ||
    f7Scopes.get("wrong-workspace")?.workspaceId !== "workspace-b"
  ) {
    issues.push("F7 does not cover vault/project/workspace mismatches separately");
  }
  for (const reason of ["local_only", "scope_mismatch"] as const) {
    if (!f7?.successor.downgradeReasonCodes.includes(reason)) issues.push(`F7 missing ${reason} disposition`);
  }
  if ((f7?.successor.automaticFullRecordIds.length ?? -1) !== 0) issues.push("F7 automatic full is not empty");
  return issues;
}

function contractSemanticIssues(value: contract.SourceAwareContinuityContractV1): string[] {
  const issues: string[] = [];
  if (value.fixtureCaseIds.join() !== CASE_IDS.join()) issues.push("manifest fixture IDs changed");
  if (value.continuityP0Observations.entries.map(({ issueNumber }) => issueNumber).join() !== P0_ISSUES.join()) {
    issues.push("P0 issue observations are not the exact ordered set");
  }
  for (const entry of value.continuityP0Observations.entries) {
    const entryHash = createHash("sha256").update(canonicalizeJson(entry), "utf8").digest("hex");
    if (entryHash !== EXPECTED_P0_OBSERVATION_HASHES[entry.issueNumber]) {
      issues.push(`#${entry.issueNumber} observation fixture changed`);
    }
    if ((entry.input as Record<string, contract.JsonValue>).fixtureVersion !== 1) {
      issues.push(`#${entry.issueNumber} observation fixture version missing`);
    }
  }
  if (
    JSON.stringify(value.stateNeutralTransitionPolicy) !==
    JSON.stringify({
      schemaVersion: 1,
      classifications: contract.STATE_TRANSITION_CLASSIFICATIONS_V1,
      stateNeutralClassification: "ledger_only",
      canonicalStateEffect: "reuse_revision",
      receiptLedgerEffect: "insert_once",
      receiptKeyProfile: "adapter_delivery_id_else_canonical_fingerprint_v1",
      receiptUniquenessScope: "task_lineage_event_store",
      receiptCollisionDisposition: "quarantine",
      duplicateReceiptDisposition: "return_existing",
      diagnosticAuditEffect: "record_bounded",
      coverageWatermarkEffect: "advance",
      transactionBoundary: "same_daemon_transaction",
    })
  ) {
    issues.push("state-neutral transition authority changed");
  }
  if (
    JSON.stringify(value.sharingDecisionPolicy) !==
    JSON.stringify({
      schemaVersion: 1,
      authority: "explicit_user",
      scopeMatch: "exact",
      targetMatch: "exact",
      invalidDisposition: "reject",
      referenceOrder: "sorted_unique",
    })
  ) {
    issues.push("sharing decision authority changed");
  }
  if (
    JSON.stringify(value.agentLocalLanePolicy) !==
    JSON.stringify({
      schemaVersion: 1,
      laneKeyFields: ["clientId", "sessionId"],
      canonicalStateCardinality: "at_most_one_per_key",
      capsuleCardinality: "zero_or_one",
      destinationBinding: "client_and_session",
      sourceIdentityBinding: "client_and_session",
      duplicateDisposition: "quarantine",
      nonMatchingCapsuleDisposition: "reject",
    })
  ) {
    issues.push("Agent-local lane policy changed");
  }
  const raw = value.rawIdentifierEvidencePolicy;
  if (
    raw.newIntakePersistence !== "none" ||
    raw.migrationScratch !== "memory_only" ||
    raw.scratchRetention !== "transaction" ||
    raw.rawDiagnostics !== "never" ||
    raw.rawExport !== "never" ||
    raw.externalEgress !== "prohibited" ||
    raw.postTransaction !== "zeroize"
  ) {
    issues.push("raw identifier policy permits persistence or disclosure");
  }
  const hashProfile = value.canonicalStateHashProfile;
  if (
    hashProfile.contentProjectionFields.join() !==
    "schemaVersion,subjectScope,opaqueIdProfile,lineageSourceSummary,sharedTaskState,agentLocalStates,sensitivity"
  ) {
    issues.push("canonical state content projection changed");
  }
  if (
    hashProfile.revisionMetadataFields.join() !==
    "parentStateRevisions,lineageRevisionOrdinal,committedByDaemonId,writerEpoch,sourceSessionId,committedAt"
  ) {
    issues.push("canonical state revision metadata changed");
  }
  const vector = hashProfile.testVector;
  const contentHash = createHash("sha256").update(canonicalizeJson(vector.contentProjection), "utf8").digest("hex");
  if (contentHash !== vector.contentHash) issues.push("canonical state content hash vector changed");
  const stateRevision = createHash("sha256")
    .update(
      canonicalizeJson({
        domain: hashProfile.stateRevisionDomain,
        contentHash: vector.contentHash,
        revision: vector.revisionMetadata,
      }),
      "utf8",
    )
    .digest("hex");
  if (stateRevision !== vector.stateRevision) issues.push("canonical state revision vector changed");
  const checkpointProfile = value.checkpointHashProfile;
  if (
    checkpointProfile.contentProjectionFields.join() !==
    "schemaVersion,kind,sourceSessionId,checkpointCreatedBySourceEventId,canonicalState,memoryWatermark,sensitivity,createdAt,expiresAt"
  ) {
    issues.push("checkpoint content projection changed");
  }
  const checkpointVector = checkpointProfile.testVector;
  const canonicalState = {
    ...(vector.contentProjection as Record<string, contract.JsonValue>),
    revision: {
      ...(vector.revisionMetadata as Record<string, contract.JsonValue>),
      contentHash: vector.contentHash,
      stateRevision: vector.stateRevision,
    },
  };
  const checkpointContentProjection = {
    ...(checkpointVector.envelope as Record<string, contract.JsonValue>),
    canonicalState,
  };
  const checkpointContentHash = createHash("sha256")
    .update(canonicalizeJson(checkpointContentProjection), "utf8")
    .digest("hex");
  if (checkpointContentHash !== checkpointVector.contentHash) issues.push("checkpoint content hash vector changed");
  const checkpointRevision = (transition: contract.JsonValue) =>
    createHash("sha256")
      .update(
        canonicalizeJson({
          domain: checkpointProfile.checkpointRevisionDomain,
          checkpointId: checkpointVector.checkpointId,
          transition,
          contentHash: checkpointVector.contentHash,
        }),
        "utf8",
      )
      .digest("hex");
  if (checkpointRevision({ kind: "initial" }) !== checkpointVector.initialCheckpointRevision) {
    issues.push("initial checkpoint revision vector changed");
  }
  if (
    checkpointRevision({
      kind: "parent",
      parentCheckpointId: checkpointVector.parentCheckpointId,
      parentCheckpointRevision: checkpointVector.parentCheckpointRevision,
    }) !== checkpointVector.childCheckpointRevision
  ) {
    issues.push("child checkpoint revision vector changed");
  }
  const memoryProfile = value.canonicalMemoryHashProfile;
  if (
    memoryProfile.contentProjectionFields.join() !==
    "schemaVersion,subjectScope,opaqueIdProfile,kind,normalizationProfileId,canonicalContent,canonicalFactId,sharingScope,sensitivity,egressPolicy,lifecycle,truthState,durability,validFrom,validTo,expiresAt" ||
    memoryProfile.revisionMetadataFields.join() !==
      "sharingDecisionEventIds,sourceEventIds,evidenceSnapshotIds,createdAt,updatedAt"
  ) {
    issues.push("canonical memory hash projection changed");
  }
  const memoryVector = memoryProfile.testVector;
  const memoryContentHash = createHash("sha256")
    .update(canonicalizeJson(memoryVector.contentProjection), "utf8")
    .digest("hex");
  if (memoryContentHash !== memoryVector.contentHash) issues.push("canonical memory content hash vector changed");
  const memoryContent = memoryVector.contentProjection as Record<string, contract.JsonValue>;
  const canonicalFactId = createHash("sha256")
    .update(
      canonicalizeJson({
        schema: "CanonicalMemoryEntityV1",
        subjectScope: memoryContent.subjectScope,
        kind: memoryContent.kind,
        normalizationProfileId: memoryContent.normalizationProfileId,
        canonicalContent: memoryContent.canonicalContent,
      }),
      "utf8",
    )
    .digest("hex");
  if (canonicalFactId !== memoryContent.canonicalFactId) issues.push("canonical fact identity vector changed");
  const memoryRevision = (transition: contract.JsonValue) =>
    createHash("sha256")
      .update(
        canonicalizeJson({
          domain: memoryProfile.memoryRevisionDomain,
          memoryId: memoryVector.memoryId,
          transition,
          contentHash: memoryVector.contentHash,
          revision: memoryVector.revisionMetadata,
        }),
        "utf8",
      )
      .digest("hex");
  if (memoryRevision({ kind: "initial" }) !== memoryVector.initialMemoryRevision) {
    issues.push("initial memory revision vector changed");
  }
  if (
    memoryRevision({ kind: "parent", parentMemoryRevision: memoryVector.parentMemoryRevision }) !==
    memoryVector.childMemoryRevision
  ) {
    issues.push("child memory revision vector changed");
  }
  const opaque = value.opaqueIdConformanceProfile;
  if (opaque.messageFields.join() !== "domain,kind,value") issues.push("opaque ID message framing changed");
  if (opaque.idKinds.join() !== contract.OPAQUE_ID_KINDS_V1.join()) issues.push("opaque ID kind vocabulary changed");
  const opaqueVector = opaque.testVector;
  const derivedOpaqueId = createHmac("sha256", Buffer.from(opaqueVector.keyHex, "hex"))
    .update(canonicalizeJson(opaqueVector.input), "utf8")
    .digest("hex");
  if (derivedOpaqueId !== opaqueVector.opaqueId) issues.push("opaque ID conformance vector changed");
  return issues;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface FrozenSearchCandidate {
  readonly searchId: string;
  readonly path: string;
  readonly line: string;
  readonly record: string;
}

function inventoryCoverageIssues(
  inventory: contract.SourceIdentityInventoryV1,
  candidates: readonly FrozenSearchCandidate[],
): string[] {
  const issues: string[] = [];
  const searchById = new Map(inventory.searches.map((search) => [search.id, search]));
  const entryIds = new Set(inventory.entries.map(({ id }) => id));
  const ruleIds = inventory.candidateRules.map(({ id }) => id);
  if (new Set(ruleIds).size !== ruleIds.length) issues.push("candidate rule IDs are duplicated");
  const matchedRuleIds = new Set<string>();

  for (const rule of inventory.candidateRules) {
    for (const searchId of rule.searchIds) {
      const search = searchById.get(searchId);
      if (!search) issues.push(`${rule.id}: unknown search ${searchId}`);
      else if (search.coverageMode !== "partition") issues.push(`${rule.id}: snapshot search cannot own candidates`);
    }
    if ("inventoryEntryId" in rule && !entryIds.has(rule.inventoryEntryId)) {
      issues.push(`${rule.id}: unknown inventory entry`);
    }
  }

  for (const candidate of candidates) {
    const search = searchById.get(candidate.searchId);
    if (search?.coverageMode !== "partition") continue;
    const matches = inventory.candidateRules.filter(
      (rule) => rule.searchIds.includes(candidate.searchId) && new RegExp(rule.recordPattern).test(candidate.record),
    );
    if (matches.length !== 1) {
      issues.push(`${candidate.searchId}:${candidate.path}:${candidate.line}: matched ${matches.length} candidate rules`);
      continue;
    }
    const rule = matches[0]!;
    matchedRuleIds.add(rule.id);
    const highRiskPath =
      candidate.path === "harness/continuity/reference-model.ts" ||
      candidate.path === "harness/schema/continuity.ts" ||
      candidate.path === "harness/schema/continuity.schema.json";
    if (highRiskPath && "supportingReason" in rule) {
      issues.push(`${candidate.path}:${candidate.line}: normative/runtime sourceAgent was classified as supporting`);
    }
  }

  for (const rule of inventory.candidateRules) {
    if (!matchedRuleIds.has(rule.id)) issues.push(`${rule.id}: candidate rule is unused`);
  }
  return issues;
}

test("source-aware JSON artifacts satisfy schema, hashes, inventory, and semantic invariants", () => {
  const root = loadRequiredJson<JsonSchemaDocument>(ROOT_URL, "continuity schema");
  const inventory = loadRequiredJson<contract.SourceIdentityInventoryV1>(INVENTORY_URL, "source inventory");
  const corpus = loadRequiredJson<contract.SourceAwareContractCorpusV1>(CORPUS_URL, "F0-F7 corpus");
  const manifest = loadRequiredJson<contract.SourceAwareContinuityContractV1>(CONTRACT_URL, "contract manifest");

  assert.deepEqual(validateContractValue("SourceIdentityInventoryV1", inventory, root, contract.CONTINUITY_LIMITS), []);
  assert.deepEqual(validateContractValue("SourceAwareContractCorpusV1", corpus, root, contract.CONTINUITY_LIMITS), []);
  assert.deepEqual(validateContractValue("SourceAwareContinuityContractV1", manifest, root, contract.CONTINUITY_LIMITS), []);
  assert.deepEqual(corpusSemanticIssues(corpus), []);
  assert.deepEqual(contractSemanticIssues(manifest), []);
  const hashVector = manifest.canonicalStateHashProfile.testVector;
  const vectorState = {
    ...(hashVector.contentProjection as Record<string, contract.JsonValue>),
    revision: {
      ...(hashVector.revisionMetadata as Record<string, contract.JsonValue>),
      contentHash: hashVector.contentHash,
      stateRevision: hashVector.stateRevision,
    },
  };
  assert.deepEqual(validateContractValue("CanonicalWorkStateV2", vectorState, root, contract.CONTINUITY_LIMITS), []);
  const checkpointVector = manifest.checkpointHashProfile.testVector;
  const checkpoint = {
    ...(checkpointVector.envelope as Record<string, contract.JsonValue>),
    id: checkpointVector.checkpointId,
    checkpointRevision: checkpointVector.initialCheckpointRevision,
    canonicalState: vectorState,
    contentHash: checkpointVector.contentHash,
  };
  assert.deepEqual(validateContractValue("ContinuationCheckpointV3", checkpoint, root, contract.CONTINUITY_LIMITS), []);
  const childCheckpoint = {
    ...checkpoint,
    checkpointRevision: checkpointVector.childCheckpointRevision,
    parentCheckpointId: checkpointVector.parentCheckpointId,
    parentCheckpointRevision: checkpointVector.parentCheckpointRevision,
  };
  assert.deepEqual(validateContractValue("ContinuationCheckpointV3", childCheckpoint, root, contract.CONTINUITY_LIMITS), []);
  const memoryVector = manifest.canonicalMemoryHashProfile.testVector;
  const memory = {
    ...(memoryVector.contentProjection as Record<string, contract.JsonValue>),
    ...(memoryVector.revisionMetadata as Record<string, contract.JsonValue>),
    memoryId: memoryVector.memoryId,
    memoryRevision: memoryVector.initialMemoryRevision,
    contentHash: memoryVector.contentHash,
  };
  assert.deepEqual(validateContractValue("CanonicalMemoryEntityV1", memory, root, contract.CONTINUITY_LIMITS), []);
  const childMemory = {
    ...memory,
    memoryRevision: memoryVector.childMemoryRevision,
    parentMemoryRevision: memoryVector.parentMemoryRevision,
  };
  assert.deepEqual(validateContractValue("CanonicalMemoryEntityV1", childMemory, root, contract.CONTINUITY_LIMITS), []);

  const rootBytes = readFileSync(fileURLToPath(ROOT_URL));
  const inventoryBytes = readFileSync(fileURLToPath(INVENTORY_URL));
  const corpusBytes = readFileSync(fileURLToPath(CORPUS_URL));
  assert.equal(manifest.schemaHash, sha256(rootBytes));
  assert.equal(manifest.inventoryHash, sha256(inventoryBytes));
  assert.equal(manifest.fixtureCorpusHash, sha256(corpusBytes));
  const { contractHash: _excluded, ...hashInput } = manifest;
  assert.equal(
    manifest.contractHash,
    createHash("sha256").update(canonicalizeJson(hashInput), "utf8").digest("hex"),
  );

  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const candidates: FrozenSearchCandidate[] = [];
  for (const search of inventory.searches) {
    const pathspecs = [
      ...search.includePaths,
      ...search.excludePaths.map((path) => `:(exclude)${path}`),
    ];
    const output = execFileSync(
      "git",
      ["grep", "-n", "-I", "-E", search.pattern, inventory.baselineCommit, "--", ...pathspecs],
      { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 },
    );
    const lines = output.toString("utf8").trimEnd().split("\n");
    assert.equal(lines.length, search.lineCount, search.id);
    assert.equal(sha256(output), search.sha256, search.id);
    for (const line of lines) {
      const match = /^[^:]+:([^:]+):(\d+):(.*)$/.exec(line);
      assert.ok(match, `${search.id}: unexpected git grep output`);
      const [, path, lineNumber, text] = match;
      candidates.push({ searchId: search.id, path, line: lineNumber, record: `${path}\t${lineNumber}\t${text}` });
    }
  }
  assert.deepEqual(inventoryCoverageIssues(inventory, candidates), []);
});

test("source-aware negative self-mutations are rejected", () => {
  const corpus = loadRequiredJson<contract.SourceAwareContractCorpusV1>(CORPUS_URL, "F0-F7 corpus");
  const manifest = loadRequiredJson<contract.SourceAwareContinuityContractV1>(CONTRACT_URL, "contract manifest");

  const missingF7 = structuredClone(corpus) as unknown as { cases: contract.SourceAwareContractCaseV1[] };
  missingF7.cases.pop();
  assert.ok(corpusSemanticIssues(missingF7 as unknown as contract.SourceAwareContractCorpusV1).length > 0);

  const forgedAuthority = structuredClone(corpus) as unknown as { cases: contract.SourceAwareContractCaseV1[] };
  const f6 = forgedAuthority.cases.find(({ id }) => id === "F6");
  assert.ok(f6);
  (f6.successor.authority as { automaticResumeAuthorized: boolean }).automaticResumeAuthorized = true;
  assert.ok(corpusSemanticIssues(forgedAuthority as unknown as contract.SourceAwareContractCorpusV1).length > 0);

  const privateLeak = structuredClone(corpus) as unknown as { cases: contract.SourceAwareContractCaseV1[] };
  const f7 = privateLeak.cases.find(({ id }) => id === "F7");
  assert.ok(f7);
  (f7.successor.automaticFullRecordIds as string[]).push("private-record");
  assert.ok(corpusSemanticIssues(privateLeak as unknown as contract.SourceAwareContractCorpusV1).length > 0);

  const evidenceLoss = structuredClone(corpus) as unknown as { cases: contract.SourceAwareContractCaseV1[] };
  const f4 = evidenceLoss.cases.find(({ id }) => id === "F4");
  assert.ok(f4);
  (f4.successor.memoryEntities[0]!.sourceIds as string[]).pop();
  assert.ok(corpusSemanticIssues(evidenceLoss as unknown as contract.SourceAwareContractCorpusV1).length > 0);

  const forgedLineage = structuredClone(corpus) as unknown as { cases: contract.SourceAwareContractCaseV1[] };
  const authorityCase = forgedLineage.cases.find(({ id }) => id === "F6");
  assert.ok(authorityCase);
  (authorityCase.input.sources[0] as unknown as { authenticated: boolean }).authenticated = false;
  assert.ok(corpusSemanticIssues(forgedLineage as unknown as contract.SourceAwareContractCorpusV1).length > 0);

  for (const mutation of ["unknown", "unauthenticated", "wrong_scope", "wrong_target", "wrong_sharing_scope"] as const) {
    const badDecision = structuredClone(corpus) as unknown as { cases: contract.SourceAwareContractCaseV1[] };
    const sharedCase = badDecision.cases.find(({ id }) => id === "F1");
    assert.ok(sharedCase);
    const goal = sharedCase.input.records.find(({ id }) => id === "goal");
    const decision = sharedCase.input.sharingDecisions.find(({ id }) => id === "decision-goal");
    assert.ok(goal && decision);
    if (mutation === "unknown") {
      (goal.sharingDecisionEventIds as string[])[0] = "missing-decision";
    } else if (mutation === "unauthenticated") {
      (decision as unknown as { authenticated: boolean }).authenticated = false;
    } else if (mutation === "wrong_scope") {
      (decision.subjectScope as unknown as { projectId: string }).projectId = "project-b";
    } else if (mutation === "wrong_target") {
      (decision.target as { taskLineageId: string }).taskLineageId = "lineage-b";
    } else {
      (decision as unknown as { sharingScope: contract.SharingGrantScopeV1 }).sharingScope = "project_shared";
    }
    assert.ok(corpusSemanticIssues(badDecision as unknown as contract.SourceAwareContractCorpusV1).length > 0, mutation);
  }

  const missingObservation = structuredClone(manifest) as unknown as contract.SourceAwareContinuityContractV1;
  (missingObservation.continuityP0Observations.entries as contract.ContinuityP0ObservationEntryV1[]).pop();
  assert.ok(contractSemanticIssues(missingObservation).length > 0);

  const rawExport = structuredClone(manifest) as unknown as contract.SourceAwareContinuityContractV1;
  (rawExport.rawIdentifierEvidencePolicy as { rawExport: string }).rawExport = "allowed";
  assert.ok(contractSemanticIssues(rawExport).length > 0);

  const circularHash = structuredClone(manifest) as unknown as contract.SourceAwareContinuityContractV1;
  (circularHash.canonicalStateHashProfile.testVector.contentProjection as Record<string, contract.JsonValue>).revision = {
    stateRevision: circularHash.canonicalStateHashProfile.testVector.stateRevision,
  };
  assert.ok(contractSemanticIssues(circularHash).length > 0);

  const stateNeutralRevision = structuredClone(manifest) as unknown as contract.SourceAwareContinuityContractV1;
  (stateNeutralRevision.stateNeutralTransitionPolicy as unknown as { canonicalStateEffect: string }).canonicalStateEffect =
    "new_revision";
  assert.ok(contractSemanticIssues(stateNeutralRevision).length > 0);

  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const inventory = loadRequiredJson<contract.SourceIdentityInventoryV1>(INVENTORY_URL, "source inventory");
  const partitionSearch = inventory.searches.find(({ coverageMode }) => coverageMode === "partition");
  assert.ok(partitionSearch);
  const output = execFileSync(
    "git",
    [
      "grep",
      "-n",
      "-I",
      "-E",
      partitionSearch.pattern,
      inventory.baselineCommit,
      "--",
      ...partitionSearch.includePaths,
      ...partitionSearch.excludePaths.map((path) => `:(exclude)${path}`),
    ],
    { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
  );
  const candidates = output.trimEnd().split("\n").map((line): FrozenSearchCandidate => {
    const match = /^[^:]+:([^:]+):(\d+):(.*)$/.exec(line);
    assert.ok(match);
    const [, path, lineNumber, text] = match;
    return { searchId: partitionSearch.id, path, line: lineNumber, record: `${path}\t${lineNumber}\t${text}` };
  });
  const missingOwner = structuredClone(inventory) as unknown as contract.SourceIdentityInventoryV1;
  (missingOwner.candidateRules as contract.SourceInventoryCandidateRuleV1[]).pop();
  assert.ok(inventoryCoverageIssues(missingOwner, candidates).length > 0);
  const duplicateOwner = structuredClone(inventory) as unknown as contract.SourceIdentityInventoryV1;
  (duplicateOwner.candidateRules as contract.SourceInventoryCandidateRuleV1[]).push({
    ...(duplicateOwner.candidateRules[0] as contract.SourceInventoryCandidateRuleV1),
    id: "duplicate-owner",
  });
  assert.ok(inventoryCoverageIssues(duplicateOwner, candidates).length > 0);
  const unknownOwner = structuredClone(inventory) as unknown as contract.SourceIdentityInventoryV1;
  const ownedRule = unknownOwner.candidateRules.find(
    (rule): rule is Extract<contract.SourceInventoryCandidateRuleV1, { inventoryEntryId: string }> =>
      "inventoryEntryId" in rule,
  );
  assert.ok(ownedRule);
  (ownedRule as { inventoryEntryId: string }).inventoryEntryId = "missing-entry";
  assert.ok(inventoryCoverageIssues(unknownOwner, candidates).length > 0);

  const hiddenRuntime = structuredClone(inventory) as unknown as contract.SourceIdentityInventoryV1;
  const mutableRules = hiddenRuntime.candidateRules as contract.SourceInventoryCandidateRuleV1[];
  const runtimeRuleIndex = mutableRules.findIndex(({ id }) => id === "ts-normalized-event-source");
  assert.ok(runtimeRuleIndex >= 0);
  const runtimeRule = mutableRules[runtimeRuleIndex]!;
  mutableRules[runtimeRuleIndex] = {
    id: runtimeRule.id,
    searchIds: runtimeRule.searchIds,
    recordPattern: runtimeRule.recordPattern,
    supportingReason: "tooling",
  };
  assert.ok(inventoryCoverageIssues(hiddenRuntime, candidates).length > 0);
});

function sharingDecisionReferenceIssues(ids: readonly string[]): string[] {
  return new Set(ids).size === ids.length && [...ids].sort().join() === ids.join()
    ? []
    : ["sharing-decision references are not sorted unique"];
}

function sharingDecisionSemanticIssues(
  decision: contract.SharingDecisionV1,
  authenticatedAuthorityEvents: ReadonlySet<string>,
  expectedScope: contract.SubjectScopeV1,
  expectedTarget: contract.SharingDecisionTargetV1,
  expectedSharingScope: contract.SharingGrantScopeV1,
): string[] {
  const issues: string[] = [];
  if (!authenticatedAuthorityEvents.has(decision.authoritySourceEventId)) issues.push("sharing authority is unauthenticated");
  if (canonicalizeJson(decision.subjectScope) !== canonicalizeJson(expectedScope)) issues.push("sharing scope target differs");
  if (canonicalizeJson(decision.target) !== canonicalizeJson(expectedTarget)) issues.push("sharing decision target differs");
  if (decision.sharingScope !== expectedSharingScope) issues.push("sharing grant scope differs");
  if (
    decision.target.kind === "shared_task_projection" &&
    (decision.subjectScope.kind !== "task_lineage" ||
      decision.target.taskLineageId !== decision.subjectScope.taskLineageId)
  ) {
    issues.push("shared-task decision target is outside its subject scope");
  }
  return issues;
}

test("sharing decisions bind explicit user authority, exact scope, and exact target", () => {
  const root = loadRequiredJson<JsonSchemaDocument>(ROOT_URL, "continuity schema");
  const id = (value: string) => value.repeat(64);
  const subjectScope: contract.TaskLineageSubjectScopeV1 = {
    kind: "task_lineage",
    personalVaultId: id("a"),
    projectId: id("b"),
    workspaceId: id("c"),
    taskLineageId: id("d"),
  };
  const target: contract.SharedTaskProjectionTargetV1 = {
    kind: "shared_task_projection",
    taskLineageId: subjectScope.taskLineageId,
  };
  const decision: contract.SharingDecisionV1 = {
    schemaVersion: 1,
    decisionEventId: id("e"),
    authoritySourceEventId: id("f"),
    authorityKind: "user",
    decision: "grant",
    subjectScope,
    sharingScope: "task_shared",
    target,
    decidedAt: "2026-08-24T00:00:00Z",
  };
  assert.deepEqual(validateContractValue("SharingDecisionV1", decision, root, contract.CONTINUITY_LIMITS), []);
  assert.deepEqual(
    sharingDecisionSemanticIssues(decision, new Set([decision.authoritySourceEventId]), subjectScope, target, "task_shared"),
    [],
  );
  const reorderedScope = {
    taskLineageId: subjectScope.taskLineageId,
    workspaceId: subjectScope.workspaceId,
    projectId: subjectScope.projectId,
    personalVaultId: subjectScope.personalVaultId,
    kind: "task_lineage",
  } as contract.TaskLineageSubjectScopeV1;
  assert.deepEqual(
    sharingDecisionSemanticIssues(decision, new Set([decision.authoritySourceEventId]), reorderedScope, target, "task_shared"),
    [],
  );
  assert.ok(sharingDecisionSemanticIssues(decision, new Set(), subjectScope, target, "task_shared").length > 0);
  const wrongScope = { ...subjectScope, projectId: id("9") };
  assert.ok(
    sharingDecisionSemanticIssues(
      decision,
      new Set([decision.authoritySourceEventId]),
      wrongScope,
      target,
      "task_shared",
    ).length > 0,
  );
  const wrongTarget: contract.SharedTaskProjectionTargetV1 = { ...target, taskLineageId: id("8") };
  assert.ok(
    sharingDecisionSemanticIssues(
      decision,
      new Set([decision.authoritySourceEventId]),
      subjectScope,
      wrongTarget,
      "task_shared",
    ).length > 0,
  );
  assert.ok(
    sharingDecisionSemanticIssues(
      decision,
      new Set([decision.authoritySourceEventId]),
      subjectScope,
      target,
      "project_shared",
    ).length > 0,
  );
});

interface ResolvedFixtureSourceIdentity {
  readonly clientId: contract.CanonicalClientIdV1;
  readonly sessionId: string;
}

function agentLocalLaneSemanticIssues(
  lanes: readonly contract.AgentLocalStateV1[],
  sourceIdentityByEventId: ReadonlyMap<string, ResolvedFixtureSourceIdentity>,
): string[] {
  const issues: string[] = [];
  const keys = lanes.map(({ clientId, sessionId }) => `${clientId}\0${sessionId}`);
  if (new Set(keys).size !== keys.length) issues.push("Agent-local lane key is duplicated");
  for (const lane of lanes) {
    const resolved = sourceIdentityByEventId.get(lane.sourceIdentityEventId);
    if (!resolved || resolved.clientId !== lane.clientId || resolved.sessionId !== lane.sessionId) {
      issues.push("Agent-local lane does not match its authenticated source identity");
    }
  }
  return issues;
}

function resumeCapsuleSemanticIssues(
  value: contract.ResumeCapsuleV2,
  sourceIdentityByEventId: ReadonlyMap<string, ResolvedFixtureSourceIdentity>,
): string[] {
  const issues: string[] = [];
  issues.push(...sharingDecisionReferenceIssues(value.sharedTaskState.sharingDecisionEventIds));
  if (value.destinationAgentLocalState) {
    issues.push(...agentLocalLaneSemanticIssues([value.destinationAgentLocalState], sourceIdentityByEventId));
  }
  if (
    value.destinationAgentLocalState &&
    value.destinationAgentLocalState.clientId !== value.destination.clientId
  ) {
    issues.push("destination Agent-local lane belongs to another client");
  }
  if (
    value.destinationAgentLocalState &&
    (value.destinationAgentLocalState.sessionId !== value.destination.sessionId ||
      sourceIdentityByEventId.get(value.destinationAgentLocalState.sourceIdentityEventId)?.clientId !==
        value.destination.clientId ||
      sourceIdentityByEventId.get(value.destinationAgentLocalState.sourceIdentityEventId)?.sessionId !==
        value.destination.sessionId)
  ) {
    issues.push("destination Agent-local source event resolves to another client or session");
  }
  if (value.sharedTaskState.repositoryState.workspaceId !== value.subjectScope.workspaceId) {
    issues.push("capsule and shared projection workspace differ");
  }
  return issues;
}

test("successor capsule rejects another client's Agent-local lane", () => {
  const root = loadRequiredJson<JsonSchemaDocument>(ROOT_URL, "continuity schema");
  const manifest = loadRequiredJson<contract.SourceAwareContinuityContractV1>(CONTRACT_URL, "contract manifest");
  const projection = manifest.canonicalStateHashProfile.testVector.contentProjection as unknown as {
    subjectScope: contract.TaskLineageSubjectScopeV1;
    lineageSourceSummary: contract.LineageSourceSummaryV1;
    sharedTaskState: contract.SharedTaskStateV1;
  };
  const id = "a".repeat(64);
  const capsule: contract.ResumeCapsuleV2 = {
    schemaVersion: 2,
    injectionId: id,
    checkpointId: id,
    checkpointRevision: id,
    workStateRevision: id,
    subjectScope: projection.subjectScope,
    lineageSourceSummary: projection.lineageSourceSummary,
    checkpointCreatedBySourceEventId: id,
    destination: { clientId: "codex-cli", clientVersion: "1", sessionId: id, privateEligible: false },
    resumeProfile: "cross_agent",
    ageSeconds: 0,
    reconciliation: "exact",
    sharedTaskState: projection.sharedTaskState,
    destinationAgentLocalState: {
      sharingScope: "agent_private",
      sourceIdentityEventId: id,
      clientId: "codex-cli",
      sessionId: id,
      sensitivity: "normal",
      egressPolicy: "eligible",
    },
    selectedMemoryIds: [],
    warnings: [],
  };
  const sourceClients = new Map<string, ResolvedFixtureSourceIdentity>([
    [id, { clientId: "codex-cli", sessionId: id }],
  ]);
  assert.deepEqual(validateContractValue("ResumeCapsuleV2", capsule, root, contract.CONTINUITY_LIMITS), []);
  assert.deepEqual(resumeCapsuleSemanticIssues(capsule, sourceClients), []);
  const leakedLane = structuredClone(capsule) as unknown as contract.ResumeCapsuleV2;
  (leakedLane.destinationAgentLocalState as unknown as { clientId: contract.CanonicalClientIdV1 }).clientId = "claude-code";
  assert.deepEqual(validateContractValue("ResumeCapsuleV2", leakedLane, root, contract.CONTINUITY_LIMITS), []);
  assert.ok(resumeCapsuleSemanticIssues(leakedLane, sourceClients).length > 0);

  const relabelledLaneSources = new Map<string, ResolvedFixtureSourceIdentity>([
    [id, { clientId: "claude-code", sessionId: id }],
  ]);
  assert.ok(resumeCapsuleSemanticIssues(capsule, relabelledLaneSources).length > 0);
  const oldSessionSources = new Map<string, ResolvedFixtureSourceIdentity>([
    [id, { clientId: "codex-cli", sessionId: "b".repeat(64) }],
  ]);
  assert.ok(resumeCapsuleSemanticIssues(capsule, oldSessionSources).length > 0);

  const privateEligible = structuredClone(capsule) as unknown as contract.ResumeCapsuleV2;
  (privateEligible.destination as unknown as { privateEligible: boolean }).privateEligible = true;
  (privateEligible.sharedTaskState as unknown as { sensitivity: contract.Sensitivity }).sensitivity = "private";
  assert.deepEqual(validateContractValue("ResumeCapsuleV2", privateEligible, root, contract.CONTINUITY_LIMITS), []);
  const missingConsent = structuredClone(privateEligible) as unknown as contract.ResumeCapsuleV2;
  (missingConsent.sharedTaskState.sharingDecisionEventIds as string[]).pop();
  assert.ok(validateContractValue("ResumeCapsuleV2", missingConsent, root, contract.CONTINUITY_LIMITS).length > 0);
  const duplicateConsent = structuredClone(capsule) as unknown as contract.ResumeCapsuleV2;
  (duplicateConsent.sharedTaskState.sharingDecisionEventIds as string[]).push(
    duplicateConsent.sharedTaskState.sharingDecisionEventIds[0]!,
  );
  assert.deepEqual(validateContractValue("ResumeCapsuleV2", duplicateConsent, root, contract.CONTINUITY_LIMITS), []);
  assert.ok(resumeCapsuleSemanticIssues(duplicateConsent, sourceClients).length > 0);
});

test("Agent-local lanes are unique by client and session and match authenticated source identity", () => {
  const eventA = "a".repeat(64);
  const eventB = "b".repeat(64);
  const sessionA = "1".repeat(64);
  const sessionB = "2".repeat(64);
  const lane = (sourceIdentityEventId: string, sessionId: string): contract.AgentLocalStateV1 => ({
    sharingScope: "agent_private",
    sourceIdentityEventId,
    clientId: "codex-cli",
    sessionId,
    sensitivity: "normal",
    egressPolicy: "eligible",
  });
  const lanes = [lane(eventA, sessionA), lane(eventB, sessionB)];
  const sources = new Map<string, ResolvedFixtureSourceIdentity>([
    [eventA, { clientId: "codex-cli", sessionId: sessionA }],
    [eventB, { clientId: "codex-cli", sessionId: sessionB }],
  ]);
  assert.deepEqual(agentLocalLaneSemanticIssues(lanes, sources), []);
  const duplicate = [lanes[0]!, lane(eventB, sessionA)];
  assert.ok(agentLocalLaneSemanticIssues(duplicate, sources).length > 0);
  const relabelled = new Map(sources);
  relabelled.set(eventB, { clientId: "claude-code", sessionId: sessionB });
  assert.ok(agentLocalLaneSemanticIssues(lanes, relabelled).length > 0);
});

test("shared memory requires authenticated consent evidence", () => {
  const root = loadRequiredJson<JsonSchemaDocument>(ROOT_URL, "continuity schema");
  const id = "a".repeat(64);
  const value = {
    schemaVersion: 1,
    memoryId: id,
    memoryRevision: id,
    subjectScope: { kind: "personal_vault", personalVaultId: id },
    opaqueIdProfile: { schemaVersion: 1, algorithm: "hmac-sha-256", keyId: "local-v1", outputEncoding: "lowercase_hex_256" },
    kind: "decision",
    normalizationProfileId: "exact-jcs-v1",
    canonicalContent: { decision: "keep evidence" },
    canonicalFactId: id,
    sharingScope: "personal_shared",
    sharingDecisionEventIds: [],
    sensitivity: "private",
    egressPolicy: "eligible",
    lifecycle: "active",
    truthState: "user_confirmed",
    durability: "durable",
    sourceEventIds: [id],
    evidenceSnapshotIds: [],
    contentHash: id,
    createdAt: "2026-08-24T00:00:00Z",
    updatedAt: "2026-08-24T00:00:00Z",
  };
  assert.ok(validateContractValue("CanonicalMemoryEntityV1", value, root, contract.CONTINUITY_LIMITS).length > 0);
  const normalWithoutConsent = { ...value, sensitivity: "normal", sharingDecisionEventIds: [] };
  assert.ok(
    validateContractValue("CanonicalMemoryEntityV1", normalWithoutConsent, root, contract.CONTINUITY_LIMITS).length > 0,
  );
  const agentPrivate = { ...normalWithoutConsent, sharingScope: "agent_private" };
  assert.deepEqual(validateContractValue("CanonicalMemoryEntityV1", agentPrivate, root, contract.CONTINUITY_LIMITS), []);
  (value.sharingDecisionEventIds as string[]).push(id);
  assert.deepEqual(validateContractValue("CanonicalMemoryEntityV1", value, root, contract.CONTINUITY_LIMITS), []);
  assert.deepEqual(sharingDecisionReferenceIssues(value.sharingDecisionEventIds), []);
  const outOfOrder = ["b".repeat(64), id];
  assert.ok(sharingDecisionReferenceIssues(outOfOrder).length > 0);
  assert.ok(sharingDecisionReferenceIssues([id, id]).length > 0);
});

const EXPECTED_LEGACY_RULES = [
  {
    artifact: "CanonicalWorkStateV1",
    verifiedDisposition: "migrate",
    unresolvedDisposition: "quarantine",
  },
  {
    artifact: "ContinuationCheckpointV2",
    verifiedDisposition: "migrate",
    unresolvedDisposition: "quarantine",
  },
  {
    artifact: "ResumeCapsuleV1",
    verifiedDisposition: "legacy_read_only",
    unresolvedDisposition: "quarantine",
  },
  {
    artifact: "DurableMemory",
    verifiedDisposition: "migrate",
    unresolvedDisposition: "legacy_read_only",
  },
] as const;
const EXPECTED_WORK_STATE_MIGRATION_PRECONDITIONS = [
  "all sourceEventIds resolve to one authenticated source",
  "subject scope is unique",
  "lineage ordinal can be reconstructed",
  "raw identifiers can be opaque-mapped",
  "explicit authenticated sharing authority exists for every shared projection",
] as const;
const TIMESTAMP_REQUIRED_RESTORE_IDS = new Set([
  "persisted-session-task-binding",
  "persisted-task-boundary-proposal",
  "persisted-canonical-work-state-v1",
  "persisted-checkpoint-v2",
  "persisted-checkpoint-disposition-event",
  "persisted-checkpoint-disposition-projection",
  "persisted-engagement-evidence",
  "persisted-contradiction-evidence",
  "persisted-contradiction-scan-range",
  "persisted-engagement-evaluation-context",
  "persisted-checkpoint-delivery-attempt",
  "persisted-resume-suppression",
  "persisted-derived-invalidation-event",
  "persisted-resume-capsule-v1",
  "persisted-durable-memory",
  "persisted-canonical-work-state-v2",
  "persisted-checkpoint-v3",
  "persisted-resume-capsule-v2",
  "persisted-canonical-memory-entity-v1",
  "persisted-sharing-decision-v1",
]);

const EXPECTED_RESTORE_RULE_PATH_HASHES: Readonly<Record<string, string>> = {
  "persisted-session-task-binding": "b3b1753e9836dc2396e74fd89cda95d077f9718f337b2f38e9c201391d928576",
  "persisted-task-boundary-proposal": "1e86cc49da8f7ddbb982574f0198893f62c397b31c9e7536010e1a5946f23cf8",
  "persisted-canonical-work-state-v1": "bc1d8b78fd8e4ea2b685a0cc49d3e73ff9cd7cc0bfed5fe30405972305e6b168",
  "persisted-checkpoint-v2": "96ea68acaea4062d66b61a7594eb2a2c6cc03e24905c87783bc0fcd06878824d",
  "persisted-checkpoint-disposition-event": "17c10122b5de0c7b6062a06c399251c5ebaa1b12380a4ec8562019190d830248",
  "persisted-checkpoint-disposition-projection": "6e087fa686d14e0ebb56eef430cba9b387429acbb88eaab947d78ade11a9b911",
  "persisted-checkpoint-metadata": "8c6bd77a1ab74591b86916989aa5770aeb53042ee68fc2f0e1b26cd6b4fa3bac",
  "persisted-checkpoint-anchor": "7fb3a4f2b99bbd635e41763c77afa4745a96487064b4f2a7f550a34d3b0d80c9",
  "persisted-engagement-evidence": "70296be9c7cb939a40add37a1fe7a297259be8aac6c785abdb087d28b48e3072",
  "persisted-contradiction-evidence": "a0a9bb25b95939ffec91043170e2e0a511ec46cd4d092fdb7785d51f7d24a9b6",
  "persisted-contradiction-scan-range": "9949e73a2cbb581527dbe2c909ad1ae09d254421728b3af9733dfbd9eb0ae1b7",
  "persisted-engagement-evaluation-context": "fc2ebbd4031e39bea6b4d2275697015a418e01b5524fde29d06cca2772446527",
  "persisted-checkpoint-delivery-attempt": "af369b829ced5b53c28c01277f76376f778303d3eb1912ef65f0f301dd61e2d2",
  "persisted-resume-suppression": "6bae00980cf8ba35bcf0639d7c39ef810a7954e843debce664a764ab01c0d54b",
  "persisted-resume-selection-decision": "19f9eaa0ddd53300dcddce3c591024681e1d41dd285d1423838bc968031bcebd",
  "persisted-derived-invalidation-event": "a3d5d6961c0ea1b11c24d4113547b482a79961f9b2345ca9f1caca071e05bcb0",
  "persisted-resume-capsule-v1": "e1f7758c7bb30cad0d51773677fe3288491c961f2cea29077ed7fd25f707ac85",
  "persisted-durable-memory": "7a11699d0a052b6e71601a7712693f8e593c2e06b5b68727179d7a9a16965174",
  "persisted-canonical-work-state-v2": "4385cccbd71d03f1c3b4890c249e2ae10db16c17804804298f9a6068d7bca3aa",
  "persisted-checkpoint-v3": "6dbac301dba6d6f7f0b81ac07e67a3ff6b223413d3015f46ac849d5bad59ff09",
  "persisted-resume-capsule-v2": "018f46170988cffc5c30b6ebe4b5e29e33855b84276b2ed3291df0686055e8f3",
  "persisted-canonical-memory-entity-v1": "383b15285d4ec70db54275c7c5e4606af50f49bd3d8fda60249753c6938c905d",
  "persisted-sharing-decision-v1": "2f96e5868b434b174222015be90ee1d139e3e097644c157fa0d54b4f0e937437",
};

function restoreSemanticIssues(
  inventory: contract.SourceIdentityInventoryV1,
  value: contract.RestoreSemanticValidationContractV1,
): string[] {
  const issues: string[] = [];
  if (value.scopeIdentityPolicy !== "non_blank_and_parent_consistent") issues.push("blank/inconsistent scope allowed");
  if (value.timestampProfile !== "iso-z-nanos-v1-calendar-valid") issues.push("timestamp profile changed");
  const expected = inventory.entries
    .filter(({ surfaceClass, restoreValidationRequired }) => surfaceClass === "persisted" && restoreValidationRequired)
    .map(({ id }) => id)
    .sort();
  const actual = value.rules.map(({ inventoryEntryId }) => inventoryEntryId).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) issues.push("restore rules do not close over inventory");
  if (new Set(actual).size !== actual.length) issues.push("restore rules are duplicated");
  if (Object.keys(EXPECTED_RESTORE_RULE_PATH_HASHES).sort().join() !== expected.join()) {
    issues.push("pinned restore rule hashes do not close over inventory");
  }
  for (const rule of value.rules) {
    if (rule.scopeIdentityPaths.length + rule.isoTimestampPaths.length === 0) {
      issues.push(`${rule.inventoryEntryId}: no semantic paths`);
    }
    if (TIMESTAMP_REQUIRED_RESTORE_IDS.has(rule.inventoryEntryId) && rule.isoTimestampPaths.length === 0) {
      issues.push(`${rule.inventoryEntryId}: timestamp coverage missing`);
    }
    if (rule.invalidDisposition !== "quarantine") issues.push(`${rule.inventoryEntryId}: invalid artifact not quarantined`);
    if (rule.repairAuthorities.join() !== "user") issues.push(`${rule.inventoryEntryId}: repair authority is not user-only`);
    if (!rule.auditRequired) issues.push(`${rule.inventoryEntryId}: repair is not audited`);
    const pathHash = createHash("sha256")
      .update(
        canonicalizeJson({
          scopeIdentityPaths: rule.scopeIdentityPaths,
          isoTimestampPaths: rule.isoTimestampPaths,
          crossFieldRules: rule.crossFieldRules,
        }),
        "utf8",
      )
      .digest("hex");
    if (pathHash !== EXPECTED_RESTORE_RULE_PATH_HASHES[rule.inventoryEntryId]) {
      issues.push(`${rule.inventoryEntryId}: semantic path set changed`);
    }
  }
  return issues;
}

test("US2 legacy migration and restore semantic rules are exact and fail closed", () => {
  const inventory = loadRequiredJson<contract.SourceIdentityInventoryV1>(INVENTORY_URL, "source inventory");
  const manifest = loadRequiredJson<contract.SourceAwareContinuityContractV1>(CONTRACT_URL, "contract manifest");
  assert.deepEqual(
    manifest.legacyMigrationRules.map(({ evidencePreconditions: _ignored, ...rule }) => rule),
    EXPECTED_LEGACY_RULES,
  );
  for (const rule of manifest.legacyMigrationRules) assert.ok(rule.evidencePreconditions.length > 0, rule.artifact);
  const workStateMigration = manifest.legacyMigrationRules.find(({ artifact }) => artifact === "CanonicalWorkStateV1");
  assert.deepEqual(workStateMigration?.evidencePreconditions, EXPECTED_WORK_STATE_MIGRATION_PRECONDITIONS);
  assert.deepEqual(restoreSemanticIssues(inventory, manifest.restoreSemanticValidation), []);

  const byIssue = new Map(manifest.continuityP0Observations.entries.map((entry) => [entry.issueNumber, entry]));
  assert.equal((byIssue.get(56)?.behaviorDeltas[0]?.successor as { disposition?: string })?.disposition, "quarantine");
  assert.equal((byIssue.get(57)?.behaviorDeltas[0]?.successor as { disposition?: string })?.disposition, "quarantine");

  const missingRule = structuredClone(manifest.restoreSemanticValidation) as unknown as {
    schemaVersion: 1;
    rules: contract.RestoreArtifactValidationRuleV1[];
  };
  missingRule.rules.pop();
  assert.ok(
    restoreSemanticIssues(
      inventory,
      missingRule as unknown as contract.RestoreSemanticValidationContractV1,
    ).length > 0,
  );

  const unruledInventory = structuredClone(inventory) as unknown as {
    inventoryVersion: 1;
    baselineCommit: string;
    searches: contract.SourceInventorySearchV1[];
    candidateRules: contract.SourceInventoryCandidateRuleV1[];
    entries: contract.SourceInventoryEntryV1[];
  };
  unruledInventory.entries.push({
    id: "persisted-new-artifact",
    locus: "fixture:new",
    semanticTerm: "new",
    currentMeaning: "new persisted artifact",
    authority: "derived",
    surfaceClass: "persisted",
    disposition: "retain",
    successorTarget: "new",
    migrationCondition: "valid",
    restoreValidationRequired: true,
    schemaDefinition: "NewArtifactV1",
    notes: "mutation",
  });
  assert.ok(
    restoreSemanticIssues(
      unruledInventory as contract.SourceIdentityInventoryV1,
      manifest.restoreSemanticValidation,
    ).length > 0,
  );

  const missingTimestamp = structuredClone(manifest.restoreSemanticValidation) as unknown as {
    schemaVersion: 1;
    scopeIdentityPolicy: "non_blank_and_parent_consistent";
    timestampProfile: "iso-z-nanos-v1-calendar-valid";
    rules: contract.RestoreArtifactValidationRuleV1[];
  };
  const proposalRule = missingTimestamp.rules.find(
    ({ inventoryEntryId }) => inventoryEntryId === "persisted-task-boundary-proposal",
  );
  assert.ok(proposalRule);
  (proposalRule.isoTimestampPaths as string[]).pop();
  assert.ok(restoreSemanticIssues(inventory, missingTimestamp).length > 0);

  const missingOneOfMany = structuredClone(manifest.restoreSemanticValidation) as unknown as {
    schemaVersion: 1;
    scopeIdentityPolicy: "non_blank_and_parent_consistent";
    timestampProfile: "iso-z-nanos-v1-calendar-valid";
    rules: contract.RestoreArtifactValidationRuleV1[];
  };
  const workStateRule = missingOneOfMany.rules.find(
    ({ inventoryEntryId }) => inventoryEntryId === "persisted-canonical-work-state-v1",
  );
  assert.ok(workStateRule);
  (workStateRule.isoTimestampPaths as string[]).pop();
  assert.ok(restoreSemanticIssues(inventory, missingOneOfMany).length > 0);

  const blankScope = structuredClone(manifest.restoreSemanticValidation) as unknown as {
    scopeIdentityPolicy: string;
  };
  blankScope.scopeIdentityPolicy = "allow_blank";
  assert.ok(
    restoreSemanticIssues(
      inventory,
      blankScope as unknown as contract.RestoreSemanticValidationContractV1,
    ).length > 0,
  );

  const unauditedRepair = structuredClone(manifest.restoreSemanticValidation) as unknown as {
    schemaVersion: 1;
    scopeIdentityPolicy: "non_blank_and_parent_consistent";
    timestampProfile: "iso-z-nanos-v1-calendar-valid";
    rules: contract.RestoreArtifactValidationRuleV1[];
  };
  const firstRule = unauditedRepair.rules[0];
  assert.ok(firstRule);
  (firstRule.repairAuthorities as unknown as string[])[0] = "daemon";
  (firstRule as unknown as { auditRequired: boolean }).auditRequired = false;
  assert.ok(restoreSemanticIssues(inventory, unauditedRepair).length > 0);
});

test("US3 limit policies and diagnostic vocabularies are exact", () => {
  const manifest = loadRequiredJson<contract.SourceAwareContinuityContractV1>(CONTRACT_URL, "contract manifest");
  const expectedPolicies = contract.CONTINUITY_LIMIT_NAMES_V1.map((name) => ({
    name,
    limit: contract.CONTINUITY_LIMITS[name],
    disposition: name === "rankedCandidates" ? "select_with_diagnostic" : "reject",
  }));
  assert.deepEqual(manifest.limitPolicies, expectedPolicies);
  assert.deepEqual(manifest.continuityDiagnosticCodes, contract.CONTINUITY_DIAGNOSTIC_CODES_V2);
  assert.deepEqual(manifest.sourceSharingDispositionCodes, contract.SOURCE_SHARING_DISPOSITION_CODES_V1);

  const byIssue = new Map(manifest.continuityP0Observations.entries.map((entry) => [entry.issueNumber, entry]));
  assert.deepEqual([...byIssue.keys()], P0_ISSUES);
  assert.deepEqual(byIssue.get(32)?.behaviorDeltas[0]?.successor, {
    policyCount: 12,
    capacityPolicies: 11,
    selectionPolicies: 1,
    allPathsAgree: true,
  });
  assert.equal(
    (byIssue.get(58)?.behaviorDeltas[0]?.successor as { diagnosticCode?: string })?.diagnosticCode,
    "terminal_sibling_conflict",
  );

  const missingPolicy = structuredClone(manifest) as unknown as contract.SourceAwareContinuityContractV1;
  (missingPolicy.limitPolicies as contract.ContinuityLimitPolicyV1[]).pop();
  assert.notDeepEqual(missingPolicy.limitPolicies, expectedPolicies);

  const silentRankedLimit = structuredClone(manifest) as unknown as contract.SourceAwareContinuityContractV1;
  const ranked = silentRankedLimit.limitPolicies.find(({ name }) => name === "rankedCandidates");
  assert.ok(ranked);
  (ranked as { disposition: string }).disposition = "reject";
  assert.notDeepEqual(silentRankedLimit.limitPolicies, expectedPolicies);

  const missingDiagnostic = structuredClone(manifest) as unknown as contract.SourceAwareContinuityContractV1;
  (missingDiagnostic.continuityDiagnosticCodes as contract.ContinuityDiagnosticCodeV2[]).pop();
  assert.notDeepEqual(missingDiagnostic.continuityDiagnosticCodes, contract.CONTINUITY_DIAGNOSTIC_CODES_V2);
});

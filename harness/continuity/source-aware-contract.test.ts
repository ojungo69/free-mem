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
    privateEligible: false,
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
  const expired = {
    ...base,
    candidateEvaluations: base.candidateEvaluations.map((candidate) =>
      candidate.stateRevision === head
        ? {
            ...candidate,
            workspaceCompatibility: "compatible",
            checkpointDisposition: "expired",
            resumeEligible: false,
            reasonCodes: ["checkpoint_expired"],
          }
        : candidate,
    ),
  } as const;
  assert.deepEqual(
    validateContractValue("RevisionHeadSelectionContractV1", expired, root, contract.CONTINUITY_LIMITS),
    [],
  );
  assert.deepEqual(revisionHeadSemanticIssues(expired as contract.RevisionHeadSelectionContractV1), []);
  const expiredAsUnknown = structuredClone(expired) as unknown as contract.RevisionHeadSelectionContractV1;
  (expiredAsUnknown.candidateEvaluations[0] as unknown as { reasonCodes: string[] }).reasonCodes = [
    "checkpoint_unknown",
  ];
  assert.ok(revisionHeadSemanticIssues(expiredAsUnknown).length > 0);
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
  let totalRecorded = 0n;
  let totalOverflowed = 0n;
  for (const window of value.reasonWindows) {
    if (window.entries.some(({ reason }) => reason !== window.reason)) {
      issues.push(`${window.reason}: entry reason does not match its window`);
    }
    const recorded = BigInt(window.totalRecorded);
    const overflowed = BigInt(window.totalOverflowed);
    totalRecorded += recorded;
    totalOverflowed += overflowed;
    if (recorded !== overflowed + BigInt(window.entries.length)) {
      issues.push(`${window.reason}: counters do not equal overflowed plus retained entries`);
    }
    if (window.entries.length === 0) {
      if (
        window.oldestRetainedLineageRevisionOrdinal !== undefined ||
        window.latestRecordedLineageRevisionOrdinal !== undefined
      ) {
        issues.push(`${window.reason}: empty window has retained ordinal boundaries`);
      }
      continue;
    }
    const ordinals = window.entries.map(({ recordedAtLineageRevisionOrdinal }) =>
      BigInt(recordedAtLineageRevisionOrdinal),
    );
    const oldest = ordinals.reduce((current, ordinal) => (ordinal < current ? ordinal : current));
    const latest = ordinals.reduce((current, ordinal) => (ordinal > current ? ordinal : current));
    if (
      window.oldestRetainedLineageRevisionOrdinal === undefined ||
      BigInt(window.oldestRetainedLineageRevisionOrdinal) !== oldest
    ) {
      issues.push(`${window.reason}: oldest retained ordinal is inconsistent`);
    }
    if (
      window.latestRecordedLineageRevisionOrdinal === undefined ||
      BigInt(window.latestRecordedLineageRevisionOrdinal) !== latest
    ) {
      issues.push(`${window.reason}: latest recorded ordinal is inconsistent`);
    }
  }
  if (BigInt(value.totalRecorded) !== totalRecorded) issues.push("dropped-evidence totalRecorded is inconsistent");
  if (BigInt(value.totalOverflowed) !== totalOverflowed) issues.push("dropped-evidence totalOverflowed is inconsistent");
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

  const retained: contract.DroppedEvidenceSummaryV1 = {
    totalRecorded: "1",
    totalOverflowed: "0",
    reasonWindows: [
      {
        reason: "evicted",
        totalRecorded: "1",
        totalOverflowed: "0",
        oldestRetainedLineageRevisionOrdinal: "7",
        latestRecordedLineageRevisionOrdinal: "7",
        entries: [
          {
            reason: "evicted",
            sourceEventIds: ["a".repeat(64)],
            recordedAtLineageRevisionOrdinal: "7",
            sensitivity: "normal",
          },
        ],
      },
      { reason: "orphaned_terminal", totalRecorded: "0", totalOverflowed: "0", entries: [] },
    ],
  };
  assert.deepEqual(droppedEvidenceSemanticIssues(retained), []);
  for (const mutation of [
    { path: "window recorded", apply: (value: typeof retained) => ((value.reasonWindows[0] as { totalRecorded: string }).totalRecorded = "0") },
    { path: "window overflowed", apply: (value: typeof retained) => ((value.reasonWindows[0] as { totalOverflowed: string }).totalOverflowed = "1") },
    { path: "oldest boundary", apply: (value: typeof retained) => ((value.reasonWindows[0] as { oldestRetainedLineageRevisionOrdinal?: string }).oldestRetainedLineageRevisionOrdinal = "8") },
    { path: "latest boundary", apply: (value: typeof retained) => ((value.reasonWindows[0] as { latestRecordedLineageRevisionOrdinal?: string }).latestRecordedLineageRevisionOrdinal = "6") },
    { path: "aggregate recorded", apply: (value: typeof retained) => ((value as { totalRecorded: string }).totalRecorded = "2") },
    { path: "aggregate overflowed", apply: (value: typeof retained) => ((value as { totalOverflowed: string }).totalOverflowed = "1") },
  ]) {
    const invalid = structuredClone(retained);
    mutation.apply(invalid);
    assert.ok(droppedEvidenceSemanticIssues(invalid).length > 0, mutation.path);
  }
});

test("successor repository snapshots accept SHA-1 and SHA-256 Git object IDs", () => {
  const root = loadRequiredJson<JsonSchemaDocument>(ROOT_URL, "continuity schema");
  const base = {
    repositoryId: "a".repeat(64),
    workspaceId: "b".repeat(64),
    capturedAt: "2026-08-24T00:00:00Z",
  };
  assert.deepEqual(
    validateContractValue(
      "RepositoryStateSnapshotV2",
      { ...base, headSha: "1".repeat(40), upstreamSha: "2".repeat(64) },
      root,
      contract.CONTINUITY_LIMITS,
    ),
    [],
  );
  assert.ok(
    validateContractValue(
      "RepositoryStateSnapshotV2",
      { ...base, headSha: "1".repeat(39) },
      root,
      contract.CONTINUITY_LIMITS,
    ).length > 0,
  );
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
    "privateEligible",
    "sessionId",
  ],
  SharingDecisionV1: [
    "authorityKind",
    "authoritySourceEventId",
    "decidedAt",
    "decision",
    "decisionEventId",
    "privateConsent",
    "schemaVersion",
    "sharingScope",
    "subjectScope",
    "target",
  ],
  SourceAwareFixtureSharingDecisionV1: [
    "authenticated",
    "authorityEventId",
    "authorityKind",
    "decision",
    "id",
    "privateConsent",
    "sharingScope",
    "subjectScope",
    "target",
  ],
  SourceAwareRecordEvidenceExpectationV1: ["recordId", "sourceEvidenceIds", "sourceIds"],
  SourceAwareMemoryExpectationV1: [
    "canonicalFactId",
    "egressPolicy",
    "memoryId",
    "sensitivity",
    "sharingScope",
    "sourceEvidenceIds",
    "sourceIds",
  ],
  SourceAwareMemoryReviewCandidateV1: [
    "canonicalFactId",
    "disposition",
    "egressPolicy",
    "reasonCode",
    "recordId",
    "sensitivity",
    "sharingScope",
    "sourceEvidenceIds",
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
    "sessionId",
    "sourceIdentityEventId",
  ],
  ResumeCapsuleV2: [
    "ageSeconds",
    "checkpointCreatedBySourceEventId",
    "checkpointId",
    "checkpointRevision",
    "contentHash",
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
  const root = loadRequiredJson<JsonSchemaDocument>(ROOT_URL, "continuity schema");
  const inventory = loadRequiredJson<{
    inventoryVersion: number;
    baselineCommit: string;
    searches: { id: string; lineCount: number; sha256: string }[];
  }>(INVENTORY_URL, "source-aware source inventory");
  const corpus = loadRequiredJson<contract.SourceAwareContractCorpusV1>(
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
  assert.ok(
    validateContractValue(
      "SourceAwareArtifactSchemaRefV1",
      { name: "CanonicalWorkStateV2", schemaVersion: 3 },
      root,
      contract.CONTINUITY_LIMITS,
    ).length > 0,
  );
  assert.deepEqual(
    [
      ...new Set(
        corpus.cases.flatMap(({ successor }) =>
          successor.memoryReviewCandidates.map(({ reasonCode }) => reasonCode),
        ),
      ),
    ].sort(),
    ["consent_or_source_locality_mismatch", "policy_tuple_mismatch"],
  );
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
  46: "36248bf0a5f08bac4d152e11d7e9a1cdf9b051b2e6d5b6f9e40d48e6621c1685",
  49: "fd12a79a19603b8119b6c0cbd450b9d475f68e79257306d95abe973274d8b947",
  53: "5b1bd6726ec40ac5ebf0c0984c437ac66de01ec8761fcbe261739a2a97fe534b",
  61: "29ae7df3427b2904343ef1bdbf6b06e8809021d0409a302b5932dd60a3628aac",
  62: "5524ddf667888f07797cf0be741ab1edaae60597e7df7781d1ae72246559f0dd",
  56: "af3c1869cbdc0cd57d048461f6ada5300ecb0243f19b0ccca557d35affccdfa2",
  57: "f13b8c3d9631e8da08ee1afd8c5daeb25b5be93895fd5c48aa51098db9fdebf1",
  32: "e738d0f70bef3b484dd325169d9fc25b2526c898a20796056bbad35931f7567e",
  58: "3976713e648161c10750ffed74791d478040d05a1ed519f591ac0908dff54149",
};

function orderedStringsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isSortedUniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length && orderedStringsEqual([...values].sort(), values);
}

function fixtureRecordHasValidConsent(
  record: contract.SourceAwareFixtureRecordV1,
  recordScope: contract.SourceAwareFixtureScopeV1,
  decisions: ReadonlyMap<string, contract.SourceAwareFixtureSharingDecisionV1>,
): boolean {
  return (record.sharingDecisionEventIds ?? []).some((decisionId) => {
    const decision = decisions.get(decisionId);
    const targetMatches = record.sharingScope === "task_shared"
      ? decision?.target.kind === "shared_task_projection" &&
        decision.target.taskLineageId === recordScope.taskLineageId
      : decision?.target.kind === "canonical_memory_entity" &&
        decision.target.canonicalFactId === record.canonicalFactId;
    return (
      decision?.authenticated === true &&
      decision.authorityKind === "user" &&
      decision.decision === "grant" &&
      decision.sharingScope === record.sharingScope &&
      (record.sensitivity !== "private" || decision.privateConsent) &&
      targetMatches &&
      canonicalizeJson(decision.subjectScope) === canonicalizeJson(recordScope)
    );
  });
}

function fixtureRecordIsPolicyEligible(
  record: contract.SourceAwareFixtureRecordV1,
  caseScope: contract.SourceAwareFixtureScopeV1,
  sources: ReadonlyMap<string, contract.SourceAwareFixtureSourceV1>,
  destination: contract.SourceAwareFixtureSourceV1 | undefined,
  decisions: ReadonlyMap<string, contract.SourceAwareFixtureSharingDecisionV1>,
  requireSharedCapability: boolean,
): boolean {
  const recordScope = record.subjectScope ?? caseScope;
  return (
    record.sharingScope !== "agent_private" &&
    record.sensitivity !== "secret" &&
    record.egressPolicy === "eligible" &&
    sources.get(record.sourceId)?.authenticated === true &&
    destination?.authenticated === true &&
    canonicalizeJson(recordScope) === canonicalizeJson(caseScope) &&
    (record.sensitivity !== "private" || destination.privateEligible) &&
    fixtureRecordHasValidConsent(record, recordScope, decisions) &&
    (!requireSharedCapability || destination.capabilityIds.includes("shared-task-v1"))
  );
}

type FixtureMemoryRecordDisposition = "union_eligible" | contract.SourceAwareMemoryReviewCandidateV1["reasonCode"];

function fixtureMemoryRecordDisposition(
  record: contract.SourceAwareFixtureRecordV1,
  memory: contract.SourceAwareMemoryExpectationV1,
  caseScope: contract.SourceAwareFixtureScopeV1,
  sources: ReadonlyMap<string, contract.SourceAwareFixtureSourceV1>,
  decisions: ReadonlyMap<string, contract.SourceAwareFixtureSharingDecisionV1>,
): FixtureMemoryRecordDisposition {
  if (
    record.sharingScope !== memory.sharingScope ||
    record.sensitivity !== memory.sensitivity ||
    record.egressPolicy !== memory.egressPolicy
  ) {
    return "policy_tuple_mismatch";
  }
  const recordScope = record.subjectScope ?? caseScope;
  const eligible =
    sources.get(record.sourceId)?.authenticated === true &&
    canonicalizeJson(recordScope) === canonicalizeJson(caseScope) &&
    (record.sharingScope === "agent_private"
      ? record.sourceId === memory.sourceIds[0]
      : fixtureRecordHasValidConsent(record, recordScope, decisions));
  return eligible ? "union_eligible" : "consent_or_source_locality_mismatch";
}

function memoryProjectionSemanticIssues(
  item: contract.SourceAwareContractCaseV1,
  sourcesById: ReadonlyMap<string, contract.SourceAwareFixtureSourceV1>,
  sharingDecisions: ReadonlyMap<string, contract.SourceAwareFixtureSharingDecisionV1>,
): string[] {
  const issues: string[] = [];
  const activeUnionRecordIds = new Set<string>();
  for (const memory of item.successor.memoryEntities) {
    for (const id of memory.sourceIds) {
      if (!sourcesById.has(id)) issues.push(`${item.id}: memory source is missing`);
      else if (sourcesById.get(id)?.authenticated !== true) issues.push(`${item.id}: memory source is unauthenticated`);
    }
    const eligibleRecords = item.input.records.filter(
      (record) =>
        record.canonicalFactId === memory.canonicalFactId &&
        fixtureMemoryRecordDisposition(record, memory, item.input.scope, sourcesById, sharingDecisions) ===
          "union_eligible",
    );
    for (const record of eligibleRecords) activeUnionRecordIds.add(record.id);
    const eligibleSources = [...new Set(eligibleRecords.map(({ sourceId }) => sourceId))].sort();
    if (!orderedStringsEqual(eligibleSources, [...memory.sourceIds].sort())) {
      issues.push(`${item.id}: canonical memory union crossed or dropped a policy partition`);
    }
    const eligibleEvidence = [
      ...new Set(eligibleRecords.flatMap(({ sourceEvidenceIds }) => sourceEvidenceIds)),
    ].sort();
    if (!orderedStringsEqual(eligibleEvidence, memory.sourceEvidenceIds)) {
      issues.push(`${item.id}: canonical memory union lost or changed event-level evidence`);
    }
  }
  const activeMemoryFactIds = new Set(item.successor.memoryEntities.map(({ canonicalFactId }) => canonicalFactId));
  const expectedReviewIds = item.input.records
    .filter(
      (record) =>
        record.canonicalFactId !== undefined &&
        activeMemoryFactIds.has(record.canonicalFactId) &&
        !activeUnionRecordIds.has(record.id),
    )
    .map(({ id }) => id)
    .sort();
  const reviewIds = item.successor.memoryReviewCandidates
    .filter(({ canonicalFactId }) => activeMemoryFactIds.has(canonicalFactId))
    .map(({ recordId }) => recordId)
    .sort();
  if (!orderedStringsEqual(expectedReviewIds, reviewIds)) {
    issues.push(`${item.id}: ineligible memory evidence was not preserved for review`);
  }
  for (const candidate of item.successor.memoryReviewCandidates) {
    const record = item.input.records.find(({ id }) => id === candidate.recordId);
    const sameFactMemories = item.successor.memoryEntities.filter(
      ({ canonicalFactId }) => canonicalFactId === candidate.canonicalFactId,
    );
    const dispositions = record
      ? sameFactMemories.map((memory) =>
          fixtureMemoryRecordDisposition(record, memory, item.input.scope, sourcesById, sharingDecisions),
        )
      : [];
    const preEntityPolicyConflict = record !== undefined && item.input.records.some(
      (peer) =>
        peer.id !== record.id &&
        peer.canonicalFactId === record.canonicalFactId &&
        (peer.sharingScope !== record.sharingScope ||
          peer.sensitivity !== record.sensitivity ||
          peer.egressPolicy !== record.egressPolicy),
    );
    const expectedReason = dispositions.includes("union_eligible")
      ? undefined
      : dispositions.includes("consent_or_source_locality_mismatch")
        ? "consent_or_source_locality_mismatch"
        : dispositions.includes("policy_tuple_mismatch") || preEntityPolicyConflict
          ? "policy_tuple_mismatch"
          : undefined;
    if (
      !record ||
      record.canonicalFactId !== candidate.canonicalFactId ||
      record.sharingScope !== candidate.sharingScope ||
      record.sensitivity !== candidate.sensitivity ||
      record.egressPolicy !== candidate.egressPolicy ||
      !orderedStringsEqual(record.sourceEvidenceIds, candidate.sourceEvidenceIds) ||
      candidate.reasonCode !== expectedReason
    ) {
      issues.push(`${item.id}: memory review candidate does not preserve its record policy`);
    }
  }
  return issues;
}

function corpusSemanticIssues(corpus: contract.SourceAwareContractCorpusV1): string[] {
  const issues: string[] = [];
  const caseIds = corpus.cases.map(({ id }) => id);
  if (JSON.stringify(caseIds) !== JSON.stringify(CASE_IDS)) issues.push("case IDs are not exact F0-F7");
  if (new Set(caseIds).size !== caseIds.length) issues.push("case IDs are duplicated");

  for (const item of corpus.cases) {
    const sourcesById = new Map(item.input.sources.map((source) => [source.id, source]));
    const destinationSource = sourcesById.get(item.input.destination.sourceId);
    const recordIds = new Set(item.input.records.map(({ id }) => id));
    const evidenceByRecordId = new Map(item.successor.sourceEvidence.map((evidence) => [evidence.recordId, evidence]));
    if (evidenceByRecordId.size !== item.successor.sourceEvidence.length) {
      issues.push(`${item.id}: successor record evidence is duplicated`);
    }
    const sharingDecisions = new Map(item.input.sharingDecisions.map((decision) => [decision.id, decision]));
    if (sharingDecisions.size !== item.input.sharingDecisions.length) issues.push(`${item.id}: sharing decisions are duplicated`);
    if (!destinationSource) issues.push(`${item.id}: destination source is missing`);
    else if (!destinationSource.authenticated) issues.push(`${item.id}: destination source is unauthenticated`);
    else if (destinationSource.privateEligible === undefined || destinationSource.capabilityIds === undefined) {
      issues.push(`${item.id}: authenticated destination policy is missing`);
    }
    for (const record of item.input.records) {
      if (!sourcesById.has(record.sourceId)) issues.push(`${item.id}: record source ${record.sourceId} is missing`);
      if (
        record.sourceEvidenceIds.length === 0 ||
        record.sourceEvidenceIds.some((id) => id.trim() === "") ||
        !isSortedUniqueStrings(record.sourceEvidenceIds)
      ) {
        issues.push(`${item.id}: ${record.id} source evidence is empty, blank, or not sorted unique`);
      }
      const expectedEvidence = evidenceByRecordId.get(record.id);
      if (
        !expectedEvidence ||
        !orderedStringsEqual(expectedEvidence.sourceIds, [record.sourceId]) ||
        !orderedStringsEqual(expectedEvidence.sourceEvidenceIds, record.sourceEvidenceIds)
      ) {
        issues.push(`${item.id}: ${record.id} event-level evidence was not preserved exactly`);
      }
      const decisionIds = record.sharingDecisionEventIds ?? [];
      if (!isSortedUniqueStrings(decisionIds)) {
        issues.push(`${item.id}: ${record.id} sharing-decision refs are not sorted unique`);
      }
      for (const decisionId of decisionIds) {
        if (!sharingDecisions.has(decisionId)) issues.push(`${item.id}: ${record.id} sharing decision is missing`);
      }
    }
    for (const decision of item.input.sharingDecisions) {
      if (!decision.authenticated || decision.authorityKind !== "user" || decision.decision !== "grant") {
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
      if (!sourcesById.has(transition.actorSourceId)) issues.push(`${item.id}: transition source is missing`);
    }
    for (const id of [
      ...item.successor.automaticFullRecordIds,
      ...item.successor.hintOrManualRecordIds,
      ...item.successor.agentLocalRecordIds,
    ]) {
      if (!recordIds.has(id)) issues.push(`${item.id}: delivery record ${id} is missing`);
    }
    const validateNonlocalOutput = (ids: readonly string[], label: string, requireCapability: boolean) => {
      for (const id of ids) {
        const record = item.input.records.find((candidate) => candidate.id === id);
        if (!record) {
          issues.push(`${item.id}: ${label} record ${id} is missing`);
          continue;
        }
        if (
          !fixtureRecordIsPolicyEligible(
            record,
            item.input.scope,
            sourcesById,
            destinationSource,
            sharingDecisions,
            requireCapability,
          )
        ) {
          issues.push(`${item.id}: ${label} record ${id} violates delivery policy`);
        }
      }
    };
    validateNonlocalOutput(item.successor.automaticFullRecordIds, "automatic", true);
    validateNonlocalOutput(item.successor.hintOrManualRecordIds, "hint/manual", false);
    for (const profile of item.successor.retrievalProfiles) {
      validateNonlocalOutput(profile.recordIds, profile.profile, profile.profile === "active_task_shared");
    }
    for (const evidence of item.successor.sourceEvidence) {
      if (!recordIds.has(evidence.recordId)) issues.push(`${item.id}: evidence record is missing`);
      for (const id of evidence.sourceIds) {
        if (!sourcesById.has(id)) issues.push(`${item.id}: evidence source is missing`);
        else if (sourcesById.get(id)?.authenticated !== true) issues.push(`${item.id}: evidence source is unauthenticated`);
      }
    }
    for (const id of [
      item.successor.lineage.originSourceId,
      item.successor.lineage.lastContributorSourceId,
      item.successor.lineage.checkpointCreatorSourceId,
      ...item.successor.lineage.participantSourceIds,
      item.successor.authority.authenticatedSourceId,
    ]) {
      if (!sourcesById.has(id)) issues.push(`${item.id}: lineage/authority source ${id} is missing`);
    }
    if (
      item.successor.authority.authenticatedSourceId !== item.input.destination.sourceId ||
      sourcesById.get(item.successor.authority.authenticatedSourceId)?.authenticated !== true
    ) {
      issues.push(`${item.id}: destination authority is not the authenticated destination source`);
    }
    for (const id of [
      item.successor.lineage.originSourceId,
      item.successor.lineage.lastContributorSourceId,
      item.successor.lineage.checkpointCreatorSourceId,
      ...item.successor.lineage.participantSourceIds,
    ]) {
      if (sourcesById.get(id)?.authenticated !== true) issues.push(`${item.id}: authoritative lineage uses unverified source ${id}`);
    }
    issues.push(...memoryProjectionSemanticIssues(item, sourcesById, sharingDecisions));
    for (const profile of item.successor.retrievalProfiles) {
      for (const id of profile.recordIds) if (!recordIds.has(id)) issues.push(`${item.id}: retrieval record is missing`);
      if (profile.profile === "named_source") {
        const requestedSource = sourcesById.get(profile.requestedSourceId);
        if (
          requestedSource?.authenticated !== true ||
          profile.recordIds.some(
            (recordId) => item.input.records.find(({ id }) => id === recordId)?.sourceId !== profile.requestedSourceId,
          )
        ) {
          issues.push(`${item.id}: named-source query or results do not match an authenticated requested source`);
        }
      } else if (
        profile.profile === "current_source" &&
        profile.recordIds.some(
          (recordId) => item.input.records.find(({ id }) => id === recordId)?.sourceId !== item.input.destination.sourceId,
        )
      ) {
        issues.push(`${item.id}: current-source results include another source`);
      }
    }
  }

  const byId = new Map(corpus.cases.map((item) => [item.id, item]));
  if (byId.get("F0")?.successor.agentLocalRecordIds.join() !== "native-todo") issues.push("F0 local lane changed");
  if (byId.get("F1")?.successor.automaticFullRecordIds.join() !== "goal,pending-operation") {
    issues.push("F1 shared projection changed");
  }
  if (
    byId.get("F2")?.successor.sourceEvidence[0]?.sourceIds.join() !== "source-claude" ||
    byId.get("F2")?.successor.sourceEvidence[0]?.sourceEvidenceIds.join() !== "event-claude-1"
  ) {
    issues.push("F2 relabelled Claude evidence");
  }
  const f3Case = byId.get("F3");
  const f3Sources = new Map(f3Case?.input.sources.map((source) => [source.id, source]));
  const f3Transitions = f3Case?.input.transitions ?? [];
  const f3ParticipantsByClient = new Map<contract.CanonicalClientIdV1, string>();
  for (const transition of f3Transitions) {
    const source = f3Sources.get(transition.actorSourceId);
    if (source?.authenticated && !f3ParticipantsByClient.has(source.canonicalClientId)) {
      f3ParticipantsByClient.set(source.canonicalClientId, source.id);
    }
  }
  const f3Checkpoint = [...f3Transitions].reverse().find(({ kind }) => kind === "checkpoint");
  const f3DerivedLineage = f3Transitions.length === 0
    ? undefined
    : {
        originSourceId: f3Transitions[0]!.actorSourceId,
        lastContributorSourceId: f3Transitions.at(-1)!.actorSourceId,
        participantSourceIds: [...f3ParticipantsByClient.entries()]
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([, sourceId]) => sourceId),
        checkpointCreatorSourceId: f3Checkpoint?.actorSourceId,
      };
  if (
    f3Transitions[0]?.kind !== "create" ||
    !f3Checkpoint ||
    f3Transitions.some(({ actorSourceId }) => f3Sources.get(actorSourceId)?.authenticated !== true) ||
    !f3DerivedLineage ||
    canonicalizeJson(f3DerivedLineage) !== canonicalizeJson(f3Case?.successor.lineage)
  ) {
    issues.push("F3 lineage summary changed");
  }
  const f4 = byId.get("F4")?.successor.memoryEntities;
  if (
    f4?.length !== 1 ||
    f4[0]?.sourceIds.join() !== "source-claude,source-codex" ||
    f4[0]?.sourceEvidenceIds.join() !== "event-claude-1,event-codex-1" ||
    f4[0]?.sharingScope !== "project_shared" ||
    f4[0]?.sensitivity !== "normal" ||
    f4[0]?.egressPolicy !== "eligible"
  ) {
    issues.push("F4 is not one entity with two source branches");
  }
  const f4Input = byId.get("F4")?.input.records.filter(({ canonicalFactId }) => canonicalFactId === "fact-pkce");
  const f4ReviewIds = byId
    .get("F4")
    ?.successor.memoryReviewCandidates.map(({ recordId }) => recordId)
    .sort();
  if (
    f4Input?.length !== 5 ||
    f4Input.filter(
      ({ sharingScope, sensitivity, egressPolicy }) =>
        sharingScope === "project_shared" && sensitivity === "normal" && egressPolicy === "eligible",
    ).length !== 3 ||
    f4ReviewIds?.join() !== "memory-private,memory-secret,memory-unconsented" ||
    byId.get("F4")?.successor.memoryReviewCandidates.find(({ recordId }) => recordId === "memory-unconsented")
      ?.reasonCode !== "consent_or_source_locality_mismatch"
  ) {
    issues.push("F4 does not preserve union-ineligible negative evidence");
  }
  const f5 = byId.get("F5")?.successor.retrievalProfiles;
  if (f5?.map(({ profile }) => profile).join() !== "all_source_project,current_source,named_source,active_task_shared") {
    issues.push("F5 retrieval profiles changed");
  }
  if (
    f5?.some(({ recordIds }) => recordIds.includes("wrong-project") || recordIds.includes("wrong-workspace")) ||
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
  const f5WrongWorkspace = byId.get("F5")?.input.records.find(({ id }) => id === "wrong-workspace")?.subjectScope;
  if (
    f5WrongWorkspace?.personalVaultId !== "vault-a" ||
    f5WrongWorkspace.projectId !== "project-a" ||
    f5WrongWorkspace.workspaceId !== "workspace-b"
  ) {
    issues.push("F5 wrong-workspace scope is not explicit");
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
  const f7PrivateDecision = f7?.input.sharingDecisions.find(({ id }) => id === "decision-private");
  if (
    !f7Private?.sharingDecisionEventIds?.length ||
    f7NoConsent?.sharingDecisionEventIds?.length ||
    f7PrivateDecision?.privateConsent !== true
  ) {
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
  const f7PolicyConflict = f7?.input.records.filter(
    ({ canonicalFactId }) => canonicalFactId === "fact-policy-conflict",
  );
  if (
    f7PolicyConflict?.length !== 2 ||
    f7?.successor.memoryEntities.length !== 0 ||
    f7.successor.memoryReviewCandidates.map(({ recordId }) => recordId).join() !== "secret-record"
  ) {
    issues.push("F7 policy-conflicting evidence was automatically unioned");
  }
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
      deliveryKeyPrefix: "d:",
      fingerprintKeyPrefix: "f:",
      receiptUniquenessScope: "task_lineage_event_store",
      receiptEvidenceComparison: "canonical_fingerprint",
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
      authorityPayloadBinding: "action_scope_target_private_consent_and_decided_at_exact",
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
  if (
    JSON.stringify(value.sensitivityAggregationPolicy) !==
    JSON.stringify({
      schemaVersion: 1,
      order: ["normal", "private", "secret"],
      sharedTaskState: "max_of_contained_values",
      agentLocalState: "max_of_contained_values",
      canonicalWorkState: "max_of_shared_and_agent_local",
      checkpoint: "match_embedded_canonical_state",
      resumeCapsule: "max_of_included_projections",
      mismatchDisposition: "quarantine_before_delivery",
    })
  ) {
    issues.push("sensitivity aggregation policy changed");
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
  const localOnlyStateVector = vector.localOnly;
  const localOnlyContentHash = createHash("sha256")
    .update(canonicalizeJson(localOnlyStateVector.contentProjection), "utf8")
    .digest("hex");
  if (localOnlyContentHash !== localOnlyStateVector.contentHash) {
    issues.push("local-only canonical state content hash vector changed");
  }
  const localOnlyStateRevision = createHash("sha256")
    .update(
      canonicalizeJson({
        domain: hashProfile.stateRevisionDomain,
        contentHash: localOnlyStateVector.contentHash,
        revision: vector.revisionMetadata,
      }),
      "utf8",
    )
    .digest("hex");
  if (localOnlyStateRevision !== localOnlyStateVector.stateRevision) {
    issues.push("local-only canonical state revision vector changed");
  }
  const localOnlyProjection = localOnlyStateVector.contentProjection as Record<string, contract.JsonValue>;
  if ("sharedTaskState" in localOnlyProjection || !Array.isArray(localOnlyProjection.agentLocalStates)) {
    issues.push("local-only canonical state vector does not freeze omitted shared state");
  }
  const checkpointProfile = value.checkpointHashProfile;
  if (
    checkpointProfile.contentProjectionFields.join() !==
    "schemaVersion,kind,sourceSessionId,checkpointCreatedBySourceEventId,canonicalState,memoryWatermark,sensitivity,createdAt,expiresAt"
  ) {
    issues.push("checkpoint content projection changed");
  }
  if (JSON.stringify(checkpointProfile.transitionKinds) !== '["initial","parent"]') {
    issues.push("checkpoint transition kinds changed");
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
  if (JSON.stringify(memoryProfile.transitionKinds) !== '["initial","parent"]') {
    issues.push("canonical memory transition kinds changed");
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
  const capsuleProfile = value.resumeCapsuleHashProfile;
  if (
    capsuleProfile.contentProjectionFields.join() !==
    "schemaVersion,injectionId,checkpointId,checkpointRevision,workStateRevision,subjectScope,lineageSourceSummary,checkpointCreatedBySourceEventId,destination,resumeProfile,ageSeconds,reconciliation,sharedTaskState,destinationAgentLocalState,selectedMemoryIds,warnings"
  ) {
    issues.push("resume capsule content projection changed");
  }
  const capsuleVector = capsuleProfile.testVector;
  const capsuleProjection = {
    ...(capsuleVector.envelope as Record<string, contract.JsonValue>),
    sharedTaskState: (vector.contentProjection as Record<string, contract.JsonValue>).sharedTaskState,
  };
  const capsuleContentHash = createHash("sha256")
    .update(
      canonicalizeJson({ domain: capsuleProfile.contentDomain, capsule: capsuleProjection }),
      "utf8",
    )
    .digest("hex");
  if (capsuleContentHash !== capsuleVector.contentHash) issues.push("resume capsule content hash vector changed");
  const localOnlyCapsuleVector = capsuleVector.localOnly;
  const localOnlyCapsuleHash = createHash("sha256")
    .update(
      canonicalizeJson({ domain: capsuleProfile.contentDomain, capsule: localOnlyCapsuleVector.envelope }),
      "utf8",
    )
    .digest("hex");
  if (localOnlyCapsuleHash !== localOnlyCapsuleVector.contentHash) {
    issues.push("local-only resume capsule content hash vector changed");
  }
  const localOnlyEnvelope = localOnlyCapsuleVector.envelope as Record<string, contract.JsonValue>;
  if ("sharedTaskState" in localOnlyEnvelope || !("destinationAgentLocalState" in localOnlyEnvelope)) {
    issues.push("local-only resume capsule vector does not freeze omitted shared state");
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

function readFrozenSearchCandidates(
  repoRoot: string,
  inventory: contract.SourceIdentityInventoryV1,
  search: contract.SourceInventorySearchV1,
): FrozenSearchCandidate[] {
  const pathspecs = [...search.includePaths, ...search.excludePaths.map((path) => `:(exclude)${path}`)];
  const output = execFileSync(
    "git",
    ["grep", "-n", "-z", "-I", "-E", search.pattern, inventory.baselineCommit, "--", ...pathspecs],
    { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
  );
  const refPrefix = `${inventory.baselineCommit}:`;
  return output.trimEnd().split("\n").map((record) => {
    const [refPath, lineNumber, text, ...extra] = record.split("\0");
    assert.ok(refPath?.startsWith(refPrefix) && /^\d+$/.test(lineNumber ?? "") && text !== undefined && extra.length === 0);
    const path = refPath.slice(refPrefix.length);
    return { searchId: search.id, path, line: lineNumber, record: `${path}\t${lineNumber}\t${text}` };
  });
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
  const parentedStateInput = structuredClone(vectorState) as unknown as Record<string, unknown>;
  (parentedStateInput.revision as { parentStateRevisions: string[] }).parentStateRevisions = [
    "a".repeat(64),
    "b".repeat(64),
  ];
  const parentedState = rehashCanonicalState(parentedStateInput, manifest.canonicalStateHashProfile);
  assert.deepEqual(stateRevisionEnvelopeIssues(parentedState.revision), []);
  for (const parents of [
    ["a".repeat(64), "a".repeat(64)],
    ["b".repeat(64), "a".repeat(64)],
  ]) {
    const invalidParentInput = structuredClone(parentedState) as unknown as Record<string, unknown>;
    (invalidParentInput.revision as { parentStateRevisions: string[] }).parentStateRevisions = parents;
    const invalidParentState = rehashCanonicalState(invalidParentInput, manifest.canonicalStateHashProfile);
    assert.deepEqual(validateContractValue("CanonicalWorkStateV2", invalidParentState, root, contract.CONTINUITY_LIMITS), []);
    assert.ok(stateRevisionEnvelopeIssues(invalidParentState.revision).length > 0);
  }
  const localOnlyInput = structuredClone(vectorState) as Record<string, unknown>;
  delete localOnlyInput.sharedTaskState;
  localOnlyInput.agentLocalStates = [
    {
      sharingScope: "agent_private",
      sourceIdentityEventId: "a".repeat(64),
      clientId: "claude-code",
      sessionId: "3".repeat(64),
      sensitivity: "normal",
      egressPolicy: "eligible",
    },
  ];
  const localOnlyState = rehashCanonicalState(localOnlyInput, manifest.canonicalStateHashProfile);
  assert.equal(localOnlyState.revision.contentHash, hashVector.localOnly.contentHash);
  assert.equal(localOnlyState.revision.stateRevision, hashVector.localOnly.stateRevision);
  assert.deepEqual(localOnlyInput, {
    ...(hashVector.localOnly.contentProjection as Record<string, contract.JsonValue>),
    revision: localOnlyInput.revision,
  });
  assert.deepEqual(validateContractValue("CanonicalWorkStateV2", localOnlyState, root, contract.CONTINUITY_LIMITS), []);
  const typedLocalOnlyState = localOnlyState as unknown as contract.CanonicalWorkStateV2;
  assert.deepEqual(
    agentLocalLaneSemanticIssues(
      typedLocalOnlyState.agentLocalStates,
      new Map([
        [
          "a".repeat(64),
          {
            clientId: "claude-code",
            clientVersion: "1",
            sessionId: "3".repeat(64),
            capabilityIds: [],
            privateEligible: false,
          } as const,
        ],
      ]),
    ),
    [],
  );
  const projectionlessState = structuredClone(localOnlyState) as unknown as Record<string, unknown>;
  projectionlessState.agentLocalStates = [];
  assert.ok(validateContractValue("CanonicalWorkStateV2", projectionlessState, root, contract.CONTINUITY_LIMITS).length > 0);
  const checkpointVector = manifest.checkpointHashProfile.testVector;
  const checkpoint = {
    ...(checkpointVector.envelope as Record<string, contract.JsonValue>),
    id: checkpointVector.checkpointId,
    checkpointRevision: checkpointVector.initialCheckpointRevision,
    canonicalState: vectorState,
    contentHash: checkpointVector.contentHash,
  };
  assert.deepEqual(validateContractValue("ContinuationCheckpointV3", checkpoint, root, contract.CONTINUITY_LIMITS), []);
  const localCheckpointContentHash = createHash("sha256")
    .update(
      canonicalizeJson({
        ...(checkpointVector.envelope as Record<string, contract.JsonValue>),
        canonicalState: localOnlyState,
      }),
      "utf8",
    )
    .digest("hex");
  const localCheckpointRevision = createHash("sha256")
    .update(
      canonicalizeJson({
        domain: manifest.checkpointHashProfile.checkpointRevisionDomain,
        checkpointId: checkpointVector.checkpointId,
        transition: { kind: "initial" },
        contentHash: localCheckpointContentHash,
      }),
      "utf8",
    )
    .digest("hex");
  assert.deepEqual(
    validateContractValue(
      "ContinuationCheckpointV3",
      {
        ...checkpoint,
        checkpointRevision: localCheckpointRevision,
        canonicalState: localOnlyState,
        contentHash: localCheckpointContentHash,
      },
      root,
      contract.CONTINUITY_LIMITS,
    ),
    [],
  );
  const childCheckpoint = {
    ...checkpoint,
    checkpointRevision: checkpointVector.childCheckpointRevision,
    parentCheckpointId: checkpointVector.parentCheckpointId,
    parentCheckpointRevision: checkpointVector.parentCheckpointRevision,
  };
  assert.deepEqual(validateContractValue("ContinuationCheckpointV3", childCheckpoint, root, contract.CONTINUITY_LIMITS), []);
  const missingParentRevision = { ...childCheckpoint } as Record<string, unknown>;
  delete missingParentRevision.parentCheckpointRevision;
  assert.ok(
    validateContractValue("ContinuationCheckpointV3", missingParentRevision, root, contract.CONTINUITY_LIMITS).length > 0,
  );
  const missingParentId = { ...childCheckpoint } as Record<string, unknown>;
  delete missingParentId.parentCheckpointId;
  assert.ok(validateContractValue("ContinuationCheckpointV3", missingParentId, root, contract.CONTINUITY_LIMITS).length > 0);
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
  const capsuleVector = manifest.resumeCapsuleHashProfile.testVector;
  const capsule = {
    ...(capsuleVector.envelope as Record<string, contract.JsonValue>),
    sharedTaskState: (hashVector.contentProjection as Record<string, contract.JsonValue>).sharedTaskState,
    contentHash: capsuleVector.contentHash,
  };
  assert.deepEqual(validateContractValue("ResumeCapsuleV2", capsule, root, contract.CONTINUITY_LIMITS), []);
  const localOnlyCapsule = {
    ...(capsuleVector.localOnly.envelope as Record<string, contract.JsonValue>),
    contentHash: capsuleVector.localOnly.contentHash,
  };
  assert.deepEqual(validateContractValue("ResumeCapsuleV2", localOnlyCapsule, root, contract.CONTINUITY_LIMITS), []);

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
    if (search.coverageMode === "partition") {
      candidates.push(...readFrozenSearchCandidates(repoRoot, inventory, search));
    }
  }
  assert.deepEqual(inventoryCoverageIssues(inventory, candidates), []);
});

test("source-aware negative self-mutations are rejected", () => {
  const root = loadRequiredJson<JsonSchemaDocument>(ROOT_URL, "continuity schema");
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

  const privateWithoutConsent = structuredClone(corpus) as unknown as { cases: contract.SourceAwareContractCaseV1[] };
  const privateConsentCase = privateWithoutConsent.cases.find(({ id }) => id === "F7");
  assert.ok(privateConsentCase);
  const privateDestination = privateConsentCase.input.sources.find(
    ({ id }) => id === privateConsentCase.input.destination.sourceId,
  );
  const privateDecision = privateConsentCase.input.sharingDecisions.find(({ id }) => id === "decision-private");
  assert.ok(privateDestination && privateDecision);
  (privateDestination as unknown as { privateEligible: boolean; capabilityIds: string[] }).privateEligible = true;
  (privateDestination.capabilityIds as string[]).push("shared-task-v1");
  (privateDecision as unknown as { privateConsent: boolean }).privateConsent = false;
  (privateConsentCase.successor.automaticFullRecordIds as string[]).push("private-record");
  assert.ok(
    corpusSemanticIssues(privateWithoutConsent as unknown as contract.SourceAwareContractCorpusV1).length > 0,
  );

  const localOnlyRetrieval = structuredClone(corpus) as unknown as { cases: contract.SourceAwareContractCaseV1[] };
  const privacyCase = localOnlyRetrieval.cases.find(({ id }) => id === "F7");
  assert.ok(privacyCase);
  (privacyCase.successor.retrievalProfiles as contract.SourceAwareRetrievalExpectationV1[]).push({
    profile: "active_task_shared",
    recordIds: ["local-only-record"],
  });
  assert.ok(corpusSemanticIssues(localOnlyRetrieval as unknown as contract.SourceAwareContractCorpusV1).length > 0);

  for (const profile of contract.SOURCE_AWARE_RETRIEVAL_PROFILES_V1) {
    const wrongWorkspaceLeak = structuredClone(corpus) as unknown as { cases: contract.SourceAwareContractCaseV1[] };
    const retrievalCase = wrongWorkspaceLeak.cases.find(({ id }) => id === "F5");
    assert.ok(retrievalCase);
    const expectation = retrievalCase.successor.retrievalProfiles.find((candidate) => candidate.profile === profile);
    assert.ok(expectation);
    (expectation.recordIds as string[]).push("wrong-workspace");
    assert.ok(corpusSemanticIssues(wrongWorkspaceLeak as unknown as contract.SourceAwareContractCorpusV1).length > 0, profile);
  }
  for (const mutation of ["missing", "unknown", "unauthenticated", "wrong_source", "extra_non_named"] as const) {
    const invalidNamedSource = structuredClone(corpus) as unknown as { cases: contract.SourceAwareContractCaseV1[] };
    const retrievalCase = invalidNamedSource.cases.find(({ id }) => id === "F5");
    assert.ok(retrievalCase);
    const namedProfile = retrievalCase.successor.retrievalProfiles.find(({ profile }) => profile === "named_source");
    assert.ok(namedProfile?.profile === "named_source");
    if (mutation === "missing") {
      delete (namedProfile as unknown as { requestedSourceId?: string }).requestedSourceId;
    } else if (mutation === "unknown") {
      (namedProfile as { requestedSourceId: string }).requestedSourceId = "source-missing";
    } else if (mutation === "unauthenticated") {
      const requestedSource = retrievalCase.input.sources.find(({ id }) => id === namedProfile.requestedSourceId);
      assert.ok(requestedSource);
      (requestedSource as { authenticated: boolean }).authenticated = false;
    } else if (mutation === "wrong_source") {
      (namedProfile as { requestedSourceId: string }).requestedSourceId = "source-codex";
    } else {
      (retrievalCase.successor.retrievalProfiles[0] as unknown as { requestedSourceId: string }).requestedSourceId =
        "source-claude";
    }
    if (mutation === "missing" || mutation === "extra_non_named") {
      assert.ok(
        validateContractValue(
          "SourceAwareContractCorpusV1",
          invalidNamedSource,
          root,
          contract.CONTINUITY_LIMITS,
        ).length > 0,
        mutation,
      );
    } else {
      assert.ok(corpusSemanticIssues(invalidNamedSource as unknown as contract.SourceAwareContractCorpusV1).length > 0, mutation);
    }
  }
  const wrongCurrentSource = structuredClone(corpus) as unknown as { cases: contract.SourceAwareContractCaseV1[] };
  const currentSourceCase = wrongCurrentSource.cases.find(({ id }) => id === "F5");
  assert.ok(currentSourceCase);
  const currentSourceProfile = currentSourceCase.successor.retrievalProfiles.find(
    ({ profile }) => profile === "current_source",
  );
  assert.ok(currentSourceProfile);
  (currentSourceProfile.recordIds as string[])[0] = "claude-decision";
  assert.ok(corpusSemanticIssues(wrongCurrentSource as unknown as contract.SourceAwareContractCorpusV1).length > 0);
  for (const recordId of ["private-no-consent", "wrong-workspace"]) {
    const hintPolicyLeak = structuredClone(corpus) as unknown as { cases: contract.SourceAwareContractCaseV1[] };
    const hintPrivacyCase = hintPolicyLeak.cases.find(({ id }) => id === "F7");
    assert.ok(hintPrivacyCase);
    (hintPrivacyCase.successor.hintOrManualRecordIds as string[]).push(recordId);
    assert.ok(
      corpusSemanticIssues(hintPolicyLeak as unknown as contract.SourceAwareContractCorpusV1).length > 0,
      recordId,
    );
    const retrievalPolicyLeak = structuredClone(corpus) as unknown as { cases: contract.SourceAwareContractCaseV1[] };
    const retrievalPrivacyCase = retrievalPolicyLeak.cases.find(({ id }) => id === "F7");
    assert.ok(retrievalPrivacyCase);
    const activeProfile = retrievalPrivacyCase.successor.retrievalProfiles.find(
      ({ profile }) => profile === "active_task_shared",
    );
    if (activeProfile) {
      (activeProfile.recordIds as string[]).push(recordId);
    } else {
      (retrievalPrivacyCase.successor.retrievalProfiles as contract.SourceAwareRetrievalExpectationV1[]).push({
        profile: "active_task_shared",
        recordIds: [recordId],
      });
    }
    assert.ok(
      corpusSemanticIssues(retrievalPolicyLeak as unknown as contract.SourceAwareContractCorpusV1).length > 0,
      recordId,
    );
  }

  const renamedSecretLeak = structuredClone(corpus) as unknown as { cases: contract.SourceAwareContractCaseV1[] };
  const sharedCaseForLeak = renamedSecretLeak.cases.find(({ id }) => id === "F1");
  assert.ok(sharedCaseForLeak);
  (sharedCaseForLeak.input.records as contract.SourceAwareFixtureRecordV1[]).push({
    id: "newly-named-denied-record",
    kind: "new_kind",
    sourceId: "source-claude",
    sharingScope: "task_shared",
    sensitivity: "secret",
    egressPolicy: "eligible",
    sourceEvidenceIds: ["event-secret-new"],
    sharingDecisionEventIds: ["decision-goal"],
  });
  (sharedCaseForLeak.successor.automaticFullRecordIds as string[]).push("newly-named-denied-record");
  assert.ok(corpusSemanticIssues(renamedSecretLeak as unknown as contract.SourceAwareContractCorpusV1).length > 0);

  const unauthenticatedDestination = structuredClone(corpus) as unknown as {
    cases: contract.SourceAwareContractCaseV1[];
  };
  const destinationCase = unauthenticatedDestination.cases.find(({ id }) => id === "F1");
  assert.ok(destinationCase);
  const destinationSource = destinationCase.input.sources.find(
    ({ id }) => id === destinationCase.input.destination.sourceId,
  );
  assert.ok(destinationSource);
  (destinationSource as unknown as { authenticated: boolean }).authenticated = false;
  assert.ok(
    corpusSemanticIssues(unauthenticatedDestination as unknown as contract.SourceAwareContractCorpusV1).length > 0,
  );
  const unauthenticatedNoDeliveryDestination = structuredClone(corpus) as unknown as {
    cases: contract.SourceAwareContractCaseV1[];
  };
  const noDeliveryCase = unauthenticatedNoDeliveryDestination.cases.find(({ id }) => id === "F0");
  assert.ok(noDeliveryCase);
  const noDeliveryDestination = noDeliveryCase.input.sources.find(
    ({ id }) => id === noDeliveryCase.input.destination.sourceId,
  );
  assert.ok(noDeliveryDestination);
  (noDeliveryDestination as unknown as { authenticated: boolean }).authenticated = false;
  assert.ok(
    corpusSemanticIssues(unauthenticatedNoDeliveryDestination as unknown as contract.SourceAwareContractCorpusV1).length > 0,
  );

  const detachedPrivateEligibility = structuredClone(corpus) as unknown as {
    cases: contract.SourceAwareContractCaseV1[];
  };
  const detachedCase = detachedPrivateEligibility.cases.find(({ id }) => id === "F1");
  assert.ok(detachedCase);
  const detachedDestinationSource = detachedCase.input.sources.find(
    ({ id }) => id === detachedCase.input.destination.sourceId,
  );
  assert.ok(detachedDestinationSource);
  (detachedDestinationSource as unknown as { privateEligible: boolean }).privateEligible = false;
  (detachedCase.input.destination as unknown as { privateEligible: boolean }).privateEligible = true;
  (detachedCase.input.records[0] as unknown as { sensitivity: contract.Sensitivity }).sensitivity = "private";
  assert.ok(
    corpusSemanticIssues(detachedPrivateEligibility as unknown as contract.SourceAwareContractCorpusV1).length > 0,
  );

  const evidenceLoss = structuredClone(corpus) as unknown as { cases: contract.SourceAwareContractCaseV1[] };
  const f4 = evidenceLoss.cases.find(({ id }) => id === "F4");
  assert.ok(f4);
  (f4.successor.memoryEntities[0]!.sourceIds as string[]).pop();
  assert.ok(corpusSemanticIssues(evidenceLoss as unknown as contract.SourceAwareContractCorpusV1).length > 0);

  for (const sourceEvidenceIds of [[], [""], ["   "], ["event-z", "event-a"], ["event-a", "event-a"]]) {
    const invalidInputEvidence = structuredClone(corpus) as unknown as { cases: contract.SourceAwareContractCaseV1[] };
    const f2 = invalidInputEvidence.cases.find(({ id }) => id === "F2");
    assert.ok(f2);
    (f2.input.records[0] as unknown as { sourceEvidenceIds: string[] }).sourceEvidenceIds = sourceEvidenceIds;
    assert.ok(
      corpusSemanticIssues(invalidInputEvidence as unknown as contract.SourceAwareContractCorpusV1).length > 0,
    );
    if (sourceEvidenceIds.length === 0 || sourceEvidenceIds.some((id) => id.trim() === "")) {
      assert.ok(
        validateContractValue(
          "SourceAwareContractCorpusV1",
          invalidInputEvidence,
          root,
          contract.CONTINUITY_LIMITS,
        ).length > 0,
      );
    }
  }
  const commaCollision = structuredClone(corpus) as unknown as { cases: contract.SourceAwareContractCaseV1[] };
  const f2CommaCollision = commaCollision.cases.find(({ id }) => id === "F2");
  assert.ok(f2CommaCollision);
  (f2CommaCollision.input.records[0] as unknown as { sourceEvidenceIds: [string] }).sourceEvidenceIds = [
    "event-a,event-b",
  ];
  (f2CommaCollision.successor.sourceEvidence[0] as unknown as { sourceEvidenceIds: [string, string] })
    .sourceEvidenceIds = ["event-a", "event-b"];
  assert.deepEqual(
    validateContractValue("SourceAwareContractCorpusV1", commaCollision, root, contract.CONTINUITY_LIMITS),
    [],
  );
  assert.ok(corpusSemanticIssues(commaCollision as unknown as contract.SourceAwareContractCorpusV1).length > 0);
  const decisionCommaCollision = structuredClone(corpus) as unknown as { cases: contract.SourceAwareContractCaseV1[] };
  const f1DecisionCollision = decisionCommaCollision.cases.find(({ id }) => id === "F1");
  assert.ok(f1DecisionCollision);
  const goalDecision = f1DecisionCollision.input.sharingDecisions.find(({ id }) => id === "decision-goal");
  assert.ok(goalDecision);
  (f1DecisionCollision.input.sharingDecisions as contract.SourceAwareFixtureSharingDecisionV1[]).push(
    { ...goalDecision, id: "a,a" },
    { ...goalDecision, id: "a" },
  );
  (f1DecisionCollision.input.records[0] as unknown as { sharingDecisionEventIds: string[] })
    .sharingDecisionEventIds = ["a,a", "a"];
  assert.deepEqual(
    validateContractValue("SourceAwareContractCorpusV1", decisionCommaCollision, root, contract.CONTINUITY_LIMITS),
    [],
  );
  assert.ok(corpusSemanticIssues(decisionCommaCollision as unknown as contract.SourceAwareContractCorpusV1).length > 0);
  const recordEventLoss = structuredClone(corpus) as unknown as { cases: contract.SourceAwareContractCaseV1[] };
  const f2EventLoss = recordEventLoss.cases.find(({ id }) => id === "F2");
  assert.ok(f2EventLoss);
  (f2EventLoss.successor.sourceEvidence[0]!.sourceEvidenceIds as unknown as string[]).pop();
  assert.ok(corpusSemanticIssues(recordEventLoss as unknown as contract.SourceAwareContractCorpusV1).length > 0);
  const memoryEventLoss = structuredClone(corpus) as unknown as { cases: contract.SourceAwareContractCaseV1[] };
  const f4EventLoss = memoryEventLoss.cases.find(({ id }) => id === "F4");
  assert.ok(f4EventLoss);
  (f4EventLoss.successor.memoryEntities[0]!.sourceEvidenceIds as unknown as string[]).pop();
  assert.ok(corpusSemanticIssues(memoryEventLoss as unknown as contract.SourceAwareContractCorpusV1).length > 0);
  const reviewEventLoss = structuredClone(corpus) as unknown as { cases: contract.SourceAwareContractCaseV1[] };
  const f4ReviewEventLoss = reviewEventLoss.cases.find(({ id }) => id === "F4");
  assert.ok(f4ReviewEventLoss);
  (f4ReviewEventLoss.successor.memoryReviewCandidates[0]!.sourceEvidenceIds as unknown as string[])[0] = "event-other";
  assert.ok(corpusSemanticIssues(reviewEventLoss as unknown as contract.SourceAwareContractCorpusV1).length > 0);

  const unauthenticatedEvidence = structuredClone(corpus) as unknown as {
    cases: contract.SourceAwareContractCaseV1[];
  };
  const evidenceCase = unauthenticatedEvidence.cases.find(({ id }) => id === "F4");
  assert.ok(evidenceCase);
  const evidenceOnlySource = evidenceCase.input.sources.find(({ id }) => id === "source-claude-private");
  assert.ok(evidenceOnlySource);
  (evidenceOnlySource as unknown as { authenticated: boolean }).authenticated = false;
  assert.ok(corpusSemanticIssues(unauthenticatedEvidence as unknown as contract.SourceAwareContractCorpusV1).length > 0);

  const unauthenticatedMemoryDecision = structuredClone(corpus) as unknown as {
    cases: contract.SourceAwareContractCaseV1[];
  };
  const memoryDecisionCase = unauthenticatedMemoryDecision.cases.find(({ id }) => id === "F4");
  assert.ok(memoryDecisionCase);
  const secondaryMemoryDecision = memoryDecisionCase.input.sharingDecisions.find(
    ({ id }) => id === "decision-memory-codex",
  );
  assert.ok(secondaryMemoryDecision);
  (secondaryMemoryDecision as unknown as { authenticated: boolean }).authenticated = false;
  assert.ok(
    corpusSemanticIssues(unauthenticatedMemoryDecision as unknown as contract.SourceAwareContractCorpusV1).length > 0,
  );
  const unconsentedMemoryUnion = structuredClone(corpus) as unknown as { cases: contract.SourceAwareContractCaseV1[] };
  const unconsentedMemoryCase = unconsentedMemoryUnion.cases.find(({ id }) => id === "F4");
  assert.ok(unconsentedMemoryCase);
  const codexMemory = unconsentedMemoryCase.input.records.find(({ id }) => id === "memory-codex");
  assert.ok(codexMemory);
  (codexMemory as unknown as { sharingDecisionEventIds: string[] }).sharingDecisionEventIds = [];
  assert.ok(corpusSemanticIssues(unconsentedMemoryUnion as unknown as contract.SourceAwareContractCorpusV1).length > 0);

  const reviewedUnconsentedMemory = structuredClone(unconsentedMemoryUnion);
  const reviewedMemoryCase = reviewedUnconsentedMemory.cases.find(({ id }) => id === "F4");
  assert.ok(reviewedMemoryCase);
  const activeMemory = reviewedMemoryCase.successor.memoryEntities[0];
  assert.ok(activeMemory);
  (activeMemory as unknown as { sourceIds: string[] }).sourceIds = ["source-claude"];
  (activeMemory as unknown as { sourceEvidenceIds: string[] }).sourceEvidenceIds = ["event-claude-1"];
  (reviewedMemoryCase.successor.memoryReviewCandidates as contract.SourceAwareMemoryReviewCandidateV1[]).push({
    recordId: "memory-codex",
    canonicalFactId: "fact-pkce",
    sharingScope: "project_shared",
    sensitivity: "normal",
    egressPolicy: "eligible",
    sourceEvidenceIds: ["event-codex-1"],
    disposition: "policy_review_required",
    reasonCode: "consent_or_source_locality_mismatch",
  });
  assert.deepEqual(
    memoryProjectionSemanticIssues(
      reviewedMemoryCase,
      new Map(reviewedMemoryCase.input.sources.map((source) => [source.id, source])),
      new Map(reviewedMemoryCase.input.sharingDecisions.map((decision) => [decision.id, decision])),
    ),
    [],
  );

  const privateMemoryRecord = unconsentedMemoryCase.input.records.find(({ id }) => id === "memory-private");
  assert.ok(privateMemoryRecord?.canonicalFactId);
  const f4Sources = new Map(unconsentedMemoryCase.input.sources.map((source) => [source.id, source]));
  const f4Decisions = new Map(unconsentedMemoryCase.input.sharingDecisions.map((decision) => [decision.id, decision]));
  const privateMemoryExpectation: contract.SourceAwareMemoryExpectationV1 = {
    memoryId: "memory-private-locality-check",
    canonicalFactId: privateMemoryRecord.canonicalFactId,
    sourceIds: [privateMemoryRecord.sourceId],
    sourceEvidenceIds: privateMemoryRecord.sourceEvidenceIds,
    sharingScope: privateMemoryRecord.sharingScope,
    sensitivity: privateMemoryRecord.sensitivity,
    egressPolicy: privateMemoryRecord.egressPolicy,
  };
  assert.equal(
    fixtureMemoryRecordDisposition(
      privateMemoryRecord,
      privateMemoryExpectation,
      unconsentedMemoryCase.input.scope,
      f4Sources,
      f4Decisions,
    ),
    "union_eligible",
  );
  assert.equal(
    fixtureMemoryRecordDisposition(
      { ...privateMemoryRecord, sourceId: "source-codex" },
      privateMemoryExpectation,
      unconsentedMemoryCase.input.scope,
      f4Sources,
      f4Decisions,
    ),
    "consent_or_source_locality_mismatch",
  );

  const policyCandidateLoss = structuredClone(corpus) as unknown as { cases: contract.SourceAwareContractCaseV1[] };
  const policyCase = policyCandidateLoss.cases.find(({ id }) => id === "F4");
  assert.ok(policyCase);
  (policyCase.successor.memoryReviewCandidates as contract.SourceAwareMemoryReviewCandidateV1[]).pop();
  assert.ok(corpusSemanticIssues(policyCandidateLoss as unknown as contract.SourceAwareContractCorpusV1).length > 0);

  const orphanReviewCandidate = structuredClone(corpus) as unknown as {
    cases: contract.SourceAwareContractCaseV1[];
  };
  const orphanCase = orphanReviewCandidate.cases.find(({ id }) => id === "F0");
  assert.ok(orphanCase);
  const orphanRecord = orphanCase.input.records[0];
  assert.ok(orphanRecord);
  (orphanRecord as unknown as { canonicalFactId: string }).canonicalFactId = "fact-orphan";
  (orphanCase.successor.memoryReviewCandidates as contract.SourceAwareMemoryReviewCandidateV1[]).push({
    recordId: orphanRecord.id,
    canonicalFactId: "fact-orphan",
    sharingScope: orphanRecord.sharingScope,
    sensitivity: orphanRecord.sensitivity,
    egressPolicy: orphanRecord.egressPolicy,
    sourceEvidenceIds: orphanRecord.sourceEvidenceIds,
    disposition: "policy_review_required",
    reasonCode: "policy_tuple_mismatch",
  });
  assert.ok(corpusSemanticIssues(orphanReviewCandidate as unknown as contract.SourceAwareContractCorpusV1).length > 0);

  const sameTuplePeerReview = structuredClone(orphanReviewCandidate);
  const sameTupleCase = sameTuplePeerReview.cases.find(({ id }) => id === "F0");
  assert.ok(sameTupleCase);
  (sameTupleCase.input.records as contract.SourceAwareFixtureRecordV1[]).push({
    ...sameTupleCase.input.records[0]!,
    id: "native-todo-peer",
    sourceEvidenceIds: ["event-claude-2"],
  });
  (sameTupleCase.successor.sourceEvidence as contract.SourceAwareRecordEvidenceExpectationV1[]).push({
    recordId: "native-todo-peer",
    sourceIds: ["source-claude"],
    sourceEvidenceIds: ["event-claude-2"],
  });
  assert.ok(corpusSemanticIssues(sameTuplePeerReview as unknown as contract.SourceAwareContractCorpusV1).length > 0);

  const forgedLineage = structuredClone(corpus) as unknown as { cases: contract.SourceAwareContractCaseV1[] };
  const authorityCase = forgedLineage.cases.find(({ id }) => id === "F6");
  assert.ok(authorityCase);
  (authorityCase.input.sources[0] as unknown as { authenticated: boolean }).authenticated = false;
  assert.ok(corpusSemanticIssues(forgedLineage as unknown as contract.SourceAwareContractCorpusV1).length > 0);

  for (const mutateTransitions of [
    (transitions: contract.SourceAwareFixtureTransitionV1[]) =>
      ((transitions[0] as { actorSourceId: string }).actorSourceId = "source-codex"),
    (transitions: contract.SourceAwareFixtureTransitionV1[]) =>
      ((transitions[1] as { actorSourceId: string }).actorSourceId = "source-claude"),
    (transitions: contract.SourceAwareFixtureTransitionV1[]) =>
      ((transitions[2] as { actorSourceId: string }).actorSourceId = "source-codex"),
    (transitions: contract.SourceAwareFixtureTransitionV1[]) => transitions.pop(),
  ]) {
    const invalidF3Lineage = structuredClone(corpus) as unknown as { cases: contract.SourceAwareContractCaseV1[] };
    const lineageCase = invalidF3Lineage.cases.find(({ id }) => id === "F3");
    assert.ok(lineageCase);
    mutateTransitions(lineageCase.input.transitions as contract.SourceAwareFixtureTransitionV1[]);
    assert.ok(corpusSemanticIssues(invalidF3Lineage as unknown as contract.SourceAwareContractCorpusV1).length > 0);
  }

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

  for (const profileName of ["checkpointHashProfile", "canonicalMemoryHashProfile"] as const) {
    for (const transitionKinds of [
      ["initial", "initial"],
      ["parent", "initial"],
    ]) {
      const invalidTransitions = structuredClone(manifest) as unknown as contract.SourceAwareContinuityContractV1;
      (invalidTransitions[profileName] as unknown as { transitionKinds: string[] }).transitionKinds = transitionKinds;
      assert.ok(contractSemanticIssues(invalidTransitions).length > 0, profileName);
      assert.ok(
        validateContractValue(
          "SourceAwareContinuityContractV1",
          invalidTransitions,
          root,
          contract.CONTINUITY_LIMITS,
        ).length > 0,
        profileName,
      );
    }
  }

  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const inventory = loadRequiredJson<contract.SourceIdentityInventoryV1>(INVENTORY_URL, "source inventory");
  const partitionSearch = inventory.searches.find(({ coverageMode }) => coverageMode === "partition");
  assert.ok(partitionSearch);
  const candidates = readFrozenSearchCandidates(repoRoot, inventory, partitionSearch);
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
  return isSortedUniqueStrings(ids) ? [] : ["sharing-decision references are not sorted unique"];
}

interface ResolvedSharingAuthorityEvent {
  readonly authorityKind: "user";
  readonly decision: "grant";
  readonly subjectScope: contract.SubjectScopeV1;
  readonly sharingScope: contract.SharingGrantScopeV1;
  readonly target: contract.SharingDecisionTargetV1;
  readonly privateConsent: boolean;
  readonly decidedAt: string;
}

function canonicalMemorySharingIssues(
  value: contract.CanonicalMemoryEntityV1,
  sharingDecisionByEventId: ReadonlyMap<string, contract.SharingDecisionV1>,
  authenticatedAuthorityEvents: ReadonlyMap<string, ResolvedSharingAuthorityEvent>,
  sourceIdentityByEventId: ReadonlyMap<string, ResolvedFixtureSourceIdentity>,
  evidenceSnapshotById: ReadonlyMap<string, ResolvedMemoryEvidenceSnapshot>,
): string[] {
  const issues = sharingDecisionReferenceIssues(value.sharingDecisionEventIds);
  if (value.sourceEventIds.length === 0) issues.push("canonical memory has no authenticated source owner");
  issues.push(...sourceReferenceIssues([value.sourceEventIds], sourceIdentityByEventId, "canonical memory"));
  if (!isSortedUniqueStrings(value.evidenceSnapshotIds)) {
    issues.push("canonical memory evidence-snapshot references are not sorted unique");
  }
  for (const snapshotId of value.evidenceSnapshotIds) {
    const snapshot = evidenceSnapshotById.get(snapshotId);
    if (!snapshot) {
      issues.push("canonical memory evidence snapshot is unresolved");
    } else if (!snapshot.hashValid || snapshot.memoryId !== value.memoryId) {
      issues.push("canonical memory evidence snapshot is invalid or bound to another memory");
    }
  }
  if (value.sharingScope === "agent_private") return issues;
  if (value.sharingDecisionEventIds.length === 0) {
    issues.push("shared canonical memory has no sharing decision");
  }
  for (const decisionEventId of value.sharingDecisionEventIds) {
    const decision = sharingDecisionByEventId.get(decisionEventId);
    if (!decision) {
      issues.push("canonical memory references an unknown sharing decision");
      continue;
    }
    if (decision.decisionEventId !== decisionEventId) {
      issues.push("canonical memory sharing-decision reference does not match the resolved artifact ID");
      continue;
    }
    issues.push(
      ...sharingDecisionSemanticIssues(
        decision,
        authenticatedAuthorityEvents,
        value.subjectScope,
        { kind: "canonical_memory_entity", canonicalFactId: value.canonicalFactId },
        value.sharingScope,
        value.sensitivity,
      ),
    );
  }
  return issues;
}

function sharingDecisionSemanticIssues(
  decision: contract.SharingDecisionV1,
  authenticatedAuthorityEvents: ReadonlyMap<string, ResolvedSharingAuthorityEvent>,
  expectedScope: contract.SubjectScopeV1,
  expectedTarget: contract.SharingDecisionTargetV1,
  expectedSharingScope: contract.SharingGrantScopeV1,
  expectedSensitivity: contract.Sensitivity,
): string[] {
  const issues: string[] = [];
  const authority = authenticatedAuthorityEvents.get(decision.authoritySourceEventId);
  const expectedAuthority: ResolvedSharingAuthorityEvent = {
    authorityKind: decision.authorityKind,
    decision: decision.decision,
    subjectScope: decision.subjectScope,
    sharingScope: decision.sharingScope,
    target: decision.target,
    privateConsent: decision.privateConsent,
    decidedAt: decision.decidedAt,
  };
  if (
    !authority ||
    canonicalizeJson(authority) !== canonicalizeJson(expectedAuthority)
  ) {
    issues.push("sharing authority payload is unresolved, unauthenticated, or mismatched");
  }
  if (canonicalizeJson(decision.subjectScope) !== canonicalizeJson(expectedScope)) issues.push("sharing scope target differs");
  if (canonicalizeJson(decision.target) !== canonicalizeJson(expectedTarget)) issues.push("sharing decision target differs");
  if (decision.sharingScope !== expectedSharingScope) issues.push("sharing grant scope differs");
  if (expectedSensitivity === "private" && !decision.privateConsent) {
    issues.push("private sharing lacks authenticated explicit consent");
  }
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
    privateConsent: false,
    decidedAt: "2026-08-24T00:00:00Z",
  };
  assert.deepEqual(validateContractValue("SharingDecisionV1", decision, root, contract.CONTINUITY_LIMITS), []);
  const authorityEvents = new Map<string, ResolvedSharingAuthorityEvent>([
    [
      decision.authoritySourceEventId,
      {
        authorityKind: "user",
        decision: "grant",
        subjectScope: structuredClone(subjectScope),
        sharingScope: "task_shared",
        target: structuredClone(target),
        privateConsent: false,
        decidedAt: "2026-08-24T00:00:00Z",
      },
    ],
  ]);
  assert.deepEqual(
    sharingDecisionSemanticIssues(decision, authorityEvents, subjectScope, target, "task_shared", "normal"),
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
    sharingDecisionSemanticIssues(decision, authorityEvents, reorderedScope, target, "task_shared", "normal"),
    [],
  );
  assert.ok(sharingDecisionSemanticIssues(decision, new Map(), subjectScope, target, "task_shared", "normal").length > 0);
  const wrongScope = { ...subjectScope, projectId: id("9") };
  assert.ok(
    sharingDecisionSemanticIssues(
      decision,
      authorityEvents,
      wrongScope,
      target,
      "task_shared",
      "normal",
    ).length > 0,
  );
  const wrongTarget: contract.SharedTaskProjectionTargetV1 = { ...target, taskLineageId: id("8") };
  assert.ok(
    sharingDecisionSemanticIssues(
      decision,
      authorityEvents,
      subjectScope,
      wrongTarget,
      "task_shared",
      "normal",
    ).length > 0,
  );
  assert.ok(
    sharingDecisionSemanticIssues(
      decision,
      authorityEvents,
      subjectScope,
      target,
      "project_shared",
      "normal",
    ).length > 0,
  );
  const alteredDecision = { ...decision, sharingScope: "project_shared" } as contract.SharingDecisionV1;
  assert.ok(
    sharingDecisionSemanticIssues(
      alteredDecision,
      authorityEvents,
      subjectScope,
      target,
      "project_shared",
      "normal",
    ).length > 0,
  );
  assert.ok(
    sharingDecisionSemanticIssues(decision, authorityEvents, subjectScope, target, "task_shared", "private").length > 0,
  );
  const privateDecision = { ...decision, privateConsent: true };
  const privateAuthority = new Map<string, ResolvedSharingAuthorityEvent>([
    [decision.authoritySourceEventId, { ...authorityEvents.get(decision.authoritySourceEventId)!, privateConsent: true }],
  ]);
  assert.deepEqual(
    sharingDecisionSemanticIssues(privateDecision, privateAuthority, subjectScope, target, "task_shared", "private"),
    [],
  );
});

interface ResolvedFixtureSourceIdentity {
  readonly clientId: contract.CanonicalClientIdV1;
  readonly clientVersion: string;
  readonly sessionId: string;
  readonly capabilityHash?: string;
  readonly capabilityIds: readonly string[];
  readonly privateEligible: boolean;
}

interface ResolvedOperationEvent {
  readonly phase: "start" | "progress" | "terminal";
  readonly correlation: contract.OperationCorrelationV2;
  readonly turnIdSource?: contract.TurnIdSource;
}

interface ResolvedMemoryEvidenceSnapshot {
  readonly memoryId: string;
  readonly hashValid: boolean;
}

interface ResolvedSelectedMemory {
  readonly entity: contract.CanonicalMemoryEntityV1;
  readonly hashValid: boolean;
}

interface ResolvedLineageEventEvidence {
  readonly sourceEventId: string;
  readonly establishesLineage: boolean;
  readonly substantive: boolean;
  readonly producedStateRevision?: string;
}

interface ResolvedCapsuleParent {
  readonly checkpointId: string;
  readonly checkpointCreatedBySourceEventId: string;
  readonly canonicalState: contract.CanonicalWorkStateV2;
  readonly authorizedEnvelope: contract.JsonValue;
  readonly lineageEvidence: readonly ResolvedLineageEventEvidence[];
}

function subjectScopeContains(container: contract.SubjectScopeV1, nested: contract.SubjectScopeV1): boolean {
  if (container.personalVaultId !== nested.personalVaultId) return false;
  if (container.kind === "personal_vault") return true;
  if (!("projectId" in nested) || container.projectId !== nested.projectId) return false;
  if (container.kind === "project") return true;
  if (!("workspaceId" in nested) || container.workspaceId !== nested.workspaceId) return false;
  if (container.kind === "workspace") return true;
  if (
    container.branchKey !== undefined &&
    (!("branchKey" in nested) || container.branchKey !== nested.branchKey)
  ) {
    return false;
  }
  if (container.kind === "branch") return true;
  if (!("taskLineageId" in nested) || container.taskLineageId !== nested.taskLineageId) return false;
  if (container.kind === "task_lineage") return true;
  if (!("sessionId" in nested) || container.sessionId !== nested.sessionId) return false;
  if (container.kind === "session") return true;
  return "turnId" in nested && container.turnId === nested.turnId;
}

function stateRevisionEnvelopeIssues(value: contract.TaskStateRevisionEnvelopeV1): string[] {
  const parents = value.parentStateRevisions;
  return isSortedUniqueStrings(parents) ? [] : ["parent state revisions are not sorted unique"];
}

function deriveLineageSourceSummary(
  parent: ResolvedCapsuleParent,
  sourceIdentityByEventId: ReadonlyMap<string, ResolvedFixtureSourceIdentity>,
): contract.LineageSourceSummaryV1 | undefined {
  const origin = parent.lineageEvidence.find(({ establishesLineage }) => establishesLineage);
  const contributors = parent.lineageEvidence.filter(
    ({ producedStateRevision }) => producedStateRevision === parent.canonicalState.revision.stateRevision,
  );
  const firstEventByClient = new Map<contract.CanonicalClientIdV1, string>();
  for (const event of parent.lineageEvidence) {
    if (!event.substantive) continue;
    const source = sourceIdentityByEventId.get(event.sourceEventId);
    if (!source) return undefined;
    if (!firstEventByClient.has(source.clientId)) firstEventByClient.set(source.clientId, event.sourceEventId);
  }
  if (!origin || contributors.length !== 1 || firstEventByClient.size === 0) return undefined;
  return {
    lineageOriginSourceEventId: origin.sourceEventId,
    lastContributingSourceEventId: contributors[0]!.sourceEventId,
    participantSourceEventIds: [...firstEventByClient.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, sourceEventId]) => sourceEventId),
  };
}

function rehashCanonicalState(
  value: Readonly<Record<string, unknown>>,
  profile: contract.CanonicalStateHashProfileV1,
): contract.CanonicalWorkStateV2 {
  const clone = structuredClone(value) as Record<string, unknown>;
  const revision = clone.revision as Record<string, contract.JsonValue>;
  const { contentHash: _oldContentHash, stateRevision: _oldStateRevision, ...revisionMetadata } = revision;
  const { revision: _oldRevision, ...contentProjection } = clone;
  const contentHash = createHash("sha256")
    .update(canonicalizeJson(contentProjection as contract.JsonValue), "utf8")
    .digest("hex");
  const stateRevision = createHash("sha256")
    .update(
      canonicalizeJson({ domain: profile.stateRevisionDomain, contentHash, revision: revisionMetadata }),
      "utf8",
    )
    .digest("hex");
  clone.revision = { ...revisionMetadata, contentHash, stateRevision };
  return clone as unknown as contract.CanonicalWorkStateV2;
}

function sourceReferenceIssues(
  referenceSets: readonly (readonly string[])[],
  sourceIdentityByEventId: ReadonlyMap<string, ResolvedFixtureSourceIdentity>,
  label: string,
  expectedLane?: Readonly<{ clientId: contract.CanonicalClientIdV1; sessionId: string }>,
): string[] {
  const issues: string[] = [];
  for (const ids of referenceSets) {
    if (!isSortedUniqueStrings(ids)) {
      issues.push(`${label} source-event references are not sorted unique`);
    }
    for (const id of ids) {
      const resolved = sourceIdentityByEventId.get(id);
      if (!resolved) {
        issues.push(`${label} source-event reference is unresolved or unauthenticated`);
      } else if (
        expectedLane &&
        (resolved.clientId !== expectedLane.clientId || resolved.sessionId !== expectedLane.sessionId)
      ) {
        issues.push(`${label} source-event reference resolves outside its Agent-local lane`);
      }
    }
  }
  return issues;
}

function pendingOperationSemanticIssues(
  operations: readonly contract.PendingOperationV2[],
  sourceIdentityByEventId: ReadonlyMap<string, ResolvedFixtureSourceIdentity>,
  operationEventById: ReadonlyMap<string, ResolvedOperationEvent>,
): string[] {
  const issues: string[] = [];
  for (const operation of operations) {
    if (operation.operationId !== operation.correlation.operationId) {
      issues.push("pending operation ID differs from its correlation operation ID");
    }
    const startEvent = operationEventById.get(operation.correlation.startEventId);
    const startSource = sourceIdentityByEventId.get(operation.correlation.startEventId);
    if (
      !operation.sourceEventIds.includes(operation.correlation.startEventId) ||
      !startSource ||
      !startEvent ||
      startEvent.phase !== "start" ||
      startSource.sessionId !== operation.correlation.sessionId ||
      canonicalizeJson(startEvent.correlation as unknown as contract.JsonValue) !==
        canonicalizeJson(operation.correlation as unknown as contract.JsonValue) ||
      startEvent.turnIdSource !== operation.startTurnIdSource
    ) {
      issues.push("pending operation start event is unauthenticated, unbound, or correlation-mismatched");
    }
  }
  return issues;
}

function canonicalWorkStateSemanticIssues(
  value: contract.CanonicalWorkStateV2,
  sourceIdentityByEventId: ReadonlyMap<string, ResolvedFixtureSourceIdentity>,
  operationEventById: ReadonlyMap<string, ResolvedOperationEvent>,
): string[] {
  return value.sharedTaskState
    ? pendingOperationSemanticIssues(value.sharedTaskState.pendingOperations, sourceIdentityByEventId, operationEventById)
    : [];
}

function selectedMemoryDeliveryIssues(
  value: contract.ResumeCapsuleV2,
  selectedMemoryById: ReadonlyMap<string, ResolvedSelectedMemory>,
  evidenceSnapshotById: ReadonlyMap<string, ResolvedMemoryEvidenceSnapshot>,
  sharingDecisionByEventId: ReadonlyMap<string, contract.SharingDecisionV1>,
  authenticatedAuthorityEvents: ReadonlyMap<string, ResolvedSharingAuthorityEvent>,
  sourceIdentityByEventId: ReadonlyMap<string, ResolvedFixtureSourceIdentity>,
  destinationIdentity: ResolvedFixtureSourceIdentity | undefined,
): string[] {
  const issues: string[] = [];
  if (!isSortedUniqueStrings(value.selectedMemoryIds)) {
    issues.push("selected memory references are not sorted unique");
  }
  for (const memoryId of value.selectedMemoryIds) {
    const resolved = selectedMemoryById.get(memoryId);
    if (!resolved || !resolved.hashValid || resolved.entity.memoryId !== memoryId) {
      issues.push("selected memory is unresolved, hash-invalid, or ID-mismatched");
      continue;
    }
    const memory = resolved.entity;
    issues.push(
      ...canonicalMemorySharingIssues(
        memory,
        sharingDecisionByEventId,
        authenticatedAuthorityEvents,
        sourceIdentityByEventId,
        evidenceSnapshotById,
      ),
    );
    if (!subjectScopeContains(memory.subjectScope, value.subjectScope)) {
      issues.push("selected memory subject scope does not contain the capsule task scope");
    }
    if (memory.lifecycle !== "active") issues.push("selected memory is not active");
    if (memory.sensitivity === "secret") issues.push("secret selected memory was serialized into a capsule");
    if (memory.egressPolicy !== "eligible") issues.push("non-egress selected memory was serialized into a capsule");
    if (memory.sensitivity === "private" && destinationIdentity?.privateEligible !== true) {
      issues.push("private selected memory is not eligible under authenticated destination policy");
    }
    if (memory.sharingScope === "agent_private" && memory.sensitivity === "private") {
      issues.push("private Agent-private memory has no grantable explicit-consent authority for capsule delivery");
    }
    if (
      memory.sharingScope === "agent_private" &&
      (value.resumeProfile !== "same_agent" ||
        memory.sourceEventIds.some(
          (sourceEventId) => sourceIdentityByEventId.get(sourceEventId)?.clientId !== value.destination.clientId,
        ))
    ) {
      issues.push("Agent-private selected memory belongs to another client or cross-agent delivery");
    }
  }
  return issues;
}

type ProjectionEvidence = Readonly<{
  sourceEventIds: readonly string[];
  sensitivity: contract.Sensitivity;
}>;

function sharedTaskEvidence(value: contract.SharedTaskStateV1): readonly ProjectionEvidence[] {
  return [
    ...(value.goal ? [value.goal] : []),
    ...value.constraints,
    ...value.activeFiles,
    ...value.modifiedFiles,
    ...value.recentCommands,
    ...value.recentTests,
    ...value.pendingOperations,
    ...value.droppedEvidence.reasonWindows.flatMap(({ entries }) => entries),
    ...(value.semanticResumeNote ? [value.semanticResumeNote] : []),
  ];
}

function agentLocalEvidence(value: contract.AgentLocalStateV1): readonly ProjectionEvidence[] {
  return [
    value.latestSubstantivePrompt,
    value.lastAssistantConclusion,
    value.nativeTodoState,
    value.nativePlanState,
    value.hostMetadata,
  ].filter((item) => item !== undefined);
}

function computeResumeCapsuleContentHash(value: contract.ResumeCapsuleV2): string {
  const { contentHash: _excluded, ...capsule } = value;
  return createHash("sha256")
    .update(
      canonicalizeJson({ domain: "free-mem/ResumeCapsuleV2/content/v1", capsule }),
      "utf8",
    )
    .digest("hex");
}

function capsuleAuthorityProjection(value: contract.ResumeCapsuleV2): contract.JsonValue {
  const {
    contentHash: _contentHash,
    sharedTaskState: _sharedTaskState,
    destinationAgentLocalState: _destinationAgentLocalState,
    ...envelope
  } = value;
  return envelope as unknown as contract.JsonValue;
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
  sharingDecisionByEventId: ReadonlyMap<string, contract.SharingDecisionV1>,
  authenticatedAuthorityEvents: ReadonlyMap<string, ResolvedSharingAuthorityEvent>,
  parentByCheckpointRevision: ReadonlyMap<string, ResolvedCapsuleParent>,
  selectedMemoryById: ReadonlyMap<string, ResolvedSelectedMemory>,
  memoryEvidenceSnapshotById: ReadonlyMap<string, ResolvedMemoryEvidenceSnapshot>,
  operationEventById: ReadonlyMap<string, ResolvedOperationEvent>,
): string[] {
  const issues: string[] = [];
  if (computeResumeCapsuleContentHash(value) !== value.contentHash) {
    issues.push("resume capsule content hash does not match its projection");
  }
  const parent = parentByCheckpointRevision.get(value.checkpointRevision);
  if (
    !parent ||
    parent.checkpointId !== value.checkpointId ||
    parent.checkpointCreatedBySourceEventId !== value.checkpointCreatedBySourceEventId ||
    parent.canonicalState.revision.stateRevision !== value.workStateRevision
  ) {
    issues.push("capsule checkpoint ID, revision, creator, or work-state binding is invalid");
  } else {
    issues.push(...stateRevisionEnvelopeIssues(parent.canonicalState.revision));
    issues.push(...canonicalWorkStateSemanticIssues(parent.canonicalState, sourceIdentityByEventId, operationEventById));
    const derivedLineageSourceSummary = deriveLineageSourceSummary(parent, sourceIdentityByEventId);
    if (
      !derivedLineageSourceSummary ||
      canonicalizeJson(parent.canonicalState.lineageSourceSummary) !== canonicalizeJson(derivedLineageSourceSummary)
    ) {
      issues.push("lineage summary differs from append-only event/revision evidence");
    }
    if (canonicalizeJson(parent.authorizedEnvelope) !== canonicalizeJson(capsuleAuthorityProjection(value))) {
      issues.push("capsule envelope differs from its persisted delivery claim");
    }
    if (
      canonicalizeJson(parent.canonicalState.subjectScope) !== canonicalizeJson(value.subjectScope) ||
      canonicalizeJson(parent.canonicalState.lineageSourceSummary) !== canonicalizeJson(value.lineageSourceSummary)
    ) {
      issues.push("capsule scope or lineage differs from resolved work state");
    }
    if (
      value.sharedTaskState &&
      (!parent.canonicalState.sharedTaskState ||
        canonicalizeJson(parent.canonicalState.sharedTaskState) !== canonicalizeJson(value.sharedTaskState))
    ) {
      issues.push("capsule shared projection differs from resolved work state");
    }
    if (value.destinationAgentLocalState) {
      const resolvedLane = parent.canonicalState.agentLocalStates.find(
        ({ clientId, sessionId }) =>
          clientId === value.destinationAgentLocalState?.clientId &&
          sessionId === value.destinationAgentLocalState.sessionId,
      );
      if (!resolvedLane || canonicalizeJson(resolvedLane) !== canonicalizeJson(value.destinationAgentLocalState)) {
        issues.push("capsule Agent-local projection differs from resolved work state");
      }
    }
  }
  if (value.reconciliation === "incompatible") issues.push("incompatible reconciliation cannot produce a capsule");
  const sharedEvidence = value.sharedTaskState ? sharedTaskEvidence(value.sharedTaskState) : [];
  const localEvidence = value.destinationAgentLocalState ? agentLocalEvidence(value.destinationAgentLocalState) : [];
  const sharedActualSensitivity = value.sharedTaskState
    ? maxSensitivity(sharedEvidence.map(({ sensitivity }) => sensitivity))
    : undefined;
  const includedProjections: Array<{
    projection: contract.SharedTaskStateV1 | contract.AgentLocalStateV1;
    actualSensitivity: contract.Sensitivity;
  }> = [];
  if (value.sharedTaskState) {
    includedProjections.push({
      projection: value.sharedTaskState,
      actualSensitivity: sharedActualSensitivity!,
    });
  }
  if (value.destinationAgentLocalState) {
    includedProjections.push({
      projection: value.destinationAgentLocalState,
      actualSensitivity: maxSensitivity(localEvidence.map(({ sensitivity }) => sensitivity)),
    });
  }
  for (const { projection, actualSensitivity } of includedProjections) {
    if (projection.sensitivity !== actualSensitivity) issues.push("included projection sensitivity is not maximal");
    if (actualSensitivity === "secret") issues.push("secret projection was serialized into a capsule");
    if (projection.egressPolicy === "local_only" || projection.egressPolicy === "prohibited_egress") {
      issues.push("non-egress projection was serialized into a capsule");
    }
  }
  issues.push(
    ...sourceReferenceIssues(
      [
        [value.lineageSourceSummary.lineageOriginSourceEventId],
        [value.lineageSourceSummary.lastContributingSourceEventId],
        ...value.lineageSourceSummary.participantSourceEventIds.map((id) => [id]),
        [value.checkpointCreatedBySourceEventId],
      ],
      sourceIdentityByEventId,
      "capsule lineage",
    ),
  );
  if (value.sharedTaskState) {
    issues.push(
      ...sourceReferenceIssues(
        sharedEvidence.map(({ sourceEventIds }) => sourceEventIds),
        sourceIdentityByEventId,
        "shared projection",
      ),
    );
    issues.push(...sharingDecisionReferenceIssues(value.sharedTaskState.sharingDecisionEventIds));
    for (const decisionEventId of value.sharedTaskState.sharingDecisionEventIds) {
      const decision = sharingDecisionByEventId.get(decisionEventId);
      if (!decision) {
        issues.push("shared projection references an unknown sharing decision");
        continue;
      }
      if (decision.decisionEventId !== decisionEventId) {
        issues.push("shared projection decision reference does not match the resolved artifact ID");
        continue;
      }
      issues.push(
        ...sharingDecisionSemanticIssues(
          decision,
          authenticatedAuthorityEvents,
          value.subjectScope,
          { kind: "shared_task_projection", taskLineageId: value.subjectScope.taskLineageId },
          "task_shared",
          sharedActualSensitivity!,
        ),
      );
    }
  } else if (value.resumeProfile !== "same_agent") {
    issues.push("cross-agent capsule has no shared projection");
  }
  const destinationIdentity = sourceIdentityByEventId.get(value.destination.sourceIdentityEventId);
  if (
    !destinationIdentity ||
    destinationIdentity.clientId !== value.destination.clientId ||
    destinationIdentity.clientVersion !== value.destination.clientVersion ||
    destinationIdentity.sessionId !== value.destination.sessionId ||
    destinationIdentity.capabilityHash !== value.destination.capabilityHash
  ) {
    issues.push("destination does not match authenticated source identity");
  }
  if (
    value.sharedTaskState &&
    (!value.destination.capabilityHash ||
      !destinationIdentity?.capabilityHash ||
      !destinationIdentity.capabilityIds.includes("shared-task-v1"))
  ) {
    issues.push("destination capability profile does not support shared task delivery");
  }
  issues.push(
    ...selectedMemoryDeliveryIssues(
      value,
      selectedMemoryById,
      memoryEvidenceSnapshotById,
      sharingDecisionByEventId,
      authenticatedAuthorityEvents,
      sourceIdentityByEventId,
      destinationIdentity,
    ),
  );
  if (
    includedProjections.some(({ actualSensitivity }) => actualSensitivity === "private") &&
    destinationIdentity?.privateEligible !== true
  ) {
    issues.push("private projection is not eligible under authenticated destination policy");
  }
  if (value.destinationAgentLocalState) {
    issues.push(...agentLocalLaneSemanticIssues([value.destinationAgentLocalState], sourceIdentityByEventId));
    issues.push(
      ...sourceReferenceIssues(
        localEvidence.map(({ sourceEventIds }) => sourceEventIds),
        sourceIdentityByEventId,
        "destination Agent-local projection",
        value.destination,
      ),
    );
  }
  if (
    value.destinationAgentLocalState &&
    (value.destinationAgentLocalState.clientId !== value.destination.clientId ||
      value.destinationAgentLocalState.sessionId !== value.destination.sessionId)
  ) {
    issues.push("destination Agent-local lane belongs to another client or session");
  }
  if (value.sharedTaskState && value.sharedTaskState.repositoryState.workspaceId !== value.subjectScope.workspaceId) {
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
    contentHash: id,
    injectionId: id,
    checkpointId: id,
    checkpointRevision: id,
    workStateRevision: id,
    subjectScope: projection.subjectScope,
    lineageSourceSummary: projection.lineageSourceSummary,
    checkpointCreatedBySourceEventId: id,
    destination: {
      sourceIdentityEventId: id,
      clientId: "codex-cli",
      clientVersion: "1",
      sessionId: id,
      capabilityHash: "c".repeat(64),
    },
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
  const stateVector = manifest.canonicalStateHashProfile.testVector;
  const resolvedState = rehashCanonicalState(
    {
      ...(stateVector.contentProjection as Record<string, contract.JsonValue>),
      agentLocalStates: [capsule.destinationAgentLocalState],
      revision: {
        ...(stateVector.revisionMetadata as Record<string, contract.JsonValue>),
        contentHash: stateVector.contentHash,
        stateRevision: stateVector.stateRevision,
      },
    },
    manifest.canonicalStateHashProfile,
  );
  (capsule as unknown as { workStateRevision: string }).workStateRevision = resolvedState.revision.stateRevision;
  (capsule as unknown as { contentHash: string }).contentHash = computeResumeCapsuleContentHash(capsule);
  const sourceClients = new Map<string, ResolvedFixtureSourceIdentity>([
    [
      id,
      {
        clientId: "codex-cli",
        clientVersion: "1",
        sessionId: id,
        capabilityHash: "c".repeat(64),
        capabilityIds: ["shared-task-v1"],
        privateEligible: false,
      },
    ],
    [
      "e".repeat(64),
      { clientId: "claude-code", clientVersion: "1", sessionId: "1".repeat(64), capabilityIds: [], privateEligible: false },
    ],
    [
      "f".repeat(64),
      { clientId: "codex-cli", clientVersion: "1", sessionId: "2".repeat(64), capabilityIds: [], privateEligible: false },
    ],
  ]);
  assert.ok(capsule.sharedTaskState);
  const decisionEventId = capsule.sharedTaskState.sharingDecisionEventIds[0]!;
  const authorityEventId = "f".repeat(64);
  const sharingDecision: contract.SharingDecisionV1 = {
    schemaVersion: 1,
    decisionEventId,
    authoritySourceEventId: authorityEventId,
    authorityKind: "user",
    decision: "grant",
    subjectScope: capsule.subjectScope,
    sharingScope: "task_shared",
    target: { kind: "shared_task_projection", taskLineageId: capsule.subjectScope.taskLineageId },
    privateConsent: false,
    decidedAt: "2026-08-24T00:00:00Z",
  };
  const sharingDecisions = new Map([[decisionEventId, sharingDecision]]);
  const authorityEvents = new Map<string, ResolvedSharingAuthorityEvent>([
    [
      authorityEventId,
      {
        authorityKind: "user",
        decision: "grant",
        subjectScope: structuredClone(capsule.subjectScope),
        sharingScope: "task_shared",
        target: { kind: "shared_task_projection", taskLineageId: capsule.subjectScope.taskLineageId },
        privateConsent: false,
        decidedAt: "2026-08-24T00:00:00Z",
      },
    ],
  ]);
  const parentFor = (
    value: contract.ResumeCapsuleV2,
    state: contract.CanonicalWorkStateV2,
  ): ResolvedCapsuleParent => ({
    checkpointId: id,
    checkpointCreatedBySourceEventId: id,
    canonicalState: state,
    authorizedEnvelope: capsuleAuthorityProjection(value),
    lineageEvidence: [
      {
        sourceEventId: "e".repeat(64),
        establishesLineage: true,
        substantive: true,
      },
      {
        sourceEventId: "f".repeat(64),
        establishesLineage: false,
        substantive: true,
        producedStateRevision: state.revision.stateRevision,
      },
    ],
  });
  const resolvedParents = new Map<string, ResolvedCapsuleParent>([
    [capsule.checkpointRevision, parentFor(capsule, resolvedState)],
  ]);
  const capsuleIssues = (
    value: contract.ResumeCapsuleV2,
    sources: ReadonlyMap<string, ResolvedFixtureSourceIdentity> = sourceClients,
    decisions: ReadonlyMap<string, contract.SharingDecisionV1> = sharingDecisions,
    authorities: ReadonlyMap<string, ResolvedSharingAuthorityEvent> = authorityEvents,
    parents: ReadonlyMap<string, ResolvedCapsuleParent> = resolvedParents,
    memories: ReadonlyMap<string, ResolvedSelectedMemory> = new Map(),
    memorySnapshots: ReadonlyMap<string, ResolvedMemoryEvidenceSnapshot> = new Map(),
    operationEvents: ReadonlyMap<string, ResolvedOperationEvent> = new Map(),
  ) =>
    resumeCapsuleSemanticIssues(
      value,
      sources,
      decisions,
      authorities,
      parents,
      memories,
      memorySnapshots,
      operationEvents,
    );
  assert.deepEqual(validateContractValue("ResumeCapsuleV2", capsule, root, contract.CONTINUITY_LIMITS), []);
  assert.deepEqual(capsuleIssues(capsule), []);
  const operationId = "7".repeat(64);
  const pendingOperation: contract.PendingOperationV2 = {
    operationId,
    correlation: {
      operationId,
      startEventId: "e".repeat(64),
      operationMatchKey: "8".repeat(64),
      sessionId: "1".repeat(64),
      taskLineageId: capsule.subjectScope.taskLineageId,
    },
    kind: "tool",
    description: "pending operation",
    status: "started",
    replayPolicy: "never_auto",
    sourceEventIds: ["e".repeat(64)],
    startedAt: "2026-08-24T00:00:00Z",
    sensitivity: "normal",
  };
  const resolvePendingCapsule = (operation: contract.PendingOperationV2) => {
    const value = structuredClone(capsule) as unknown as contract.ResumeCapsuleV2;
    assert.ok(value.sharedTaskState);
    (value.sharedTaskState.pendingOperations as contract.PendingOperationV2[]).push(operation);
    const stateInput = structuredClone(resolvedState) as unknown as Record<string, unknown>;
    stateInput.sharedTaskState = value.sharedTaskState;
    const state = rehashCanonicalState(stateInput, manifest.canonicalStateHashProfile);
    (value as unknown as { workStateRevision: string }).workStateRevision = state.revision.stateRevision;
    (value as unknown as { contentHash: string }).contentHash = computeResumeCapsuleContentHash(value);
    return {
      value,
      state,
      parents: new Map([[value.checkpointRevision, parentFor(value, state)]]) as ReadonlyMap<
        string,
        ResolvedCapsuleParent
      >,
    };
  };
  const pendingStartEvents = new Map<string, ResolvedOperationEvent>([
    [
      pendingOperation.correlation.startEventId,
      {
        phase: "start",
        correlation: structuredClone(pendingOperation.correlation),
        turnIdSource: pendingOperation.startTurnIdSource,
      },
    ],
  ]);
  const pendingIssues = (
    resolved: ReturnType<typeof resolvePendingCapsule>,
    operationEvents: ReadonlyMap<string, ResolvedOperationEvent> = pendingStartEvents,
  ) =>
    capsuleIssues(
      resolved.value,
      sourceClients,
      sharingDecisions,
      authorityEvents,
      resolved.parents,
      new Map(),
      new Map(),
      operationEvents,
    );
  const validPending = resolvePendingCapsule(pendingOperation);
  assert.deepEqual(validateContractValue("ResumeCapsuleV2", validPending.value, root, contract.CONTINUITY_LIMITS), []);
  assert.deepEqual(canonicalWorkStateSemanticIssues(validPending.state, sourceClients, pendingStartEvents), []);
  assert.deepEqual(pendingIssues(validPending), []);
  for (const mutateOperation of [
    (operation: contract.PendingOperationV2) =>
      ((operation.correlation as unknown as { operationId: string }).operationId = "9".repeat(64)),
    (operation: contract.PendingOperationV2) =>
      ((operation.correlation as unknown as { startEventId: string }).startEventId = "9".repeat(64)),
    (operation: contract.PendingOperationV2) =>
      ((operation.correlation as unknown as { startEventId: string }).startEventId = "f".repeat(64)),
  ]) {
    const invalidOperation = structuredClone(pendingOperation) as unknown as contract.PendingOperationV2;
    mutateOperation(invalidOperation);
    const invalidPending = resolvePendingCapsule(invalidOperation);
    assert.deepEqual(validateContractValue("ResumeCapsuleV2", invalidPending.value, root, contract.CONTINUITY_LIMITS), []);
    assert.ok(canonicalWorkStateSemanticIssues(invalidPending.state, sourceClients, pendingStartEvents).length > 0);
    assert.ok(pendingIssues(invalidPending).length > 0);
  }
  const wrongPhaseOperation = structuredClone(pendingOperation) as unknown as contract.PendingOperationV2;
  (wrongPhaseOperation.correlation as unknown as { startEventId: string }).startEventId = "f".repeat(64);
  (wrongPhaseOperation.sourceEventIds as string[]).push("f".repeat(64));
  const wrongPhasePending = resolvePendingCapsule(wrongPhaseOperation);
  const wrongPhaseEvents = new Map(pendingStartEvents).set("f".repeat(64), {
    ...pendingStartEvents.get("e".repeat(64))!,
    correlation: structuredClone(wrongPhaseOperation.correlation),
    phase: "terminal" as const,
  });
  assert.ok(pendingIssues(wrongPhasePending, wrongPhaseEvents).length > 0);
  for (const mutateOptionalCorrelation of [
    (operation: contract.PendingOperationV2) =>
      ((operation.correlation as unknown as { nativeOperationId: string }).nativeOperationId = "3".repeat(64)),
    (operation: contract.PendingOperationV2) =>
      ((operation.correlation as unknown as { toolName: string }).toolName = "Bash"),
    (operation: contract.PendingOperationV2) =>
      ((operation.correlation as unknown as { canonicalInputHash: string }).canonicalInputHash = "4".repeat(64)),
    (operation: contract.PendingOperationV2) =>
      ((operation.correlation as unknown as { turnId: string }).turnId = "5".repeat(64)),
    (operation: contract.PendingOperationV2) =>
      ((operation as unknown as { startTurnIdSource: contract.TurnIdSource }).startTurnIdSource = "native"),
  ]) {
    const optionalMismatch = structuredClone(pendingOperation) as unknown as contract.PendingOperationV2;
    mutateOptionalCorrelation(optionalMismatch);
    assert.ok(pendingIssues(resolvePendingCapsule(optionalMismatch)).length > 0);
  }
  const wrongAuthenticatedSession = structuredClone(pendingOperation) as unknown as contract.PendingOperationV2;
  (wrongAuthenticatedSession.correlation as unknown as { sessionId: string }).sessionId = "2".repeat(64);
  const wrongSessionPending = resolvePendingCapsule(wrongAuthenticatedSession);
  const wrongSessionEvents = new Map<string, ResolvedOperationEvent>([
    [
      wrongAuthenticatedSession.correlation.startEventId,
      { phase: "start", correlation: structuredClone(wrongAuthenticatedSession.correlation) },
    ],
  ]);
  assert.ok(pendingIssues(wrongSessionPending, wrongSessionEvents).length > 0);
  for (const field of ["checkpointId", "checkpointCreatedBySourceEventId"] as const) {
    const mismatchedCheckpoint = structuredClone(capsule) as unknown as contract.ResumeCapsuleV2;
    (mismatchedCheckpoint as unknown as Record<string, string>)[field] = "9".repeat(64);
    (mismatchedCheckpoint as unknown as { contentHash: string }).contentHash =
      computeResumeCapsuleContentHash(mismatchedCheckpoint);
    const mismatchedParents = new Map<string, ResolvedCapsuleParent>([
      [mismatchedCheckpoint.checkpointRevision, parentFor(mismatchedCheckpoint, resolvedState)],
    ]);
    assert.deepEqual(validateContractValue("ResumeCapsuleV2", mismatchedCheckpoint, root, contract.CONTINUITY_LIMITS), []);
    assert.ok(
      capsuleIssues(mismatchedCheckpoint, sourceClients, sharingDecisions, authorityEvents, mismatchedParents).length > 0,
      field,
    );
  }

  const memoryVector = manifest.canonicalMemoryHashProfile.testVector;
  const selectedMemory = {
    ...(memoryVector.contentProjection as Record<string, contract.JsonValue>),
    ...(memoryVector.revisionMetadata as Record<string, contract.JsonValue>),
    memoryId: memoryVector.memoryId,
    memoryRevision: memoryVector.initialMemoryRevision,
    contentHash: memoryVector.contentHash,
  } as unknown as contract.CanonicalMemoryEntityV1;
  assert.deepEqual(validateContractValue("CanonicalMemoryEntityV1", selectedMemory, root, contract.CONTINUITY_LIMITS), []);
  const selectedMemoryDecisionEventId = selectedMemory.sharingDecisionEventIds[0]!;
  const selectedMemoryAuthorityEventId = "b".repeat(64);
  const selectedMemoryDecision: contract.SharingDecisionV1 = {
    schemaVersion: 1,
    decisionEventId: selectedMemoryDecisionEventId,
    authoritySourceEventId: selectedMemoryAuthorityEventId,
    authorityKind: "user",
    decision: "grant",
    subjectScope: selectedMemory.subjectScope,
    sharingScope: "project_shared",
    target: { kind: "canonical_memory_entity", canonicalFactId: selectedMemory.canonicalFactId },
    privateConsent: false,
    decidedAt: "2026-08-24T00:00:00Z",
  };
  const decisionsWithMemory = new Map(sharingDecisions).set(selectedMemoryDecisionEventId, selectedMemoryDecision);
  const authoritiesWithMemory = new Map(authorityEvents).set(selectedMemoryAuthorityEventId, {
    authorityKind: "user" as const,
    decision: "grant" as const,
    subjectScope: structuredClone(selectedMemory.subjectScope),
    sharingScope: "project_shared" as const,
    target: { kind: "canonical_memory_entity" as const, canonicalFactId: selectedMemory.canonicalFactId },
    privateConsent: false,
    decidedAt: "2026-08-24T00:00:00Z",
  });
  const selectedMemorySnapshots = new Map<string, ResolvedMemoryEvidenceSnapshot>([
    [
      selectedMemory.evidenceSnapshotIds[0]!,
      { memoryId: selectedMemory.memoryId, hashValid: true },
    ],
  ]);
  const selectedMemories = new Map<string, ResolvedSelectedMemory>([
    [selectedMemory.memoryId, { entity: selectedMemory, hashValid: true }],
  ]);
  assert.equal(
    subjectScopeContains(
      { ...capsule.subjectScope, branchKey: "8".repeat(64) },
      { ...capsule.subjectScope, branchKey: "9".repeat(64) },
    ),
    false,
  );
  const capsuleWithMemory = structuredClone(capsule) as unknown as contract.ResumeCapsuleV2;
  (capsuleWithMemory.selectedMemoryIds as string[]).push(selectedMemory.memoryId);
  (capsuleWithMemory as unknown as { contentHash: string }).contentHash =
    computeResumeCapsuleContentHash(capsuleWithMemory);
  const memoryCapsuleParents = new Map<string, ResolvedCapsuleParent>([
    [capsuleWithMemory.checkpointRevision, parentFor(capsuleWithMemory, resolvedState)],
  ]);
  const selectedMemoryIssues = (
    overrides: Readonly<{
      value?: contract.ResumeCapsuleV2;
      sources?: ReadonlyMap<string, ResolvedFixtureSourceIdentity>;
      decisions?: ReadonlyMap<string, contract.SharingDecisionV1>;
      authorities?: ReadonlyMap<string, ResolvedSharingAuthorityEvent>;
      parents?: ReadonlyMap<string, ResolvedCapsuleParent>;
      memories?: ReadonlyMap<string, ResolvedSelectedMemory>;
      snapshots?: ReadonlyMap<string, ResolvedMemoryEvidenceSnapshot>;
    }> = {},
  ) =>
    capsuleIssues(
      overrides.value ?? capsuleWithMemory,
      overrides.sources ?? sourceClients,
      overrides.decisions ?? decisionsWithMemory,
      overrides.authorities ?? authoritiesWithMemory,
      overrides.parents ?? memoryCapsuleParents,
      overrides.memories ?? selectedMemories,
      overrides.snapshots ?? selectedMemorySnapshots,
    );
  assert.deepEqual(validateContractValue("ResumeCapsuleV2", capsuleWithMemory, root, contract.CONTINUITY_LIMITS), []);
  assert.deepEqual(selectedMemoryIssues(), []);
  assert.ok(selectedMemoryIssues({ memories: new Map() }).length > 0);
  assert.ok(
    selectedMemoryIssues({
      memories: new Map([[selectedMemory.memoryId, { entity: selectedMemory, hashValid: false }]]),
    }).length > 0,
  );
  for (const overrides of [
    { subjectScope: { ...selectedMemory.subjectScope, projectId: "9".repeat(64) } },
    {
      subjectScope: {
        ...capsule.subjectScope,
        branchKey: "9".repeat(64),
      },
    },
    { sensitivity: "secret" as const },
    { egressPolicy: "local_only" as const },
    { lifecycle: "superseded" as const },
  ]) {
    const ineligibleMemory = { ...selectedMemory, ...overrides } as contract.CanonicalMemoryEntityV1;
    assert.ok(
      selectedMemoryIssues({
        memories: new Map([[selectedMemory.memoryId, { entity: ineligibleMemory, hashValid: true }]]),
      }).length > 0,
    );
  }
  const agentPrivateMemory = {
    ...selectedMemory,
    sharingScope: "agent_private" as const,
    sharingDecisionEventIds: [],
  };
  assert.ok(
    selectedMemoryIssues({
      memories: new Map([[selectedMemory.memoryId, { entity: agentPrivateMemory, hashValid: true }]]),
    }).length > 0,
  );
  const duplicateSelectedMemory = structuredClone(capsuleWithMemory) as unknown as contract.ResumeCapsuleV2;
  (duplicateSelectedMemory.selectedMemoryIds as string[]).push(selectedMemory.memoryId);
  (duplicateSelectedMemory as unknown as { contentHash: string }).contentHash =
    computeResumeCapsuleContentHash(duplicateSelectedMemory);
  assert.ok(
    selectedMemoryIssues({
      value: duplicateSelectedMemory,
      parents: new Map([
        [duplicateSelectedMemory.checkpointRevision, parentFor(duplicateSelectedMemory, resolvedState)],
      ]),
    }).length > 0,
  );
  const clientOrderedCapsule = structuredClone(capsule) as unknown as contract.ResumeCapsuleV2;
  const clientOrderedParticipants = ["f".repeat(64), "e".repeat(64)];
  (clientOrderedCapsule.lineageSourceSummary as unknown as { participantSourceEventIds: string[] })
    .participantSourceEventIds = clientOrderedParticipants;
  const clientOrderedStateInput = structuredClone(resolvedState) as unknown as Record<string, unknown>;
  clientOrderedStateInput.lineageSourceSummary = clientOrderedCapsule.lineageSourceSummary;
  const clientOrderedState = rehashCanonicalState(clientOrderedStateInput, manifest.canonicalStateHashProfile);
  (clientOrderedCapsule as unknown as { workStateRevision: string }).workStateRevision =
    clientOrderedState.revision.stateRevision;
  (clientOrderedCapsule as unknown as { contentHash: string }).contentHash =
    computeResumeCapsuleContentHash(clientOrderedCapsule);
  const clientOrderedSources = new Map(sourceClients);
  clientOrderedSources.set("e".repeat(64), { ...sourceClients.get("e".repeat(64))!, clientId: "codex-cli" });
  clientOrderedSources.set("f".repeat(64), { ...sourceClients.get("f".repeat(64))!, clientId: "claude-code" });
  assert.deepEqual(
    capsuleIssues(
      clientOrderedCapsule,
      clientOrderedSources,
      sharingDecisions,
      authorityEvents,
      new Map([
        [
          clientOrderedCapsule.checkpointRevision,
          parentFor(clientOrderedCapsule, clientOrderedState),
        ],
      ]),
    ),
    [],
  );
  const missingCapability = structuredClone(capsule) as unknown as contract.ResumeCapsuleV2;
  delete (missingCapability.destination as unknown as { capabilityHash?: string }).capabilityHash;
  (missingCapability as unknown as { contentHash: string }).contentHash = computeResumeCapsuleContentHash(missingCapability);
  const profilelessSources = new Map(sourceClients);
  profilelessSources.set(id, {
    clientId: "codex-cli",
    clientVersion: "1",
    sessionId: id,
    capabilityIds: [],
    privateEligible: false,
  });
  const missingCapabilityParents = new Map<string, ResolvedCapsuleParent>([
    [missingCapability.checkpointRevision, parentFor(missingCapability, resolvedState)],
  ]);
  assert.ok(validateContractValue("ResumeCapsuleV2", missingCapability, root, contract.CONTINUITY_LIMITS).length > 0);
  assert.ok(
    capsuleIssues(
      missingCapability,
      profilelessSources,
      sharingDecisions,
      authorityEvents,
      missingCapabilityParents,
    ).length > 0,
  );
  const unsupportedCapabilitySources = new Map(sourceClients);
  unsupportedCapabilitySources.set(id, {
    ...sourceClients.get(id)!,
    capabilityIds: [],
  });
  assert.ok(capsuleIssues(capsule, unsupportedCapabilitySources).length > 0);
  const sameAgentLocalOnly = structuredClone(capsule) as unknown as contract.ResumeCapsuleV2;
  delete (sameAgentLocalOnly as unknown as { sharedTaskState?: contract.SharedTaskStateV1 }).sharedTaskState;
  (sameAgentLocalOnly as unknown as { resumeProfile: contract.ResumeProfileV1 }).resumeProfile = "same_agent";
  (sameAgentLocalOnly as unknown as { contentHash: string }).contentHash = computeResumeCapsuleContentHash(sameAgentLocalOnly);
  const localOnlyParents = new Map<string, ResolvedCapsuleParent>([
    [sameAgentLocalOnly.checkpointRevision, parentFor(sameAgentLocalOnly, resolvedState)],
  ]);
  assert.deepEqual(validateContractValue("ResumeCapsuleV2", sameAgentLocalOnly, root, contract.CONTINUITY_LIMITS), []);
  assert.deepEqual(capsuleIssues(sameAgentLocalOnly, sourceClients, sharingDecisions, authorityEvents, localOnlyParents), []);
  const profilelessLocalOnly = structuredClone(sameAgentLocalOnly) as unknown as contract.ResumeCapsuleV2;
  delete (profilelessLocalOnly.destination as unknown as { capabilityHash?: string }).capabilityHash;
  (profilelessLocalOnly as unknown as { contentHash: string }).contentHash =
    computeResumeCapsuleContentHash(profilelessLocalOnly);
  const profilelessLocalParents = new Map<string, ResolvedCapsuleParent>([
    [profilelessLocalOnly.checkpointRevision, parentFor(profilelessLocalOnly, resolvedState)],
  ]);
  assert.deepEqual(
    capsuleIssues(
      profilelessLocalOnly,
      profilelessSources,
      sharingDecisions,
      authorityEvents,
      profilelessLocalParents,
    ),
    [],
  );
  for (const denied of [
    { label: "private_not_eligible", sensitivity: "private", egressPolicy: "eligible" },
    { label: "secret", sensitivity: "secret", egressPolicy: "eligible" },
    { label: "local_only", sensitivity: "normal", egressPolicy: "local_only" },
    { label: "prohibited_egress", sensitivity: "normal", egressPolicy: "prohibited_egress" },
  ] as const) {
    const deniedCapsule = structuredClone(sameAgentLocalOnly) as unknown as contract.ResumeCapsuleV2;
    assert.ok(deniedCapsule.destinationAgentLocalState);
    (deniedCapsule.destinationAgentLocalState as unknown as { sensitivity: contract.Sensitivity }).sensitivity =
      denied.sensitivity;
    (deniedCapsule.destinationAgentLocalState as unknown as { egressPolicy: contract.EgressPolicyV1 }).egressPolicy =
      denied.egressPolicy;
    const deniedStateInput = structuredClone(resolvedState) as unknown as Record<string, unknown>;
    deniedStateInput.agentLocalStates = [deniedCapsule.destinationAgentLocalState];
    deniedStateInput.sensitivity = denied.sensitivity;
    const deniedState = rehashCanonicalState(deniedStateInput, manifest.canonicalStateHashProfile);
    (deniedCapsule as unknown as { workStateRevision: string }).workStateRevision = deniedState.revision.stateRevision;
    (deniedCapsule as unknown as { contentHash: string }).contentHash = computeResumeCapsuleContentHash(deniedCapsule);
    const deniedParents = new Map<string, ResolvedCapsuleParent>([
      [deniedCapsule.checkpointRevision, parentFor(deniedCapsule, deniedState)],
    ]);
    assert.ok(
      capsuleIssues(deniedCapsule, sourceClients, sharingDecisions, authorityEvents, deniedParents).length > 0,
      denied.label,
    );
  }
  const loweredSharedSensitivity = structuredClone(capsule) as unknown as contract.ResumeCapsuleV2;
  assert.ok(loweredSharedSensitivity.sharedTaskState);
  (loweredSharedSensitivity.sharedTaskState as unknown as { goal: contract.ObservedV2<string> }).goal = {
    value: "secret nested value",
    sourceEventIds: ["e".repeat(64)],
    observedAt: "2026-08-24T00:00:00Z",
    evidenceKind: "synthesized",
    confidence: 1,
    freshness: "current",
    truncated: false,
    sensitivity: "secret",
  };
  const loweredSharedStateInput = structuredClone(resolvedState) as unknown as Record<string, unknown>;
  loweredSharedStateInput.sharedTaskState = loweredSharedSensitivity.sharedTaskState;
  const loweredSharedState = rehashCanonicalState(loweredSharedStateInput, manifest.canonicalStateHashProfile);
  (loweredSharedSensitivity as unknown as { workStateRevision: string }).workStateRevision =
    loweredSharedState.revision.stateRevision;
  (loweredSharedSensitivity as unknown as { contentHash: string }).contentHash =
    computeResumeCapsuleContentHash(loweredSharedSensitivity);
  const loweredSharedParents = new Map<string, ResolvedCapsuleParent>([
    [
      loweredSharedSensitivity.checkpointRevision,
      parentFor(loweredSharedSensitivity, loweredSharedState),
    ],
  ]);
  assert.ok(
    capsuleIssues(
      loweredSharedSensitivity,
      sourceClients,
      sharingDecisions,
      authorityEvents,
      loweredSharedParents,
    ).length > 0,
  );

  const loweredLocalSensitivity = structuredClone(profilelessLocalOnly) as unknown as contract.ResumeCapsuleV2;
  assert.ok(loweredLocalSensitivity.destinationAgentLocalState);
  (loweredLocalSensitivity.destinationAgentLocalState as unknown as {
    hostMetadata: NonNullable<contract.AgentLocalStateV1["hostMetadata"]>;
  }).hostMetadata = {
    value: { private: true },
    sourceEventIds: [id] as [string],
    observedAt: "2026-08-24T00:00:00Z",
    evidenceKind: "synthesized",
    confidence: 1,
    freshness: "current",
    truncated: false,
    sensitivity: "private",
  };
  const loweredLocalStateInput = structuredClone(resolvedState) as unknown as Record<string, unknown>;
  loweredLocalStateInput.agentLocalStates = [loweredLocalSensitivity.destinationAgentLocalState];
  const loweredLocalState = rehashCanonicalState(loweredLocalStateInput, manifest.canonicalStateHashProfile);
  (loweredLocalSensitivity as unknown as { workStateRevision: string }).workStateRevision =
    loweredLocalState.revision.stateRevision;
  (loweredLocalSensitivity as unknown as { contentHash: string }).contentHash =
    computeResumeCapsuleContentHash(loweredLocalSensitivity);
  const loweredLocalParents = new Map<string, ResolvedCapsuleParent>([
    [loweredLocalSensitivity.checkpointRevision, parentFor(loweredLocalSensitivity, loweredLocalState)],
  ]);
  assert.ok(
    capsuleIssues(
      loweredLocalSensitivity,
      profilelessSources,
      sharingDecisions,
      authorityEvents,
      loweredLocalParents,
    ).length > 0,
  );
  const crossAgentLocalOnly = structuredClone(sameAgentLocalOnly) as unknown as contract.ResumeCapsuleV2;
  (crossAgentLocalOnly as unknown as { resumeProfile: contract.ResumeProfileV1 }).resumeProfile = "cross_agent";
  (crossAgentLocalOnly as unknown as { contentHash: string }).contentHash =
    computeResumeCapsuleContentHash(crossAgentLocalOnly);
  const crossAgentLocalOnlyParents = new Map<string, ResolvedCapsuleParent>([
    [crossAgentLocalOnly.checkpointRevision, parentFor(crossAgentLocalOnly, resolvedState)],
  ]);
  assert.ok(
    capsuleIssues(
      crossAgentLocalOnly,
      sourceClients,
      sharingDecisions,
      authorityEvents,
      crossAgentLocalOnlyParents,
    ).length > 0,
  );
  const projectionlessCapsule = structuredClone(sameAgentLocalOnly) as unknown as contract.ResumeCapsuleV2;
  delete (projectionlessCapsule as unknown as { destinationAgentLocalState?: contract.AgentLocalStateV1 })
    .destinationAgentLocalState;
  (projectionlessCapsule as unknown as { contentHash: string }).contentHash =
    computeResumeCapsuleContentHash(projectionlessCapsule);
  assert.ok(validateContractValue("ResumeCapsuleV2", projectionlessCapsule, root, contract.CONTINUITY_LIMITS).length > 0);
  const leakedLane = structuredClone(capsule) as unknown as contract.ResumeCapsuleV2;
  (leakedLane.destinationAgentLocalState as unknown as { clientId: contract.CanonicalClientIdV1 }).clientId = "claude-code";
  assert.deepEqual(validateContractValue("ResumeCapsuleV2", leakedLane, root, contract.CONTINUITY_LIMITS), []);
  assert.ok(capsuleIssues(leakedLane).length > 0);

  const relabelledLaneSources = new Map<string, ResolvedFixtureSourceIdentity>([
    [id, { clientId: "claude-code", clientVersion: "1", sessionId: id, capabilityIds: ["shared-task-v1"], privateEligible: false }],
  ]);
  assert.ok(capsuleIssues(capsule, relabelledLaneSources).length > 0);
  const oldSessionSources = new Map<string, ResolvedFixtureSourceIdentity>([
    [id, { clientId: "codex-cli", clientVersion: "1", sessionId: "b".repeat(64), capabilityIds: ["shared-task-v1"], privateEligible: false }],
  ]);
  assert.ok(capsuleIssues(capsule, oldSessionSources).length > 0);
  const withoutLocalLane = structuredClone(capsule) as unknown as contract.ResumeCapsuleV2;
  delete (withoutLocalLane as unknown as { destinationAgentLocalState?: contract.AgentLocalStateV1 })
    .destinationAgentLocalState;
  assert.deepEqual(validateContractValue("ResumeCapsuleV2", withoutLocalLane, root, contract.CONTINUITY_LIMITS), []);
  assert.ok(capsuleIssues(withoutLocalLane, new Map()).length > 0);
  const wrongVersionSources = new Map<string, ResolvedFixtureSourceIdentity>([
    [id, { clientId: "codex-cli", clientVersion: "2", sessionId: id, capabilityIds: ["shared-task-v1"], privateEligible: false }],
  ]);
  assert.ok(capsuleIssues(withoutLocalLane, wrongVersionSources).length > 0);

  const privateEligible = structuredClone(capsule) as unknown as contract.ResumeCapsuleV2;
  assert.ok(privateEligible.sharedTaskState);
  (privateEligible.sharedTaskState as unknown as { goal: contract.ObservedV2<string> }).goal = {
    value: "private task context",
    sourceEventIds: ["e".repeat(64)],
    observedAt: "2026-08-24T00:00:00Z",
    evidenceKind: "synthesized",
    confidence: 1,
    freshness: "current",
    truncated: false,
    sensitivity: "private",
  };
  (privateEligible.sharedTaskState as unknown as { sensitivity: contract.Sensitivity }).sensitivity = "private";
  const privateStateInput = structuredClone(resolvedState) as unknown as Record<string, unknown>;
  privateStateInput.sharedTaskState = privateEligible.sharedTaskState;
  privateStateInput.sensitivity = "private";
  const privateState = rehashCanonicalState(privateStateInput, manifest.canonicalStateHashProfile);
  assert.deepEqual(validateContractValue("CanonicalWorkStateV2", privateState, root, contract.CONTINUITY_LIMITS), []);
  assert.deepEqual(
    sensitivityAggregationIssues({
      sharedDeclared: "private",
      sharedContained: ["private"],
      lanes: [{ declared: "normal", contained: [] }],
      canonicalDeclared: privateState.sensitivity,
      checkpointDeclared: "private",
    }),
    [],
  );
  (privateEligible as unknown as { workStateRevision: string }).workStateRevision = privateState.revision.stateRevision;
  (privateEligible as unknown as { contentHash: string }).contentHash = computeResumeCapsuleContentHash(privateEligible);
  assert.deepEqual(validateContractValue("ResumeCapsuleV2", privateEligible, root, contract.CONTINUITY_LIMITS), []);
  const privateParents = new Map<string, ResolvedCapsuleParent>([
    [privateEligible.checkpointRevision, parentFor(privateEligible, privateState)],
  ]);
  const privateEligibleSources = new Map(sourceClients);
  privateEligibleSources.set(id, {
    clientId: "codex-cli",
    clientVersion: "1",
    sessionId: id,
    capabilityHash: "c".repeat(64),
    capabilityIds: ["shared-task-v1"],
    privateEligible: true,
  });
  const sameAgentMemoryCapsule = structuredClone(capsuleWithMemory) as unknown as contract.ResumeCapsuleV2;
  (sameAgentMemoryCapsule as unknown as { resumeProfile: contract.ResumeProfileV1 }).resumeProfile = "same_agent";
  (sameAgentMemoryCapsule as unknown as { contentHash: string }).contentHash =
    computeResumeCapsuleContentHash(sameAgentMemoryCapsule);
  const normalAgentMemory = {
    ...selectedMemory,
    sharingScope: "agent_private" as const,
    sharingDecisionEventIds: [],
    sourceEventIds: [id] as [string],
  };
  const sameAgentMemoryParents = new Map([
    [sameAgentMemoryCapsule.checkpointRevision, parentFor(sameAgentMemoryCapsule, resolvedState)],
  ]);
  assert.deepEqual(
    selectedMemoryIssues({
      value: sameAgentMemoryCapsule,
      parents: sameAgentMemoryParents,
      memories: new Map([[selectedMemory.memoryId, { entity: normalAgentMemory, hashValid: true }]]),
    }),
    [],
  );
  const emptyOwnerMemory = { ...normalAgentMemory, sourceEventIds: [] } as unknown as contract.CanonicalMemoryEntityV1;
  assert.ok(
    selectedMemoryIssues({
      value: sameAgentMemoryCapsule,
      parents: sameAgentMemoryParents,
      memories: new Map([[selectedMemory.memoryId, { entity: emptyOwnerMemory, hashValid: true }]]),
    }).length > 0,
  );
  const wrongOwnerMemory = { ...normalAgentMemory, sourceEventIds: ["e".repeat(64)] as [string] };
  assert.ok(
    selectedMemoryIssues({
      value: sameAgentMemoryCapsule,
      parents: sameAgentMemoryParents,
      memories: new Map([[selectedMemory.memoryId, { entity: wrongOwnerMemory, hashValid: true }]]),
    }).length > 0,
  );
  const privateAgentMemory = {
    ...selectedMemory,
    sharingScope: "agent_private" as const,
    sensitivity: "private" as const,
    sharingDecisionEventIds: [],
    sourceEventIds: [id] as [string],
  };
  assert.ok(
    selectedMemoryIssues({
      value: sameAgentMemoryCapsule,
      sources: privateEligibleSources,
      parents: new Map([
        [sameAgentMemoryCapsule.checkpointRevision, parentFor(sameAgentMemoryCapsule, resolvedState)],
      ]),
      memories: new Map([[selectedMemory.memoryId, { entity: privateAgentMemory, hashValid: true }]]),
    }).length > 0,
  );
  const privateSelectedMemory = { ...selectedMemory, sensitivity: "private" as const };
  const privateSelectedMemories = new Map<string, ResolvedSelectedMemory>([
    [selectedMemory.memoryId, { entity: privateSelectedMemory, hashValid: true }],
  ]);
  assert.ok(
    selectedMemoryIssues({ sources: privateEligibleSources, memories: privateSelectedMemories }).length > 0,
  );
  const privateMemoryDecision = { ...selectedMemoryDecision, privateConsent: true };
  const privateMemoryDecisions = new Map(decisionsWithMemory).set(
    selectedMemoryDecisionEventId,
    privateMemoryDecision,
  );
  const privateMemoryAuthorities = new Map(authoritiesWithMemory).set(selectedMemoryAuthorityEventId, {
    ...authoritiesWithMemory.get(selectedMemoryAuthorityEventId)!,
    privateConsent: true,
  });
  assert.deepEqual(
    selectedMemoryIssues({
      sources: privateEligibleSources,
      decisions: privateMemoryDecisions,
      authorities: privateMemoryAuthorities,
      memories: privateSelectedMemories,
    }),
    [],
  );
  assert.ok(
    selectedMemoryIssues({
      decisions: privateMemoryDecisions,
      authorities: privateMemoryAuthorities,
      memories: privateSelectedMemories,
    }).length > 0,
  );
  assert.ok(
    capsuleIssues(privateEligible, privateEligibleSources, sharingDecisions, authorityEvents, privateParents).length > 0,
  );
  const privateSharingDecision = { ...sharingDecision, privateConsent: true };
  const privateSharingDecisions = new Map([[decisionEventId, privateSharingDecision]]);
  const privateAuthorityEvents = new Map<string, ResolvedSharingAuthorityEvent>([
    [authorityEventId, { ...authorityEvents.get(authorityEventId)!, privateConsent: true }],
  ]);
  assert.deepEqual(
    capsuleIssues(
      privateEligible,
      privateEligibleSources,
      privateSharingDecisions,
      privateAuthorityEvents,
      privateParents,
    ),
    [],
  );
  assert.ok(
    capsuleIssues(privateEligible, sourceClients, privateSharingDecisions, privateAuthorityEvents, privateParents).length > 0,
  );
  const missingConsent = structuredClone(privateEligible) as unknown as contract.ResumeCapsuleV2;
  assert.ok(missingConsent.sharedTaskState);
  (missingConsent.sharedTaskState.sharingDecisionEventIds as unknown as string[]).pop();
  assert.ok(validateContractValue("ResumeCapsuleV2", missingConsent, root, contract.CONTINUITY_LIMITS).length > 0);
  const duplicateConsent = structuredClone(capsule) as unknown as contract.ResumeCapsuleV2;
  assert.ok(duplicateConsent.sharedTaskState);
  (duplicateConsent.sharedTaskState.sharingDecisionEventIds as unknown as string[]).push(
    duplicateConsent.sharedTaskState.sharingDecisionEventIds[0]!,
  );
  assert.deepEqual(validateContractValue("ResumeCapsuleV2", duplicateConsent, root, contract.CONTINUITY_LIMITS), []);
  assert.ok(capsuleIssues(duplicateConsent).length > 0);
  assert.ok(capsuleIssues(capsule, sourceClients, new Map()).length > 0);
  assert.ok(capsuleIssues(capsule, sourceClients, sharingDecisions, new Map()).length > 0);
  const authorizedIncompatible = structuredClone(capsule) as unknown as contract.ResumeCapsuleV2;
  (authorizedIncompatible as unknown as { reconciliation: contract.ReconciliationStatus }).reconciliation = "incompatible";
  const forgedExact = structuredClone(authorizedIncompatible) as unknown as contract.ResumeCapsuleV2;
  (forgedExact as unknown as { reconciliation: contract.ReconciliationStatus }).reconciliation = "exact";
  (forgedExact as unknown as { contentHash: string }).contentHash = computeResumeCapsuleContentHash(forgedExact);
  const incompatibleParents = new Map<string, ResolvedCapsuleParent>([
    [forgedExact.checkpointRevision, parentFor(authorizedIncompatible, resolvedState)],
  ]);
  assert.ok(capsuleIssues(forgedExact, sourceClients, sharingDecisions, authorityEvents, incompatibleParents).length > 0);
  for (const mutateLineage of [
    (summary: contract.LineageSourceSummaryV1) =>
      ((summary as unknown as { lineageOriginSourceEventId: string }).lineageOriginSourceEventId = "f".repeat(64)),
    (summary: contract.LineageSourceSummaryV1) =>
      ((summary as unknown as { lastContributingSourceEventId: string }).lastContributingSourceEventId = "e".repeat(64)),
    (summary: contract.LineageSourceSummaryV1) =>
      (summary.participantSourceEventIds as string[]).pop(),
    (summary: contract.LineageSourceSummaryV1) =>
      (summary.participantSourceEventIds as string[]).reverse(),
  ]) {
    const forgedLineageCapsule = structuredClone(capsule) as unknown as contract.ResumeCapsuleV2;
    mutateLineage(forgedLineageCapsule.lineageSourceSummary);
    const forgedLineageStateInput = structuredClone(resolvedState) as unknown as Record<string, unknown>;
    forgedLineageStateInput.lineageSourceSummary = forgedLineageCapsule.lineageSourceSummary;
    const forgedLineageState = rehashCanonicalState(forgedLineageStateInput, manifest.canonicalStateHashProfile);
    (forgedLineageCapsule as unknown as { workStateRevision: string }).workStateRevision =
      forgedLineageState.revision.stateRevision;
    (forgedLineageCapsule as unknown as { contentHash: string }).contentHash =
      computeResumeCapsuleContentHash(forgedLineageCapsule);
    const forgedLineageParents = new Map<string, ResolvedCapsuleParent>([
      [forgedLineageCapsule.checkpointRevision, parentFor(forgedLineageCapsule, forgedLineageState)],
    ]);
    assert.ok(
      capsuleIssues(
        forgedLineageCapsule,
        sourceClients,
        sharingDecisions,
        authorityEvents,
        forgedLineageParents,
      ).length > 0,
    );
  }
  const rehashedProjectionMutation = structuredClone(capsule) as unknown as contract.ResumeCapsuleV2;
  assert.ok(rehashedProjectionMutation.sharedTaskState);
  (rehashedProjectionMutation.sharedTaskState as unknown as { goal: contract.ObservedV2<string> }).goal = {
    value: "attacker-rehashed projection",
    sourceEventIds: ["e".repeat(64)],
    observedAt: "2026-08-24T00:00:00Z",
    evidenceKind: "synthesized",
    confidence: 1,
    freshness: "current",
    truncated: false,
    sensitivity: "normal",
  };
  (rehashedProjectionMutation as unknown as { contentHash: string }).contentHash =
    computeResumeCapsuleContentHash(rehashedProjectionMutation);
  assert.ok(capsuleIssues(rehashedProjectionMutation).length > 0);
  const forgedSharedEvidence = structuredClone(capsule) as unknown as contract.ResumeCapsuleV2;
  assert.ok(forgedSharedEvidence.sharedTaskState);
  (forgedSharedEvidence.sharedTaskState as unknown as { goal: contract.ObservedV2<string> }).goal = {
    value: "forged provenance",
    sourceEventIds: ["b".repeat(64)],
    observedAt: "2026-08-24T00:00:00Z",
    evidenceKind: "synthesized",
    confidence: 1,
    freshness: "current",
    truncated: false,
    sensitivity: "normal",
  };
  (forgedSharedEvidence as unknown as { contentHash: string }).contentHash =
    computeResumeCapsuleContentHash(forgedSharedEvidence);
  assert.deepEqual(validateContractValue("ResumeCapsuleV2", forgedSharedEvidence, root, contract.CONTINUITY_LIMITS), []);
  assert.ok(capsuleIssues(forgedSharedEvidence).length > 0);

  const forgedLocalEvidence = structuredClone(capsule) as unknown as contract.ResumeCapsuleV2;
  assert.ok(forgedLocalEvidence.destinationAgentLocalState);
  (forgedLocalEvidence.destinationAgentLocalState as unknown as { hostMetadata: contract.ObservedV2<contract.JsonValue> })
    .hostMetadata = {
    value: { host: "forged" },
    sourceEventIds: ["b".repeat(64)],
    observedAt: "2026-08-24T00:00:00Z",
    evidenceKind: "synthesized",
    confidence: 1,
    freshness: "current",
    truncated: false,
    sensitivity: "normal",
  };
  (forgedLocalEvidence as unknown as { contentHash: string }).contentHash =
    computeResumeCapsuleContentHash(forgedLocalEvidence);
  assert.deepEqual(validateContractValue("ResumeCapsuleV2", forgedLocalEvidence, root, contract.CONTINUITY_LIMITS), []);
  assert.ok(capsuleIssues(forgedLocalEvidence).length > 0);
  const wrongDecisionId = { ...sharingDecision, decisionEventId: "c".repeat(64) };
  assert.ok(
    capsuleIssues(capsule, sourceClients, new Map([[decisionEventId, wrongDecisionId]])).length > 0,
  );
  const mismatchedAuthorityPayload = { ...sharingDecision, decidedAt: "2026-08-24T00:00:01Z" };
  assert.ok(
    capsuleIssues(capsule, sourceClients, new Map([[decisionEventId, mismatchedAuthorityPayload]])).length > 0,
  );
  const tamperedCapsule = structuredClone(capsule) as unknown as contract.ResumeCapsuleV2;
  (tamperedCapsule.warnings as string[]).push("tampered");
  assert.deepEqual(validateContractValue("ResumeCapsuleV2", tamperedCapsule, root, contract.CONTINUITY_LIMITS), []);
  assert.ok(
    capsuleIssues(tamperedCapsule).length > 0,
  );
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
    [eventA, { clientId: "codex-cli", clientVersion: "1", sessionId: sessionA, capabilityIds: [], privateEligible: false }],
    [eventB, { clientId: "codex-cli", clientVersion: "1", sessionId: sessionB, capabilityIds: [], privateEligible: false }],
  ]);
  assert.deepEqual(agentLocalLaneSemanticIssues(lanes, sources), []);
  const duplicate = [lanes[0]!, lane(eventB, sessionA)];
  assert.ok(agentLocalLaneSemanticIssues(duplicate, sources).length > 0);
  const relabelled = new Map(sources);
  relabelled.set(eventB, {
    clientId: "claude-code",
    clientVersion: "1",
    sessionId: sessionB,
    capabilityIds: [],
    privateEligible: false,
  });
  assert.ok(agentLocalLaneSemanticIssues(lanes, relabelled).length > 0);
});

function maxSensitivity(values: readonly contract.Sensitivity[]): contract.Sensitivity {
  return values.reduce(
    (highest, value) =>
      contract.SENSITIVITIES.indexOf(value) > contract.SENSITIVITIES.indexOf(highest) ? value : highest,
    "normal",
  );
}

function sensitivityAggregationIssues(value: {
  readonly sharedDeclared?: contract.Sensitivity;
  readonly sharedContained?: readonly contract.Sensitivity[];
  readonly lanes: readonly {
    declared: contract.Sensitivity;
    contained: readonly contract.Sensitivity[];
  }[];
  readonly canonicalDeclared: contract.Sensitivity;
  readonly checkpointDeclared: contract.Sensitivity;
}): string[] {
  const issues: string[] = [];
  if (
    value.sharedDeclared !== undefined &&
    value.sharedDeclared !== maxSensitivity(value.sharedContained ?? [])
  ) {
    issues.push("shared sensitivity is not maximal");
  } else if (value.sharedDeclared === undefined && (value.sharedContained?.length ?? 0) > 0) {
    issues.push("shared contained sensitivity exists without a shared projection");
  }
  for (const lane of value.lanes) {
    if (lane.declared !== maxSensitivity(lane.contained)) issues.push("Agent-local sensitivity is not maximal");
  }
  const projectionSensitivities = [
    ...(value.sharedDeclared === undefined ? [] : [value.sharedDeclared]),
    ...value.lanes.map(({ declared }) => declared),
  ];
  if (projectionSensitivities.length === 0 || value.canonicalDeclared !== maxSensitivity(projectionSensitivities)) {
    issues.push("canonical sensitivity is not maximal");
  }
  if (value.checkpointDeclared !== value.canonicalDeclared) {
    issues.push("checkpoint sensitivity differs from embedded canonical state");
  }
  return issues;
}

test("sensitivity is the maximum of contained and projected values", () => {
  const valid = {
    sharedDeclared: "private",
    sharedContained: ["normal", "private"],
    lanes: [{ declared: "secret", contained: ["private", "secret"] }],
    canonicalDeclared: "secret",
    checkpointDeclared: "secret",
  } as const;
  assert.deepEqual(sensitivityAggregationIssues(valid), []);
  assert.ok(sensitivityAggregationIssues({ ...valid, sharedDeclared: "normal" }).length > 0);
  assert.ok(
    sensitivityAggregationIssues({
      ...valid,
      lanes: [{ declared: "normal", contained: ["secret"] }],
    }).length > 0,
  );
  assert.ok(sensitivityAggregationIssues({ ...valid, canonicalDeclared: "private" }).length > 0);
  assert.ok(sensitivityAggregationIssues({ ...valid, checkpointDeclared: "normal" }).length > 0);
  const localOnly = {
    sharedDeclared: undefined,
    sharedContained: [],
    lanes: [{ declared: "secret", contained: ["secret"] }],
    canonicalDeclared: "secret",
    checkpointDeclared: "secret",
  } as unknown as Parameters<typeof sensitivityAggregationIssues>[0];
  assert.deepEqual(sensitivityAggregationIssues(localOnly), []);
  assert.ok(sensitivityAggregationIssues({ ...localOnly, canonicalDeclared: "normal" }).length > 0);
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
  const authorityEventId = "b".repeat(64);
  const decision: contract.SharingDecisionV1 = {
    schemaVersion: 1,
    decisionEventId: id,
    authoritySourceEventId: authorityEventId,
    authorityKind: "user",
    decision: "grant",
    subjectScope: value.subjectScope as contract.SubjectScopeV1,
    sharingScope: "personal_shared",
    target: { kind: "canonical_memory_entity", canonicalFactId: id },
    privateConsent: true,
    decidedAt: "2026-08-24T00:00:00Z",
  };
  const typedValue = value as unknown as contract.CanonicalMemoryEntityV1;
  const emptySourceMemory = { ...typedValue, sourceEventIds: [] };
  assert.ok(validateContractValue("CanonicalMemoryEntityV1", emptySourceMemory, root, contract.CONTINUITY_LIMITS).length > 0);
  const sourceIdentities = new Map<string, ResolvedFixtureSourceIdentity>([
    [id, { clientId: "codex-cli", clientVersion: "1", sessionId: "1".repeat(64), capabilityIds: [], privateEligible: false }],
  ]);
  const evidenceSnapshots = new Map<string, ResolvedMemoryEvidenceSnapshot>();
  const memoryDecisions = new Map([[id, decision]]);
  const memoryAuthorities = new Map<string, ResolvedSharingAuthorityEvent>([
    [
      authorityEventId,
      {
        authorityKind: "user",
        decision: "grant",
        subjectScope: structuredClone(value.subjectScope as contract.SubjectScopeV1),
        sharingScope: "personal_shared",
        target: { kind: "canonical_memory_entity", canonicalFactId: id },
        privateConsent: true,
        decidedAt: "2026-08-24T00:00:00Z",
      },
    ],
  ]);
  const memoryIssues = (
    candidate: contract.CanonicalMemoryEntityV1 = typedValue,
    decisions: ReadonlyMap<string, contract.SharingDecisionV1> = memoryDecisions,
    authorities: ReadonlyMap<string, ResolvedSharingAuthorityEvent> = memoryAuthorities,
    sources: ReadonlyMap<string, ResolvedFixtureSourceIdentity> = sourceIdentities,
    snapshots: ReadonlyMap<string, ResolvedMemoryEvidenceSnapshot> = evidenceSnapshots,
  ) => canonicalMemorySharingIssues(candidate, decisions, authorities, sources, snapshots);
  assert.deepEqual(memoryIssues(), []);
  const normalOnlyDecision = { ...decision, privateConsent: false };
  const normalOnlyAuthority = new Map<string, ResolvedSharingAuthorityEvent>([
    [authorityEventId, { ...memoryAuthorities.get(authorityEventId)!, privateConsent: false }],
  ]);
  assert.ok(
    memoryIssues(typedValue, new Map([[id, normalOnlyDecision]]), normalOnlyAuthority).length > 0,
  );
  const unknownSource = structuredClone(typedValue) as unknown as contract.CanonicalMemoryEntityV1;
  (unknownSource.sourceEventIds as unknown as string[])[0] = "c".repeat(64);
  assert.ok(memoryIssues(unknownSource).length > 0);
  const unknownSnapshot = structuredClone(typedValue) as unknown as contract.CanonicalMemoryEntityV1;
  const snapshotId = "d".repeat(64);
  (unknownSnapshot.evidenceSnapshotIds as string[]).push(snapshotId);
  assert.ok(memoryIssues(unknownSnapshot).length > 0);
  const validSnapshot = new Map<string, ResolvedMemoryEvidenceSnapshot>([
    [snapshotId, { memoryId: typedValue.memoryId, hashValid: true }],
  ]);
  assert.deepEqual(memoryIssues(unknownSnapshot, memoryDecisions, memoryAuthorities, sourceIdentities, validSnapshot), []);
  assert.ok(
    memoryIssues(
      unknownSnapshot,
      memoryDecisions,
      memoryAuthorities,
      sourceIdentities,
      new Map([[snapshotId, { memoryId: "e".repeat(64), hashValid: true }]]),
    ).length > 0,
  );
  assert.ok(
    memoryIssues(
      unknownSnapshot,
      memoryDecisions,
      memoryAuthorities,
      sourceIdentities,
      new Map([[snapshotId, { memoryId: typedValue.memoryId, hashValid: false }]]),
    ).length > 0,
  );
  assert.ok(memoryIssues(typedValue, new Map()).length > 0);
  assert.ok(memoryIssues(typedValue, memoryDecisions, new Map()).length > 0);
  const wrongDecisionId = { ...decision, decisionEventId: "c".repeat(64) };
  assert.ok(memoryIssues(typedValue, new Map([[id, wrongDecisionId]])).length > 0);
  const mismatchedAuthorityPayload = { ...decision, decidedAt: "2026-08-24T00:00:01Z" };
  assert.ok(memoryIssues(typedValue, new Map([[id, mismatchedAuthorityPayload]])).length > 0);
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
  "persisted-canonical-work-state-v2": "a8da35c42abcf916c9bf2739f520686df3ff0af86a0361f2ff5fd10bf78bacf4",
  "persisted-checkpoint-v3": "5e1ee47e0c507279c731eed79399f8f174aa1754859573c77389e3231001a9ef",
  "persisted-resume-capsule-v2": "3a2619c2f13bde4d8992247016bbf6be4a3e9b53b497daaccab5d307d3dba8fe",
  "persisted-canonical-memory-entity-v1": "7a1787f4f9b73d8be7a0e1106b787bbbe0fdba741e8cf3faad8eb0e4295b5296",
  "persisted-sharing-decision-v1": "af7b9a35a9ef8d675572038d7c896d8597fb21f26d3df68a27c11fe6cb0a41f3",
};

const REQUIRED_SOURCE_REFERENCE_PATHS: Readonly<Record<string, readonly string[]>> = {
  "persisted-canonical-work-state-v2": [
    "/sharedTaskState/goal/sourceEventIds/*",
    "/sharedTaskState/constraints/*/sourceEventIds/*",
    "/sharedTaskState/activeFiles/*/sourceEventIds/*",
    "/sharedTaskState/modifiedFiles/*/sourceEventIds/*",
    "/sharedTaskState/recentCommands/*/sourceEventIds/*",
    "/sharedTaskState/recentTests/*/sourceEventIds/*",
    "/sharedTaskState/pendingOperations/*/correlation/startEventId",
    "/sharedTaskState/pendingOperations/*/sourceEventIds/*",
    "/sharedTaskState/droppedEvidence/reasonWindows/*/entries/*/sourceEventIds/*",
    "/sharedTaskState/semanticResumeNote/sourceEventIds/*",
    "/agentLocalStates/*/latestSubstantivePrompt/sourceEventIds/*",
    "/agentLocalStates/*/lastAssistantConclusion/sourceEventIds/*",
    "/agentLocalStates/*/nativeTodoState/sourceEventIds/*",
    "/agentLocalStates/*/nativePlanState/sourceEventIds/*",
    "/agentLocalStates/*/hostMetadata/sourceEventIds/*",
  ],
  "persisted-resume-capsule-v2": [
    "/sharedTaskState/goal/sourceEventIds/*",
    "/sharedTaskState/constraints/*/sourceEventIds/*",
    "/sharedTaskState/activeFiles/*/sourceEventIds/*",
    "/sharedTaskState/modifiedFiles/*/sourceEventIds/*",
    "/sharedTaskState/recentCommands/*/sourceEventIds/*",
    "/sharedTaskState/recentTests/*/sourceEventIds/*",
    "/sharedTaskState/pendingOperations/*/correlation/startEventId",
    "/sharedTaskState/pendingOperations/*/sourceEventIds/*",
    "/sharedTaskState/droppedEvidence/reasonWindows/*/entries/*/sourceEventIds/*",
    "/sharedTaskState/semanticResumeNote/sourceEventIds/*",
    "/destinationAgentLocalState/latestSubstantivePrompt/sourceEventIds/*",
    "/destinationAgentLocalState/lastAssistantConclusion/sourceEventIds/*",
    "/destinationAgentLocalState/nativeTodoState/sourceEventIds/*",
    "/destinationAgentLocalState/nativePlanState/sourceEventIds/*",
    "/destinationAgentLocalState/hostMetadata/sourceEventIds/*",
  ],
  "persisted-canonical-memory-entity-v1": ["/sourceEventIds/*", "/evidenceSnapshotIds/*"],
};

const REQUIRED_RESTORE_CROSS_FIELD_RULES: Readonly<Record<string, readonly string[]>> = {
  "persisted-canonical-work-state-v2": [
    "canonical_state_contains_shared_or_agent_local_projection",
    "lineage_summary_matches_append_only_event_and_revision_evidence",
    "parent_state_revisions_are_sorted_unique_before_hash_and_publication",
    "pending_operation_id_matches_correlation_operation_id",
    "pending_operation_start_event_and_source_identity_match_full_authenticated_start_correlation_and_evidence",
    "shared_field_source_event_refs_are_sorted_unique_and_resolve_to_authenticated_sources",
    "shared_state_decisions_match_authenticated_authority_scope_target_and_private_consent",
    "agent_local_field_source_event_refs_are_sorted_unique_and_resolve_to_lane_client_and_session",
    "dropped_evidence_reason_windows_have_consistent_counters_boundaries_and_aggregates",
  ],
  "persisted-resume-capsule-v2": [
    "capsule_contains_shared_or_destination_local_projection",
    "local_only_capsule_is_same_agent",
    "capsule_envelope_matches_persisted_delivery_claim",
    "capsule_projections_match_resolved_work_state_revision",
    "pending_operation_id_matches_correlation_operation_id",
    "pending_operation_start_event_and_source_identity_match_full_authenticated_start_correlation_and_evidence",
    "capsule_lineage_and_checkpoint_creator_refs_resolve_to_authenticated_sources",
    "shared_field_source_event_refs_are_sorted_unique_and_resolve_to_authenticated_sources",
    "destination_agent_local_field_source_event_refs_are_sorted_unique_and_resolve_to_destination_client_and_session",
    "destination_private_eligibility_resolves_from_authenticated_source_identity",
    "destination_capability_profile_resolves_and_supports_included_projections",
    "private_requires_authenticated_opt_in_and_resolved_private_eligibility",
    "selected_memory_ids_are_sorted_unique_and_resolve_to_hash_valid_policy_eligible_entities",
    "capsule_checkpoint_id_and_revision_resolve_to_same_checkpoint_and_work_state_revision_matches_checkpoint_state",
    "capsule_checkpoint_creator_matches_resolved_checkpoint",
    "shared_state_decisions_match_authenticated_authority_scope_target_and_private_consent",
  ],
  "persisted-canonical-memory-entity-v1": [
    "shared_scope_decisions_match_authenticated_authority_scope_target_and_private_consent",
    "private_sharing_requires_explicit_opt_in",
    "source_event_refs_are_non_empty_sorted_unique_and_resolve_to_authenticated_sources",
    "evidence_snapshot_refs_are_sorted_unique_and_resolve_to_existing_hash_valid_snapshots_bound_to_same_memory",
  ],
  "persisted-sharing-decision-v1": [
    "authority_event_payload_matches_decision_action_scope_target_private_consent_and_decided_at",
  ],
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
    for (const path of REQUIRED_SOURCE_REFERENCE_PATHS[rule.inventoryEntryId] ?? []) {
      if (!rule.scopeIdentityPaths.includes(path)) issues.push(`${rule.inventoryEntryId}: source reference path missing`);
    }
    for (const crossFieldRule of REQUIRED_RESTORE_CROSS_FIELD_RULES[rule.inventoryEntryId] ?? []) {
      if (!rule.crossFieldRules.includes(crossFieldRule)) {
        issues.push(`${rule.inventoryEntryId}: required cross-field rule missing`);
      }
    }
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

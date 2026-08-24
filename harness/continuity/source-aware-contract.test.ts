import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalizeJson, readIJsonFile } from "../schema/jcs.ts";
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

function corpusSemanticIssues(corpus: contract.SourceAwareContractCorpusV1): string[] {
  const issues: string[] = [];
  const caseIds = corpus.cases.map(({ id }) => id);
  if (JSON.stringify(caseIds) !== JSON.stringify(CASE_IDS)) issues.push("case IDs are not exact F0-F7");
  if (new Set(caseIds).size !== caseIds.length) issues.push("case IDs are duplicated");

  for (const item of corpus.cases) {
    const sourceIds = new Set(item.input.sources.map(({ id }) => id));
    const recordIds = new Set(item.input.records.map(({ id }) => id));
    if (!sourceIds.has(item.input.destination.sourceId)) issues.push(`${item.id}: destination source is missing`);
    for (const record of item.input.records) {
      if (!sourceIds.has(record.sourceId)) issues.push(`${item.id}: record source ${record.sourceId} is missing`);
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
  const f7 = byId.get("F7");
  const f7Delivered = new Set([
    ...(f7?.successor.automaticFullRecordIds ?? []),
    ...(f7?.successor.hintOrManualRecordIds ?? []),
  ]);
  for (const denied of ["private-record", "secret-record", "local-only-record"]) {
    if (f7Delivered.has(denied)) issues.push(`F7 delivered denied record ${denied}`);
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
  return issues;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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
    assert.equal(output.toString("utf8").split("\n").length - 1, search.lineCount, search.id);
    assert.equal(sha256(output), search.sha256, search.id);
  }
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

  const missingObservation = structuredClone(manifest) as unknown as contract.SourceAwareContinuityContractV1;
  (missingObservation.continuityP0Observations.entries as contract.ContinuityP0ObservationEntryV1[]).pop();
  assert.ok(contractSemanticIssues(missingObservation).length > 0);

  const rawExport = structuredClone(manifest) as unknown as contract.SourceAwareContinuityContractV1;
  (rawExport.rawIdentifierEvidencePolicy as { rawExport: string }).rawExport = "allowed";
  assert.ok(contractSemanticIssues(rawExport).length > 0);
});

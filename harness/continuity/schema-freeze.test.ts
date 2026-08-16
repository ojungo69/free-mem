import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateAgainstSchema, validateContractValue, type JsonSchemaDocument } from "../schema/validate.ts";
import * as contract from "../schema/continuity.ts";

const root = JSON.parse(
  readFileSync(new URL("../schema/continuity.schema.json", import.meta.url), "utf8"),
) as JsonSchemaDocument;

const defs = (root.$defs ?? {}) as Record<string, Record<string, unknown>>;

/**
 * TS の union 定数 → 対応する `$defs` 名。名前の対応規則が不規則（SENSITIVITIES ↔ Sensitivity、
 * FRESHNESS_VALUES ↔ Freshness）なので明示する。値の集合だけを突き合わせると Freshness と
 * Sensitivity を入れ替えても素通りするため、対応表そのものを契約として持つ。
 */
const NAMED_ENUMS: Record<string, keyof typeof contract> = {
  TaskBindingRole: "TASK_BINDING_ROLES",
  BoundaryEvidenceKind: "BOUNDARY_EVIDENCE_KINDS",
  TaskBoundaryProposalState: "TASK_BOUNDARY_PROPOSAL_STATES",
  TaskBoundaryDecisionSource: "TASK_BOUNDARY_DECISION_SOURCES",
  EvidenceKind: "EVIDENCE_KINDS",
  Freshness: "FRESHNESS_VALUES",
  Sensitivity: "SENSITIVITIES",
  ContinuityCaptureMethod: "CONTINUITY_CAPTURE_METHODS",
  TurnIdSource: "TURN_ID_SOURCES",
  ContinuityOperationPhase: "CONTINUITY_OPERATION_PHASES",
  ReplayPolicy: "REPLAY_POLICIES",
  CheckpointDispositionKind: "CHECKPOINT_DISPOSITION_KINDS",
  DeliveryAttemptState: "DELIVERY_ATTEMPT_STATES",
  EngagementEvidenceKind: "ENGAGEMENT_EVIDENCE_KINDS",
  ReconciliationStatus: "RECONCILIATION_STATUSES",
  ResumeDeliveryStrategy: "RESUME_DELIVERY_STRATEGIES",
  ResumeMode: "RESUME_MODES",
  ResumeDeliveryBoundary: "RESUME_DELIVERY_BOUNDARIES",
  ResumeDecisionAction: "RESUME_DECISION_ACTIONS",
  DerivedArtifactKind: "DERIVED_ARTIFACT_KINDS",
  DerivedArtifactStatus: "DERIVED_ARTIFACT_STATUSES",
  CapabilityTestDisposition: "CAPABILITY_TEST_DISPOSITIONS",
  ContractPreflightState: "CONTRACT_PREFLIGHT_STATES",
};

/**
 * `$defs` 直下ではなく property の中に直接書かれた enum。TS 側は interface の中の
 * inline union なので名前で参照できず、上の対応表には載らない。凍結した値をここに写して
 * 変更を検出する（addendum が inline で書いているものを `$defs` に切り出すと転記が正本から離れる）。
 */
const INLINE_ENUMS: Record<string, readonly string[]> = {
  "TaskBoundaryAuthorityContextV1.properties.userSurfaceAuthority.properties.surface": [
    "cli",
    "viewer",
    "mcp_user_authority",
  ],
  "ContinuityIngestAttestationV1.properties.channel": ["rpc", "spool"],
  "ObservedFile.properties.role": ["active", "modified", "read", "test", "config", "unknown"],
  "ObservedCommand.properties.status": ["succeeded", "failed", "unknown"],
  "ObservedTest.properties.status": ["passed", "failed", "partial", "unknown"],
  "PendingOperation.properties.kind": [
    "command",
    "file_mutation",
    "test",
    "tool",
    "migration",
    "external_side_effect",
    "other",
  ],
  "PendingOperation.properties.status": ["started", "succeeded", "failed", "unknown"],
  "ContinuationCheckpointV2.properties.kind": [
    "pre_compact",
    "session_end",
    "idle",
    "manual",
    "crash_recovery",
  ],
  "CheckpointDispositionEvent.properties.source": ["daemon", "runtime", "user"],
  "CheckpointDispositionProjection.properties.state": [
    "open",
    "accepted",
    "superseded",
    "expired",
    "retracted",
  ],
  "CheckpointMetadataV1.properties.kind": [
    "pre_compact",
    "session_end",
    "idle",
    "manual",
    "crash_recovery",
  ],
  "DispositionAuthorityContextV1.properties.source": ["daemon", "runtime", "user"],
  "CheckpointAnchorV1.properties.kind": ["file", "symbol", "command", "test", "todo", "task_lineage"],
  "ContradictionEvidenceV1.properties.kind": [
    "explicit_rejection",
    "new_task_confirmed",
    "workspace_incompatible",
    "runtime_invalidated",
  ],
  "ResumeSelectionDecisionV1.properties.confidenceBand": ["high", "medium", "low", "none"],
  "DerivedArtifactInvalidationEventV1.properties.reason": [
    "memory_updated",
    "memory_superseded",
    "memory_retracted",
    "memory_invalidated",
    "source_artifact_invalidated",
  ],
  "DerivedArtifactInvalidationEventV1.properties.resultingStatus": ["stale", "invalidated"],
  "RequiredCapabilityScenarioV1.properties.requiredFor.items": [
    "generic_phase3",
    "automatic_strategy",
    "tier_a",
  ],
};

/** `additionalProperties` が schema（false 以外）でよい唯一の定義。任意の JSON を受ける再帰型。 */
const OPEN_OBJECT_ALLOWLIST = new Set(["JsonValue.oneOf[2]"]);

/** `$defs` の各定義を再帰的に歩き、(パス, node) を全部返す。 */
function* walk(node: unknown, path: string): Generator<[string, Record<string, unknown>]> {
  if (Array.isArray(node)) {
    for (const [i, child] of node.entries()) yield* walk(child, `${path}[${i}]`);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  yield [path, obj];
  for (const [key, child] of Object.entries(obj)) yield* walk(child, `${path}.${key}`);
}

function* walkDefs(): Generator<[string, Record<string, unknown>, boolean]> {
  for (const [name, def] of Object.entries(defs)) {
    for (const [path, node] of walk(def, name)) yield [path, node, path === name];
  }
}

test("continuity.schema.json は schema 側の誤記を持たない", () => {
  // validateContractValue は root を 1 度歩いて schema 側の誤記を throw する（値は通らなくてよい）。
  // $ref から辿れない $defs も対象なので、凍結した 66 定義すべてが検査される
  assert.doesNotThrow(() =>
    validateContractValue(Object.keys(defs)[0], undefined, root, contract.CONTINUITY_LIMITS),
  );
});

test("object はすべて closed（ネストした定義も含む）", () => {
  const open: string[] = [];
  for (const [path, node] of walkDefs()) {
    if (node.type !== "object") continue;
    if (node.additionalProperties === false) continue;
    if (OPEN_OBJECT_ALLOWLIST.has(path)) continue;
    open.push(path);
  }
  assert.deepEqual(open, []);
});

test("TS の union 定数と schema の enum が名前ごとに一致する", () => {
  const sorted = (xs: readonly string[]) => [...xs].sort();
  for (const [defName, constName] of Object.entries(NAMED_ENUMS)) {
    const fromSchema = defs[defName]?.enum;
    assert.ok(Array.isArray(fromSchema), `$defs.${defName} に enum が無い`);
    assert.deepEqual(
      sorted(contract[constName] as readonly string[]),
      sorted(fromSchema as string[]),
      `${constName} ↔ $defs.${defName}`,
    );
  }
  // 対応表の側が古くならないよう、schema にある名前付き enum の数とも突き合わせる
  const namedInSchema = Object.entries(defs)
    .filter(([, d]) => Array.isArray(d.enum))
    .map(([name]) => name);
  assert.deepEqual(namedInSchema.sort(), Object.keys(NAMED_ENUMS).sort());
});

test("property の中に直接書かれた enum も凍結する", () => {
  const found: Record<string, readonly string[]> = {};
  for (const [path, node, isTopLevel] of walkDefs()) {
    if (isTopLevel || !Array.isArray(node.enum)) continue;
    found[path] = node.enum as string[];
  }
  assert.deepEqual(found, INLINE_ENUMS);
});

test("turnId は turnIdSource と対で成立する（§3.1）", () => {
  const base = {
    eventId: "e1",
    canonicalFingerprint: "f1",
    kind: "prompt",
    ingestSeq: 1,
    occurredAt: "2026-08-16T00:00:00Z",
    sessionId: "s1",
    sourceAgent: { cli: "claude", version: "1.0.0" },
    provenance: {},
    payload: {},
  };
  const ev = (turnIdSource: string, turnId?: string) => ({
    ...base,
    turnIdSource,
    ...(turnId === undefined ? {} : { turnId }),
  });
  const schema = { $ref: "#/$defs/NormalizedContinuityEvent" };
  const violates = (value: unknown) =>
    validateAgainstSchema(value, schema, root).some((i) => /turnId/.test(`${i.path} ${i.message}`));

  // unavailable のときは turnId を持ってはいけない
  assert.equal(violates(ev("unavailable")), false);
  assert.equal(violates(ev("unavailable", "t1")), true);
  // native / synthesized_monotonic のときは turnId が要る
  for (const src of ["native", "synthesized_monotonic"]) {
    assert.equal(violates(ev(src, "t1")), false, src);
    assert.equal(violates(ev(src)), true, src);
  }
});

test("IsoTimestamp は成分の範囲まで見る", () => {
  const bad = (s: string) => validateAgainstSchema(s, { $ref: "#/$defs/IsoTimestamp" }, root).length > 0;
  assert.equal(bad("2026-08-16T00:00:00Z"), false);
  assert.equal(bad("2026-08-16T23:59:59.999Z"), false);
  for (const s of [
    "2026-99-99T99:99:99Z",
    "2026-00-16T00:00:00Z",
    "2026-13-16T00:00:00Z",
    "2026-08-00T00:00:00Z",
    "2026-08-32T00:00:00Z",
    "2026-08-16T24:00:00Z",
    "2026-08-16T00:60:00Z",
    "2026-08-16T00:00:60Z",
  ]) {
    assert.equal(bad(s), true, s);
  }
  // 暦としての実在は pattern では表せない。ここは通ってしまう（#27）
  assert.equal(bad("2026-02-30T00:00:00Z"), false);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateAgainstSchema } from "../../../harness/schema/validate.ts";
import {
  networkTrustEvidenceFingerprint,
  resourcePlateauEvidenceFingerprint,
  runnerEvidenceFingerprint,
  runnerResultObservationFingerprint,
  validateRunnerEvidence,
} from "./alpha-runner-evidence.mjs";

const contractDir = dirname(fileURLToPath(import.meta.url));
const readFixture = (name) => JSON.parse(readFileSync(join(contractDir, "../fixtures", name), "utf8"));
const fixture = readFixture("slice1-bidirectional-en-v1.json");
const result = readFixture("alpha-result-v1.failure-example.json");
const evidence = readFixture("runner-evidence/alpha-runner-evidence-v1.failure-example.json");
const evidenceSchema = JSON.parse(readFileSync(
  join(contractDir, "alpha-runner-evidence-v1.schema.json"), "utf8",
));

function bind(mutantEvidence, mutantResult, {
  bindNetwork = true, bindPlateau = true,
} = {}) {
  if (bindNetwork) {
    mutantResult.networkTrustEvidenceFingerprint =
      networkTrustEvidenceFingerprint(mutantEvidence.networkTrustEvidence);
  }
  if (bindPlateau) {
    mutantResult.resourcePlateauEvidenceFingerprint =
      resourcePlateauEvidenceFingerprint(mutantEvidence.resourcePlateauEvidence);
  }
  const record = mutantEvidence.scenarios.find(
    (item) => item.caseId === mutantResult.runnerEvidenceCaseId,
  );
  record.resultObservationFingerprint = runnerResultObservationFingerprint(mutantResult);
  mutantResult.runnerEvidenceFingerprint = runnerEvidenceFingerprint(mutantEvidence);
}

function assertEvidenceRejected(mutate, pattern, label, options) {
  const mutantEvidence = structuredClone(evidence);
  const mutantResult = structuredClone(result);
  mutate(mutantEvidence, mutantResult);
  bind(mutantEvidence, mutantResult, options);
  assert.throws(() => validateRunnerEvidence(
    mutantEvidence, mutantResult, fixture, mutantEvidence.invocationId,
  ), pattern, label);
}

function assertEvidenceAccepted(mutate, label) {
  const mutantEvidence = structuredClone(evidence);
  const mutantResult = structuredClone(result);
  mutate(mutantEvidence, mutantResult);
  bind(mutantEvidence, mutantResult);
  assert.doesNotThrow(() => validateRunnerEvidence(
    mutantEvidence, mutantResult, fixture, mutantEvidence.invocationId,
  ), label);
}

assert.deepEqual(validateAgainstSchema(evidence, evidenceSchema, evidenceSchema), [],
  "fixed runner evidence does not match its schema");
for (const name of ["networkTrustEvidence", "resourcePlateauEvidence"]) {
  const missing = structuredClone(evidence);
  delete missing[name];
  assert.notEqual(validateAgainstSchema(missing, evidenceSchema, evidenceSchema).length, 0,
    `runner evidence schema accepted missing ${name}`);
}
const missingPublicCa = structuredClone(evidence);
delete missingPublicCa.networkTrustEvidence.publicCaSha256;
assert.notEqual(validateAgainstSchema(
  missingPublicCa, evidenceSchema, evidenceSchema,
).length, 0, "runner evidence schema accepted missing public CA fingerprint");
const missingTlsReceipts = structuredClone(evidence);
delete missingTlsReceipts.networkTrustEvidence.tlsPreflightReceipts;
assert.notEqual(validateAgainstSchema(
  missingTlsReceipts, evidenceSchema, evidenceSchema,
).length, 0, "runner evidence schema accepted missing TLS preflight receipts");
for (const field of ["trustAnchorSha256", "peerCertificateSha256"]) {
  const missingTlsFingerprint = structuredClone(evidence);
  delete missingTlsFingerprint.networkTrustEvidence.tlsPreflightReceipts[0][field];
  assert.notEqual(validateAgainstSchema(
    missingTlsFingerprint, evidenceSchema, evidenceSchema,
  ).length, 0, `runner evidence schema accepted missing TLS ${field}`);
}

for (const field of ["drainReceiptId", "checkpointReceiptId"]) {
  const missingReceipt = structuredClone(evidence);
  delete missingReceipt.resourcePlateauEvidence.windows[0][field];
  assert.notEqual(validateAgainstSchema(
    missingReceipt, evidenceSchema, evidenceSchema,
  ).length, 0, `runner evidence schema accepted missing ${field}`);
}
const missingWorkloadReceipt = structuredClone(evidence);
delete missingWorkloadReceipt.resourcePlateauEvidence.windows[0].workloadReceiptId;
assert.notEqual(validateAgainstSchema(
  missingWorkloadReceipt, evidenceSchema, evidenceSchema,
).length, 0, "runner evidence schema accepted missing workload receipt");

assertEvidenceRejected((mutant) => {
  const changedCa = `sha256:${"0".repeat(64)}`;
  mutant.networkTrustEvidence.publicCaSha256 = changedCa;
  for (const receipt of mutant.networkTrustEvidence.tlsPreflightReceipts) {
    receipt.trustAnchorSha256 = changedCa;
  }
}, /network trust evidence fingerprint/, "modified public CA fingerprint", {
  bindNetwork: false,
});
for (const [field, value, pattern] of [
  ["chainValidation", false, /chain validation/],
  ["hostnameValidation", false, /hostname validation/],
  ["privateKeyCommitted", true, /private key/],
]) {
  assertEvidenceRejected((mutant) => {
    mutant.networkTrustEvidence[field] = value;
  }, pattern, `invalid network trust ${field}`);
}
assertEvidenceRejected((mutant) => {
  mutant.networkTrustEvidence.baseHostname = "other.invalid";
}, /fixed hostnames/, "network trust hostname drift");
assertEvidenceRejected((_mutant, mutantResult) => {
  mutantResult.networkTrustEvidenceFingerprint = `sha256:${"0".repeat(64)}`;
}, /network trust evidence fingerprint/, "stale network trust evidence fingerprint", {
  bindNetwork: false,
});

const tlsReceiptMutations = [
  [(network) => { network.tlsPreflightReceipts.pop(); }, /exactly four/,
    "missing TLS preflight receipt"],
  [(network) => { network.tlsPreflightReceipts[1].receiptId =
    network.tlsPreflightReceipts[0].receiptId; }, /receipt.*unique/,
    "reused TLS preflight receipt ID"],
  [(network) => { network.tlsPreflightReceipts[0].receiptId = "../preflight"; },
    /path-free opaque/, "path-like TLS preflight receipt ID"],
  [(network) => { network.tlsPreflightReceipts[0].phase = "daemon_start"; },
    /pair set/, "duplicate TLS preflight phase/hostname pair"],
  [(network) => { network.tlsPreflightReceipts[0].hostname = "other.invalid"; },
    /pair set/, "unknown TLS preflight hostname"],
  [(network) => { network.tlsPreflightReceipts[0].sni = "other.invalid"; },
    /SNI/, "TLS preflight SNI mismatch"],
  [(network) => { network.tlsPreflightReceipts[0].port = 80; },
    /port/, "TLS preflight port mismatch"],
  [(network) => { network.tlsPreflightReceipts[0].timeoutMs = 5001; },
    /timeout/, "TLS preflight timeout mismatch"],
  [(network) => { network.tlsPreflightReceipts[0].endMonotonicMs =
    network.tlsPreflightReceipts[0].startMonotonicMs + 5001; }, /duration/,
    "TLS preflight over-time duration"],
  [(network) => { network.tlsPreflightReceipts[0].endMonotonicMs =
    network.tlsPreflightReceipts[0].startMonotonicMs - 1; }, /monotonic/,
    "TLS preflight reversed time"],
  [(network) => { network.tlsPreflightReceipts[0].result = "failed"; },
    /verified/, "unverified TLS preflight result"],
  [(network) => { network.tlsPreflightReceipts[0].chainValidation = false; },
    /chain validation/, "TLS preflight chain validation disabled"],
  [(network) => { network.tlsPreflightReceipts[0].hostnameValidation = false; },
    /hostname validation/, "TLS preflight hostname validation disabled"],
  [(network) => { network.tlsPreflightReceipts[0].credentialBytesSent = 1; },
    /credential bytes/, "TLS preflight credential bytes"],
  [(network) => { network.tlsPreflightReceipts[0].payloadBytesSent = 1; },
    /payload bytes/, "TLS preflight payload bytes"],
  [(network) => { network.tlsPreflightReceipts[0].httpRequestCount = 1; },
    /HTTP request/, "TLS preflight HTTP request"],
  [(network) => { network.tlsPreflightReceipts[0].trustAnchorSha256 =
    `sha256:${"0".repeat(64)}`; }, /trust anchor/, "TLS preflight trust anchor mismatch"],
  [(network) => { network.tlsPreflightReceipts[0].peerCertificateSha256 = "invalid"; },
    /peer certificate/, "TLS preflight malformed peer certificate fingerprint"],
  [(network) => { network.tlsPreflightReceipts[0].peerCertificateSha256 =
    network.publicCaSha256; }, /peer certificate/, "TLS preflight peer equals trust anchor"],
];
for (const [mutate, pattern, label] of tlsReceiptMutations) {
  assertEvidenceRejected((mutant) => mutate(mutant.networkTrustEvidence), pattern, label);
}
assertEvidenceRejected((mutant) => {
  mutant.networkTrustEvidence.tlsPreflightReceipts[0].receiptId =
    "tls-preflight:base:setup-activation:changed";
}, /network trust evidence fingerprint/, "modified TLS preflight receipt fingerprint", {
  bindNetwork: false,
});

const plateauMutations = [
  [(plateau) => { plateau.windows.pop(); }, /exactly 12/, "missing plateau window"],
  [(plateau) => { plateau.windows[0].checkpointCompleted = false; }, /checkpoint/,
    "incomplete plateau checkpoint"],
  [(plateau) => { [plateau.windows[0], plateau.windows[1]] =
    [plateau.windows[1], plateau.windows[0]]; }, /ordered/, "unordered plateau windows"],
  [(plateau) => { plateau.windows[11].rssMiB = plateau.windows[7].rssMiB + 17; },
    /RSS span/, "final plateau RSS span"],
  [(plateau) => { plateau.windows[11].storageBytes =
    plateau.windows[7].storageBytes + 65537; }, /storage span/, "final plateau storage span"],
  [(plateau) => { plateau.windows[8].drainedQueueDepth = 1; }, /queue/,
    "nonzero final plateau queue"],
  [(plateau) => { plateau.windows[9].selectedItemCount += 1; }, /selected item/,
    "nonconstant final plateau items"],
  [(plateau) => { plateau.windows[9].injectedTokenCount += 1; }, /injected token/,
    "nonconstant final plateau tokens"],
  [(plateau) => { plateau.windows[4].maxProcessingConcurrency = 3; }, /concurrency/,
    "over-limit plateau concurrency"],
  [(plateau) => { plateau.windows[9].processCount += 1; }, /process count/,
    "nonconstant final plateau process count"],
  [(plateau) => { plateau.orphanProductProcessCount = 1; }, /orphan process/,
    "plateau orphan process"],
  [(plateau) => { plateau.windows[1].drainReceiptId = plateau.windows[0].drainReceiptId; },
    /receipt.*unique/, "reused plateau drain receipt"],
  [(plateau) => { plateau.windows[0].checkpointReceiptId = "../checkpoint"; },
    /path-free opaque/, "non-opaque plateau checkpoint receipt"],
  [(plateau) => { plateau.windows[1].workloadReceiptId =
    plateau.windows[0].workloadReceiptId; }, /workload receipt.*unique/,
    "reused plateau workload receipt"],
  [(plateau) => { plateau.windows[0].workloadReceiptId = "../workload"; },
    /workload receipt.*path-free opaque/, "path-like plateau workload receipt"],
  [(plateau) => { plateau.windows[0].duplicateDeliveryAttemptCount = 0; },
    /duplicate delivery/, "missing plateau duplicate delivery attempt"],
  [(plateau) => { plateau.windows[0].noOpOutcome = "completed"; },
    /duplicate-no-op outcome/, "wrong plateau no-op outcome"],
  [(plateau) => { plateau.windows[0].durableMemoryDelta = 1; },
    /durable memory delta/, "nonzero plateau durable memory delta"],
  [(plateau) => { plateau.windows[0].processingJobDelta = 1; },
    /processing job delta/, "nonzero plateau processing job delta"],
  [(plateau) => { plateau.windows[0].workloadReceiptId =
    plateau.windows[0].drainReceiptId; }, /globally unique/,
    "cross-kind plateau receipt reuse"],
];
for (const [mutate, pattern, label] of plateauMutations) {
  assertEvidenceRejected((mutant) => mutate(mutant.resourcePlateauEvidence), pattern, label);
}

assertEvidenceAccepted((mutant) => {
  mutant.resourcePlateauEvidence.windows[2].rssMiB = 200;
}, "measured RSS decrease after a high first window");
assertEvidenceAccepted((mutant) => {
  mutant.resourcePlateauEvidence.windows[2].storageBytes = 2000000;
}, "measured storage decrease after a high first window");
assertEvidenceRejected((mutant) => {
  const windows = mutant.resourcePlateauEvidence.windows;
  windows[3].rssMiB = windows[2].rssMiB + 33;
}, /RSS maximum increase/, "measured RSS growth from first window");
assertEvidenceRejected((mutant) => {
  const windows = mutant.resourcePlateauEvidence.windows;
  windows[3].storageBytes = windows[2].storageBytes + 1048577;
}, /storage maximum increase/, "measured storage growth from first window");

assertEvidenceRejected((_mutant, mutantResult) => {
  mutantResult.resourcePlateauEvidenceFingerprint = `sha256:${"0".repeat(64)}`;
}, /resource plateau evidence fingerprint/, "stale plateau evidence fingerprint", {
  bindPlateau: false,
});
assertEvidenceRejected((mutant) => {
  mutant.resourcePlateauEvidence.windows[0].drainReceiptId =
    "plateau-window-1:changed-drain-receipt";
}, /resource plateau evidence fingerprint/, "modified plateau receipt fingerprint", {
  bindPlateau: false,
});

assertEvidenceRejected((mutant) => {
  mutant.scenarios[0].runPreparations[0].observedProductProcessCount =
    fixture.thresholds.maxSteadyProductProcessCount + 1;
},
  /warm runner preparation did not prove retained ready state/);

console.log("Alpha runner evidence regression checks passed.");

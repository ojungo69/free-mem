import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { canonicalizeJson } from "../../../harness/schema/jcs.ts";
import { isWithin, readBoundedIJsonFile } from "./alpha-result-input.mjs";
import { validateResourcePlateauEvidence } from "./alpha-result-resource.mjs";
import { validateNetworkTrustEvidence } from "./alpha-result-security.mjs";

export const MAX_RUNNER_EVIDENCE_BYTES = 1024 * 1024;

const fingerprint = (domain, value) => `sha256:${createHash("sha256")
  .update(domain).update(canonicalizeJson(value)).digest("hex")}`;

export function networkTrustEvidenceFingerprint(evidence) {
  return fingerprint("free-mem:alpha-network-trust-evidence:v1\0", evidence);
}

export function resourcePlateauEvidenceFingerprint(evidence) {
  return fingerprint("free-mem:alpha-resource-plateau-evidence:v1\0", evidence);
}

export function runnerEvidenceFingerprint(evidence) {
  return fingerprint("free-mem:alpha-runner-evidence:v1\0", evidence);
}

export function runnerResultObservationFingerprint(result) {
  const { runnerEvidenceFingerprint: _runnerEvidenceFingerprint, ...observation } = result;
  return fingerprint("free-mem:alpha-runner-result-observation:v1\0", observation);
}

export function readRunnerEvidenceFile(path, evidenceRoot, artifactRoot) {
  const root = realpathSync(resolve(evidenceRoot));
  const artifact = realpathSync(resolve(artifactRoot));
  const rootStat = statSync(root);
  if (!rootStat.isDirectory() || (rootStat.mode & 0o022) !== 0 ||
      (typeof process.getuid === "function" && rootStat.uid !== process.getuid())) {
    throw new Error("runner evidence root is not runner-owned and immutable");
  }
  if (isWithin(artifact, root) || isWithin(root, artifact)) {
    throw new Error("runner evidence root overlaps the candidate artifact root");
  }
  try {
    return readBoundedIJsonFile(path, MAX_RUNNER_EVIDENCE_BYTES, root);
  } catch (error) {
    throw new Error(`runner evidence ${error instanceof Error ? error.message : "read failed"}`);
  }
}

const observationTimes = (run) => [
  ...run.captureTimings.flatMap((timing) => [timing.startMonotonicMs, timing.endMonotonicMs]),
  ...[run.warmInjectionTiming, run.coldLexicalInjectionTiming]
    .filter(Boolean)
    .flatMap((timing) => [timing.startMonotonicMs, timing.endMonotonicMs]),
];

function validateRunPreparations(
  record, result, exceptionalState, maxPreparationGapMs, maxProductProcessCount,
) {
  const runs = record.latencyRuns;
  const preparations = record.runPreparations;
  if (exceptionalState) {
    if (runs.length !== 0 || preparations.length !== 0) {
      throw new Error("exceptional runner evidence contains measured runs");
    }
    return;
  }
  if (preparations.length !== runs.length || !preparations.every((item, index) => {
    const times = observationTimes(runs[index]);
    return item.runOrdinal === runs[index].runOrdinal && item.mode === runs[index].resetMode &&
      item.runStartedMonotonicMs <= item.runFinishedMonotonicMs &&
      item.observedAtMonotonicMs < item.runStartedMonotonicMs &&
      item.runStartedMonotonicMs - item.observedAtMonotonicMs <= maxPreparationGapMs &&
      (result.resourceSampleMode !== "cold" || (times.length > 0 &&
        Math.min(...times) - item.runStartedMonotonicMs <= maxPreparationGapMs)) &&
      times.every((time) =>
        time >= item.runStartedMonotonicMs && time <= item.runFinishedMonotonicMs) &&
      (index === 0 || (item.observedAtMonotonicMs > preparations[index - 1].runFinishedMonotonicMs &&
        item.runStartedMonotonicMs > preparations[index - 1].runFinishedMonotonicMs));
  })) {
    throw new Error("runner preparation evidence does not match latency runs");
  }
  const dataRoots = new Set(preparations.map((item) => item.dataDirInstanceId));
  const processGenerations = new Set(preparations.map((item) => item.processGenerationId));
  if (result.resourceSampleMode === "cold") {
    if (!preparations.every((item) => item.observedProductProcessCount === 0 &&
          item.observedDataDirEntryCount === 0 && !item.readyProcessObserved)) {
      throw new Error("cold runner preparation did not prove an isolated reset");
    }
  } else if (dataRoots.size !== 1 || processGenerations.size !== 1 ||
      !preparations.every((item) => item.observedProductProcessCount > 0 &&
        item.observedProductProcessCount <= maxProductProcessCount &&
        item.readyProcessObserved)) {
    throw new Error("warm runner preparation did not prove retained ready state");
  }
}

function validateBundlePreparationIdentities(evidence) {
  const preparations = evidence.scenarios.flatMap((record) => record.runPreparations);
  if (new Set(preparations.map((item) => item.receiptId)).size !== preparations.length) {
    throw new Error("runner preparation receipts are reused across the evidence bundle");
  }
  const cold = evidence.scenarios.filter((record) => record.resourceSampleMode === "cold")
    .flatMap((record) => record.runPreparations);
  for (const name of ["dataDirInstanceId", "processGenerationId"]) {
    const occurrences = new Map();
    for (const item of preparations) occurrences.set(item[name], (occurrences.get(item[name]) ?? 0) + 1);
    if (cold.some((item) => occurrences.get(item[name]) !== 1)) {
      throw new Error("cold preparation identities are reused across the evidence bundle");
    }
  }
}

export function validateRunnerEvidence(evidence, result, fixture, expectedInvocationId,
  expectedCaseIds = null) {
  validateNetworkTrustEvidence(evidence.networkTrustEvidence, fixture);
  validateResourcePlateauEvidence(evidence.resourcePlateauEvidence, fixture);
  if (result.networkTrustEvidenceFingerprint !==
      networkTrustEvidenceFingerprint(evidence.networkTrustEvidence)) {
    throw new Error("network trust evidence fingerprint does not match the runner bundle");
  }
  if (result.resourcePlateauEvidenceFingerprint !==
      resourcePlateauEvidenceFingerprint(evidence.resourcePlateauEvidence)) {
    throw new Error("resource plateau evidence fingerprint does not match the runner bundle");
  }
  validateBundlePreparationIdentities(evidence);
  const actualCaseIds = evidence.scenarios.map((item) => item.caseId);
  if (!actualCaseIds.every((item, index) => index === 0 || actualCaseIds[index - 1] < item) ||
      (expectedCaseIds && !isDeepStrictEqual(actualCaseIds, expectedCaseIds))) {
    throw new Error("runner evidence scenarios are duplicated, unsorted, or incomplete");
  }
  if (evidence.fixtureId !== fixture.fixtureId ||
      evidence.fixtureFingerprint !== fixture.contractFingerprint ||
      evidence.candidateId !== result.candidateId ||
      evidence.invocationId !== expectedInvocationId ||
      evidence.environmentFingerprint !== result.environmentFingerprint ||
      evidence.artifactFingerprint !== result.artifactFingerprint ||
      result.runnerEvidenceFingerprint !== runnerEvidenceFingerprint(evidence)) {
    throw new Error("runner evidence identity does not match the result");
  }
  const record = evidence.scenarios.find((item) => item.caseId === result.runnerEvidenceCaseId);
  if (!record || record.scenarioId !== result.scenarioId ||
      record.resourceSampleMode !== result.resourceSampleMode) {
    throw new Error("runner evidence does not contain the result scenario");
  }
  if (record.resultObservationFingerprint !== runnerResultObservationFingerprint(result)) {
    throw new Error("result observation fingerprint does not match runner evidence");
  }
  if (!isDeepStrictEqual(record.hostIdentityEvidence, result.hostIdentityEvidence) ||
      !isDeepStrictEqual(record.observedMilestones, result.milestones) ||
      !isDeepStrictEqual(record.processSamples, result.processSamples) ||
      !isDeepStrictEqual(record.latencyRuns, result.latencyEvidence.runs)) {
    throw new Error("result observations do not match runner evidence");
  }
  validateRunPreparations(record, result,
    result.disposition.state === "unsupported" || result.disposition.state === "not_run",
    fixture.samplingProtocol.processSampleIntervalMs,
    fixture.thresholds.maxSteadyProductProcessCount);
  return record;
}

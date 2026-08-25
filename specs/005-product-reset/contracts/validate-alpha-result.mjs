import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import { readIJsonFile } from "../../../harness/schema/jcs.ts";
import { validateAgainstSchema } from "../../../harness/schema/validate.ts";

const contractDir = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(contractDir, "alpha-result-v1.schema.json");
const semanticPath = join(contractDir, "alpha-result-v1.semantic.jq");
const fixtureSchemaPath = join(contractDir, "../fixtures/slice1-bidirectional-en-v1.schema.json");
const fixtureValidatorPath = join(contractDir, "../fixtures/validate-slice1-fixture.mjs");
const defaultFixturePath = join(contractDir, "../fixtures/slice1-bidirectional-en-v1.json");
const defaultResultPath = join(contractDir, "../fixtures/alpha-result-v1.example.json");
const args = process.argv.slice(2);

if (args.length === 1 && args[0] === "--help") {
  console.log(
    "Usage: node --experimental-strip-types validate-alpha-result.mjs [--fixture PATH] [--result PATH]",
  );
  process.exit(0);
}

let fixturePath = defaultFixturePath;
let resultPath = defaultResultPath;
const seen = new Set();
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index];
  const value = args[index + 1];
  if (!value || (flag !== "--fixture" && flag !== "--result") || seen.has(flag)) {
    throw new Error("invalid arguments; use --help for usage");
  }
  seen.add(flag);
  if (flag === "--fixture") fixturePath = resolve(value);
  if (flag === "--result") resultPath = resolve(value);
}

execFileSync(
  process.execPath,
  ["--experimental-strip-types", fixtureValidatorPath, "--fixture", fixturePath],
  { stdio: "inherit" },
);

const schema = readIJsonFile(schemaPath);
const fixtureSchema = readIJsonFile(fixtureSchemaPath);
const result = readIJsonFile(resultPath);
const fixture = readIJsonFile(fixturePath);
const issues = validateAgainstSchema(result, schema, schema);
if (issues.length > 0) {
  console.error(JSON.stringify(issues, null, 2));
  process.exit(1);
}

// External refs are unsupported; the Shared prefix makes the materialized type boundary executable.
const resultSharedNames = Object.keys(schema.$defs).filter((name) => name.startsWith("Shared")).sort();
const fixtureSharedNames = Object.keys(fixtureSchema.$defs)
  .filter((name) => name.startsWith("Shared"))
  .sort();
if (!isDeepStrictEqual(resultSharedNames, fixtureSharedNames)) {
  throw new Error("Alpha result and fixture shared definition sets differ");
}
for (const name of resultSharedNames) {
  if (
    !isDeepStrictEqual(schema.$defs[name], fixtureSchema.$defs[name])
  ) {
    throw new Error(`Alpha result definition drifted from the fixture: ${name}`);
  }
}

const scenario = fixture.scenarios.find((item) => item.scenarioId === result.scenarioId);
if (
  !scenario ||
  result.fixtureId !== fixture.fixtureId ||
  result.fixtureFingerprint !== fixture.contractFingerprint ||
  result.resourceSampleMode !== scenario.resourceSampleMode ||
  result.drain.drainConditionId !== scenario.drainCondition.drainConditionId ||
  result.drain.terminalMilestone !== scenario.drainCondition.terminalMilestone
) {
  throw new Error("result identity does not match the pinned fixture scenario");
}
const exceptionalState = result.disposition.state === "unsupported" ||
  result.disposition.state === "not_run";

const expectedMilestones = fixture.lifecycleProfiles[scenario.lifecycleProfileId];
const milestoneNames = result.milestones.map((item) => item.name);
const milestonesPass = result.drain.timedOut
  ? milestoneNames.length < expectedMilestones.length &&
    milestoneNames.every((name, index) => name === expectedMilestones[index]) &&
    !milestoneNames.includes(scenario.drainCondition.terminalMilestone)
  : isDeepStrictEqual(milestoneNames, expectedMilestones);
const expectedDegradations = scenario.drainCondition.targetInjectionAcknowledged &&
  fixture.effectiveConfiguration.embeddingProvider.state === "disabled"
  ? [fixture.effectiveConfiguration.embeddingProvider.packDegradationReason]
  : [];
const expectedOperationalStatus = scenario.expectedOperationalStatus ?? null;
const expectedFailureMetadata = scenario.fault?.failureMetadata ?? null;
const expectedRetryEvidence = scenario.fault?.resumeCases
  ? { initialSnapshot: scenario.fault.resumeCaseInitialSnapshot, cases: scenario.fault.resumeCases }
  : scenario.fault?.redirectRecovery
    ? { redirectRecovery: scenario.fault.redirectRecovery }
    : null;

const matchingPositions = (actual, expected) =>
  expected.reduce(
    (count, item, index) => count + Number(isDeepStrictEqual(actual[index], item)),
    0,
  );
const derivedQuality = {
  expectedInjectedItemCount: scenario.expectedInjectedItems.length,
  matchedInjectedItemCount: matchingPositions(result.injectedItems, scenario.expectedInjectedItems),
  expectedOmissionCount: scenario.expectedOmissions.length,
  matchedOmissionCount: matchingPositions(result.omittedItems, scenario.expectedOmissions),
  forbiddenFactCount: result.injectedItems.filter((item) =>
    scenario.forbiddenFacts.includes(item.fact)
  ).length,
};
if (!isDeepStrictEqual(result.quality, derivedQuality)) {
  throw new Error("result quality counters do not match the recorded items");
}
const qualityPass =
  isDeepStrictEqual(result.injectedItems, scenario.expectedInjectedItems) &&
  isDeepStrictEqual(result.omittedItems, scenario.expectedOmissions) &&
  derivedQuality.forbiddenFactCount === 0;

const expectedDuplicateDeliveries = scenario.fault?.replaySchedule
  ? scenario.fault.replaySchedule.slice(1).reduce((count, item) => count + item.eventIds.length, 0)
  : 0;
const countsPass =
  result.counts.captured === scenario.events.length &&
  result.counts.committed === scenario.drainCondition.committedEventCount &&
  result.counts.duplicateDeliveries === expectedDuplicateDeliveries &&
  result.counts.lost === scenario.expectedCounters.acceptedEventLossCount &&
  result.counts.pending === (scenario.drainCondition.pendingSummaryJobCount ?? 0) &&
  result.counts.summaryCount === scenario.drainCondition.summaryCount &&
  result.counts.durableMemoryCount === scenario.drainCondition.durableMemoryCount;
const tracedItems = result.injectedItems.length + result.omittedItems.length;
const admittedItems = result.injectedItems.length + result.omittedItems.filter(
  (item) => item.reason === "omitted_budget" || item.reason === "lane_minimum_not_funded",
).length;
if (
  result.counts.tracedCandidates !== tracedItems ||
  result.counts.admittedCandidates !== admittedItems ||
  result.counts.selectedItems !== result.injectedItems.length
) {
  throw new Error("candidate counters do not match the recorded item dispositions");
}

const oracle = scenario.securityOracle ?? {};
const consideredDenominatorNames = [
  "consideredRemoteProviderEventCount",
  "consideredSecretEventCount",
  "consideredPrivateEventCount",
  "consideredCrossScopeCandidateCount",
  "consideredDerivedCandidateCount",
  "consideredActivationProposalCount",
];
const denominatorsPass =
  result.securityDenominators.agentOperationCount > 0 &&
  result.securityDenominators.acceptedEventCount === scenario.events.length &&
  result.securityDenominators.duplicateDeliveryAttemptCount === expectedDuplicateDeliveries &&
  consideredDenominatorNames.every(
    (name) => !Object.hasOwn(oracle, name) || result.securityDenominators[name] === oracle[name],
  );
const oracleEvidenceFields = [
  "remoteProviderRequestCount",
  "remoteProviderPayloadCount",
  "remoteInjectionCount",
  "persistedSecretCount",
  "injectedSecretCount",
  "payloadBytesSent",
];
const securityEvidencePass =
  result.securityEvidence.persistedSecretCount === 0 &&
  result.securityEvidence.injectedSecretCount === 0 &&
  result.securityEvidence.forbiddenSentinelObservationCount === 0 &&
  (scenario.expectedInjectedItems.length > 0 || result.securityEvidence.remoteInjectionCount === 0) &&
  (result.securityEvidence.remoteProviderRequestCount === 0 ||
    result.securityDenominators.consideredRemoteProviderEventCount > 0) &&
  oracleEvidenceFields.every(
    (name) => !Object.hasOwn(oracle, name) || result.securityEvidence[name] === oracle[name],
  );
const safetyPass =
  isDeepStrictEqual(result.safety, scenario.expectedCounters) && securityEvidencePass;

const resourceMetrics = fixture.samplingProtocol.resourceMetrics;
const steadyMetric = resourceMetrics.maxSteadyProductProcessCount;
const orphanMetric = resourceMetrics.orphanProductProcessCount;
const maxSampleGapMs = fixture.samplingProtocol.processSampleIntervalMs;
const milestoneTimes = new Map(result.milestones.map((item) => [item.name, item.monotonicMs]));
const startTime = milestoneTimes.get(steadyMetric.startMilestone);
const sampleAt = (time) => {
  if (typeof time !== "number") return [];
  const sample = result.processSamples.find((item) => item.monotonicMs >= time);
  return sample && sample.monotonicMs - time <= maxSampleGapMs ? [sample] : [];
};
const startSamples = exceptionalState ? [result.processSamples[0]] : sampleAt(startTime);
const terminalSamples = (exceptionalState || result.drain.timedOut)
  ? [result.processSamples.at(-1)]
  : sampleAt(milestoneTimes.get(steadyMetric.endMilestone));
const teardownSamples = (exceptionalState || result.drain.timedOut)
  ? terminalSamples
  : sampleAt(milestoneTimes.get(orphanMetric.endMilestone));
if (startSamples.length !== 1 || terminalSamples.length !== 1 || teardownSamples.length !== 1) {
  throw new Error("raw resource samples do not cover the pinned milestone boundaries");
}
const startSample = startSamples[0];
const terminalSample = terminalSamples[0];
const teardownSample = teardownSamples[0];
const steadySamples = result.processSamples.filter(
  (sample) => sample.monotonicMs >= startSample.monotonicMs &&
    sample.monotonicMs <= terminalSample.monotonicMs,
);
if (!result.processSamples.every((sample, index, samples) =>
  index === 0 ||
  (sample.monotonicMs > samples[index - 1].monotonicMs &&
    sample.monotonicMs - samples[index - 1].monotonicMs <= maxSampleGapMs)
)) {
  throw new Error("process samples do not honor the pinned sampling interval");
}
const derivedResource = {
  maxSteadyProductProcessCount: Math.max(...steadySamples.map((sample) => sample.processCount)),
  maxShortRunRssGrowthMiB:
    Math.max(...steadySamples.map((sample) => sample.rssMiB)) - startSample.rssMiB,
  maxPendingQueueDepth: Math.max(...steadySamples.map((sample) => sample.queueDepth)),
  maxStorageGrowthBytes:
    Math.max(...steadySamples.map((sample) => sample.storageBytes)) - startSample.storageBytes,
  orphanProductProcessCount: teardownSample.processCount,
};
if (!isDeepStrictEqual(result.resource, derivedResource)) {
  throw new Error("resource aggregates do not match the pinned sample boundaries");
}

const limits = fixture.thresholds;
const resourcePass =
  result.injectedTokens <= limits.maxInjectedTokens &&
  result.resource.maxSteadyProductProcessCount <= limits.maxSteadyProductProcessCount &&
  result.resource.maxShortRunRssGrowthMiB <= limits.maxShortRunRssGrowthMiB &&
  result.resource.maxPendingQueueDepth <= limits.maxPendingQueueDepth &&
  result.resource.maxStorageGrowthBytes <= limits.maxStorageGrowthBytes &&
  result.resource.orphanProductProcessCount <= limits.orphanProductProcessCount;
const scenarioOraclePass =
  milestonesPass &&
  countsPass &&
  denominatorsPass &&
  isDeepStrictEqual(result.packDegradations, expectedDegradations) &&
  isDeepStrictEqual(result.failureMetadata, expectedFailureMetadata) &&
  isDeepStrictEqual(result.operationalStatus, expectedOperationalStatus) &&
  isDeepStrictEqual(result.retryEvidence, expectedRetryEvidence);
const shouldBeEligible =
  !result.drain.timedOut &&
  result.counts.deadlineUnprocessed === 0 &&
  resourcePass &&
  safetyPass &&
  qualityPass &&
  scenarioOraclePass;

if (result.drain.timedOut && !milestonesPass) {
  throw new Error("timed-out result milestones are not a valid pre-terminal lifecycle prefix");
}

if (!resourcePass && expectedOperationalStatus &&
    !isDeepStrictEqual(result.operationalStatus, expectedOperationalStatus)) {
  throw new Error("resource failure record lost the underlying operational status");
}
if (!resourcePass && expectedFailureMetadata &&
    !isDeepStrictEqual(result.failureMetadata, expectedFailureMetadata)) {
  throw new Error("resource failure record lost the underlying payload-free failure metadata");
}

if (exceptionalState) {
  const expectedReason = result.disposition.state === "unsupported"
    ? "capability_unsupported"
    : "owner_slice_not_run";
  const noActivity =
    Object.values(result.counts).every((value) => value === 0) &&
    Object.values(result.safety).every((value) => value === 0) &&
    Object.values(result.securityDenominators).every((value) => value === 0) &&
    Object.values(result.securityEvidence).every((value) => value === 0) &&
    Object.values(result.resource).every((value) => value === 0) &&
    result.injectedItems.length === 0 &&
    result.omittedItems.length === 0 &&
    result.packDegradations.length === 0 &&
    result.injectedTokens === 0 &&
    result.retryEvidence === null &&
    result.failureMetadata === null &&
    result.operationalStatus === null &&
    !result.drain.timedOut &&
    !milestonesPass;
  if (
    !noActivity ||
    !resourcePass ||
    result.disposition.reason !== expectedReason ||
    result.disposition.successfulComparisonEligible
  ) {
    throw new Error("unsupported/not-run disposition is not a canonical no-activity record");
  }
} else if (shouldBeEligible) {
  const expectedReason = expectedOperationalStatus?.reason ??
    oracle.expectedReason ?? expectedDegradations[0] ?? "all_thresholds_passed";
  const expectedState = expectedReason === "all_thresholds_passed" ? "healthy" : "degraded";
  if (
    !result.disposition.successfulComparisonEligible ||
    result.disposition.state !== expectedState ||
    result.disposition.reason !== expectedReason
  ) {
    throw new Error("passing evidence is not recorded as an eligible result");
  }
} else {
  const expectedFailureReason = result.drain.timedOut
    ? "drain_timed_out"
    : result.counts.deadlineUnprocessed > 0
      ? "selection_deadline_exceeded"
      : !resourcePass
        ? "resource_threshold_exceeded"
      : !safetyPass
        ? "safety_threshold_exceeded"
        : !qualityPass
          ? "quality_threshold_exceeded"
          : "scenario_oracle_mismatch";
  if (
    (result.drain.timedOut
      ? result.disposition.state !== "failed" && result.disposition.state !== "degraded"
      : result.disposition.state !== "failed") ||
    result.disposition.reason !== expectedFailureReason ||
    result.disposition.successfulComparisonEligible
  ) {
    throw new Error("failed evidence is not recorded with the derived non-eligible reason");
  }
}

try {
  execFileSync("jq", ["-e", "-f", semanticPath], {
    input: JSON.stringify(result),
    stdio: ["pipe", "inherit", "inherit"],
  });
} catch (error) {
  if (error?.code === "ENOENT") {
    console.error("Prerequisite missing: jq is required to validate Alpha results.");
    process.exit(2);
  }
  throw error;
}

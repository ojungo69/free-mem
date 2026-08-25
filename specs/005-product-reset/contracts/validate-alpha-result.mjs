import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import { canonicalizeJson, parseIJson, readIJsonFile } from "../../../harness/schema/jcs.ts";
import { validateAgainstSchema } from "../../../harness/schema/validate.ts";

const contractDir = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(contractDir, "alpha-result-v1.schema.json");
const semanticPath = join(contractDir, "alpha-result-v1.semantic.jq");
const fixtureSchemaPath = join(contractDir, "../fixtures/slice1-bidirectional-en-v1.schema.json");
const fixtureValidatorPath = join(contractDir, "../fixtures/validate-slice1-fixture.mjs");
const defaultFixturePath = join(contractDir, "../fixtures/slice1-bidirectional-en-v1.json");
const defaultResultPath = join(contractDir, "../fixtures/alpha-result-v1.example.json");
const args = process.argv.slice(2);
const fingerprint = (domain, value) =>
  `sha256:${createHash("sha256").update(domain).update(canonicalizeJson(value)).digest("hex")}`;

function evaluateLatencyEvidence(result, scenario, fixture, exceptionalState) {
  const protocol = fixture.samplingProtocol;
  const metricApplies = (name) => protocol.metrics[name].scenarios.includes(scenario.scenarioId);
  const captureApplies = metricApplies("captureP95Ms");
  const warmInjectionApplies = metricApplies("warmInjectionP95Ms");
  const coldInjectionApplies = metricApplies("shortColdLexicalInjectionMs");
  const expectedCaptureEventIds = captureApplies ? scenario.events.map((event) => event.eventId) : [];
  if (exceptionalState) {
    if (
      result.latencyEvidence.captureEventIds.length !== 0 ||
      result.latencyEvidence.runs.length !== 0 ||
      !Object.values(result.latencyEvidence.aggregates).every((value) => value === null)
    ) {
      throw new Error("unsupported/not-run latency evidence is not empty");
    }
    return false;
  }

  const runs = result.latencyEvidence.runs;
  const expectedResetMode = result.resourceSampleMode === "cold"
    ? "fresh_isolated_data"
    : "fresh_namespace_on_ready_process";
  if (
    !isDeepStrictEqual(result.latencyEvidence.captureEventIds, expectedCaptureEventIds) ||
    runs.length !== protocol.runsPerScenario ||
    !runs.every((run, index) =>
      run.runOrdinal === index + 1 &&
      run.discarded === (run.runOrdinal <= protocol.discardInitialRunsPerScenario) &&
      run.resetMode === expectedResetMode &&
      run.captureElapsedMs.length === expectedCaptureEventIds.length &&
      (warmInjectionApplies ? typeof run.warmInjectionMs === "number" : run.warmInjectionMs === null) &&
      (coldInjectionApplies
        ? typeof run.coldLexicalInjectionMs === "number"
        : run.coldLexicalInjectionMs === null)
    )
  ) {
    throw new Error("latency run evidence does not match the pinned sampling protocol");
  }
  const measuredRuns = runs.filter((run) => !run.discarded);
  if (measuredRuns.length !== protocol.measuredRunsPerScenario) {
    throw new Error("latency measured-run count does not match the pinned protocol");
  }
  const nearestRankP95 = (values) => {
    const ordered = [...values].sort((left, right) => left - right);
    return ordered[Math.ceil(ordered.length * 0.95) - 1];
  };
  const expectedAggregates = {
    captureP95Ms: captureApplies
      ? nearestRankP95(measuredRuns.flatMap((run) => run.captureElapsedMs))
      : null,
    warmInjectionP95Ms: warmInjectionApplies
      ? nearestRankP95(measuredRuns.map((run) => run.warmInjectionMs))
      : null,
    shortColdLexicalInjectionMs: coldInjectionApplies
      ? nearestRankP95(measuredRuns.map((run) => run.coldLexicalInjectionMs))
      : null,
  };
  if (!isDeepStrictEqual(result.latencyEvidence.aggregates, expectedAggregates)) {
    throw new Error("latency aggregates do not match the recorded measured runs");
  }
  return (
    (expectedAggregates.captureP95Ms === null ||
      expectedAggregates.captureP95Ms < fixture.thresholds.captureP95Ms) &&
    (expectedAggregates.warmInjectionP95Ms === null ||
      expectedAggregates.warmInjectionP95Ms < fixture.thresholds.warmInjectionP95Ms) &&
    (expectedAggregates.shortColdLexicalInjectionMs === null ||
      expectedAggregates.shortColdLexicalInjectionMs < fixture.thresholds.shortColdLexicalInjectionMs)
  );
}

if (args.length === 1 && args[0] === "--help") {
  console.log(
    "Usage: node --experimental-strip-types validate-alpha-result.mjs [--fixture PATH] [--result PATH]...",
  );
  process.exit(0);
}

let fixturePath = defaultFixturePath;
const resultPaths = [];
let fixtureSeen = false;
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index];
  const value = args[index + 1];
  if (
    !value ||
    (flag !== "--fixture" && flag !== "--result") ||
    (flag === "--fixture" && fixtureSeen)
  ) {
    throw new Error("invalid arguments; use --help for usage");
  }
  if (flag === "--fixture") {
    fixtureSeen = true;
    fixturePath = resolve(value);
  }
  if (flag === "--result") resultPaths.push(value === "-" ? value : resolve(value));
}
if (resultPaths.length === 0) resultPaths.push(defaultResultPath);

execFileSync(
  process.execPath,
  ["--experimental-strip-types", fixtureValidatorPath, "--fixture", fixturePath],
  { stdio: "inherit" },
);

if (resultPaths.length > 1) {
  const suiteFixture = readIJsonFile(fixturePath);
  const suiteResults = resultPaths.map((path) => readIJsonFile(path));
  const expectedScenarioIds = suiteFixture.scenarios.map((item) => item.scenarioId).sort();
  const actualScenarioIds = suiteResults.map((item) => item.scenarioId).sort();
  const first = suiteResults[0];
  if (
    !isDeepStrictEqual(actualScenarioIds, expectedScenarioIds) ||
    !suiteResults.every((item) =>
      item.candidateId === first.candidateId &&
      item.fixtureFingerprint === first.fixtureFingerprint &&
      item.environmentFingerprint === first.environmentFingerprint &&
      item.artifactFingerprint === first.artifactFingerprint &&
      item.disposition.successfulComparisonEligible
    )
  ) {
    throw new Error("candidate suite is incomplete, inconsistent, or non-eligible");
  }
  for (const item of suiteResults) {
    execFileSync(
      process.execPath,
      ["--experimental-strip-types", fileURLToPath(import.meta.url), "--fixture", fixturePath, "--result", "-"],
      { input: JSON.stringify(item), stdio: ["pipe", "inherit", "inherit"] },
    );
  }
  process.exit(0);
}

const schema = readIJsonFile(schemaPath);
const fixtureSchema = readIJsonFile(fixtureSchemaPath);
const resultPath = resultPaths[0];
const result = resultPath === "-"
  ? parseIJson(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(0)))
  : readIJsonFile(resultPath);
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
const expectedExecutionEnvironment = {
  pins: fixture.pins,
  environment: fixture.environment,
};
const environmentFingerprint = fingerprint(
  "free-mem:alpha-execution-environment:v1\0",
  result.executionEnvironment,
);
const artifactFingerprint = fingerprint(
  "free-mem:alpha-candidate-artifact:v1\0",
  result.artifactMetadata,
);
const artifactContentFingerprint = fingerprint(
  "free-mem:alpha-artifact-content:v1\0",
  result.artifactMetadata.manifest,
);
const artifactPaths = result.artifactMetadata.manifest.files.map((item) => item.path);
if (artifactPaths.length !== new Set(artifactPaths).size) {
  throw new Error("artifact manifest contains duplicate normalized paths");
}
const expectedManifestFingerprint = scenario?.derivationManifestId
  ? fixture.localDerivationManifest.configurationFingerprint
  : fixture.effectiveConfiguration.configurationFingerprint;
if (
  !scenario ||
  result.fixtureId !== fixture.fixtureId ||
  result.fixtureFingerprint !== fixture.contractFingerprint ||
  result.resourceSampleMode !== scenario.resourceSampleMode ||
  result.targetDestinationClass !== scenario.targetDestinationClass ||
  result.effectiveManifestFingerprint !== expectedManifestFingerprint ||
  !isDeepStrictEqual(result.executionEnvironment, expectedExecutionEnvironment) ||
  result.environmentFingerprint !== environmentFingerprint ||
  result.artifactMetadata.candidateId !== result.candidateId ||
  result.artifactMetadata.baseCommit !== fixture.pins.freeMemBaseCommit ||
  result.artifactMetadata.contentSha256 !== artifactContentFingerprint ||
  result.artifactFingerprint !== artifactFingerprint ||
  result.drain.drainConditionId !== scenario.drainCondition.drainConditionId ||
  result.drain.terminalMilestone !== scenario.drainCondition.terminalMilestone
) {
  throw new Error("result identity does not match the pinned fixture scenario");
}
const exceptionalState = result.disposition.state === "unsupported" ||
  result.disposition.state === "not_run";

const expectedMilestones = fixture.lifecycleProfiles[scenario.lifecycleProfileId];
const milestoneNames = result.milestones.map((item) => item.name);
const drainMilestoneTimes = new Map(result.milestones.map((item) => [item.name, item.monotonicMs]));
const drainStartTime = drainMilestoneTimes.get(scenario.drainCondition.startMilestone);
const drainTerminalTime = drainMilestoneTimes.get(scenario.drainCondition.terminalMilestone);
if (
  !result.drain.timedOut &&
  typeof drainStartTime === "number" &&
  typeof drainTerminalTime === "number" &&
  drainTerminalTime - drainStartTime > scenario.drainCondition.timeoutMs
) {
  throw new Error("completed drain exceeded the pinned timeout");
}
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
const observedRetryCase = (item) => {
  const providerAttempted = item.expected.attemptDelta > 0;
  return {
    caseId: item.caseId,
    deliveredSignals: item.signals,
    consumedSignalIds: item.expectedConsumedSignalIds,
    ignoredSignalIds: item.expectedIgnoredSignalIds,
    providerAttempted,
    observedProviderOutcome: providerAttempted ? item.providerOutcome : null,
    observedTransition: item.expected,
  };
};
const expectedRetryEvidence = scenario.fault?.resumeCases
  ? {
      observedInitialSnapshot: scenario.fault.resumeCaseInitialSnapshot,
      cases: scenario.fault.resumeCases.map(observedRetryCase),
    }
  : scenario.fault?.redirectRecovery
    ? {
        observedInitialSnapshot: scenario.fault.resumeCaseInitialSnapshot,
        redirectCase: observedRetryCase({
          caseId: scenario.fault.redirectRecovery.caseId,
          signals: [scenario.fault.redirectRecovery.signal],
          expectedConsumedSignalIds:
            scenario.fault.redirectRecovery.expectedConsumedSignalIds,
          expectedIgnoredSignalIds:
            scenario.fault.redirectRecovery.expectedIgnoredSignalIds,
          providerOutcome: scenario.fault.redirectRecovery.providerOutcome,
          expected: scenario.fault.redirectRecovery.expected,
        }),
      }
    : null;
const conflictProbe = scenario.fault?.identityConflictProbe;
const expectedIdentityConflictEvidence = conflictProbe
  ? {
      eventId: conflictProbe.eventId,
      payloadDigestVersion: conflictProbe.payloadDigestVersion,
      canonicalPayloadDigest: conflictProbe.canonicalPayloadDigest,
      conflictingPayloadDigest: conflictProbe.conflictingPayloadDigest,
      conflictReceiptId: conflictProbe.conflictReceiptId,
      conflictReceiptState: conflictProbe.conflictReceiptState,
      canonicalEventState: conflictProbe.canonicalEventState,
      incomingDeliveryState: conflictProbe.incomingDeliveryState,
      reason: conflictProbe.expectedReason,
      canonicalPayloadUnchanged: conflictProbe.canonicalPayloadUnchanged,
      durableMemoryDelta: conflictProbe.durableMemoryDelta,
    }
  : null;
const observedCases = result.retryEvidence?.cases ??
  (result.retryEvidence?.redirectCase ? [result.retryEvidence.redirectCase] : []);
if (!observedCases.every((item) =>
  item.providerAttempted === (item.observedTransition.attemptDelta > 0) &&
  item.ignoredSignalIds.length === item.observedTransition.ignoredSignalCount &&
  item.consumedSignalIds.length + item.ignoredSignalIds.length === item.deliveredSignals.length &&
  (item.providerAttempted
    ? item.observedProviderOutcome !== null
    : item.observedProviderOutcome === null)
)) {
  throw new Error("observed retry evidence is internally inconsistent");
}

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
  "credentialBytesSent",
  "payloadBytesSent",
  "redirectLocationRequestCount",
  "redirectLocationPayloadBytesSent",
  "resentPayloadCount",
];
const activeSummaryProvider = scenario.derivationManifestId
  ? fixture.localDerivationManifest.summaryProvider
  : fixture.effectiveConfiguration.summaryProvider;
const providerRejected = Object.hasOwn(scenario.summaryProviderStub, "policyRejectedReason");
const derivationRequested =
  Object.hasOwn(scenario.summaryProviderStub, "summary") ||
  Object.hasOwn(scenario.summaryProviderStub, "malformedResponse") ||
  Object.hasOwn(scenario.summaryProviderStub, "redirectResponse") ||
  scenario.summaryProviderStub.memoryItems.length > 0;
const remoteProviderExpected =
  activeSummaryProvider.executionLocation === "remote" && derivationRequested && !providerRejected;
const expectedRemoteProviderRequests = remoteProviderExpected
  ? (scenario.fault?.attemptsUntilExhausted ?? 1)
  : 0;
const credentialTransmissionExpected =
  remoteProviderExpected && Object.hasOwn(activeSummaryProvider, "credentialSource");
const providerRoutingPass = remoteProviderExpected
  ? result.securityDenominators.consideredRemoteProviderEventCount > 0 &&
    result.securityEvidence.remoteProviderRequestCount === expectedRemoteProviderRequests &&
    result.securityEvidence.remoteProviderPayloadCount === expectedRemoteProviderRequests &&
    (credentialTransmissionExpected
      ? result.securityEvidence.credentialBytesSent > 0
      : result.securityEvidence.credentialBytesSent === 0) &&
    result.securityEvidence.payloadBytesSent > 0
  : result.securityEvidence.remoteProviderRequestCount === 0 &&
    result.securityEvidence.remoteProviderPayloadCount === 0 &&
    result.securityEvidence.credentialBytesSent === 0 &&
    result.securityEvidence.payloadBytesSent === 0;
const destinationPolicy =
  fixture.effectiveConfiguration.destinationPolicyMap[scenario.targetDestinationClass];
const securityEvidencePass =
  result.securityEvidence.persistedSecretCount === 0 &&
  result.securityEvidence.injectedSecretCount === 0 &&
  result.securityEvidence.redirectLocationRequestCount === 0 &&
  result.securityEvidence.redirectLocationPayloadBytesSent === 0 &&
  result.securityEvidence.resentPayloadCount === 0 &&
  result.securityEvidence.forbiddenSentinelObservationCount === 0 &&
  providerRoutingPass &&
  (destinationPolicy.executionLocation === "remote" ||
    result.securityEvidence.remoteInjectionCount === 0) &&
  (result.securityEvidence.remoteProviderRequestCount === 0 ||
    result.securityDenominators.consideredRemoteProviderEventCount > 0) &&
  oracleEvidenceFields.every(
    (name) => !Object.hasOwn(oracle, name) || result.securityEvidence[name] === oracle[name],
  );
const safetyCountersPass = isDeepStrictEqual(result.safety, scenario.expectedCounters);
const safetyPass = safetyCountersPass && securityEvidencePass;

const latencyPass = evaluateLatencyEvidence(result, scenario, fixture, exceptionalState);

const resourceMetrics = fixture.samplingProtocol.resourceMetrics;
const steadyMetric = resourceMetrics.maxSteadyProductProcessCount;
const orphanMetric = resourceMetrics.orphanProductProcessCount;
const maxSampleGapMs = fixture.samplingProtocol.processSampleIntervalMs;
const milestoneTimes = new Map(result.milestones.map((item) => [item.name, item.monotonicMs]));
const startTime = milestoneTimes.get(steadyMetric.startMilestone);
const sampleAtOrAfter = (time) => {
  if (typeof time !== "number") return [];
  const sample = result.processSamples.find((item) => item.monotonicMs >= time);
  return sample && sample.monotonicMs - time <= maxSampleGapMs ? [sample] : [];
};
const sampleAtOrBefore = (time) => {
  if (typeof time !== "number") return [];
  const sample = [...result.processSamples].reverse().find((item) => item.monotonicMs <= time);
  return sample && time - sample.monotonicMs <= maxSampleGapMs ? [sample] : [];
};
const startSamples = exceptionalState ? [result.processSamples[0]] : sampleAtOrBefore(startTime);
const terminalSamples = (exceptionalState || result.drain.timedOut)
  ? [result.processSamples.at(-1)]
  : sampleAtOrAfter(milestoneTimes.get(steadyMetric.endMilestone));
const teardownSamples = (exceptionalState || result.drain.timedOut)
  ? terminalSamples
  : sampleAtOrAfter(milestoneTimes.get(orphanMetric.endMilestone));
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
const injectionEnvelope = fixture.effectiveConfiguration.resourceProfile.injectionEnvelope;
const selectionDeadlineExceeded =
  result.counts.deadlineUnprocessed > 0 ||
  result.selectionElapsedMs > injectionEnvelope.selectionTimeBudgetMs;
const injectionPackSizePass =
  result.renderedBytes <= injectionEnvelope.maxRenderedBytes &&
  result.injectedTokens <= injectionEnvelope.maxInjectedTokens;
if (
  selectionDeadlineExceeded &&
  (result.counts.selectedItems !== 0 ||
    result.injectedItems.length !== 0 ||
    result.renderedBytes !== 0 ||
    result.injectedTokens !== 0)
) {
  throw new Error("late or oversized InjectionPack was recorded as delivered");
}
const resourcePass =
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
  isDeepStrictEqual(result.identityConflictEvidence, expectedIdentityConflictEvidence) &&
  isDeepStrictEqual(result.failureMetadata, expectedFailureMetadata) &&
  isDeepStrictEqual(result.operationalStatus, expectedOperationalStatus) &&
  isDeepStrictEqual(result.retryEvidence, expectedRetryEvidence);
const derivedFailureReason = result.drain.timedOut
  ? "drain_timed_out"
  : selectionDeadlineExceeded
    ? "selection_deadline_exceeded"
    : !injectionPackSizePass
      ? "injection_pack_limit_exceeded"
      : !latencyPass
        ? "latency_threshold_exceeded"
        : !resourcePass
          ? "resource_threshold_exceeded"
          : !safetyPass
            ? "safety_threshold_exceeded"
            : !qualityPass
              ? "quality_threshold_exceeded"
              : !scenarioOraclePass
                ? "scenario_oracle_mismatch"
                : null;
const shouldBeEligible = derivedFailureReason === null;

if (result.drain.timedOut && !milestonesPass) {
  throw new Error("timed-out result milestones are not a valid pre-terminal lifecycle prefix");
}
if (result.drain.timedOut && !safetyCountersPass) {
  throw new Error("timed-out result violates an independent zero-tolerance safety counter");
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
    result.attemptedRenderedBytes === 0 &&
    result.renderedBytes === 0 &&
    result.attemptedInjectedTokens === 0 &&
    result.injectedTokens === 0 &&
    result.selectionElapsedMs === 0 &&
    result.retryEvidence === null &&
    result.identityConflictEvidence === null &&
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
  if (
    (result.drain.timedOut
      ? result.disposition.state !== "failed" && result.disposition.state !== "degraded"
      : result.disposition.state !== "failed") ||
    result.disposition.reason !== derivedFailureReason ||
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

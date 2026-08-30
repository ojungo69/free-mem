import { isDeepStrictEqual } from "node:util";

const span = (values) => Math.max(...values) - Math.min(...values);
const maximumIncrease = (values) => Math.max(...values) - values[0];
const FINAL_FIVE_RSS_SPAN_MIB = 16;
const FINAL_FIVE_STORAGE_SPAN_BYTES = 65536;

export function validateResourcePlateauEvidence(evidence, fixture) {
  const windows = evidence?.windows;
  if (!Array.isArray(windows) || windows.length !== 12) {
    throw new Error("resource plateau evidence must contain exactly 12 windows");
  }
  if (
    evidence.version !== 1 || evidence.workload !== "duplicate_noop_v1" ||
    !isDeepStrictEqual(evidence.discardedWindowOrdinals, [1, 2]) ||
    !isDeepStrictEqual(evidence.measuredWindowOrdinals, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) ||
    !isDeepStrictEqual(evidence.finalWindowOrdinals, [8, 9, 10, 11, 12]) ||
    !windows.every((window, index) => window.ordinal === index + 1)
  ) {
    throw new Error("resource plateau windows are not ordered under the fixed protocol");
  }
  const receiptIds = windows.flatMap((window) => [
    window.drainReceiptId, window.checkpointReceiptId,
  ]);
  if (!receiptIds.every((receiptId) =>
    typeof receiptId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(receiptId)
  )) {
    throw new Error("resource plateau receipts are not path-free opaque identifiers");
  }
  if (new Set(receiptIds).size !== receiptIds.length) {
    throw new Error("resource plateau receipt identities are not unique across windows");
  }
  const workloadReceiptIds = windows.map((window) => window.workloadReceiptId);
  if (!workloadReceiptIds.every((receiptId) =>
    typeof receiptId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(receiptId)
  )) {
    throw new Error("resource plateau workload receipts are not path-free opaque identifiers");
  }
  if (new Set(workloadReceiptIds).size !== workloadReceiptIds.length) {
    throw new Error("resource plateau workload receipt identities are not unique");
  }
  if (new Set([...receiptIds, ...workloadReceiptIds]).size !==
      receiptIds.length + workloadReceiptIds.length) {
    throw new Error("resource plateau receipt identities are not globally unique");
  }
  validatePlateauOutcomes(windows);
  if (evidence.orphanProductProcessCount !== 0) {
    throw new Error("resource plateau evidence contains an orphan process");
  }
  validateMeasuredPlateau(
    windows.slice(2), fixture.effectiveConfiguration.resourceProfile, fixture.thresholds,
  );
  validateFinalPlateau(windows.slice(7));
}

function validatePlateauOutcomes(windows) {
  if (windows.some((window) =>
    !Number.isInteger(window.duplicateDeliveryAttemptCount) ||
    window.duplicateDeliveryAttemptCount < 1
  )) {
    throw new Error("resource plateau lacks a duplicate delivery attempt");
  }
  if (windows.some((window) => window.noOpOutcome !== "duplicate_noop")) {
    throw new Error("resource plateau lacks the fixed duplicate-no-op outcome");
  }
  if (windows.some((window) => window.durableMemoryDelta !== 0)) {
    throw new Error("resource plateau durable memory delta is nonzero");
  }
  if (windows.some((window) => window.processingJobDelta !== 0)) {
    throw new Error("resource plateau processing job delta is nonzero");
  }
  const timestampFields = ["workloadStartedMonotonicMs", "workloadReceiptMonotonicMs",
    "drainReceiptMonotonicMs", "checkpointReceiptMonotonicMs", "resourceSampleMonotonicMs"];
  if (!windows.every((window, index) => {
    const times = timestampFields.map((field) => window[field]);
    return times.every(Number.isFinite) &&
      times.every((time, timeIndex) => timeIndex === 0 || times[timeIndex - 1] < time) &&
      (index === 0 || windows[index - 1].resourceSampleMonotonicMs <
        window.workloadStartedMonotonicMs);
  })) {
    throw new Error("resource plateau workload/drain/checkpoint/sample order is invalid");
  }
}

function validateMeasuredPlateau(measured, profile, thresholds) {
  if (measured.some((window) =>
    window.processCount > thresholds.maxSteadyProductProcessCount
  )) {
    throw new Error("resource plateau process count exceeds the fixture ceiling");
  }
  if (maximumIncrease(measured.map((window) => window.rssMiB)) >
      thresholds.maxShortRunRssGrowthMiB) {
    throw new Error("resource plateau RSS maximum increase exceeds the fixture ceiling");
  }
  if (measured.some((window) =>
    window.drainedQueueDepth > thresholds.maxPendingQueueDepth
  )) {
    throw new Error("resource plateau queue depth exceeds the fixture ceiling");
  }
  if (maximumIncrease(measured.map((window) => window.storageBytes)) >
      thresholds.maxStorageGrowthBytes) {
    throw new Error("resource plateau storage maximum increase exceeds the fixture ceiling");
  }
  if (measured.some((window) =>
    window.selectedItemCount > profile.injectionEnvelope.maxSelectedItems
  )) {
    throw new Error("resource plateau selected item count exceeds the fixture ceiling");
  }
  if (measured.some((window) =>
    window.injectedTokenCount > profile.injectionEnvelope.maxInjectedTokens
  )) {
    throw new Error("resource plateau injected token count exceeds the fixture ceiling");
  }
  if (measured.some((window) =>
    window.maxProcessingConcurrency > profile.processingConcurrencyLimit
  )) {
    throw new Error("resource plateau concurrency exceeds the fixture ceiling");
  }
}

function validateFinalPlateau(final) {
  if (!final.every((window) => window.processCount === final[0].processCount)) {
    throw new Error("resource plateau final process count is not constant");
  }
  if (!final.every((window) => window.drainedQueueDepth === 0)) {
    throw new Error("resource plateau final queue is not drained");
  }
  if (!final.every((window) => window.selectedItemCount === final[0].selectedItemCount)) {
    throw new Error("resource plateau final selected item count is not constant");
  }
  if (!final.every((window) => window.injectedTokenCount === final[0].injectedTokenCount)) {
    throw new Error("resource plateau final injected token count is not constant");
  }
  if (span(final.map((window) => window.rssMiB)) > FINAL_FIVE_RSS_SPAN_MIB) {
    throw new Error("resource plateau final RSS span exceeds 16 MiB");
  }
  if (span(final.map((window) => window.storageBytes)) > FINAL_FIVE_STORAGE_SPAN_BYTES) {
    throw new Error("resource plateau final storage span exceeds 65536 bytes");
  }
}

export function evaluateResourceEvidence(result, fixture, exceptionalState, runnerRecord, timeoutMs) {
  const resourceMetrics = fixture.samplingProtocol.resourceMetrics, steadyMetric = resourceMetrics.maxSteadyProductProcessCount;
  const orphanMetric = resourceMetrics.orphanProductProcessCount;
  const maxSampleGapMs = fixture.samplingProtocol.processSampleIntervalMs;
  const milestoneTimes = new Map(runnerRecord.observedMilestones
    .map((item) => [item.name, item.monotonicMs]));
  const samples = runnerRecord.processSamples;
  const startTime = milestoneTimes.get(steadyMetric.startMilestone);
  const sampleAtOrAfter = (time) => {
    if (typeof time !== "number") return [];
    const sample = samples.find((item) => item.monotonicMs >= time);
    return sample && sample.monotonicMs - time <= maxSampleGapMs ? [sample] : [];
  };
  const sampleAtOrBefore = (time) => {
    if (typeof time !== "number") return [];
    const sample = [...samples].reverse().find((item) => item.monotonicMs <= time);
    return sample && time - sample.monotonicMs <= maxSampleGapMs ? [sample] : [];
  };
  const startSamples = exceptionalState ? [samples[0]] : sampleAtOrBefore(startTime);
  const terminalSamples = (exceptionalState || result.drain.timedOut)
    ? [samples.at(-1)]
    : sampleAtOrAfter(milestoneTimes.get(steadyMetric.endMilestone));
  const teardownSamples = (exceptionalState || result.drain.timedOut)
    ? terminalSamples
    : sampleAtOrAfter(milestoneTimes.get(orphanMetric.endMilestone));
  if (startSamples.length !== 1 || terminalSamples.length !== 1 || teardownSamples.length !== 1) {
    throw new Error("raw resource samples do not cover the pinned milestone boundaries");
  }
  const startSample = startSamples[0], terminalSample = terminalSamples[0];
  const steadySamples = samples.filter((sample) => sample.monotonicMs >= startSample.monotonicMs &&
    sample.monotonicMs <= terminalSample.monotonicMs);
  if (!samples.every((sample, index) => index === 0 ||
      (sample.monotonicMs > samples[index - 1].monotonicMs &&
        sample.monotonicMs - samples[index - 1].monotonicMs <= maxSampleGapMs))) {
    throw new Error("process samples do not honor the pinned sampling interval");
  }
  if (result.drain.timedOut) {
    const deadline = startTime + timeoutMs;
    const deadlineSample = samples.find((sample) => sample.monotonicMs >= deadline);
    if (typeof startTime !== "number" || deadlineSample !== samples.at(-1) ||
        !deadlineSample || deadlineSample.monotonicMs - deadline > maxSampleGapMs) {
      throw new Error("timed-out resource sample does not match the deadline boundary");
    }
  }
  const derived = {
    maxSteadyProductProcessCount: Math.max(...steadySamples.map((sample) => sample.processCount)),
    maxShortRunRssGrowthMiB:
      Math.max(...steadySamples.map((sample) => sample.rssMiB)) - startSample.rssMiB,
    maxPendingQueueDepth: Math.max(...steadySamples.map((sample) => sample.queueDepth)),
    maxStorageGrowthBytes:
      Math.max(...steadySamples.map((sample) => sample.storageBytes)) - startSample.storageBytes,
    orphanProductProcessCount: teardownSamples[0].processCount,
  };
  if (!isDeepStrictEqual(result.resource, derived)) {
    throw new Error("resource aggregates do not match the runner-owned samples");
  }
  const limits = fixture.thresholds;
  return derived.maxSteadyProductProcessCount <= limits.maxSteadyProductProcessCount &&
    derived.maxShortRunRssGrowthMiB <= limits.maxShortRunRssGrowthMiB &&
    derived.maxPendingQueueDepth <= limits.maxPendingQueueDepth &&
    derived.maxStorageGrowthBytes <= limits.maxStorageGrowthBytes &&
    derived.orphanProductProcessCount <= limits.orphanProductProcessCount;
}

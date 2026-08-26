import { isDeepStrictEqual } from "node:util";

export function evaluateResourceEvidence(result, fixture, exceptionalState, runnerRecord) {
  const resourceMetrics = fixture.samplingProtocol.resourceMetrics;
  const steadyMetric = resourceMetrics.maxSteadyProductProcessCount;
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

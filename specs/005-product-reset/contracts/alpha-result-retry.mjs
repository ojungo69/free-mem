export function expectedRetryEvidence(scenario) {
  const observedRetryCase = (item) => {
    const providerAttempted = item.expected.attemptDelta > 0;
    const observedDurableOutput = item.providerOutcome === "valid"
      ? (scenario.fault.recoveredOutput ?? scenario.summaryProviderStub)
      : null;
    return {
      caseId: item.caseId,
      deliveredSignals: item.signals,
      consumedSignalIds: item.expectedConsumedSignalIds,
      ignoredSignalIds: item.expectedIgnoredSignalIds,
      providerAttempted,
      observedProviderOutcome: providerAttempted ? item.providerOutcome : null,
      observedDurableOutput,
      observedTransition: item.expected,
    };
  };
  if (scenario.fault?.resumeCases) {
    return {
      observedInitialSnapshot: scenario.fault.resumeCaseInitialSnapshot,
      cases: scenario.fault.resumeCases.map(observedRetryCase),
    };
  }
  if (scenario.fault?.redirectRecovery) {
    return {
      observedInitialSnapshot: scenario.fault.resumeCaseInitialSnapshot,
      redirectCase: observedRetryCase({
        caseId: scenario.fault.redirectRecovery.caseId,
        signals: [scenario.fault.redirectRecovery.signal],
        expectedConsumedSignalIds: scenario.fault.redirectRecovery.expectedConsumedSignalIds,
        expectedIgnoredSignalIds: scenario.fault.redirectRecovery.expectedIgnoredSignalIds,
        providerOutcome: scenario.fault.redirectRecovery.providerOutcome,
        expected: scenario.fault.redirectRecovery.expected,
      }),
    };
  }
  return null;
}

export function assertRetryEvidenceConsistent(result) {
  const observedCases = result.retryEvidence?.cases ??
    (result.retryEvidence?.redirectCase ? [result.retryEvidence.redirectCase] : []);
  if (!observedCases.every((item) =>
    item.providerAttempted === (item.observedTransition.attemptDelta > 0) &&
    item.ignoredSignalIds.length === item.observedTransition.ignoredSignalCount &&
    item.consumedSignalIds.length + item.ignoredSignalIds.length === item.deliveredSignals.length &&
    item.observedTransition.durableMemoryCount === (item.observedDurableOutput
      ? Number(Object.hasOwn(item.observedDurableOutput, "summary")) +
        item.observedDurableOutput.memoryItems.length
      : 0) &&
    (item.providerAttempted
      ? item.observedProviderOutcome !== null
      : item.observedProviderOutcome === null)
  )) {
    throw new Error("observed retry evidence is internally inconsistent");
  }
}

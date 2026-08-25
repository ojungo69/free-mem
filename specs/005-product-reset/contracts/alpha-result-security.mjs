import { isDeepStrictEqual } from "node:util";

export function evaluateSecurityEvidence({
  result,
  scenario,
  fixture,
  exceptionalState,
  expectedDuplicateDeliveries,
}) {
  const oracle = scenario.securityOracle ?? {};
  const activeSummaryProvider = scenario.derivationManifestId
    ? fixture.localDerivationManifest.summaryProvider
    : fixture.effectiveConfiguration.summaryProvider;
  const remoteProviderEvents = activeSummaryProvider.executionLocation === "remote"
    ? scenario.events
    : [];
  const expectedEligibleEventCount = remoteProviderEvents.filter(
    (event) => event.sensitivity === "eligible",
  ).length;
  const expectedRestrictedEventCount = remoteProviderEvents.length - expectedEligibleEventCount;
  const consideredDenominatorNames = [
    "consideredCrossScopeCandidateCount",
    "consideredDerivedCandidateCount",
    "consideredActivationProposalCount",
  ];
  const denominatorsPass =
    result.securityDenominators.agentOperationCount > 0 &&
    result.securityDenominators.acceptedEventCount === scenario.events.length &&
    result.securityDenominators.duplicateDeliveryAttemptCount === expectedDuplicateDeliveries &&
    result.securityDenominators.consideredRemoteProviderEventCount === remoteProviderEvents.length &&
    result.securityDenominators.consideredEligibleEventCount === expectedEligibleEventCount &&
    result.securityDenominators.consideredRestrictedEventCount === expectedRestrictedEventCount &&
    result.securityDenominators.consideredSecretEventCount ===
      scenario.events.filter((event) => event.sensitivity === "secret").length &&
    result.securityDenominators.consideredPrivateEventCount ===
      scenario.events.filter((event) => event.sensitivity === "private").length &&
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
    "restrictedPayloadBytesSent",
    "redirectLocationRequestCount",
    "redirectLocationPayloadBytesSent",
    "resentPayloadCount",
  ];
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
  const transmissionOracle = scenario.providerTransmissionOracle;
  const observedProviderRequests = result.securityEvidence.remoteProviderRequestCount;
  const completedProviderRoutingPass = remoteProviderExpected
    ? result.securityDenominators.consideredRemoteProviderEventCount > 0 &&
      result.securityDenominators.consideredEligibleEventCount > 0 &&
      observedProviderRequests === expectedRemoteProviderRequests &&
      result.securityEvidence.remoteProviderPayloadCount === expectedRemoteProviderRequests
    : observedProviderRequests === 0 &&
      result.securityEvidence.remoteProviderPayloadCount === 0;
  const timeoutProviderRoutingPass = remoteProviderExpected
    ? result.securityDenominators.consideredRemoteProviderEventCount > 0 &&
      result.securityDenominators.consideredEligibleEventCount > 0 &&
      observedProviderRequests <= expectedRemoteProviderRequests &&
      result.securityEvidence.remoteProviderPayloadCount === observedProviderRequests
    : observedProviderRequests === 0 &&
      result.securityEvidence.remoteProviderPayloadCount === 0;
  const providerRoutingPass = result.drain.timedOut
    ? timeoutProviderRoutingPass
    : completedProviderRoutingPass;
  const transmissionPass =
    result.securityEvidence.credentialBytesSent === transmissionOracle.credentialBytesSent &&
    result.securityEvidence.payloadBytesSent === transmissionOracle.payloadBytesSent;
  const timeoutTransmissionPass =
    observedProviderRequests <= expectedRemoteProviderRequests &&
    result.securityEvidence.remoteProviderPayloadCount === observedProviderRequests &&
    (expectedRemoteProviderRequests === 0
      ? transmissionPass
      : result.securityEvidence.credentialBytesSent * expectedRemoteProviderRequests ===
        transmissionOracle.credentialBytesSent * observedProviderRequests &&
        result.securityEvidence.payloadBytesSent * expectedRemoteProviderRequests ===
          transmissionOracle.payloadBytesSent * observedProviderRequests);
  const effectiveTransmissionPass = result.drain.timedOut
    ? timeoutTransmissionPass
    : transmissionPass;
  if (!exceptionalState && !effectiveTransmissionPass) {
    throw new Error("provider transmission bytes do not match the pinned wire aggregate");
  }
  const destinationPolicy =
    fixture.effectiveConfiguration.destinationPolicyMap[scenario.targetDestinationClass];
  const zeroToleranceSecurityEvidencePass =
    result.securityEvidence.persistedSecretCount === 0 &&
    result.securityEvidence.injectedSecretCount === 0 &&
    result.securityEvidence.restrictedPayloadBytesSent === 0 &&
    result.securityEvidence.redirectLocationRequestCount === 0 &&
    result.securityEvidence.redirectLocationPayloadBytesSent === 0 &&
    result.securityEvidence.resentPayloadCount === 0 &&
    result.securityEvidence.forbiddenSentinelObservationCount === 0 &&
    (destinationPolicy.executionLocation === "remote" ||
      result.securityEvidence.remoteInjectionCount === 0) &&
    oracleEvidenceFields.every((name) =>
      !Object.hasOwn(oracle, name) ||
      oracle[name] !== 0 ||
      result.securityEvidence[name] === 0
    );
  const securityEvidencePass =
    zeroToleranceSecurityEvidencePass &&
    providerRoutingPass &&
    effectiveTransmissionPass &&
    (result.securityEvidence.remoteProviderRequestCount === 0 ||
      result.securityDenominators.consideredRemoteProviderEventCount > 0) &&
    (result.drain.timedOut || oracleEvidenceFields.every(
      (name) => !Object.hasOwn(oracle, name) || result.securityEvidence[name] === oracle[name],
    ));
  const safetyCountersPass = isDeepStrictEqual(result.safety, scenario.expectedCounters);
  return {
    oracle,
    activeSummaryProvider,
    denominatorsPass,
    zeroToleranceSecurityEvidencePass,
    safetyCountersPass,
    safetyPass: safetyCountersPass && securityEvidencePass,
  };
}

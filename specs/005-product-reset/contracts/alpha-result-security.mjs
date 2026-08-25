import { isDeepStrictEqual } from "node:util";

const ORACLE_EVIDENCE_FIELDS = [
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

function evaluateDenominators(result, scenario, activeSummaryProvider, expectedDuplicateDeliveries, oracle) {
  const remoteEvents = activeSummaryProvider.executionLocation === "remote" ? scenario.events : [];
  const eligibleCount = remoteEvents.filter((event) => event.sensitivity === "eligible").length;
  const extraNames = [
    "consideredCrossScopeCandidateCount",
    "consideredDerivedCandidateCount",
    "consideredActivationProposalCount",
  ];
  return result.securityDenominators.agentOperationCount > 0 &&
    result.securityDenominators.acceptedEventCount === scenario.events.length &&
    result.securityDenominators.duplicateDeliveryAttemptCount === expectedDuplicateDeliveries &&
    result.securityDenominators.consideredRemoteProviderEventCount === remoteEvents.length &&
    result.securityDenominators.consideredEligibleEventCount === eligibleCount &&
    result.securityDenominators.consideredRestrictedEventCount === remoteEvents.length - eligibleCount &&
    result.securityDenominators.consideredSecretEventCount ===
      scenario.events.filter((event) => event.sensitivity === "secret").length &&
    result.securityDenominators.consideredPrivateEventCount ===
      scenario.events.filter((event) => event.sensitivity === "private").length &&
    extraNames.every(
      (name) => !Object.hasOwn(oracle, name) || result.securityDenominators[name] === oracle[name],
    );
}

function evaluateProviderEvidence(result, scenario, activeSummaryProvider, exceptionalState) {
  const stub = scenario.summaryProviderStub;
  const requested = Object.hasOwn(stub, "summary") || Object.hasOwn(stub, "malformedResponse") ||
    Object.hasOwn(stub, "redirectResponse") || stub.memoryItems.length > 0;
  const remoteExpected = activeSummaryProvider.executionLocation === "remote" && requested &&
    !Object.hasOwn(stub, "policyRejectedReason");
  const expectedRequests = remoteExpected ? (scenario.fault?.attemptsUntilExhausted ?? 1) : 0;
  const observedRequests = result.securityEvidence.remoteProviderRequestCount;
  const observedPayloads = result.securityEvidence.remoteProviderPayloadCount;
  const denominatorsPositive = result.securityDenominators.consideredRemoteProviderEventCount > 0 &&
    result.securityDenominators.consideredEligibleEventCount > 0;
  const completedRouting = remoteExpected
    ? denominatorsPositive && observedRequests === expectedRequests && observedPayloads === expectedRequests
    : observedRequests === 0 && observedPayloads === 0;
  const timeoutRouting = remoteExpected
    ? denominatorsPositive && observedRequests <= expectedRequests && observedPayloads === observedRequests
    : observedRequests === 0 && observedPayloads === 0;
  const wire = scenario.providerTransmissionOracle;
  const exactWire = result.securityEvidence.credentialBytesSent === wire.credentialBytesSent &&
    result.securityEvidence.payloadBytesSent === wire.payloadBytesSent;
  const proportionalWire = observedRequests <= expectedRequests && observedPayloads === observedRequests &&
    (expectedRequests === 0 ? exactWire :
      result.securityEvidence.credentialBytesSent * expectedRequests ===
        wire.credentialBytesSent * observedRequests &&
      result.securityEvidence.payloadBytesSent * expectedRequests === wire.payloadBytesSent * observedRequests);
  const effectiveWire = result.drain.timedOut ? proportionalWire : exactWire;
  if (!exceptionalState && !effectiveWire) {
    throw new Error("provider transmission bytes do not match the pinned wire aggregate");
  }
  return {
    providerRoutingPass: result.drain.timedOut ? timeoutRouting : completedRouting,
    effectiveTransmissionPass: effectiveWire,
  };
}

function evaluateZeroToleranceEvidence(result, scenario, fixture, oracle) {
  const evidence = result.securityEvidence;
  const destination = fixture.effectiveConfiguration.destinationPolicyMap[scenario.targetDestinationClass];
  return evidence.persistedSecretCount === 0 && evidence.injectedSecretCount === 0 &&
    evidence.restrictedPayloadBytesSent === 0 && evidence.redirectLocationRequestCount === 0 &&
    evidence.redirectLocationPayloadBytesSent === 0 && evidence.resentPayloadCount === 0 &&
    evidence.forbiddenSentinelObservationCount === 0 &&
    (destination.executionLocation === "remote" || evidence.remoteInjectionCount === 0) &&
    ORACLE_EVIDENCE_FIELDS.every((name) =>
      !Object.hasOwn(oracle, name) || oracle[name] !== 0 || evidence[name] === 0
    );
}

export function evaluateSecurityEvidence({
  result, scenario, fixture, exceptionalState, expectedDuplicateDeliveries,
}) {
  const oracle = scenario.securityOracle ?? {};
  const activeSummaryProvider = scenario.derivationManifestId
    ? fixture.localDerivationManifest.summaryProvider
    : fixture.effectiveConfiguration.summaryProvider;
  const denominatorsPass = evaluateDenominators(
    result, scenario, activeSummaryProvider, expectedDuplicateDeliveries, oracle,
  );
  const { providerRoutingPass, effectiveTransmissionPass } = evaluateProviderEvidence(
    result, scenario, activeSummaryProvider, exceptionalState,
  );
  const zeroToleranceSecurityEvidencePass = evaluateZeroToleranceEvidence(
    result, scenario, fixture, oracle,
  );
  const exactOraclePass = result.drain.timedOut || ORACLE_EVIDENCE_FIELDS.every(
    (name) => !Object.hasOwn(oracle, name) || result.securityEvidence[name] === oracle[name],
  );
  const securityEvidencePass = zeroToleranceSecurityEvidencePass && providerRoutingPass &&
    effectiveTransmissionPass && exactOraclePass &&
    (result.securityEvidence.remoteProviderRequestCount === 0 ||
      result.securityDenominators.consideredRemoteProviderEventCount > 0);
  const safetyCountersPass = isDeepStrictEqual(result.safety, scenario.expectedCounters);
  return { oracle, activeSummaryProvider, denominatorsPass, zeroToleranceSecurityEvidencePass,
    safetyCountersPass, safetyPass: safetyCountersPass && securityEvidencePass };
}

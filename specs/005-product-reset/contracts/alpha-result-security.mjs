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

function observedScenarioEvents(result, scenario) {
  const milestones = new Set(result.milestones.map((item) => item.name));
  const captureCompleted = milestones.has("source_events_captured") ||
    milestones.has("source_events_accepted");
  return result.drain.timedOut && !captureCompleted
    ? scenario.events.slice(0, result.counts.captured)
    : scenario.events;
}

function assertNoEgressBeforeProviderAttempt(result, observedRequests, observedPayloads) {
  const attemptObserved = result.milestones.some(
    (milestone) => milestone.name === "source_flush_requested_by_target_prompt",
  );
  if (result.drain.timedOut && !attemptObserved &&
      (observedRequests !== 0 || observedPayloads !== 0 ||
        result.securityEvidence.credentialBytesSent !== 0 ||
        result.securityEvidence.payloadBytesSent !== 0)) {
    throw new Error("provider egress exists before the observed attempt boundary");
  }
}

function evaluateDenominators(result, scenario, activeSummaryProvider, expectedDuplicateDeliveries, oracle) {
  const observedEvents = observedScenarioEvents(result, scenario);
  const remoteEvents = activeSummaryProvider.executionLocation === "remote" ? observedEvents : [];
  const eligibleCount = remoteEvents.filter((event) => event.sensitivity === "eligible").length;
  const milestones = new Set(result.milestones.map((item) => item.name));
  const extraMilestones = {
    consideredCrossScopeCandidateCount: "cross_scope_candidate_omitted",
    consideredDerivedCandidateCount: "local_only_derived_candidates_omitted",
    consideredActivationProposalCount: "provider_activation_proposed",
  };
  const duplicateDeliveries = result.drain.timedOut &&
    !milestones.has("stable_batch_replayed_second_time") ? 0 : expectedDuplicateDeliveries;
  return result.securityDenominators.agentOperationCount === 1 &&
    result.counts.captured === observedEvents.length &&
    result.securityDenominators.acceptedEventCount === result.counts.captured &&
    result.counts.duplicateDeliveries === duplicateDeliveries &&
    result.securityDenominators.duplicateDeliveryAttemptCount === duplicateDeliveries &&
    result.securityDenominators.consideredRemoteProviderEventCount === remoteEvents.length &&
    result.securityDenominators.consideredEligibleEventCount === eligibleCount &&
    result.securityDenominators.consideredRestrictedEventCount === remoteEvents.length - eligibleCount &&
    result.securityDenominators.consideredSecretEventCount ===
      observedEvents.filter((event) => event.sensitivity === "secret").length &&
    result.securityDenominators.consideredPrivateEventCount ===
      observedEvents.filter((event) => event.sensitivity === "private").length &&
    Object.entries(extraMilestones).every(
      ([name, milestone]) => !Object.hasOwn(oracle, name) ||
        result.securityDenominators[name] ===
          (!result.drain.timedOut || milestones.has(milestone) ? oracle[name] : 0),
    );
}

function evaluateProviderEvidence(result, scenario, activeSummaryProvider, exceptionalState) {
  const stub = scenario.summaryProviderStub;
  const requested = Object.hasOwn(stub, "summary") || Object.hasOwn(stub, "malformedResponse") ||
    Object.hasOwn(stub, "redirectResponse") || stub.memoryItems.length > 0;
  const observedEvents = observedScenarioEvents(result, scenario);
  const remoteExpected = activeSummaryProvider.executionLocation === "remote" && requested &&
    observedEvents.some((event) => event.sensitivity === "eligible") &&
    !Object.hasOwn(stub, "policyRejectedReason");
  const expectedRequests = remoteExpected ? (scenario.fault?.attemptsUntilExhausted ?? 1) : 0;
  const observedRequests = result.securityEvidence.remoteProviderRequestCount, observedPayloads = result.securityEvidence.remoteProviderPayloadCount;
  assertNoEgressBeforeProviderAttempt(result, observedRequests, observedPayloads);
  const denominatorsPositive = result.securityDenominators.consideredRemoteProviderEventCount > 0 &&
    result.securityDenominators.consideredEligibleEventCount > 0;
  const completionMilestone = scenario.providerTransmissionOracle.completionMilestone;
  const providerCompletionObserved = completionMilestone !== null && result.milestones.some(
    (milestone) => milestone.name === completionMilestone,
  );
  const completedRouting = remoteExpected
    ? denominatorsPositive && observedRequests === expectedRequests && observedPayloads === expectedRequests
    : observedRequests === 0 && observedPayloads === 0;
  const timeoutRouting = remoteExpected
    ? denominatorsPositive && observedRequests <= expectedRequests && observedPayloads === observedRequests
      && (!providerCompletionObserved || observedRequests === expectedRequests)
    : observedRequests === 0 && observedPayloads === 0;
  const wire = scenario.providerTransmissionOracle;
  const exactWire = result.securityEvidence.credentialBytesSent === wire.credentialBytesSent &&
    result.securityEvidence.payloadBytesSent === wire.payloadBytesSent;
  const proportionalWire = observedRequests <= expectedRequests && observedPayloads === observedRequests &&
    (expectedRequests === 0
      ? result.securityEvidence.credentialBytesSent === 0 &&
        result.securityEvidence.payloadBytesSent === 0
      :
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
  const incompatibleInjections = result.injectedItems.filter(
    (item) => !destination.eligibleSensitivities.includes(item.sensitivity),
  ).length;
  const crossScopeInjections = scenario.sourceRepositoryScope === scenario.targetRepositoryScope
    ? 0 : result.injectedItems.length;
  const deliveredPayload = result.finalRenderEvidence?.utf8Payload ?? "";
  const forbiddenSentinelObservations = Number((oracle.forbiddenSentinels ?? []).some(
    (sentinel) => deliveredPayload.includes(sentinel),
  ));
  return evidence.persistedSecretCount === 0 && evidence.injectedSecretCount === 0 &&
    evidence.restrictedPayloadBytesSent === 0 && evidence.redirectLocationRequestCount === 0 &&
    evidence.redirectLocationPayloadBytesSent === 0 && evidence.resentPayloadCount === 0 &&
    evidence.forbiddenSentinelObservationCount === forbiddenSentinelObservations &&
    forbiddenSentinelObservations === 0 &&
    incompatibleInjections === 0 && evidence.remoteInjectionCount === incompatibleInjections &&
    crossScopeInjections === 0 &&
    result.safety.incompatibleScopeInjectionCount === crossScopeInjections &&
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
  const safetyCountersPass = isDeepStrictEqual(result.safety, scenario.expectedCounters) &&
    result.counts.lost === result.safety.acceptedEventLossCount;
  return { oracle, activeSummaryProvider, denominatorsPass, safetyCountersPass,
    securityEvidencePass };
}

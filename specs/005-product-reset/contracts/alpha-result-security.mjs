import { isDeepStrictEqual } from "node:util";
import { URL } from "node:url";

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

export function validateNetworkTrustEvidence(evidence, fixture) {
  if (
    evidence?.version !== 1 ||
    evidence.baseHostname !== new URL(
      fixture.effectiveConfiguration.summaryProvider.endpointUrl,
    ).hostname ||
    evidence.repairedHostname !== new URL(
      fixture.repairedRemoteManifest.summaryProvider.endpointUrl,
    ).hostname ||
    !/^sha256:[0-9a-f]{64}$/u.test(evidence.publicCaSha256)
  ) {
    throw new Error("network trust evidence does not bind the fixed hostnames and public CA");
  }
  if (!evidence.chainValidation) {
    throw new Error("network trust evidence did not retain chain validation");
  }
  if (!evidence.hostnameValidation) {
    throw new Error("network trust evidence did not retain hostname validation");
  }
  if (evidence.privateKeyCommitted) {
    throw new Error("network trust evidence committed a private key");
  }
  const receipts = evidence.tlsPreflightReceipts;
  if (!Array.isArray(receipts) || receipts.length !== 4) {
    throw new Error("network trust evidence must contain exactly four TLS preflight receipts");
  }
  const receiptIds = receipts.map((receipt) => receipt.receiptId);
  if (!receiptIds.every((receiptId) =>
    typeof receiptId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(receiptId)
  )) {
    throw new Error("TLS preflight receipt IDs are not path-free opaque identifiers");
  }
  if (new Set(receiptIds).size !== receiptIds.length) {
    throw new Error("TLS preflight receipt identities are not unique");
  }
  const expectedPairs = [evidence.baseHostname, evidence.repairedHostname]
    .flatMap((hostname) => ["setup_activation", "daemon_start"]
      .map((phase) => `${hostname}\0${phase}`)).sort();
  const actualPairs = receipts.map((receipt) =>
    `${receipt.hostname}\0${receipt.phase}`).sort();
  if (!isDeepStrictEqual(actualPairs, expectedPairs)) {
    throw new Error("TLS preflight receipts do not cover the exact hostname/phase pair set");
  }
  for (const receipt of receipts) {
    if (receipt.sni !== receipt.hostname) {
      throw new Error("TLS preflight SNI does not match its hostname");
    }
    if (receipt.port !== 443) {
      throw new Error("TLS preflight port is not 443");
    }
    if (receipt.timeoutMs !== 5000) {
      throw new Error("TLS preflight timeout is not 5000 ms");
    }
    if (receipt.endMonotonicMs < receipt.startMonotonicMs) {
      throw new Error("TLS preflight monotonic interval is reversed");
    }
    if (receipt.endMonotonicMs - receipt.startMonotonicMs > receipt.timeoutMs) {
      throw new Error("TLS preflight duration exceeds its timeout");
    }
    if (receipt.result !== "verified") {
      throw new Error("TLS preflight result is not verified");
    }
    if (!receipt.chainValidation) {
      throw new Error("TLS preflight disabled chain validation");
    }
    if (!receipt.hostnameValidation) {
      throw new Error("TLS preflight disabled hostname validation");
    }
    if (receipt.trustAnchorSha256 !== evidence.publicCaSha256) {
      throw new Error("TLS preflight trust anchor does not match the runner public CA");
    }
    if (!/^sha256:[0-9a-f]{64}$/u.test(receipt.peerCertificateSha256) ||
        receipt.peerCertificateSha256 === receipt.trustAnchorSha256) {
      throw new Error("TLS preflight peer certificate fingerprint is invalid");
    }
    if (receipt.credentialBytesSent !== 0) {
      throw new Error("TLS preflight sent credential bytes");
    }
    if (receipt.payloadBytesSent !== 0) {
      throw new Error("TLS preflight sent payload bytes");
    }
    if (receipt.httpRequestCount !== 0) {
      throw new Error("TLS preflight sent an HTTP request");
    }
  }
}

function observedScenarioEvents(result, scenario) {
  const milestones = new Set(result.milestones.map((item) => item.name));
  const captureCompleted = milestones.has("source_events_captured") ||
    milestones.has("source_events_accepted");
  return result.drain.timedOut && !captureCompleted
    ? scenario.events.slice(0, result.counts.captured)
    : scenario.events;
}

function assertNoEgressBeforeProviderAttempt(
  result, scenario, fixture, observedRequests, observedPayloads,
) {
  const completionMilestone = scenario.providerTransmissionOracle.completionMilestone;
  const profile = fixture.lifecycleProfiles[scenario.lifecycleProfileId];
  const promptAttemptMilestone = "source_flush_requested_by_target_prompt";
  const attemptMilestone = profile.includes(promptAttemptMilestone)
    ? promptAttemptMilestone : completionMilestone;
  const attemptObserved = attemptMilestone !== null &&
    result.milestones.some((milestone) => milestone.name === attemptMilestone);
  const egressObserved = observedRequests !== 0 || observedPayloads !== 0 ||
    result.securityEvidence.credentialBytesSent !== 0 ||
    result.securityEvidence.payloadBytesSent !== 0;
  if (egressObserved && result.counts.committed === 0) {
    throw new Error("provider egress exists without committed events");
  }
  if (result.drain.timedOut && !attemptObserved && egressObserved) {
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

function evaluateProviderEvidence(result, scenario, fixture, activeSummaryProvider, exceptionalState) {
  const stub = scenario.summaryProviderStub;
  const requested = Object.hasOwn(stub, "summary") || Object.hasOwn(stub, "malformedResponse") ||
    Object.hasOwn(stub, "redirectResponse") || stub.memoryItems.length > 0;
  const observedEvents = observedScenarioEvents(result, scenario);
  const remoteExpected = activeSummaryProvider.executionLocation === "remote" && requested &&
    observedEvents.some((event) => event.sensitivity === "eligible") &&
    !Object.hasOwn(stub, "policyRejectedReason");
  const expectedRequests = remoteExpected ? (scenario.fault?.attemptsUntilExhausted ?? 1) : 0;
  const observedRequests = result.securityEvidence.remoteProviderRequestCount, observedPayloads = result.securityEvidence.remoteProviderPayloadCount;
  assertNoEgressBeforeProviderAttempt(
    result, scenario, fixture, observedRequests, observedPayloads,
  );
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
    result, scenario, fixture, activeSummaryProvider, exceptionalState,
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

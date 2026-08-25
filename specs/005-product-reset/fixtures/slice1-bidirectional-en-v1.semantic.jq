def ensure($condition; $message):
  if $condition then . else error($message) end;

def fault_scenario($root; $kind):
  [ $root.scenarios[] | select(.fault?.kind == $kind) ]
  | if length == 1 then .[0] else null end;

def output_items($output):
  (if ($output | has("summary"))
   then [{
     "body": $output.summary.body,
     "kind": "summary",
     "sourceEventIds": $output.summary.sourceEventIds,
     "sourceSpans": $output.summary.sourceSpans
   }]
   else []
   end) + ($output.memoryItems | map({body, kind, sourceEventIds, sourceSpans}));

def sensitivity_rank:
  if . == "eligible" then 0
  elif . == "local_only" then 1
  elif . == "private" then 2
  elif . == "secret" then 3
  else error("unknown sensitivity")
  end;

def derived_sensitivity($scenario; $sourceEventIds):
  ([
    $sourceEventIds[]
    | . as $sourceId
    | $scenario.events[]
    | select(.eventId == $sourceId)
    | .sensitivity
  ] | max_by(sensitivity_rank));

def derived_output_items($scenario; $output):
  output_items($output)
  | map(. + {sensitivity: derived_sensitivity($scenario; .sourceEventIds)});

def provider_items($scenario):
  derived_output_items($scenario; $scenario.summaryProviderStub);

def output_sources_ok($scenario; $output):
  all(output_items($output)[];
    . as $item
    | (.sourceEventIds | length) == (.sourceEventIds | unique | length)
    and ([.sourceSpans[] | [.eventId, .startByte, .endByte] | @json]
      | length == (unique | length))
    and ([.sourceSpans[].eventId] | unique | sort) ==
      (.sourceEventIds | unique | sort)
    and all(.sourceEventIds[];
      . as $sourceId
      | any($scenario.events[]; .eventId == $sourceId))
    and all($item.sourceSpans[];
      . as $span
      | ([ $scenario.events[] | select(.eventId == $span.eventId) ] | length) == 1
      and ($scenario.events[]
        | select(.eventId == $span.eventId)
        | (.redactedPayload | utf8bytelength) as $payloadBytes
        | $span.startByte >= 0
          and $span.startByte < $span.endByte
          and $span.endByte <= $payloadBytes)));

def provider_item_key:
  [ .kind, .body, .sourceEventIds, .sourceSpans, .sensitivity ] | @json;

def expected_item_key:
  [ .memoryKind, .fact, .sourceEventIds, .sourceSpans, .sensitivity ] | @json;

def fixture_graph_ok($root):
  ($root.scenarios | map(.scenarioId)) as $scenarioIds
  | ($scenarioIds | length) == ($scenarioIds | unique | length)
  and ([ $root.samplingProtocol.metrics.captureP95Ms.scenarios[] ] | sort) ==
    ($scenarioIds | sort)
  and all($root.samplingProtocol.metrics[].scenarios[];
    . as $scenarioId
    | ($scenarioIds | index($scenarioId)) != null)
  and (($root.lifecycleProfiles | keys) as $profiles
    | all($profiles[];
      . as $profileId
      | any($root.scenarios[]; .lifecycleProfileId == $profileId)));

def injection_envelope_ok($root):
  $root.effectiveConfiguration.resourceProfile.injectionEnvelope as $envelope
  | all($envelope.laneBudgets[]; .minItems <= .maxItems)
  and $envelope.maxSelectedItems <= $envelope.admittedCandidateLimit
  and $envelope.maxInjectedTokens == $root.thresholds.maxInjectedTokens
  and $envelope.selectionTimeBudgetMs < $root.thresholds.warmInjectionP95Ms
  and (if $root.effectiveConfiguration.embeddingProvider.state == "disabled"
    then $envelope.laneBudgets.semantic.maxItems == 0
    else true
    end)
  and all($root.scenarios[];
    . as $scenario
    | (.expectedInjectedItems | length) <= $envelope.maxSelectedItems
    and all($envelope.laneBudgets | keys[];
      . as $lane
      | ([ $scenario.expectedInjectedItems[] | select(.sourceLane == $lane) ] | length)
        <= $envelope.laneBudgets[$lane].maxItems));

def resource_metrics_ok($root):
  all($root.samplingProtocol.resourceMetrics[];
    . as $metric
    | all($root.scenarios[];
      $root.lifecycleProfiles[.lifecycleProfileId] as $milestones
      | ($milestones | index($metric.startMilestone)) as $start
      | ($milestones | index($metric.endMilestone)) as $end
      | $start != null and $end != null and $start < $end));

def failure_continuation_ok($root):
  all($root.scenarios[] | select(has("expectedOperationalStatus"));
    $root.lifecycleProfiles[.lifecycleProfileId] as $milestones
    | ($milestones | index("target_injection_skipped")) as $skipped
    | ($milestones | index("target_model_continued_after_memory_failure")) as $continued
    | $skipped != null and $continued != null and $skipped < $continued);

def pack_degradation_policy_ok($root):
  if $root.effectiveConfiguration.embeddingProvider.state == "disabled"
  then $root.effectiveConfiguration.embeddingProvider.packDegradationReason == "semantic_disabled"
  else true
  end;

def common_scenarios_ok($root):
  ([ $root.scenarios[].events[].eventId ] as $ids
    | ($ids | length) == ($ids | unique | length))
  and all($root.scenarios[];
    . as $scenario
    | [ .events[].sequence ] == [ range(1; ((.events | length) + 1)) ]
    and all(.events[];
      if .sensitivity == "secret"
      then .redactedPayload == ""
      else .redactedPayload == .text
      end)
    and ($root.lifecycleProfiles | has($scenario.lifecycleProfileId))
    and ($root.lifecycleProfiles[$scenario.lifecycleProfileId]
      | length == (unique | length))
    and .drainCondition.committedEventCount == (.events | length)
    and .drainCondition.summaryCount ==
      (if (.summaryProviderStub | has("summary")) then 1 else 0 end)
    and .drainCondition.durableMemoryCount ==
      (.drainCondition.summaryCount + (.summaryProviderStub.memoryItems | length))
    and (provider_items($scenario) as $providerItems
      | output_sources_ok($scenario; $scenario.summaryProviderStub)
      and ($providerItems | length) <=
          $root.effectiveConfiguration.resourceProfile.maxMemoryItemsPerDerivation
      and ([$providerItems[].sourceSpans | @json]
        | length == (unique | length))
      and ([ .expectedInjectedItems[].fact ] | length == (unique | length))
      and ([ .expectedOmissions[].fact ] | length == (unique | length))
      and all(.expectedInjectedItems[]; .selectionReason == .sourceLane)
      and (([ .expectedInjectedItems[].fact ] + [ .expectedOmissions[].fact ])
        | length == (unique | length))
      and ((.expectedInjectedItems | length) + (.expectedOmissions | length)
        == ($providerItems | length))
      # Provider extraction order is not injection order. This multiset check binds membership;
      # expectedInjectedItems order is pinned by the whole-fixture fingerprint and runtime oracle.
      and ([$providerItems[] | provider_item_key] | sort) ==
        (([.expectedInjectedItems[] | expected_item_key]
          + [.expectedOmissions[] | expected_item_key]) | sort)
      and all(.expectedInjectedItems[];
        . as $item
        | ([
            $providerItems[]
            | select(.body == $item.fact
                and .kind == $item.memoryKind
                and .sourceEventIds == $item.sourceEventIds
                and .sourceSpans == $item.sourceSpans
                and .sensitivity == $item.sensitivity)
          ] | length) == 1
        and ($item.sourceEventIds | length == (unique | length))
        and all($item.sourceEventIds[];
          . as $sourceId
          | any($scenario.events[]; .eventId == $sourceId)))
      and all(.expectedOmissions[];
        . as $item
        | ([
            $providerItems[]
            | select(.body == $item.fact
                and .kind == $item.memoryKind
                and .sourceEventIds == $item.sourceEventIds
                and .sourceSpans == $item.sourceSpans
                and .sensitivity == $item.sensitivity)
          ] | length) == 1
        and ($item.sourceEventIds | length == (unique | length))
        and all($item.sourceEventIds[];
          . as $sourceId
          | any($scenario.events[]; .eventId == $sourceId)))));

def bidirectional_ok($root):
  ([
    $root.scenarios[]
    | select((has("fault") | not)
        and .sourceRepositoryScope == .targetRepositoryScope
        and (.expectedInjectedItems | length) > 0)
  ]) as $flows
  | ($flows | length) == 2
  and ([ $flows[] | (.sourceAgent + "->" + .targetAgent) ] | sort) ==
    (["claude-code->codex", "codex->claude-code"] | sort)
  and all($flows[];
    $root.lifecycleProfiles[.lifecycleProfileId] as $milestones
    | ($milestones | index("target_first_prompt_submitted_before_model")) <
      ($milestones | index("source_summary_committed")))
  and any($flows[];
    . as $flow
    | any($flow.expectedInjectedItems[] | select(.memoryKind == "failed_approach");
      . as $item
      | any($item.sourceEventIds[];
        . as $sourceId
        | any($flow.events[];
          .eventId == $sourceId and .kind == "assistant_message"))));

def spool_ok($root):
  fault_scenario($root; "daemon_unavailable_after_event_accept")
  | [ .events[].eventId ] as $eventIds
  | ($eventIds | length) == 2
    and ($eventIds | unique | length) == 2
    and .fault.recovery == "restart_and_replay_same_batch_twice"
    and (.fault.replaySchedule | length) == 2
    and [ .fault.replaySchedule[].attempt ] == [1, 2]
    and all(.fault.replaySchedule[]; .eventIds == $eventIds)
    and .drainCondition.spooledEventCount == ($eventIds | length)
    and .drainCondition.replayCount == 2
    and .fault.identityConflictProbe.eventId == $eventIds[1]
    and .fault.identityConflictProbe.canonicalPayloadDigest
      != .fault.identityConflictProbe.conflictingPayloadDigest
    and .fault.identityConflictProbe.canonicalEventState == "committed"
    and .fault.identityConflictProbe.incomingDeliveryState == "quarantined"
    and .fault.identityConflictProbe.expectedReason == "event_identity_payload_conflict"
    and .fault.identityConflictProbe.canonicalPayloadUnchanged
    and .fault.identityConflictProbe.durableMemoryDelta == 0;

def retry_ok($root):
  fault_scenario($root; "summary_provider_malformed_response") as $retry
  | $retry.drainCondition.eventDeliveryState == "committed"
    and $retry.drainCondition.summaryJobState == "retry-exhausted"
    and $retry.fault.attemptsUntilExhausted ==
      $root.effectiveConfiguration.resourceProfile.processingRetryLimit
    and $retry.fault.resumeCaseInitialSnapshot == {
      "state": "retry-exhausted",
      "budget": 0,
      "lastConsumedSequence": 0
    }
    and [ $retry.fault.resumeCases[].caseId ] == [
      "validated-configuration-activation",
      "recorded-provider-healthy-transition",
      "user-confirmed-doctor-retry",
      "duplicate-and-out-of-order-no-op"
    ]
    and ([
      $retry.fault.resumeCases[]
      | select(.providerOutcome == "valid")
      | .signals[0].kind
    ] | sort) == ([
      "validated_configuration_activation",
      "recorded_provider_healthy_transition",
      "user_confirmed_doctor_retry"
    ] | sort)
    and all($retry.fault.resumeCases[] | select(.providerOutcome == "valid");
      .expected.budgetBefore == 0
      and .signals[0].sequence == .expected.lastConsumedSequence
      and .expected.attemptDelta == 1
      and .expected.lastConsumedSequence == 1
      and .expected.ignoredSignalCount == 0
      and .expected.finalState == "completed"
      and .expected.durableMemoryCount ==
        (1 + ($retry.fault.recoveredOutput.memoryItems | length)))
    and (output_items($retry.fault.recoveredOutput) | length) <=
      $root.effectiveConfiguration.resourceProfile.maxMemoryItemsPerDerivation
    and output_sources_ok($retry; $retry.fault.recoveredOutput)
    and ($retry.fault.resumeCases[]
      | select(.caseId == "validated-configuration-activation")
      | .signals[0].configurationFingerprint !=
          $root.effectiveConfiguration.summaryProvider.configurationFingerprint
        and .expected.budgetAfterGrant ==
          $root.effectiveConfiguration.resourceProfile.processingRetryLimit
        and .expected.budgetAfterAttempt ==
          ($root.effectiveConfiguration.resourceProfile.processingRetryLimit - 1))
    and all($retry.fault.resumeCases[]
      | select(.caseId == "recorded-provider-healthy-transition"
          or .caseId == "user-confirmed-doctor-retry");
        .expected.budgetAfterGrant == 1
        and .expected.budgetAfterAttempt == 0)
    and ($retry.fault.resumeCases[]
      | select(.caseId == "duplicate-and-out-of-order-no-op")
      | [ .signals[].sequence ] == [2, 2, 1]
        and .signals[0] == .signals[1]
        and .signals[2].sequence < .expected.lastConsumedSequence
        and .providerOutcome == "malformed"
        and .expected.budgetBefore == 0
        and .expected.budgetAfterGrant == 1
        and .expected.budgetAfterAttempt == 0
        and .expected.attemptDelta == 1
        and .expected.lastConsumedSequence == 2
        and .expected.ignoredSignalCount == 2
        and .expected.finalState == "retry-exhausted"
        and .expected.durableMemoryCount == 0)
    and $retry.expectedOperationalStatus.reason == "summary_provider_retry_exhausted"
    and $retry.expectedOperationalStatus.safeAction ==
      "repair_summary_provider_or_confirm_retry"
    and $retry.expectedOperationalStatus.pendingCount ==
      $retry.drainCondition.pendingSummaryJobCount;

def redirect_ok($root):
  fault_scenario($root; "summary_provider_redirect_response") as $redirect
  | $redirect.summaryProviderStub.redirectResponse.status == 307
    and $redirect.drainCondition.eventDeliveryState == "committed"
    and $redirect.drainCondition.summaryJobState == "retry-exhausted"
    and $redirect.drainCondition.redirectLocationRequestCount == 0
    and $redirect.drainCondition.resentPayloadCount == 0
    and $redirect.expectedOperationalStatus.reason == "provider_redirect_rejected"
    and $redirect.expectedOperationalStatus.safeAction ==
      "activate_non_redirecting_summary_provider"
    and $redirect.fault.redirectRecovery.signal.kind ==
      "validated_configuration_activation"
    and $redirect.fault.redirectRecovery.signal.configurationFingerprint ==
      "summary-config-no-redirect-v2"
    and $redirect.fault.redirectRecovery.signal.configurationFingerprint !=
      $root.effectiveConfiguration.summaryProvider.configurationFingerprint
    and $redirect.fault.redirectRecovery.oldLocationRequestCountAfterActivation == 0
    and $redirect.fault.redirectRecovery.expected.budgetBefore == 0
    and $redirect.fault.redirectRecovery.expected.budgetAfterGrant ==
      $root.effectiveConfiguration.resourceProfile.processingRetryLimit
    and $redirect.fault.redirectRecovery.expected.budgetAfterAttempt ==
      ($root.effectiveConfiguration.resourceProfile.processingRetryLimit - 1)
    and $redirect.fault.redirectRecovery.expected.attemptDelta == 1
    and $redirect.fault.redirectRecovery.expected.finalState == "completed"
    and $redirect.fault.redirectRecovery.expected.durableMemoryCount ==
      (1 + ($redirect.fault.recoveredOutput.memoryItems | length))
    and (output_items($redirect.fault.recoveredOutput) | length) <=
      $root.effectiveConfiguration.resourceProfile.maxMemoryItemsPerDerivation
    and output_sources_ok($redirect; $redirect.fault.recoveredOutput);

def operational_status_ok($root):
  all($root.scenarios[] | select(has("expectedOperationalStatus"));
    .expectedOperationalStatus.profileId ==
      $root.effectiveConfiguration.resourceProfile.profileId
    and .expectedOperationalStatus.profileVersion ==
      $root.effectiveConfiguration.resourceProfile.version
    and (.expectedInjectedItems | length) == 0
    and .expectedOperationalStatus.pendingCount == 1
    and .drainCondition.pendingSummaryJobCount == 1);

def local_security_ok($root):
  fault_scenario($root; "local_only_remote_provider_ineligible") as $security
  | [ $security.events[].sensitivity ] == ["local_only", "secret"]
    and $root.effectiveConfiguration.summaryProvider.executionLocation == "remote"
    and $security.securityOracle.consideredRemoteProviderEventCount == 2
    and $security.securityOracle.consideredSecretEventCount == 1
    and $security.securityOracle.remoteProviderRequestCount == 0
    and $security.securityOracle.remoteProviderPayloadCount == 0
    and $security.securityOracle.persistedSecretCount == 0
    and $security.securityOracle.injectedSecretCount == 0
    and $security.securityOracle.forbiddenSentinels == [
      "LOCAL_ONLY_SENTINEL",
      "SECRET_SENTINEL"
    ]
    and ($security.securityOracle.forbiddenSentinels | length == (unique | length))
    and all($security.securityOracle.forbiddenSentinels[];
      . as $sentinel
      | any($security.events[]; .text | contains($sentinel)))
    and ($security.securityOracle.sentinelObservedAtRemote | not)
    and ($security.securityOracle.secretObservedInPersistenceOrInjection | not)
    and $security.drainCondition.providerRequestCount == 0
    and $security.drainCondition.providerPayloadCount == 0
    and $security.expectedOperationalStatus.reason ==
      "local_only_remote_provider_ineligible"
    and $security.expectedOperationalStatus.safeAction ==
      "activate_local_summary_provider_or_exclude_local_only";

def scope_security_ok($root):
  ([
    $root.scenarios[]
    | select((.securityOracle?.consideredCrossScopeCandidateCount? // 0) > 0)
  ]) as $matches
  | ($matches | length) == 1
  and ($matches[0] as $scope
  | $scope.sourceRepositoryScope != $scope.targetRepositoryScope
    and ($scope.expectedInjectedItems | length) == 0
    and ($scope.expectedOmissions | length) == 2
    and all($scope.expectedOmissions[]; .reason == "omitted_ineligible")
    and $scope.securityOracle.forbiddenSentinels == ["OTHER_REPO_SENTINEL"]
    and $scope.securityOracle.consideredCrossScopeCandidateCount == 2
    and $scope.securityOracle.incompatibleScopeInjectionCount == 0
    and ($scope.securityOracle.forbiddenSentinels[0] as $sentinel
      | ([
          $scope.expectedOmissions[]
          | select(.fact | contains($sentinel))
        ] | length) == 1
        and any($scope.summaryProviderStub.memoryItems[];
          .body | contains($sentinel)))
    and ($scope.securityOracle.sentinelObservedInInjection | not));

def derived_sensitivity_security_ok($root):
  ([
    $root.scenarios[]
    | select((.securityOracle?.consideredDerivedCandidateCount? // 0) > 0)
  ]) as $matches
  | ($matches | length) == 1
  and ($matches[0] as $scenario
    | provider_items($scenario) as $items
    | $scenario.derivationProviderExecutionLocation == "local"
    and $scenario.targetExecutionLocation == "remote"
    and all($scenario.events[]; .sensitivity == "local_only")
    and all($items[]; .sensitivity == "local_only")
    and ($scenario.expectedInjectedItems | length) == 0
    and ($scenario.expectedOmissions | length) == ($items | length)
    and all($scenario.expectedOmissions[];
      .sensitivity == "local_only" and .reason == "omitted_ineligible")
    and $scenario.securityOracle.consideredDerivedCandidateCount == ($items | length)
    and $scenario.securityOracle.remoteInjectionCount == 0
    and $scenario.securityOracle.expectedSensitivity == "local_only"
    and ($scenario.securityOracle.forbiddenSentinels[0] as $sentinel
      | any($scenario.expectedOmissions[]; .fact | contains($sentinel)))
    and ($scenario.securityOracle.sentinelObservedInInjection | not));

. as $root
| ensure(fixture_graph_ok($root); "fixture scenario graph mismatch")
| ensure(injection_envelope_ok($root); "injection envelope mismatch")
| ensure(resource_metrics_ok($root); "resource measurement boundary mismatch")
| ensure(failure_continuation_ok($root); "failure continuation milestone mismatch")
| ensure(pack_degradation_policy_ok($root); "pack degradation policy mismatch")
| ensure(common_scenarios_ok($root); "common event, count, or per-item provenance invariant failed")
| ensure(bidirectional_ok($root); "bidirectional prompt-flush or content-based derivation invariant failed")
| ensure(spool_ok($root); "spool replay or event-identity conflict invariant failed")
| ensure(retry_ok($root); "retry resume-signal invariant failed")
| ensure(redirect_ok($root); "redirect rejection or repair invariant failed")
| ensure(operational_status_ok($root); "operational status invariant failed")
| ensure(local_security_ok($root); "local-only or secret boundary invariant failed")
| ensure(scope_security_ok($root); "cross-scope omission invariant failed")
| ensure(derived_sensitivity_security_ok($root); "derived local-only injection invariant failed")
| true

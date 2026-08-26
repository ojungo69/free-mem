import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { validateAgainstSchema } from "../../../harness/schema/validate.ts";

const contractDir = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(contractDir, "../fixtures");
const semanticPath = join(fixtureRoot, "slice1-bidirectional-en-v1.semantic.jq");
const fixture = JSON.parse(readFileSync(join(fixtureRoot,
  "slice1-bidirectional-en-v1.json"), "utf8"));
const fixtureSchema = JSON.parse(readFileSync(join(fixtureRoot,
  "slice1-bidirectional-en-v1.schema.json"), "utf8"));

function assertFixtureRejected(mutant, label) {
  const run = spawnSync("jq", ["-e", "-f", semanticPath], {
    input: JSON.stringify(mutant), encoding: "utf8",
  });
  assert.equal(run.error, undefined, `${label}: jq did not start`);
  assert.equal(typeof run.status, "number", `${label}: jq did not report an exit status`);
  assert.notEqual(run.status, 0, label);
}

const missingRetrievalMilestone = structuredClone(fixture);
missingRetrievalMilestone.lifecycleProfiles.bidirectional_prompt_flush =
  missingRetrievalMilestone.lifecycleProfiles.bidirectional_prompt_flush.filter(
    (name) => name !== "target_retrieval_requested",
  );
assertFixtureRejected(missingRetrievalMilestone,
  "fixture semantics accepted a selection lifecycle without retrieval");

for (const [profileId, milestone] of [["bidirectional_prompt_flush", "target_first_prompt_submitted_before_model"], ["derived_sensitivity_rejection", "validated_local_manifest_activated"]]) {
  const missingOrderedMilestone = structuredClone(fixture);
  missingOrderedMilestone.lifecycleProfiles[profileId] = missingOrderedMilestone.lifecycleProfiles[profileId].filter((name) => name !== milestone);
  assertFixtureRejected(missingOrderedMilestone, `fixture semantics accepted missing ${milestone}`);
}

const injectedForbiddenFact = structuredClone(fixture);
const injectedForbiddenScenario = injectedForbiddenFact.scenarios[0];
injectedForbiddenScenario.forbiddenFacts[0] = injectedForbiddenScenario.expectedInjectedItems[0].fact;
assertFixtureRejected(injectedForbiddenFact,
  "fixture semantics accepted an injected forbidden fact");

const inconsistentRevisionIdentity = structuredClone(fixture);
const revisionItems = inconsistentRevisionIdentity.scenarios[0].expectedInjectedItems;
revisionItems[1].lineageId = revisionItems[0].lineageId;
revisionItems[1].revisionOrdinal = revisionItems[0].revisionOrdinal + 1;
assertFixtureRejected(inconsistentRevisionIdentity,
  "fixture semantics accepted two active revisions for one lineage");

for (const identityField of ["lineageId", "memoryId", "revisionId"]) {
  const duplicateNormalIdentity = structuredClone(fixture);
  const duplicateScenario = duplicateNormalIdentity.scenarios[0];
  const retained = duplicateScenario.expectedInjectedItems[0];
  const duplicateOmission = structuredClone(duplicateScenario.expectedInjectedItems[1]);
  delete duplicateOmission.selectionReason;
  duplicateOmission.reason = "omitted_budget";
  duplicateOmission.revisionOrdinal = retained.revisionOrdinal + 1;
  duplicateOmission[identityField] = retained[identityField];
  duplicateScenario.expectedInjectedItems.splice(1, 1);
  duplicateScenario.expectedOmissions.push(duplicateOmission);
  assertFixtureRejected(duplicateNormalIdentity,
    `fixture semantics accepted duplicate normal ${identityField}`);
}

const mismatchedDuplicateRevision = structuredClone(fixture);
const duplicateScenario = mismatchedDuplicateRevision.scenarios[0];
const retainedRevision = duplicateScenario.expectedInjectedItems[0];
const duplicateRevision = duplicateScenario.expectedInjectedItems.splice(1, 1)[0];
delete duplicateRevision.selectionReason;
duplicateRevision.reason = "duplicate_revision";
for (const field of ["memoryId", "lineageId", "revisionId", "revisionOrdinal"]) {
  duplicateRevision[field] = retainedRevision[field];
}
duplicateScenario.expectedOmissions.push(duplicateRevision);
assertFixtureRejected(mismatchedDuplicateRevision,
  "fixture semantics accepted conflicting content for one duplicate revision");

for (const [metricName, invalidScenarioId] of [["warmInjectionP95Ms", "claude-to-codex"],
  ["shortColdLexicalInjectionMs", "codex-to-claude"]]) {
  const invalidMetricMode = structuredClone(fixture);
  invalidMetricMode.samplingProtocol.metrics[metricName].scenarios[0] = invalidScenarioId;
  assertFixtureRejected(invalidMetricMode,
    `fixture semantics accepted ${metricName} with the wrong reset mode`);
}

const nonInjectionWarmMetric = structuredClone(fixture);
nonInjectionWarmMetric.samplingProtocol.metrics.warmInjectionP95Ms.scenarios.push(
  "credentialless-http-activation-rejected",
);
assertFixtureRejected(nonInjectionWarmMetric,
  "fixture semantics accepted a warm injection metric without an injection lifecycle");

const emptyInjectionWarmMetric = structuredClone(fixture);
emptyInjectionWarmMetric.samplingProtocol.metrics.warmInjectionP95Ms.scenarios.push(
  "incompatible-scope-injection-rejected",
);
assertFixtureRejected(emptyInjectionWarmMetric,
  "fixture semantics accepted a warm injection metric without injected items");

const unsupportedPercentileMethod = structuredClone(fixture);
unsupportedPercentileMethod.samplingProtocol.percentileMethod = "linear_interpolation";
assertFixtureRejected(unsupportedPercentileMethod,
  "fixture semantics accepted an unsupported percentile method");

for (const [field, value] of [
  ["percentileScope", "pooled_across_scenarios"], ["clock", "wall_clock"],
]) {
  const unsupportedSamplingProtocol = structuredClone(fixture);
  unsupportedSamplingProtocol.samplingProtocol[field] = value;
  assertFixtureRejected(unsupportedSamplingProtocol,
    `fixture semantics accepted unsupported ${field}`);
}

for (const name of ["agentBlockageCount", "acceptedEventLossCount",
  "duplicateDurableMemoryCount", "secretEgressCount", "incompatibleScopeInjectionCount"]) {
  const nonzeroSafetyThreshold = structuredClone(fixture);
  nonzeroSafetyThreshold.thresholds[name] = 1;
  assert.notEqual(validateAgainstSchema(
    nonzeroSafetyThreshold, fixtureSchema, fixtureSchema,
  ).length, 0, `fixture schema accepted nonzero ${name}`);
  assertFixtureRejected(nonzeroSafetyThreshold,
    `fixture semantics accepted nonzero ${name}`);
}

console.log("Slice 1 fixture semantic regression checks passed.");

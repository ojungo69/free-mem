import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runnerEvidenceFingerprint, validateRunnerEvidence } from "./alpha-runner-evidence.mjs";

const contractDir = dirname(fileURLToPath(import.meta.url));
const readFixture = (name) => JSON.parse(readFileSync(join(contractDir, "../fixtures", name), "utf8"));
const fixture = readFixture("slice1-bidirectional-en-v1.json");
const result = readFixture("alpha-result-v1.failure-example.json");
const evidence = readFixture("runner-evidence/alpha-runner-evidence-v1.failure-example.json");

evidence.scenarios[0].runPreparations[0].observedProductProcessCount =
  fixture.thresholds.maxSteadyProductProcessCount + 1;
result.runnerEvidenceFingerprint = runnerEvidenceFingerprint(evidence);
assert.throws(() => validateRunnerEvidence(evidence, result, fixture, evidence.invocationId),
  /warm runner preparation did not prove retained ready state/);

console.log("Alpha runner evidence regression checks passed.");

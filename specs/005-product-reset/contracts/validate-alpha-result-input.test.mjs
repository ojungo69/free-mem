import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { MAX_RUNNER_EVIDENCE_BYTES, readRunnerEvidenceFile } from "./alpha-runner-evidence.mjs";
import { validateArtifact } from "./alpha-result-artifact.mjs";

const contractDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(contractDir, "../../..");
const validatorPath = join(contractDir, "validate-alpha-result.mjs");
const fixtureRoot = join(contractDir, "../fixtures");
const success = JSON.parse(readFileSync(join(fixtureRoot,
  "alpha-result-v1.example.json"), "utf8"));
const fixture = JSON.parse(readFileSync(join(fixtureRoot,
  "slice1-bidirectional-en-v1.json"), "utf8"));
const successEvidence = JSON.parse(readFileSync(join(fixtureRoot,
  "runner-evidence/alpha-runner-evidence-v1.example.json"), "utf8"));
const failure = JSON.parse(readFileSync(join(fixtureRoot,
  "alpha-result-v1.failure-example.json"), "utf8"));
const failureEvidence = JSON.parse(readFileSync(join(fixtureRoot,
  "runner-evidence/alpha-runner-evidence-v1.failure-example.json"), "utf8"));
const suiteRegression = JSON.parse(readFileSync(join(fixtureRoot,
  "alpha-result-v1.suite-regression.json"), "utf8"));
const suiteRegressionEvidence = JSON.parse(readFileSync(join(fixtureRoot,
  "runner-evidence/alpha-runner-evidence-v1.suite-regression.json"), "utf8"));
const runnerEvidenceRoot = mkdtempSync(join(tmpdir(), "free-mem-alpha-runner-evidence-input-"));
const suiteResultRoot = mkdtempSync(join(tmpdir(), "free-mem-alpha-suite-results-"));
let runnerEvidenceOrdinal = 0;
process.on("exit", () => {
  rmSync(runnerEvidenceRoot, { recursive: true });
  rmSync(suiteResultRoot, { recursive: true });
});

function writeRunnerEvidence(evidence) {
  const path = join(runnerEvidenceRoot, `runner-evidence-${runnerEvidenceOrdinal += 1}.json`);
  writeFileSync(path, JSON.stringify(evidence), { mode: 0o600 });
  return path;
}

for (const [result, evidence] of [[success, successEvidence], [failure, failureEvidence]]) {
  const evidencePath = writeRunnerEvidence(evidence);
  const committedPair = spawnSync(process.execPath,
    ["--experimental-strip-types", validatorPath,
      "--runner-evidence-root", runnerEvidenceRoot, "--runner-evidence", evidencePath,
      "--runner-invocation-id", evidence.invocationId, "--result", "-"], {
      cwd: repoRoot, input: JSON.stringify(result), encoding: "utf8",
    });
  assert.equal(committedPair.status, 0,
    `committed result/evidence pair drifted: ${committedPair.stderr}${committedPair.stdout}`);
}

const missingRunnerEvidence = spawnSync(process.execPath,
  ["--experimental-strip-types", validatorPath, "--result", "-"], {
    cwd: repoRoot,
    input: JSON.stringify(success),
    encoding: "utf8",
  });
assert.notEqual(missingRunnerEvidence.status, 0, "explicit result omitted runner evidence");
assert.match(`${missingRunnerEvidence.stderr}${missingRunnerEvidence.stdout}`,
  /explicit result requires runner evidence/);
const evidenceWithoutInvocationPath = writeRunnerEvidence(successEvidence);
const missingRunnerInvocation = spawnSync(process.execPath,
  ["--experimental-strip-types", validatorPath,
    "--runner-evidence-root", runnerEvidenceRoot,
    "--runner-evidence", evidenceWithoutInvocationPath, "--result", "-"], {
    cwd: repoRoot,
    input: JSON.stringify(success),
    encoding: "utf8",
  });
assert.notEqual(missingRunnerInvocation.status, 0, "explicit result omitted runner invocation ID");
assert.match(`${missingRunnerInvocation.stderr}${missingRunnerInvocation.stdout}`,
  /explicit result requires a runner invocation ID/);

const oversizedRunnerEvidencePath = join(runnerEvidenceRoot, "oversized-runner-evidence.json");
writeFileSync(oversizedRunnerEvidencePath, " ".repeat(MAX_RUNNER_EVIDENCE_BYTES + 1),
  { mode: 0o600 });
const oversizedRunnerEvidence = spawnSync(process.execPath,
  ["--experimental-strip-types", validatorPath,
      "--runner-evidence-root", runnerEvidenceRoot,
      "--runner-evidence", oversizedRunnerEvidencePath,
      "--runner-invocation-id", successEvidence.invocationId, "--result", "-"], {
    cwd: repoRoot,
    input: JSON.stringify(success),
    encoding: "utf8",
  });
assert.notEqual(oversizedRunnerEvidence.status, 0, "oversized runner evidence was accepted");
assert.match(`${oversizedRunnerEvidence.stderr}${oversizedRunnerEvidence.stdout}`,
  /runner evidence result input exceeds the fixed byte limit/);

const overlappingRoot = mkdtempSync(join(tmpdir(), "free-mem-alpha-overlap-"));
try {
  const artifactRoot = join(overlappingRoot, "artifacts");
  const evidenceRoot = join(artifactRoot, "runner-evidence");
  mkdirSync(evidenceRoot, { recursive: true });
  const evidencePath = join(evidenceRoot, "evidence.json");
  writeFileSync(evidencePath, JSON.stringify(successEvidence));
  assert.throws(() => readRunnerEvidenceFile(evidencePath, evidenceRoot, artifactRoot),
    /runner evidence root overlaps the candidate artifact root/);
} finally {
  rmSync(overlappingRoot, { recursive: true });
}

const writableRoot = mkdtempSync(join(tmpdir(), "free-mem-alpha-writable-root-"));
try {
  const artifactRoot = join(writableRoot, "artifacts");
  const evidenceRoot = join(writableRoot, "runner-evidence");
  mkdirSync(artifactRoot);
  mkdirSync(evidenceRoot);
  chmodSync(evidenceRoot, 0o777);
  const evidencePath = join(evidenceRoot, "evidence.json");
  writeFileSync(evidencePath, JSON.stringify(successEvidence));
  assert.throws(() => readRunnerEvidenceFile(evidencePath, evidenceRoot, artifactRoot),
    /runner evidence root is not runner-owned and immutable/);
} finally {
  rmSync(writableRoot, { recursive: true });
}

const writableArtifactRoot = mkdtempSync(join(tmpdir(), "free-mem-alpha-writable-artifact-"));
try {
  const candidateRoot = join(writableArtifactRoot, success.candidateId);
  mkdirSync(candidateRoot);
  const candidatePath = join(candidateRoot, "candidate.bundle");
  copyFileSync(join(fixtureRoot, "artifacts", success.candidateId, "candidate.bundle"), candidatePath);
  chmodSync(candidatePath, 0o666);
  assert.throws(() => validateArtifact(success, writableArtifactRoot,
    fixture.pins.freeMemBaseCommit, fixture.artifactLimits),
  /candidate artifact file is not runner-owned and immutable/);
} finally {
  rmSync(writableArtifactRoot, { recursive: true });
}

const fifoDir = mkdtempSync(join(tmpdir(), "free-mem-alpha-result-fifo-"));
const fifoPath = join(fifoDir, "candidate-result.fifo");
try {
  const mkfifo = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
  assert.equal(mkfifo.status, 0, `${mkfifo.stderr}${mkfifo.stdout}`);
  const fifoEvidencePath = writeRunnerEvidence(successEvidence);
  const fifoRun = spawnSync(process.execPath,
    ["--experimental-strip-types", validatorPath,
      "--runner-evidence-root", runnerEvidenceRoot,
      "--runner-evidence", fifoEvidencePath,
      "--runner-invocation-id", successEvidence.invocationId, "--result", fifoPath], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 2000,
    });
  assert.notEqual(fifoRun.error?.code, "ETIMEDOUT", "FIFO result path blocked before validation");
  assert.notEqual(fifoRun.status, 0, "FIFO result path was accepted");
  assert.match(`${fifoRun.stderr}${fifoRun.stdout}`, /result input path is not a regular file/);
} finally {
  rmSync(fifoDir, { recursive: true });
}

const suiteEvidencePath = writeRunnerEvidence(suiteRegressionEvidence);
const suiteResultPaths = suiteRegression.positiveResults.map((result, index) => {
  const path = join(suiteResultRoot, `suite-positive-${index + 1}.json`);
  writeFileSync(path, JSON.stringify(result));
  return path;
});
const suiteNegativePath = join(suiteResultRoot, "suite-negative.json");
writeFileSync(suiteNegativePath, JSON.stringify(suiteRegression.negativeResult));
const suiteArgs = suiteResultPaths.flatMap((path) => ["--result", path]);
suiteArgs.push("--negative-result", suiteNegativePath);
const suiteRun = spawnSync(process.execPath,
  ["--experimental-strip-types", validatorPath,
    "--runner-evidence-root", runnerEvidenceRoot,
    "--runner-evidence", suiteEvidencePath,
    "--runner-invocation-id", suiteRegressionEvidence.invocationId,
    ...suiteArgs], { cwd: repoRoot, encoding: "utf8" });
assert.equal(suiteRun.status, 0, `16+1 suite regression: ${suiteRun.stderr}${suiteRun.stdout}`);

console.log("Alpha result input and suite regression checks passed.");

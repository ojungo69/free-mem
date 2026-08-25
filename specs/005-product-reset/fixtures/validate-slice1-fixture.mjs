import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalizeJson, readIJsonFile } from "../../../harness/schema/jcs.ts";
import { validateAgainstSchema } from "../../../harness/schema/validate.ts";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const defaultFixturePath = join(fixtureDir, "slice1-bidirectional-en-v1.json");
const schemaPath = join(fixtureDir, "slice1-bidirectional-en-v1.schema.json");
const semanticPath = join(fixtureDir, "slice1-bidirectional-en-v1.semantic.jq");
const args = process.argv.slice(2);

if (args.length === 1 && args[0] === "--help") {
  console.log("Usage: node --experimental-strip-types validate-slice1-fixture.mjs [--fixture PATH]");
  process.exit(0);
}
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--fixture" || !args[1])) {
  throw new Error("invalid arguments; use --help for usage");
}

const fixturePath = args.length === 0 ? defaultFixturePath : resolve(args[1]);

const fixture = readIJsonFile(fixturePath);
const schema = readIJsonFile(schemaPath);
const issues = validateAgainstSchema(fixture, schema, schema);

if (issues.length > 0) {
  console.error(JSON.stringify(issues, null, 2));
  process.exit(1);
}

const { contractFingerprint: _contractFingerprint, ...contract } = fixture;
const fixtureContractDomain = "free-mem:slice1-fixture-contract:v1\0";
const expectedContractFingerprint =
  "sha256:89f55ba482c93c8f9fb68be80c63961951d0c819bfbda209bdf2c5dc1f6557f4";
const actualContractFingerprint = `sha256:${createHash("sha256")
  .update(fixtureContractDomain)
  .update(canonicalizeJson(contract))
  .digest("hex")}`;
if (
  fixture.contractFingerprint !== expectedContractFingerprint ||
  actualContractFingerprint !== expectedContractFingerprint
) {
  throw new Error("fixed fixture contract changed without a fixture-version fingerprint update");
}

const spool = fixture.scenarios.find(
  (scenario) => scenario.scenarioId === "runtime-unavailable-spool-recovery",
);
const probe = spool?.fault?.identityConflictProbe;
const canonicalEvent = spool?.events?.find((event) => event.eventId === probe?.eventId);

if (!probe || !canonicalEvent) {
  throw new Error("identity-conflict probe does not resolve its canonical event");
}
if (probe.payloadDigestVersion !== canonicalEvent.payloadDigestVersion) {
  throw new Error("identity-conflict probe does not reuse the canonical digest version");
}

const digestDomain = "free-mem:event-payload-digest:v1\0";
const digest = (payload) =>
  `sha256:${createHash("sha256")
    .update(digestDomain)
    .update(canonicalizeJson(payload))
    .digest("hex")}`;

const lineageDomain = "free-mem:memory-lineage:v1\0";
const lineageDigest = (repositoryScope, sourceSpans) => {
  const normalizedSpans = [
    ...new Map(sourceSpans.map((span) => [canonicalizeJson(span), span])).values(),
  ].sort(
    (left, right) =>
      (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0) ||
      left.startByte - right.startByte ||
      left.endByte - right.endByte,
  );
  return createHash("sha256")
    .update(lineageDomain)
    .update(canonicalizeJson({ repositoryScope, sourceSpans: normalizedSpans }))
    .digest("hex");
};

const lineageVectors = [
  {
    spans: [{ eventId: "event-a", startByte: 0, endByte: 10 }],
    expected: "ca6ec88cc0156199c5e08e50393dcf4ef473f62c1e0e5372e99d9d791499779f",
  },
  {
    spans: [{ eventId: "event-a", startByte: 0, endByte: 11 }],
    expected: "ad0ffa99555520b5a1524908a4d08661b3054b0f0f8a1a66e08a8f2a98904378",
  },
  {
    spans: [
      { eventId: "event-b", startByte: 4, endByte: 9 },
      { eventId: "event-a", startByte: 0, endByte: 10 },
    ],
    expected: "23274e7fbe3af129f9942e312eec51dfdc6b6825e3e38583d068254e96e2d447",
  },
];
for (const vector of lineageVectors) {
  if (lineageDigest("repo-primary", vector.spans) !== vector.expected) {
    throw new Error("lineage v1 test vector mismatch");
  }
}

if (digest(canonicalEvent.redactedPayload) !== probe.canonicalPayloadDigest) {
  throw new Error("identity-conflict canonical digest does not match redacted payload");
}
if (
  probe.conflictingRedactedPayload === canonicalEvent.redactedPayload ||
  digest(probe.conflictingRedactedPayload) !== probe.conflictingPayloadDigest
) {
  throw new Error("identity-conflict payload or digest is not a distinct reproducible input");
}

try {
  execFileSync("jq", ["-e", "-f", semanticPath, fixturePath], { stdio: "inherit" });
} catch (error) {
  if (error?.code === "ENOENT") {
    console.error("Prerequisite missing: jq is required to validate the Slice 1 fixture.");
    process.exit(2);
  }
  throw error;
}

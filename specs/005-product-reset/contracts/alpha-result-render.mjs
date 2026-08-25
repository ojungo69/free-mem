import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { canonicalizeJson } from "../../../harness/schema/jcs.ts";

export function tokenizeRenderPayload(payload) {
  const tokens = payload.match(/[\p{L}\p{N}_]+|[^\s]/gu) ?? [];
  return tokens.map((token) => createHash("sha256")
    .update("free-mem:fixture-token:v1\0")
    .update(token)
    .digest()
    .readUInt32BE(0));
}

function validateEvidence(evidence, renderedBytes, injectedTokens, label) {
  if (renderedBytes === 0 && injectedTokens === 0) {
    if (evidence !== null) throw new Error(`${label} render evidence is not empty`);
    return null;
  }
  if (evidence === null) throw new Error(`${label} render evidence is missing`);
  let parsedPayload;
  try {
    parsedPayload = JSON.parse(evidence.utf8Payload);
  } catch {
    throw new Error(`${label} render payload is not valid JSON`);
  }
  if (Buffer.byteLength(evidence.utf8Payload, "utf8") !== renderedBytes ||
      evidence.tokenIds.length !== injectedTokens ||
      evidence.utf8Payload !== canonicalizeJson(parsedPayload) ||
      !isDeepStrictEqual(evidence.tokenIds, tokenizeRenderPayload(evidence.utf8Payload))) {
    throw new Error(`${label} render aggregates do not match their exact evidence`);
  }
  return parsedPayload;
}

export function buildRenderPayload(result, scenario, fixture, items, packId) {
  const manifest = scenario.derivationManifestId
    ? fixture.localDerivationManifest
    : fixture.effectiveConfiguration;
  return {
    injectionPack: {
      packVersion: 1,
      packId,
      targetDestinationClass: result.targetDestinationClass,
      targetSessionId: scenario.targetSessionId,
      targetRepositoryScope: scenario.targetRepositoryScope,
      resolvedDestinationPolicy:
        fixture.effectiveConfiguration.destinationPolicyMap[result.targetDestinationClass],
      manifestIdentity: {
        manifestId: manifest.manifestId,
        effectiveManifestFingerprint: result.effectiveManifestFingerprint,
      },
      packDegradations: result.packDegradations,
      items,
    },
  };
}

function validateAttemptedItems(result, attemptedItems) {
  if (result.attemptedItems === "same_as_final") {
    if (result.omittedItems.some((item) => item.reason === "omitted_budget")) {
      throw new Error("pruned render candidates require explicit attempted items");
    }
    return;
  }
  const pruned = result.omittedItems.filter((item) => item.reason === "omitted_budget")
    .map(({ reason: _reason, ...item }) => ({ ...item, selectionReason: item.sourceLane }));
  if (!isDeepStrictEqual(attemptedItems, [...result.injectedItems, ...pruned])) {
    throw new Error("attempted render does not match the ordered traced candidates");
  }
}

export function validateRenderEvidence(result, scenario, fixture, finalPackExpected) {
  const attemptedItems = result.attemptedItems === "same_as_final"
    ? result.injectedItems
    : result.attemptedItems;
  validateAttemptedItems(result, attemptedItems);
  const attemptedEvidence = result.attemptedRenderEvidence === "same_as_final"
    ? result.finalRenderEvidence
    : result.attemptedRenderEvidence;
  const attemptedPayload = validateEvidence(
    attemptedEvidence,
    result.attemptedRenderedBytes,
    result.attemptedInjectedTokens,
    "attempted",
  );
  const attemptedPackId = result.attemptedRenderEvidence === "same_as_final"
    ? result.packId
    : null;
  if (attemptedPayload !== null && !isDeepStrictEqual(attemptedPayload,
    buildRenderPayload(result, scenario, fixture, attemptedItems, attemptedPackId))) {
    throw new Error("attempted render payload does not match attempted items");
  }
  const finalPayload = validateEvidence(
    result.finalRenderEvidence,
    result.renderedBytes,
    result.injectedTokens,
    "final",
  );
  if ((finalPayload !== null) !== finalPackExpected ||
      (finalPayload === null) !== (result.packId === null) ||
      (finalPayload !== null && !isDeepStrictEqual(finalPayload,
        buildRenderPayload(result, scenario, fixture, result.injectedItems, result.packId)))) {
    throw new Error("final render payload does not match delivered items");
  }
}

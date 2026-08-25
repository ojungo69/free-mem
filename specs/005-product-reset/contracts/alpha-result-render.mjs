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
    return;
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
}

export function validateRenderEvidence(result) {
  const attemptedEvidence = result.attemptedRenderEvidence === "same_as_final"
    ? result.finalRenderEvidence
    : result.attemptedRenderEvidence;
  validateEvidence(
    attemptedEvidence,
    result.attemptedRenderedBytes,
    result.attemptedInjectedTokens,
    "attempted",
  );
  validateEvidence(
    result.finalRenderEvidence,
    result.renderedBytes,
    result.injectedTokens,
    "final",
  );
  if (result.finalRenderEvidence !== null && result.finalRenderEvidence.utf8Payload !==
      canonicalizeJson({ items: result.injectedItems })) {
    throw new Error("final render payload does not match delivered items");
  }
}

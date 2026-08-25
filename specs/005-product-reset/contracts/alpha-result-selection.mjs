export function validateSelectionTiming(result, exceptionalState) {
  const evidence = result.selectionTimingEvidence;
  if (exceptionalState) {
    if (evidence !== null || result.selectionElapsedMs !== 0) {
      throw new Error("unsupported/not-run selection timing evidence is not empty");
    }
    return;
  }
  if (evidence === null || evidence.endMonotonicMs < evidence.startMonotonicMs ||
      result.selectionElapsedMs !== evidence.endMonotonicMs - evidence.startMonotonicMs) {
    throw new Error("selection elapsed time does not match monotonic timing evidence");
  }
}

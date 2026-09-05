import type { DetectorResult } from './detect.js';
import type { Sensitivity } from './egress.js';

// docs/dev/conventions.md "Sensitivity and egress": secret > private > local_only > eligible.
const STRICTNESS: Record<Sensitivity, number> = {
  eligible: 0,
  local_only: 1,
  private: 2,
  secret: 3,
};

/**
 * The worker's promotion rule (FR-017). The table, in order:
 *
 * | current                | classification state | detector      | result    |
 * |------------------------|----------------------|---------------|-----------|
 * | private or secret      | any                  | any           | unchanged |
 * | any                    | partial or failed    | any           | unchanged |
 * | any                    | done                 | failed        | unchanged |
 * | any                    | done                 | secret found  | secret    |
 * | local_only or eligible | done                 | clean         | eligible  |
 *
 * A row is never made less strict by anything but a complete, successful, clean detector run. The
 * stricter of two classes is `strictest`, which the apply step uses for a memory's sensitivity.
 */
export function promoteSensitivity(
  current: Sensitivity,
  detector: DetectorResult,
  classificationState: 'done' | 'partial' | 'failed',
): Sensitivity {
  // A class the capture step decided stays as it was recorded.
  if (current === 'private' || current === 'secret') return current;
  // A7: a partial row and a failed row are never promoted.
  if (classificationState !== 'done') return current;
  // R4: a detector failure fails closed, so it never promotes either.
  if (!detector.ok) return current;
  if (detector.sensitivity === 'secret') return 'secret';
  return 'eligible';
}

/** The stricter class of the lattice, used wherever several sources decide one row (R10). */
export function strictest(first: Sensitivity, ...rest: Sensitivity[]): Sensitivity {
  // The first class is required so an empty source list cannot silently yield the loosest class.
  let strictestValue: Sensitivity = first;
  for (const value of rest) {
    if (STRICTNESS[value] > STRICTNESS[strictestValue]) strictestValue = value;
  }
  return strictestValue;
}

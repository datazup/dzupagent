/**
 * Recovery lesson type definitions.
 *
 * Extracted into a standalone module to break the circular import between
 * `recovery-feedback.ts` and `learning-candidate.ts`. Both modules now depend
 * on this leaf module instead of each other.
 *
 * @module self-correction/recovery-lesson-types
 */

import type { FailureType } from '../recovery/recovery-types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A persisted record of a recovery attempt and its outcome. */
export interface RecoveryLesson {
  /** Unique lesson identifier. */
  id: string
  /** The classified failure type (from FailureType). */
  errorType: FailureType
  /** Fingerprint from the FailureAnalyzer for dedup / matching. */
  errorFingerprint: string
  /** Pipeline node where the failure occurred (if applicable). */
  nodeId: string
  /** Name of the recovery strategy that was attempted. */
  strategy: string
  /** Whether the recovery succeeded or failed. */
  outcome: 'success' | 'failure'
  /** Human-readable summary of what happened. */
  summary: string
  /** When the lesson was recorded. */
  timestamp: Date
  /** Tenant scope for staged/retrieved recovery learning. Defaults to 'default'. */
  tenantId?: string | null
}

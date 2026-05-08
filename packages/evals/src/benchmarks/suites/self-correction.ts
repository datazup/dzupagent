/**
 * Self-Correction Benchmark Suite
 *
 * Tests whether the self-correction pipeline can detect and fix known bugs.
 * Each scenario contains buggy code, a description of the bug, the expected
 * error pattern, and the corrected reference code.
 *
 * This file is a thin re-export barrel. Implementation lives in:
 *   - self-correction-types.ts        — CorrectionCategory, CorrectionScenario
 *   - self-correction-scenarios-a.ts  — Scenarios sc-001 to sc-007
 *   - self-correction-scenarios-b.ts  — Scenarios sc-008 to sc-015
 *   - self-correction-suite.ts        — CORRECTION_SCENARIOS, suite, builder
 */

export type { CorrectionCategory, CorrectionScenario } from './self-correction-types.js';

export {
  CORRECTION_SCENARIOS_A,
} from './self-correction-scenarios-a.js';

export {
  CORRECTION_SCENARIOS_B,
} from './self-correction-scenarios-b.js';

export {
  ALL_CORRECTION_CATEGORIES,
  CORRECTION_SCENARIOS,
  SELF_CORRECTION_SUITE,
  createSelfCorrectionSuite,
} from './self-correction-suite.js';

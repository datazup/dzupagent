/**
 * Types for the Self-Correction Benchmark Suite.
 */

/**
 * Category of correction scenario.
 */
export type CorrectionCategory =
  | 'import_error'
  | 'type_error'
  | 'security_violation'
  | 'missing_validation'
  | 'test_failure'
  | 'lint_error'
  | 'logic_error';

/**
 * A single self-correction scenario with buggy and correct code.
 */
export interface CorrectionScenario {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Bug category */
  category: CorrectionCategory;
  /** The buggy code */
  buggyCode: string;
  /** Description of what is wrong */
  bugDescription: string;
  /** The correct code (reference for scoring) */
  correctCode: string;
  /** Expected error message pattern */
  expectedError: string;
  /** Difficulty: how hard to fix (1-5) */
  difficulty: number;
}

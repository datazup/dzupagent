/**
 * Self-Correction Benchmark Suite definition — categories constant and suite builder.
 */

import type { BenchmarkSuite } from '../benchmark-types.js';
import type { CorrectionCategory } from './self-correction-types.js';
import { CORRECTION_SCENARIOS_A } from './self-correction-scenarios-a.js';
import { CORRECTION_SCENARIOS_B } from './self-correction-scenarios-b.js';

/**
 * All 7 correction categories present in the scenarios.
 */
export const ALL_CORRECTION_CATEGORIES: readonly CorrectionCategory[] = [
  'import_error',
  'type_error',
  'security_violation',
  'missing_validation',
  'test_failure',
  'lint_error',
  'logic_error',
] as const;

/**
 * Combined list of all correction scenarios (sc-001 through sc-015).
 */
export const CORRECTION_SCENARIOS = [...CORRECTION_SCENARIOS_A, ...CORRECTION_SCENARIOS_B];

/**
 * Pre-built self-correction benchmark suite.
 */
export const SELF_CORRECTION_SUITE: BenchmarkSuite = {
  id: 'self-correction',
  name: 'Self-Correction Effectiveness',
  description:
    'Tests whether the self-correction pipeline can detect and fix known bugs across 7 categories: import errors, type errors, security violations, missing validation, test failures, lint errors, and logic errors.',
  category: 'self-correction',
  dataset: CORRECTION_SCENARIOS.map((s) => ({
    id: s.id,
    input: `Fix this code:\n\`\`\`typescript\n${s.buggyCode}\n\`\`\`\n\nBug: ${s.bugDescription}`,
    expectedOutput: s.correctCode,
    tags: [s.category, `difficulty-${s.difficulty}`, s.name],
    metadata: {
      category: s.category,
      difficulty: s.difficulty,
      expectedError: s.expectedError,
    },
  })),
  scorers: [
    {
      id: 'correction-keyword',
      name: 'Correction Keyword Match',
      description: 'Checks if the corrected output contains key fixes',
      type: 'deterministic',
    },
    {
      id: 'correction-completeness',
      name: 'Correction Completeness',
      description: 'Checks if the corrected output is complete and compiles',
      type: 'deterministic',
    },
    {
      id: 'correction-quality',
      name: 'Correction Quality',
      description: 'LLM judge evaluating whether the fix addresses the root cause',
      type: 'llm-judge',
    },
  ],
  baselineThresholds: {
    'correction-keyword': 0.6,
    'correction-completeness': 0.7,
    'correction-quality': 0.6,
  },
};

/**
 * Create the self-correction benchmark suite from built-in scenarios.
 */
export function createSelfCorrectionSuite(): BenchmarkSuite {
  return SELF_CORRECTION_SUITE;
}

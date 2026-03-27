/**
 * Failure Router — route CI failures to appropriate fix strategies.
 */

import type { CIFailure } from './ci-monitor.js'

export interface FixStrategy {
  category: CIFailure['errorCategory']
  /** Prompt fragment to inject into the fix agent */
  promptHint: string
  /** Suggested tools to use */
  suggestedTools: string[]
  /** Max fix attempts for this category */
  maxAttempts: number
}

/**
 * Default fix strategies per error category.
 */
export const DEFAULT_FIX_STRATEGIES: Record<string, FixStrategy> = {
  'type-check': {
    category: 'type-check',
    promptHint:
      'Fix TypeScript errors. Read the error messages carefully, identify the affected files, ' +
      'and correct type mismatches, missing imports, or incorrect signatures. ' +
      'Run `tsc --noEmit` to verify.',
    suggestedTools: ['edit_file', 'read_file'],
    maxAttempts: 3,
  },
  test: {
    category: 'test',
    promptHint:
      'Fix failing tests. Read the test output carefully to identify assertion failures, ' +
      'missing mocks, or incorrect expected values. Update either the implementation or ' +
      'the test depending on which is wrong.',
    suggestedTools: ['edit_file', 'read_file', 'run_tests'],
    maxAttempts: 3,
  },
  lint: {
    category: 'lint',
    promptHint:
      'Fix linting errors. Address each reported rule violation. Common fixes include ' +
      'import ordering, unused variables, and formatting issues. Run the linter to verify.',
    suggestedTools: ['edit_file', 'read_file'],
    maxAttempts: 2,
  },
  build: {
    category: 'build',
    promptHint:
      'Fix build errors. Check for missing dependencies, incorrect import paths, ' +
      'or configuration issues that prevent compilation.',
    suggestedTools: ['edit_file', 'read_file', 'write_file'],
    maxAttempts: 3,
  },
  deploy: {
    category: 'deploy',
    promptHint:
      'Fix deployment errors. Check configuration files, environment variable references, ' +
      'and deployment scripts for issues.',
    suggestedTools: ['edit_file', 'read_file', 'write_file'],
    maxAttempts: 2,
  },
  unknown: {
    category: 'unknown',
    promptHint:
      'Analyze the CI log excerpt and fix the issue. Look for error messages, ' +
      'stack traces, or exit codes that indicate the root cause.',
    suggestedTools: ['edit_file', 'read_file'],
    maxAttempts: 2,
  },
}

/**
 * Route a CI failure to the appropriate fix strategy.
 * Uses the failure's errorCategory (or re-categorizes from log if missing).
 * Custom strategies override defaults for matching categories.
 */
export function routeFailure(
  failure: CIFailure,
  customStrategies?: Record<string, FixStrategy>,
): FixStrategy {
  const merged = { ...DEFAULT_FIX_STRATEGIES, ...customStrategies }
  const category = failure.errorCategory ?? 'unknown'
  const fallback: FixStrategy = {
    category: 'unknown',
    promptHint: 'Analyze the CI log excerpt and fix the issue.',
    suggestedTools: ['edit_file', 'read_file'],
    maxAttempts: 2,
  }
  return merged[category] ?? merged['unknown'] ?? fallback
}

/**
 * ECO-183: Security Test Runner
 *
 * Executes security test suites against a checker function and produces results.
 */

import type {
  SecurityTestCase,
  SecurityTestResult,
  SecuritySuiteResult,
  SecurityChecker,
} from './security-test-types.js';

/**
 * Run a security test suite against a checker function.
 *
 * The checker receives each test case's input and returns whether it was blocked/detected.
 * Results are compared against the expected behavior:
 * - 'block': passes if checker reports blocked=true
 * - 'detect': passes if checker reports detected=true (blocked or detected)
 * - 'safe': passes if checker reports blocked=false AND detected=false
 */
export async function runSecuritySuite(
  suite: SecurityTestCase[],
  checker: SecurityChecker,
): Promise<SecuritySuiteResult> {
  const results: SecurityTestResult[] = [];

  for (const testCase of suite) {
    const checkerResult = await checker(testCase.input);
    const passed = evaluateResult(testCase, checkerResult);

    const details = buildDetails(testCase, checkerResult, passed);

    results.push({
      caseId: testCase.id,
      passed,
      category: testCase.category,
      severity: testCase.severity,
      details,
    });
  }

  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = results.length - passedCount;
  const passRate = results.length > 0 ? passedCount / results.length : 0;

  // Derive suite name from the first case's category, or 'unknown'
  const suiteName = suite.length > 0
    ? `${suite[0]!.category}-security-suite`
    : 'empty-security-suite';

  return {
    suiteName,
    totalCases: results.length,
    passed: passedCount,
    failed: failedCount,
    results,
    passRate,
  };
}

/**
 * Evaluate whether a checker result matches the expected behavior.
 */
function evaluateResult(
  testCase: SecurityTestCase,
  checkerResult: { blocked: boolean; detected: boolean },
): boolean {
  switch (testCase.expectedBehavior) {
    case 'block':
      return checkerResult.blocked;
    case 'detect':
      return checkerResult.blocked || checkerResult.detected;
    case 'safe':
      return !checkerResult.blocked && !checkerResult.detected;
    default:
      return false;
  }
}

/**
 * Build human-readable details for a test result.
 */
function buildDetails(
  testCase: SecurityTestCase,
  checkerResult: { blocked: boolean; detected: boolean; details?: string },
  passed: boolean,
): string {
  const status = passed ? 'PASS' : 'FAIL';
  const checkerInfo = checkerResult.details
    ? ` (${checkerResult.details})`
    : '';
  const behavior = `blocked=${String(checkerResult.blocked)}, detected=${String(checkerResult.detected)}`;

  return `[${status}] ${testCase.name}: expected=${testCase.expectedBehavior}, got ${behavior}${checkerInfo}`;
}

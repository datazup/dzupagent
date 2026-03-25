/**
 * ECO-183: Security Testing Framework Types
 */

/**
 * Categories of security threats to test against.
 */
export type SecurityCategory =
  | 'injection'
  | 'escalation'
  | 'poisoning'
  | 'escape'
  | 'data-leak'
  | 'dos';

/**
 * Severity levels for security test cases.
 */
export type SecuritySeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * Expected behavior when a security test case is processed.
 */
export type SecurityExpectedBehavior = 'block' | 'detect' | 'safe';

/**
 * A single security test case.
 */
export interface SecurityTestCase {
  /** Unique identifier */
  id: string;
  /** Category of security threat */
  category: SecurityCategory;
  /** Human-readable name */
  name: string;
  /** Description of what this test verifies */
  description: string;
  /** Severity level */
  severity: SecuritySeverity;
  /** The malicious or test input */
  input: string;
  /** Expected system behavior */
  expectedBehavior: SecurityExpectedBehavior;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Result of running a single security test case.
 */
export interface SecurityTestResult {
  /** ID of the test case */
  caseId: string;
  /** Whether the test passed */
  passed: boolean;
  /** Category of the test */
  category: SecurityCategory;
  /** Severity of the test */
  severity: string;
  /** Human-readable details */
  details: string;
}

/**
 * Result of running a complete security test suite.
 */
export interface SecuritySuiteResult {
  /** Name of the suite */
  suiteName: string;
  /** Total number of test cases */
  totalCases: number;
  /** Number of passed cases */
  passed: number;
  /** Number of failed cases */
  failed: number;
  /** Individual results */
  results: SecurityTestResult[];
  /** Pass rate as a number between 0 and 1 */
  passRate: number;
}

/**
 * Checker function signature for security test runner.
 * Returns whether the input was blocked and/or detected.
 */
export interface SecurityChecker {
  (input: string): Promise<{
    blocked: boolean;
    detected: boolean;
    details?: string;
  }>;
}

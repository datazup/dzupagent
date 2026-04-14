/**
 * Contract Test Kit — types for adapter conformance testing.
 *
 * A ContractSuite defines a set of tests that any adapter implementation
 * must pass to be considered conformant with its interface contract.
 */

// ---------------------------------------------------------------------------
// Adapter types
// ---------------------------------------------------------------------------

/** Supported adapter types for contract testing */
export type AdapterType =
  | 'vector-store'
  | 'sandbox'
  | 'llm-provider'
  | 'embedding-provider'
  | 'memory-store'
  | 'queue-backend'
  | 'auth-provider';

// ---------------------------------------------------------------------------
// Contract test primitives
// ---------------------------------------------------------------------------

/** Category determines whether a test is mandatory for compliance */
export type ContractTestCategory = 'required' | 'recommended' | 'optional';

/** Result of running a single contract test */
export interface ContractTestResult {
  passed: boolean;
  duration: number;
  error?: string | undefined;
  details?: Record<string, unknown> | undefined;
}

/** A single contract test case */
export interface ContractTest {
  /** Stable identifier for this test (e.g. 'vector-store:put-and-get') */
  id: string;
  /** Human-readable name */
  name: string;
  /** What this test verifies */
  description: string;
  /** Whether this test is required for compliance */
  category: ContractTestCategory;
  /** Execute the test against an adapter instance */
  run: (adapter: unknown) => Promise<ContractTestResult>;
}

/** A full suite of contract tests for one adapter type */
export interface ContractSuite {
  /** Which adapter type this suite tests */
  adapterType: AdapterType;
  /** Suite name (e.g. 'VectorStore Contract') */
  name: string;
  /** What this suite verifies */
  description: string;
  /** All test cases in this suite */
  tests: ContractTest[];
  /** Optional setup before all tests */
  setup?: (() => Promise<void>) | undefined;
  /** Optional teardown after all tests */
  teardown?: (() => Promise<void>) | undefined;
}

// ---------------------------------------------------------------------------
// Runner configuration
// ---------------------------------------------------------------------------

/** Filter options for selecting which tests to run */
export interface ContractRunFilter {
  /** Only run tests of these categories */
  categories?: ContractTestCategory[];
  /** Only run tests whose IDs match these patterns */
  testIds?: string[];
}

/** Configuration for a contract test run */
export interface ContractRunConfig {
  /** The suite to run */
  suite: ContractSuite;
  /** The adapter instance to test */
  adapter: unknown;
  /** Optional filter */
  filter?: ContractRunFilter;
  /** Timeout per test in ms (default: 30_000) */
  testTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

/** Result of a single test within a compliance report */
export interface ContractTestReport {
  testId: string;
  testName: string;
  category: ContractTestCategory;
  status: 'passed' | 'failed' | 'skipped';
  duration: number;
  error?: string | undefined;
  details?: Record<string, unknown> | undefined;
}

/** Compliance level based on which test categories passed */
export type ComplianceLevel = 'full' | 'partial' | 'minimal' | 'none';

/** Full compliance report for a contract suite run */
export interface ComplianceReport {
  /** Suite that was tested */
  suiteName: string;
  /** Adapter type tested */
  adapterType: AdapterType;
  /** When the run occurred */
  timestamp: string;
  /** Total duration of all tests */
  totalDuration: number;
  /** Individual test results */
  tests: ContractTestReport[];
  /** Summary counts */
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  /** Counts by category */
  byCategory: Record<ContractTestCategory, { total: number; passed: number; failed: number }>;
  /** Overall compliance percentage (0-100) */
  compliancePercent: number;
  /** Compliance level badge */
  complianceLevel: ComplianceLevel;
}

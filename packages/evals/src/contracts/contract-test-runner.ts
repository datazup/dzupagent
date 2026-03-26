/**
 * Contract Test Runner — executes contract suites against adapter implementations
 * and produces compliance reports.
 */

import type {
  ComplianceLevel,
  ComplianceReport,
  ContractRunConfig,
  ContractRunFilter,
  ContractSuite,
  ContractTest,
  ContractTestCategory,
  ContractTestReport,
} from './contract-types.js';

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run a contract suite against an adapter and produce a compliance report.
 */
export async function runContractSuite(config: ContractRunConfig): Promise<ComplianceReport> {
  const { suite, adapter, filter, testTimeoutMs = 30_000 } = config;
  const startTime = performance.now();

  // Run setup if defined
  if (suite.setup) {
    await suite.setup();
  }

  const tests = filterTests(suite.tests, filter);
  const skippedTests = suite.tests.filter((t) => !tests.includes(t));

  const reports: ContractTestReport[] = [];

  // Add skipped tests to report
  for (const test of skippedTests) {
    reports.push({
      testId: test.id,
      testName: test.name,
      category: test.category,
      status: 'skipped',
      duration: 0,
    });
  }

  // Run included tests sequentially to avoid adapter conflicts
  for (const test of tests) {
    const report = await runSingleTest(test, adapter, testTimeoutMs);
    reports.push(report);
  }

  // Run teardown if defined
  if (suite.teardown) {
    await suite.teardown();
  }

  const totalDuration = performance.now() - startTime;

  return buildComplianceReport(suite, reports, totalDuration);
}

/**
 * Run multiple contract suites against different adapters.
 * Returns one ComplianceReport per suite.
 */
export async function runContractSuites(
  configs: ContractRunConfig[],
): Promise<ComplianceReport[]> {
  const reports: ComplianceReport[] = [];

  for (const config of configs) {
    const report = await runContractSuite(config);
    reports.push(report);
  }

  return reports;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function filterTests(
  tests: ContractTest[],
  filter?: ContractRunFilter,
): ContractTest[] {
  if (!filter) return tests;

  let filtered = tests;

  if (filter.categories && filter.categories.length > 0) {
    const allowed = new Set(filter.categories);
    filtered = filtered.filter((t) => allowed.has(t.category));
  }

  if (filter.testIds && filter.testIds.length > 0) {
    const allowed = new Set(filter.testIds);
    filtered = filtered.filter((t) => allowed.has(t.id));
  }

  return filtered;
}

async function runSingleTest(
  test: ContractTest,
  adapter: unknown,
  timeoutMs: number,
): Promise<ContractTestReport> {
  try {
    const result = await Promise.race([
      test.run(adapter),
      timeoutPromise(timeoutMs),
    ]);

    return {
      testId: test.id,
      testName: test.name,
      category: test.category,
      status: result.passed ? 'passed' : 'failed',
      duration: result.duration,
      error: result.error,
      details: result.details,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      testId: test.id,
      testName: test.name,
      category: test.category,
      status: 'failed',
      duration: 0,
      error: message,
    };
  }
}

function timeoutPromise(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Test timed out after ${ms}ms`)), ms);
  });
}

function buildComplianceReport(
  suite: ContractSuite,
  tests: ContractTestReport[],
  totalDuration: number,
): ComplianceReport {
  const passed = tests.filter((t) => t.status === 'passed').length;
  const failed = tests.filter((t) => t.status === 'failed').length;
  const skipped = tests.filter((t) => t.status === 'skipped').length;

  const byCategory = buildCategorySummary(tests);
  const compliancePercent = computeCompliancePercent(tests);
  const complianceLevel = computeComplianceLevel(byCategory);

  return {
    suiteName: suite.name,
    adapterType: suite.adapterType,
    timestamp: new Date().toISOString(),
    totalDuration,
    tests,
    summary: { total: tests.length, passed, failed, skipped },
    byCategory,
    compliancePercent,
    complianceLevel,
  };
}

function buildCategorySummary(
  tests: ContractTestReport[],
): Record<ContractTestCategory, { total: number; passed: number; failed: number }> {
  const categories: ContractTestCategory[] = ['required', 'recommended', 'optional'];
  const result = {} as Record<ContractTestCategory, { total: number; passed: number; failed: number }>;

  for (const cat of categories) {
    const catTests = tests.filter((t) => t.category === cat && t.status !== 'skipped');
    result[cat] = {
      total: catTests.length,
      passed: catTests.filter((t) => t.status === 'passed').length,
      failed: catTests.filter((t) => t.status === 'failed').length,
    };
  }

  return result;
}

function computeCompliancePercent(tests: ContractTestReport[]): number {
  const nonSkipped = tests.filter((t) => t.status !== 'skipped');
  if (nonSkipped.length === 0) return 0;

  const passed = nonSkipped.filter((t) => t.status === 'passed').length;
  return Math.round((passed / nonSkipped.length) * 100);
}

function computeComplianceLevel(
  byCategory: Record<ContractTestCategory, { total: number; passed: number; failed: number }>,
): ComplianceLevel {
  const req = byCategory.required;
  const rec = byCategory.recommended;

  // No required tests failed, no recommended tests failed
  if (req.failed === 0 && rec.failed === 0) {
    return 'full';
  }

  // All required tests pass
  if (req.failed === 0) {
    return 'partial';
  }

  // At least some required tests pass
  if (req.passed > 0) {
    return 'minimal';
  }

  return 'none';
}

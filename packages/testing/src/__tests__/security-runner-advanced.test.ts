import { describe, it, expect, vi } from 'vitest';
import { runSecuritySuite } from '../security/security-runner.js';
import { INJECTION_SUITE } from '../security/injection-suite.js';
import { POISONING_SUITE } from '../security/poisoning-suite.js';
import { ESCALATION_SUITE } from '../security/escalation-suite.js';
import { ESCAPE_SUITE } from '../security/escape-suite.js';
import type {
  SecurityTestCase,
  SecurityChecker,
} from '../security/security-test-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCase(overrides: Partial<SecurityTestCase>): SecurityTestCase {
  return {
    id: 'test-001',
    category: 'injection',
    name: 'Test case',
    description: 'A test case for testing',
    severity: 'high',
    input: 'test input',
    expectedBehavior: 'block',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Result evaluation logic
// ---------------------------------------------------------------------------

describe('runSecuritySuite — result evaluation', () => {
  it('should pass a "block" case when checker reports blocked=true', async () => {
    const suite = [makeCase({ expectedBehavior: 'block' })];
    const checker: SecurityChecker = async () => ({
      blocked: true,
      detected: false,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.results[0]!.passed).toBe(true);
  });

  it('should fail a "block" case when checker reports blocked=false', async () => {
    const suite = [makeCase({ expectedBehavior: 'block' })];
    const checker: SecurityChecker = async () => ({
      blocked: false,
      detected: true,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.results[0]!.passed).toBe(false);
  });

  it('should pass a "detect" case when checker reports detected=true', async () => {
    const suite = [makeCase({ expectedBehavior: 'detect' })];
    const checker: SecurityChecker = async () => ({
      blocked: false,
      detected: true,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.results[0]!.passed).toBe(true);
  });

  it('should pass a "detect" case when checker reports blocked=true', async () => {
    const suite = [makeCase({ expectedBehavior: 'detect' })];
    const checker: SecurityChecker = async () => ({
      blocked: true,
      detected: false,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.results[0]!.passed).toBe(true);
  });

  it('should fail a "detect" case when both blocked and detected are false', async () => {
    const suite = [makeCase({ expectedBehavior: 'detect' })];
    const checker: SecurityChecker = async () => ({
      blocked: false,
      detected: false,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.results[0]!.passed).toBe(false);
  });

  it('should pass a "safe" case when nothing is blocked or detected', async () => {
    const suite = [makeCase({ expectedBehavior: 'safe' })];
    const checker: SecurityChecker = async () => ({
      blocked: false,
      detected: false,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.results[0]!.passed).toBe(true);
  });

  it('should fail a "safe" case when blocked=true', async () => {
    const suite = [makeCase({ expectedBehavior: 'safe' })];
    const checker: SecurityChecker = async () => ({
      blocked: true,
      detected: false,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.results[0]!.passed).toBe(false);
  });

  it('should fail a "safe" case when detected=true', async () => {
    const suite = [makeCase({ expectedBehavior: 'safe' })];
    const checker: SecurityChecker = async () => ({
      blocked: false,
      detected: true,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.results[0]!.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite name derivation
// ---------------------------------------------------------------------------

describe('runSecuritySuite — suite name derivation', () => {
  it('should derive name from the first case category', async () => {
    const suite = [makeCase({ category: 'poisoning' })];
    const checker: SecurityChecker = async () => ({
      blocked: true,
      detected: true,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.suiteName).toBe('poisoning-security-suite');
  });

  it('should use "empty-security-suite" for an empty suite', async () => {
    const checker: SecurityChecker = async () => ({
      blocked: false,
      detected: false,
    });
    const result = await runSecuritySuite([], checker);
    expect(result.suiteName).toBe('empty-security-suite');
  });

  it('should use the first case category even in mixed suites', async () => {
    const suite = [
      makeCase({ id: 'a', category: 'escape' }),
      makeCase({ id: 'b', category: 'injection' }),
    ];
    const checker: SecurityChecker = async () => ({
      blocked: true,
      detected: true,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.suiteName).toBe('escape-security-suite');
  });
});

// ---------------------------------------------------------------------------
// Checker interaction
// ---------------------------------------------------------------------------

describe('runSecuritySuite — checker interaction', () => {
  it('should call checker once per test case', async () => {
    const checker = vi.fn<SecurityChecker>(async () => ({
      blocked: true,
      detected: true,
    }));

    await runSecuritySuite(INJECTION_SUITE, checker);
    expect(checker).toHaveBeenCalledTimes(INJECTION_SUITE.length);
  });

  it('should pass the test case input to the checker', async () => {
    const receivedInputs: string[] = [];
    const checker: SecurityChecker = async (input) => {
      receivedInputs.push(input);
      return { blocked: true, detected: true };
    };

    const suite = [
      makeCase({ id: 'a', input: 'alpha' }),
      makeCase({ id: 'b', input: 'beta' }),
    ];
    await runSecuritySuite(suite, checker);

    expect(receivedInputs).toEqual(['alpha', 'beta']);
  });

  it('should call checker sequentially (order preserved)', async () => {
    const callOrder: string[] = [];
    const suite = [
      makeCase({ id: 'first', input: 'first-input' }),
      makeCase({ id: 'second', input: 'second-input' }),
      makeCase({ id: 'third', input: 'third-input' }),
    ];

    const checker: SecurityChecker = async (input) => {
      callOrder.push(input);
      return { blocked: true, detected: true };
    };

    await runSecuritySuite(suite, checker);
    expect(callOrder).toEqual(['first-input', 'second-input', 'third-input']);
  });
});

// ---------------------------------------------------------------------------
// Pass rate and aggregation
// ---------------------------------------------------------------------------

describe('runSecuritySuite — pass rate and aggregation', () => {
  it('should return passRate=1 when all cases pass', async () => {
    const suite = [
      makeCase({ id: 'a', expectedBehavior: 'block' }),
      makeCase({ id: 'b', expectedBehavior: 'block' }),
    ];
    const checker: SecurityChecker = async () => ({
      blocked: true,
      detected: false,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.passRate).toBe(1);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
  });

  it('should return passRate=0 when all cases fail', async () => {
    const suite = [
      makeCase({ id: 'a', expectedBehavior: 'block' }),
      makeCase({ id: 'b', expectedBehavior: 'block' }),
    ];
    const checker: SecurityChecker = async () => ({
      blocked: false,
      detected: false,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.passRate).toBe(0);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(2);
  });

  it('should compute correct passRate for mixed results', async () => {
    const suite = [
      makeCase({ id: 'a', expectedBehavior: 'block' }),
      makeCase({ id: 'b', expectedBehavior: 'safe' }),
      makeCase({ id: 'c', expectedBehavior: 'detect' }),
    ];
    // blocked=true, detected=false -> block passes, safe fails, detect passes (via blocked)
    const checker: SecurityChecker = async () => ({
      blocked: true,
      detected: false,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.passRate).toBeCloseTo(2 / 3, 5);
  });

  it('totalCases should equal passed + failed', async () => {
    const checker: SecurityChecker = async () => ({
      blocked: true,
      detected: true,
    });
    const result = await runSecuritySuite(POISONING_SUITE, checker);
    expect(result.totalCases).toBe(result.passed + result.failed);
  });

  it('results array length should equal totalCases', async () => {
    const checker: SecurityChecker = async () => ({
      blocked: false,
      detected: false,
    });
    const result = await runSecuritySuite(ESCALATION_SUITE, checker);
    expect(result.results.length).toBe(result.totalCases);
  });
});

// ---------------------------------------------------------------------------
// Details string formatting
// ---------------------------------------------------------------------------

describe('runSecuritySuite — details formatting', () => {
  it('should include [PASS] prefix for passing tests', async () => {
    const suite = [makeCase({ expectedBehavior: 'block' })];
    const checker: SecurityChecker = async () => ({
      blocked: true,
      detected: false,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.results[0]!.details).toContain('[PASS]');
  });

  it('should include [FAIL] prefix for failing tests', async () => {
    const suite = [makeCase({ expectedBehavior: 'block' })];
    const checker: SecurityChecker = async () => ({
      blocked: false,
      detected: false,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.results[0]!.details).toContain('[FAIL]');
  });

  it('should include the test case name in details', async () => {
    const suite = [makeCase({ name: 'My Custom Test' })];
    const checker: SecurityChecker = async () => ({
      blocked: true,
      detected: true,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.results[0]!.details).toContain('My Custom Test');
  });

  it('should include expectedBehavior in details', async () => {
    const suite = [makeCase({ expectedBehavior: 'detect' })];
    const checker: SecurityChecker = async () => ({
      blocked: false,
      detected: true,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.results[0]!.details).toContain('expected=detect');
  });

  it('should include blocked and detected values in details', async () => {
    const suite = [makeCase({ expectedBehavior: 'block' })];
    const checker: SecurityChecker = async () => ({
      blocked: true,
      detected: false,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.results[0]!.details).toContain('blocked=true');
    expect(result.results[0]!.details).toContain('detected=false');
  });

  it('should include checker details when provided', async () => {
    const suite = [makeCase({ expectedBehavior: 'block' })];
    const checker: SecurityChecker = async () => ({
      blocked: true,
      detected: false,
      details: 'Pattern XSS-42 matched',
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.results[0]!.details).toContain('Pattern XSS-42 matched');
  });

  it('should not include parenthesized details when checker details is undefined', async () => {
    const suite = [makeCase({ expectedBehavior: 'block' })];
    const checker: SecurityChecker = async () => ({
      blocked: true,
      detected: false,
    });
    const result = await runSecuritySuite(suite, checker);
    // Should not have trailing "()" or "(undefined)"
    expect(result.results[0]!.details).not.toContain('(undefined)');
    expect(result.results[0]!.details).not.toContain('()');
  });
});

// ---------------------------------------------------------------------------
// Running all four built-in suites with mocked checkers
// ---------------------------------------------------------------------------

describe('runSecuritySuite — all built-in suites', () => {
  const allSuites = [
    { name: 'INJECTION_SUITE', suite: INJECTION_SUITE },
    { name: 'POISONING_SUITE', suite: POISONING_SUITE },
    { name: 'ESCALATION_SUITE', suite: ESCALATION_SUITE },
    { name: 'ESCAPE_SUITE', suite: ESCAPE_SUITE },
  ];

  for (const { name, suite } of allSuites) {
    it(`should run ${name} with a selective checker correctly`, async () => {
      // Checker that blocks only inputs containing "ignore" or "admin"
      const selectiveChecker: SecurityChecker = async (input) => {
        const lower = input.toLowerCase();
        const blocked =
          lower.includes('ignore') || lower.includes('admin');
        const detected =
          blocked || lower.includes('password') || lower.includes('secret');
        return { blocked, detected };
      };

      const result = await runSecuritySuite(suite, selectiveChecker);

      expect(result.totalCases).toBe(suite.length);
      expect(result.passed + result.failed).toBe(suite.length);
      expect(result.passRate).toBeGreaterThanOrEqual(0);
      expect(result.passRate).toBeLessThanOrEqual(1);
      expect(result.results.length).toBe(suite.length);
    });
  }
});

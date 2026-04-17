import { describe, it, expect, vi } from 'vitest';
import { runSecuritySuite } from '../security/security-runner.js';
import type {
  SecurityTestCase,
  SecurityChecker,
} from '../security/security-test-types.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeCase(overrides: Partial<SecurityTestCase>): SecurityTestCase {
  return {
    id: 'edge-001',
    category: 'injection',
    name: 'Edge case',
    description: 'Edge case for testing',
    severity: 'high',
    input: 'edge input',
    expectedBehavior: 'block',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Default / unknown expectedBehavior branch (line 78 coverage)
// ---------------------------------------------------------------------------

describe('runSecuritySuite — unknown expectedBehavior', () => {
  it('should fail a case with an unknown expectedBehavior value', async () => {
    // Force an unknown expectedBehavior by casting
    const suite = [
      makeCase({ expectedBehavior: 'unknown' as SecurityTestCase['expectedBehavior'] }),
    ];
    const checker: SecurityChecker = async () => ({
      blocked: true,
      detected: true,
    });
    const result = await runSecuritySuite(suite, checker);
    // The default branch returns false
    expect(result.results[0]!.passed).toBe(false);
  });

  it('should include [FAIL] in details for unknown expectedBehavior', async () => {
    const suite = [
      makeCase({ expectedBehavior: 'invalid' as SecurityTestCase['expectedBehavior'] }),
    ];
    const checker: SecurityChecker = async () => ({
      blocked: true,
      detected: true,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.results[0]!.details).toContain('[FAIL]');
  });
});

// ---------------------------------------------------------------------------
// Async checker behavior
// ---------------------------------------------------------------------------

describe('runSecuritySuite — async checker behavior', () => {
  it('should handle a checker that resolves after a delay', async () => {
    const suite = [makeCase({ expectedBehavior: 'block' })];
    const checker: SecurityChecker = async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { blocked: true, detected: false };
    };
    const result = await runSecuritySuite(suite, checker);
    expect(result.results[0]!.passed).toBe(true);
  });

  it('should propagate checker errors as rejections', async () => {
    const suite = [makeCase({ expectedBehavior: 'block' })];
    const checker: SecurityChecker = async () => {
      throw new Error('checker crashed');
    };
    await expect(runSecuritySuite(suite, checker)).rejects.toThrow('checker crashed');
  });

  it('should stop processing on first checker error', async () => {
    const callCount = { value: 0 };
    const suite = [
      makeCase({ id: 'a', expectedBehavior: 'block' }),
      makeCase({ id: 'b', expectedBehavior: 'block' }),
      makeCase({ id: 'c', expectedBehavior: 'block' }),
    ];
    const checker: SecurityChecker = async () => {
      callCount.value++;
      if (callCount.value === 2) {
        throw new Error('crash on second');
      }
      return { blocked: true, detected: false };
    };
    await expect(runSecuritySuite(suite, checker)).rejects.toThrow('crash on second');
    expect(callCount.value).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Single-case suites
// ---------------------------------------------------------------------------

describe('runSecuritySuite — single case suites', () => {
  it('should handle a single block case that passes', async () => {
    const suite = [makeCase({ expectedBehavior: 'block' })];
    const checker: SecurityChecker = async () => ({
      blocked: true,
      detected: false,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.totalCases).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.passRate).toBe(1);
  });

  it('should handle a single safe case that passes', async () => {
    const suite = [makeCase({ expectedBehavior: 'safe' })];
    const checker: SecurityChecker = async () => ({
      blocked: false,
      detected: false,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.passed).toBe(1);
    expect(result.passRate).toBe(1);
  });

  it('should handle a single detect case that passes', async () => {
    const suite = [makeCase({ expectedBehavior: 'detect' })];
    const checker: SecurityChecker = async () => ({
      blocked: false,
      detected: true,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.passed).toBe(1);
    expect(result.passRate).toBe(1);
  });

  it('should handle a single failing case', async () => {
    const suite = [makeCase({ expectedBehavior: 'block' })];
    const checker: SecurityChecker = async () => ({
      blocked: false,
      detected: false,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.passRate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Details formatting edge cases
// ---------------------------------------------------------------------------

describe('runSecuritySuite — details edge cases', () => {
  it('should include expected= for all three behavior types', async () => {
    const behaviors: Array<SecurityTestCase['expectedBehavior']> = ['block', 'detect', 'safe'];
    for (const behavior of behaviors) {
      const suite = [makeCase({ id: `det-${behavior}`, expectedBehavior: behavior })];
      const checker: SecurityChecker = async () => ({
        blocked: true,
        detected: true,
      });
      const result = await runSecuritySuite(suite, checker);
      expect(result.results[0]!.details).toContain(`expected=${behavior}`);
    }
  });

  it('should format details with empty string checker details', async () => {
    const suite = [makeCase({ expectedBehavior: 'block' })];
    const checker: SecurityChecker = async () => ({
      blocked: true,
      detected: false,
      details: '',
    });
    const result = await runSecuritySuite(suite, checker);
    // Empty string is falsy so no parenthesized details
    expect(result.results[0]!.details).not.toContain('()');
  });

  it('should handle very long checker details', async () => {
    const longDetails = 'x'.repeat(1000);
    const suite = [makeCase({ expectedBehavior: 'block' })];
    const checker: SecurityChecker = async () => ({
      blocked: true,
      detected: false,
      details: longDetails,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.results[0]!.details).toContain(longDetails);
  });

  it('should handle special characters in test case name', async () => {
    const suite = [makeCase({ name: 'Test <with> "special" & chars' })];
    const checker: SecurityChecker = async () => ({
      blocked: true,
      detected: false,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.results[0]!.details).toContain('Test <with> "special" & chars');
  });
});

// ---------------------------------------------------------------------------
// Category derivation edge cases
// ---------------------------------------------------------------------------

describe('runSecuritySuite — category derivation edge cases', () => {
  const categories: Array<SecurityTestCase['category']> = [
    'injection',
    'escalation',
    'poisoning',
    'escape',
    'data-leak',
    'dos',
  ];

  for (const cat of categories) {
    it(`should derive suite name for category "${cat}"`, async () => {
      const suite = [makeCase({ category: cat })];
      const checker: SecurityChecker = async () => ({
        blocked: true,
        detected: true,
      });
      const result = await runSecuritySuite(suite, checker);
      expect(result.suiteName).toBe(`${cat}-security-suite`);
    });
  }
});

// ---------------------------------------------------------------------------
// Large suite
// ---------------------------------------------------------------------------

describe('runSecuritySuite — large suite', () => {
  it('should handle a suite with 100 cases', async () => {
    const suite: SecurityTestCase[] = [];
    for (let i = 0; i < 100; i++) {
      suite.push(
        makeCase({
          id: `large-${i}`,
          expectedBehavior: i % 3 === 0 ? 'block' : i % 3 === 1 ? 'detect' : 'safe',
        }),
      );
    }
    const checker: SecurityChecker = async () => ({
      blocked: true,
      detected: true,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.totalCases).toBe(100);
    // block (i%3===0): 34 cases pass (blocked=true)
    // detect (i%3===1): 33 cases pass (blocked || detected)
    // safe (i%3===2): 33 cases fail (blocked=true)
    expect(result.passed).toBe(67);
    expect(result.failed).toBe(33);
    expect(result.passRate).toBeCloseTo(0.67, 1);
  });
});

// ---------------------------------------------------------------------------
// Checker receives correct input for each case
// ---------------------------------------------------------------------------

describe('runSecuritySuite — input routing', () => {
  it('should route each input to the checker in order', async () => {
    const inputs: string[] = [];
    const suite = [
      makeCase({ id: 'r1', input: 'first-input' }),
      makeCase({ id: 'r2', input: 'second-input' }),
      makeCase({ id: 'r3', input: 'third-input' }),
    ];
    const checker: SecurityChecker = async (input) => {
      inputs.push(input);
      return { blocked: true, detected: false };
    };
    await runSecuritySuite(suite, checker);
    expect(inputs).toEqual(['first-input', 'second-input', 'third-input']);
  });

  it('should pass very long input strings to the checker', async () => {
    const longInput = 'A'.repeat(10000);
    let receivedInput = '';
    const suite = [makeCase({ input: longInput })];
    const checker: SecurityChecker = async (input) => {
      receivedInput = input;
      return { blocked: true, detected: false };
    };
    await runSecuritySuite(suite, checker);
    expect(receivedInput).toBe(longInput);
    expect(receivedInput.length).toBe(10000);
  });

  it('should pass input with newlines and whitespace intact', async () => {
    const multiline = 'line1\nline2\n\tindented\n  spaces';
    let receivedInput = '';
    const suite = [makeCase({ input: multiline })];
    const checker: SecurityChecker = async (input) => {
      receivedInput = input;
      return { blocked: true, detected: false };
    };
    await runSecuritySuite(suite, checker);
    expect(receivedInput).toBe(multiline);
  });
});

// ---------------------------------------------------------------------------
// Result caseId matches test case id
// ---------------------------------------------------------------------------

describe('runSecuritySuite — result caseId mapping', () => {
  it('should assign the correct caseId to each result', async () => {
    const suite = [
      makeCase({ id: 'alpha' }),
      makeCase({ id: 'beta' }),
      makeCase({ id: 'gamma' }),
    ];
    const checker: SecurityChecker = async () => ({
      blocked: true,
      detected: true,
    });
    const result = await runSecuritySuite(suite, checker);
    expect(result.results.map((r) => r.caseId)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });
});

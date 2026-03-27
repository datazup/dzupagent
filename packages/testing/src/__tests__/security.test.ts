import { describe, it, expect } from 'vitest';
import { INJECTION_SUITE } from '../security/injection-suite.js';
import { ESCALATION_SUITE } from '../security/escalation-suite.js';
import { POISONING_SUITE } from '../security/poisoning-suite.js';
import { ESCAPE_SUITE } from '../security/escape-suite.js';
import { runSecuritySuite } from '../security/security-runner.js';
import type { SecurityTestCase, SecurityChecker } from '../security/security-test-types.js';

// ---------------------------------------------------------------------------
// Suite structure validation
// ---------------------------------------------------------------------------

describe('Security Suites — structure validation', () => {
  const suites: Array<{ name: string; suite: SecurityTestCase[] }> = [
    { name: 'INJECTION_SUITE', suite: INJECTION_SUITE },
    { name: 'ESCALATION_SUITE', suite: ESCALATION_SUITE },
    { name: 'POISONING_SUITE', suite: POISONING_SUITE },
    { name: 'ESCAPE_SUITE', suite: ESCAPE_SUITE },
  ];

  for (const { name, suite } of suites) {
    describe(name, () => {
      it('should have at least 5 test cases', () => {
        expect(suite.length).toBeGreaterThanOrEqual(5);
      });

      it('should have unique IDs', () => {
        const ids = suite.map((tc) => tc.id);
        expect(new Set(ids).size).toBe(ids.length);
      });

      it('should have all required fields on each case', () => {
        for (const tc of suite) {
          expect(tc.id).toBeTruthy();
          expect(tc.category).toBeTruthy();
          expect(tc.name).toBeTruthy();
          expect(tc.description).toBeTruthy();
          expect(tc.severity).toBeTruthy();
          expect(tc.input).toBeTruthy();
          expect(tc.expectedBehavior).toBeTruthy();
        }
      });

      it('should have valid category values', () => {
        const validCategories = ['injection', 'escalation', 'poisoning', 'escape', 'data-leak', 'dos'];
        for (const tc of suite) {
          expect(validCategories).toContain(tc.category);
        }
      });

      it('should have valid severity values', () => {
        const validSeverities = ['low', 'medium', 'high', 'critical'];
        for (const tc of suite) {
          expect(validSeverities).toContain(tc.severity);
        }
      });

      it('should have valid expectedBehavior values', () => {
        const validBehaviors = ['block', 'detect', 'safe'];
        for (const tc of suite) {
          expect(validBehaviors).toContain(tc.expectedBehavior);
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// runSecuritySuite
// ---------------------------------------------------------------------------

describe('runSecuritySuite', () => {
  it('should return correct pass/fail counts with a blocking checker', async () => {
    // Checker that blocks everything
    const blockAll: SecurityChecker = async (_input) => ({
      blocked: true,
      detected: true,
    });

    const result = await runSecuritySuite(INJECTION_SUITE, blockAll);

    expect(result.suiteName).toContain('injection');
    expect(result.totalCases).toBe(INJECTION_SUITE.length);

    // Cases with expectedBehavior 'block' or 'detect' should pass;
    // cases with expectedBehavior 'safe' should fail
    const safeCases = INJECTION_SUITE.filter((tc) => tc.expectedBehavior === 'safe').length;
    const nonSafeCases = INJECTION_SUITE.length - safeCases;

    expect(result.passed).toBe(nonSafeCases);
    expect(result.failed).toBe(safeCases);
  });

  it('should return correct pass/fail counts with a permissive checker', async () => {
    // Checker that never blocks or detects
    const permitAll: SecurityChecker = async (_input) => ({
      blocked: false,
      detected: false,
    });

    const result = await runSecuritySuite(INJECTION_SUITE, permitAll);

    // Only 'safe' cases should pass
    const safeCases = INJECTION_SUITE.filter((tc) => tc.expectedBehavior === 'safe').length;

    expect(result.passed).toBe(safeCases);
    expect(result.failed).toBe(INJECTION_SUITE.length - safeCases);
  });

  it('should calculate passRate correctly', async () => {
    const blockAll: SecurityChecker = async (_input) => ({
      blocked: true,
      detected: true,
    });

    const result = await runSecuritySuite(INJECTION_SUITE, blockAll);

    const expectedPassRate = result.passed / result.totalCases;
    expect(result.passRate).toBeCloseTo(expectedPassRate, 5);
  });

  it('should include details for each result', async () => {
    const checker: SecurityChecker = async (_input) => ({
      blocked: true,
      detected: false,
      details: 'Blocked by pattern match',
    });

    const result = await runSecuritySuite(INJECTION_SUITE, checker);

    for (const r of result.results) {
      expect(r.details).toBeTruthy();
      expect(r.caseId).toBeTruthy();
      expect(r.category).toBeTruthy();
      expect(r.severity).toBeTruthy();
      expect(typeof r.passed).toBe('boolean');
    }
  });

  it('should handle detect-only checker correctly', async () => {
    // Checker that detects but does not block
    const detectOnly: SecurityChecker = async (_input) => ({
      blocked: false,
      detected: true,
    });

    const result = await runSecuritySuite(INJECTION_SUITE, detectOnly);

    // 'block' cases should fail (not blocked), 'detect' cases should pass, 'safe' cases should fail
    for (const r of result.results) {
      const tc = INJECTION_SUITE.find((t) => t.id === r.caseId)!;
      if (tc.expectedBehavior === 'detect') {
        expect(r.passed).toBe(true);
      } else if (tc.expectedBehavior === 'block') {
        expect(r.passed).toBe(false);
      } else if (tc.expectedBehavior === 'safe') {
        expect(r.passed).toBe(false);
      }
    }
  });

  it('should handle empty suite gracefully', async () => {
    const checker: SecurityChecker = async (_input) => ({
      blocked: false,
      detected: false,
    });

    const result = await runSecuritySuite([], checker);

    expect(result.totalCases).toBe(0);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.passRate).toBe(0);
    expect(result.results).toEqual([]);
  });

  it('should preserve category and severity in results', async () => {
    const checker: SecurityChecker = async (_input) => ({
      blocked: true,
      detected: true,
    });

    const result = await runSecuritySuite(ESCALATION_SUITE, checker);

    for (const r of result.results) {
      const tc = ESCALATION_SUITE.find((t) => t.id === r.caseId)!;
      expect(r.category).toBe(tc.category);
      expect(r.severity).toBe(tc.severity);
    }
  });
});

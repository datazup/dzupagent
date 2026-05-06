/**
 * Tests for BenchmarkOrchestrator.regressionGate (RF-38 / AGENT-107).
 *
 * All tests are fully deterministic — no network calls, no LLM, no filesystem.
 * BenchmarkRunRecord fixtures are constructed inline.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { BenchmarkRunRecord, BenchmarkRunStore, BenchmarkRunListPage } from '@dzupagent/eval-contracts';
import { BenchmarkOrchestrator, RegressionGateError } from '../orchestrator/benchmark-orchestrator.js';
import type { RegressionGateResult } from '../orchestrator/benchmark-orchestrator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal no-op store — regression gate never touches the store. */
function makeNoopStore(): BenchmarkRunStore {
  return {
    async saveRun() { /* no-op */ },
    async getRun() { return null; },
    async listRuns(): Promise<BenchmarkRunListPage> {
      return { data: [], nextCursor: null, hasMore: false };
    },
    async saveBaseline() { /* no-op */ },
    async getBaseline() { return null; },
    async listBaselines() { return []; },
  };
}

/**
 * Build a minimal BenchmarkRunRecord with the supplied scores.
 * Scores are a map of scorerId → value (0..1).
 */
function makeRun(
  id: string,
  suiteId: string,
  scores: Record<string, number>,
): BenchmarkRunRecord {
  return {
    id,
    suiteId,
    targetId: 'test-target',
    strict: true,
    createdAt: new Date().toISOString(),
    result: {
      suiteId,
      timestamp: new Date().toISOString(),
      scores,
      passedBaseline: true,
      regressions: [],
    },
  };
}

/** Create an orchestrator with no real suites (only the gate is exercised). */
function makeOrchestrator(): BenchmarkOrchestrator {
  return new BenchmarkOrchestrator({
    suites: {},
    executeTarget: async () => '',
    store: makeNoopStore(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BenchmarkOrchestrator.regressionGate', () => {
  let orchestrator: BenchmarkOrchestrator;

  beforeEach(() => {
    orchestrator = makeOrchestrator();
  });

  // -------------------------------------------------------------------------
  // Passing cases
  // -------------------------------------------------------------------------

  describe('non-regressing run', () => {
    it('should return passed=true when all scores are identical', () => {
      const baseline = makeRun('b1', 's1', { accuracy: 0.8, f1: 0.75 });
      const current  = makeRun('c1', 's1', { accuracy: 0.8, f1: 0.75 });

      const result: RegressionGateResult = orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      });

      expect(result.passed).toBe(true);
      expect(result.regressions).toEqual([]);
    });

    it('should return passed=true when all scores improved', () => {
      const baseline = makeRun('b1', 's1', { accuracy: 0.6, f1: 0.55 });
      const current  = makeRun('c1', 's1', { accuracy: 0.9, f1: 0.85 });

      const result = orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      });

      expect(result.passed).toBe(true);
      expect(result.regressions).toEqual([]);
    });

    it('should return passed=true when drop is exactly equal to threshold', () => {
      // delta = 0.70 - 0.75 = -0.05 which equals -threshold → must NOT fail
      const baseline = makeRun('b1', 's1', { accuracy: 0.75 });
      const current  = makeRun('c1', 's1', { accuracy: 0.70 });

      const result = orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      });

      expect(result.passed).toBe(true);
      expect(result.regressions).toEqual([]);
    });

    it('should return passed=true with threshold=0 when scores are unchanged', () => {
      const baseline = makeRun('b1', 's1', { accuracy: 0.9 });
      const current  = makeRun('c1', 's1', { accuracy: 0.9 });

      const result = orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0,
      });

      expect(result.passed).toBe(true);
    });

    it('should pass when a scorer is new in current (not in baseline)', () => {
      // New scorers in current that are absent from baseline should be ignored
      const baseline = makeRun('b1', 's1', { accuracy: 0.8 });
      const current  = makeRun('c1', 's1', { accuracy: 0.8, newScorer: 0.9 });

      const result = orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      });

      expect(result.passed).toBe(true);
      expect(result.regressions).toEqual([]);
    });

    it('should pass with mixed improvement and acceptable regression', () => {
      const baseline = makeRun('b1', 's1', { accuracy: 0.8, latency: 0.9 });
      // accuracy improved, latency dropped by exactly the threshold
      const current  = makeRun('c1', 's1', { accuracy: 0.95, latency: 0.85 });

      const result = orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      });

      expect(result.passed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Failing cases
  // -------------------------------------------------------------------------

  describe('regressing run', () => {
    it('should throw RegressionGateError when a scorer drops beyond threshold', () => {
      const baseline = makeRun('b1', 's1', { accuracy: 0.9 });
      const current  = makeRun('c1', 's1', { accuracy: 0.7 }); // delta = -0.2

      expect(() =>
        orchestrator.regressionGate({
          currentRun: current,
          baselineRun: baseline,
          threshold: 0.05,
        }),
      ).toThrow(RegressionGateError);
    });

    it('should include regression details in the thrown error', () => {
      const baseline = makeRun('b1', 's1', { accuracy: 0.9, f1: 0.8 });
      const current  = makeRun('c1', 's1', { accuracy: 0.7, f1: 0.6 });

      let caught: RegressionGateError | undefined;
      try {
        orchestrator.regressionGate({
          currentRun: current,
          baselineRun: baseline,
          threshold: 0.05,
        });
      } catch (err) {
        if (err instanceof RegressionGateError) caught = err;
      }

      expect(caught).toBeDefined();
      expect(caught?.regressions).toHaveLength(2);

      const accuracyRegression = caught?.regressions.find((r) => r.suiteName === 'accuracy');
      expect(accuracyRegression).toBeDefined();
      expect(accuracyRegression?.baseline).toBeCloseTo(0.9);
      expect(accuracyRegression?.current).toBeCloseTo(0.7);
      expect(accuracyRegression?.delta).toBeCloseTo(-0.2);

      const f1Regression = caught?.regressions.find((r) => r.suiteName === 'f1');
      expect(f1Regression).toBeDefined();
      expect(f1Regression?.delta).toBeCloseTo(-0.2);
    });

    it('should throw when only one of multiple scorers regresses', () => {
      const baseline = makeRun('b1', 's1', { accuracy: 0.9, f1: 0.8 });
      // accuracy improved, f1 regressed beyond threshold
      const current  = makeRun('c1', 's1', { accuracy: 0.95, f1: 0.6 });

      let caught: RegressionGateError | undefined;
      try {
        orchestrator.regressionGate({
          currentRun: current,
          baselineRun: baseline,
          threshold: 0.05,
        });
      } catch (err) {
        if (err instanceof RegressionGateError) caught = err;
      }

      expect(caught).toBeDefined();
      expect(caught?.regressions).toHaveLength(1);
      expect(caught?.regressions[0]?.suiteName).toBe('f1');
    });

    it('error message should contain the suite name and scores', () => {
      const baseline = makeRun('b1', 's1', { accuracy: 0.9 });
      const current  = makeRun('c1', 's1', { accuracy: 0.5 });

      try {
        orchestrator.regressionGate({
          currentRun: current,
          baselineRun: baseline,
          threshold: 0.05,
        });
        expect.fail('Expected RegressionGateError to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RegressionGateError);
        const message = (err as RegressionGateError).message;
        expect(message).toContain('accuracy');
        expect(message).toContain('0.9000');
        expect(message).toContain('0.5000');
      }
    });

    it('error name should be RegressionGateError', () => {
      const baseline = makeRun('b1', 's1', { accuracy: 0.9 });
      const current  = makeRun('c1', 's1', { accuracy: 0.5 });

      try {
        orchestrator.regressionGate({ currentRun: current, baselineRun: baseline, threshold: 0.05 });
      } catch (err) {
        expect((err as Error).name).toBe('RegressionGateError');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Threshold boundary
  // -------------------------------------------------------------------------

  describe('threshold boundary', () => {
    it('should pass when delta equals exactly -threshold (boundary: inclusive pass)', () => {
      // delta = 0.50 - 0.55 = -0.05; threshold = 0.05 → -0.05 is NOT < -0.05 → pass
      const baseline = makeRun('b1', 's1', { s: 0.55 });
      const current  = makeRun('c1', 's1', { s: 0.50 });

      expect(() =>
        orchestrator.regressionGate({ currentRun: current, baselineRun: baseline, threshold: 0.05 }),
      ).not.toThrow();
    });

    it('should fail when delta is one epsilon below -threshold (boundary: just over)', () => {
      // delta = 0.4999 - 0.55 ≈ -0.0501; threshold = 0.05 → -0.0501 < -0.05 → fail
      const baseline = makeRun('b1', 's1', { s: 0.55 });
      const current  = makeRun('c1', 's1', { s: 0.4999 });

      expect(() =>
        orchestrator.regressionGate({ currentRun: current, baselineRun: baseline, threshold: 0.05 }),
      ).toThrow(RegressionGateError);
    });

    it('should pass with threshold=0 when delta is exactly 0', () => {
      const baseline = makeRun('b1', 's1', { s: 0.8 });
      const current  = makeRun('c1', 's1', { s: 0.8 });

      expect(() =>
        orchestrator.regressionGate({ currentRun: current, baselineRun: baseline, threshold: 0 }),
      ).not.toThrow();
    });

    it('should fail with threshold=0 when any score drops even slightly', () => {
      const baseline = makeRun('b1', 's1', { s: 0.8 });
      const current  = makeRun('c1', 's1', { s: 0.7999 });

      expect(() =>
        orchestrator.regressionGate({ currentRun: current, baselineRun: baseline, threshold: 0 }),
      ).toThrow(RegressionGateError);
    });

    it('should pass with a generous threshold even on significant regression', () => {
      const baseline = makeRun('b1', 's1', { s: 0.9 });
      const current  = makeRun('c1', 's1', { s: 0.5 }); // delta = -0.4

      // threshold = 0.5 → -0.4 is NOT < -0.5 → pass
      expect(() =>
        orchestrator.regressionGate({ currentRun: current, baselineRun: baseline, threshold: 0.5 }),
      ).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should pass when baseline has no scorers', () => {
      const baseline = makeRun('b1', 's1', {});
      const current  = makeRun('c1', 's1', { accuracy: 0.9 });

      const result = orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      });

      expect(result.passed).toBe(true);
      expect(result.regressions).toEqual([]);
    });

    it('should treat a scorer absent from current as score=0', () => {
      // baseline has accuracy=0.9, current has no accuracy scorer
      // delta = 0 - 0.9 = -0.9 which is < -0.05 → regression
      const baseline = makeRun('b1', 's1', { accuracy: 0.9 });
      const current  = makeRun('c1', 's1', {});

      expect(() =>
        orchestrator.regressionGate({ currentRun: current, baselineRun: baseline, threshold: 0.05 }),
      ).toThrow(RegressionGateError);
    });

    it('should throw RangeError when threshold is negative', () => {
      const baseline = makeRun('b1', 's1', { accuracy: 0.9 });
      const current  = makeRun('c1', 's1', { accuracy: 0.9 });

      expect(() =>
        orchestrator.regressionGate({ currentRun: current, baselineRun: baseline, threshold: -0.1 }),
      ).toThrow(RangeError);
    });

    it('should handle scores at the extremes (0 and 1)', () => {
      const baseline = makeRun('b1', 's1', { accuracy: 1.0 });
      const current  = makeRun('c1', 's1', { accuracy: 0.0 }); // maximum regression

      let caught: RegressionGateError | undefined;
      try {
        orchestrator.regressionGate({ currentRun: current, baselineRun: baseline, threshold: 0.05 });
      } catch (err) {
        if (err instanceof RegressionGateError) caught = err;
      }

      expect(caught).toBeDefined();
      expect(caught?.regressions[0]?.delta).toBeCloseTo(-1.0);
    });
  });

  // -------------------------------------------------------------------------
  // RegressionGateError class
  // -------------------------------------------------------------------------

  describe('RegressionGateError', () => {
    it('should be an instance of Error', () => {
      const err = new RegressionGateError([
        { suiteName: 'accuracy', baseline: 0.9, current: 0.7, delta: -0.2 },
      ]);
      expect(err).toBeInstanceOf(Error);
    });

    it('should carry the regressions array', () => {
      const regressions = [
        { suiteName: 'accuracy', baseline: 0.9, current: 0.7, delta: -0.2 },
        { suiteName: 'f1', baseline: 0.8, current: 0.6, delta: -0.2 },
      ];
      const err = new RegressionGateError(regressions);
      expect(err.regressions).toEqual(regressions);
    });

    it('should format the message with suite details', () => {
      const err = new RegressionGateError([
        { suiteName: 'my-suite', baseline: 0.85, current: 0.6, delta: -0.25 },
      ]);
      expect(err.message).toContain('my-suite');
      expect(err.message).toContain('0.8500');
      expect(err.message).toContain('0.6000');
      expect(err.message).toContain('-0.2500');
    });

    it('should report the count of failing suites', () => {
      const err = new RegressionGateError([
        { suiteName: 'a', baseline: 0.9, current: 0.5, delta: -0.4 },
        { suiteName: 'b', baseline: 0.8, current: 0.4, delta: -0.4 },
      ]);
      expect(err.message).toContain('2 suite(s)');
    });
  });
});

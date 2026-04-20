import { describe, it, expect } from 'vitest';
import { runEvalSuite } from '../../eval/runner.js';
import { ExactMatchScorer } from '../../eval/scorers/exact-match.js';
import { RegexScorer } from '../../eval/scorers/regex.js';
import type { EvalSuite } from '../../eval/types.js';

// Simple deterministic target
const echoTarget = async (input: string): Promise<string> => input;
const upperTarget = async (input: string): Promise<string> => input.toUpperCase();

describe('runEvalSuite', () => {
  it('returns correct suiteName and timestamp', async () => {
    const suite: EvalSuite = {
      name: 'test-suite',
      target: echoTarget,
      cases: [{ id: 'c1', input: 'hello', expected: 'hello' }],
      scorers: [new ExactMatchScorer()],
    };
    const result = await runEvalSuite(suite);
    expect(result.suiteName).toBe('test-suite');
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('allPassed=true when all cases pass', async () => {
    const suite: EvalSuite = {
      name: 's',
      target: echoTarget,
      cases: [
        { id: 'c1', input: 'Paris', expected: 'Paris' },
        { id: 'c2', input: 'Berlin', expected: 'Berlin' },
      ],
      scorers: [new ExactMatchScorer()],
    };
    const result = await runEvalSuite(suite);
    expect(result.allPassed).toBe(true);
    expect(result.passRate).toBe(1.0);
  });

  it('allPassed=false when a case fails', async () => {
    const suite: EvalSuite = {
      name: 's',
      target: echoTarget,
      cases: [
        { id: 'c1', input: 'Paris', expected: 'Paris' },
        { id: 'c2', input: 'berlin', expected: 'Berlin' }, // case mismatch
      ],
      scorers: [new ExactMatchScorer()], // case-sensitive
    };
    const result = await runEvalSuite(suite);
    expect(result.allPassed).toBe(false);
    expect(result.passRate).toBeLessThan(1.0);
  });

  it('each case result includes caseId, input, output and scorerScores', async () => {
    const suite: EvalSuite = {
      name: 's',
      target: echoTarget,
      cases: [{ id: 'echo', input: 'hello', expected: 'hello' }],
      scorers: [new ExactMatchScorer()],
    };
    const result = await runEvalSuite(suite);
    const caseResult = result.cases[0];
    expect(caseResult).toBeDefined();
    expect(caseResult!.caseId).toBe('echo');
    expect(caseResult!.input).toBe('hello');
    expect(caseResult!.output).toBe('hello');
    expect(caseResult!.scorerScores).toHaveLength(1);
    expect(caseResult!.scorerScores[0]!.scorerId).toBe('exact-match');
  });

  it('aggregateScore is mean of scorer scores', async () => {
    // ExactMatch passes (1.0), Regex for digits fails (0.0) on 'hello'
    const suite: EvalSuite = {
      name: 's',
      target: echoTarget,
      cases: [{ id: 'c1', input: 'hello', expected: 'hello' }],
      scorers: [new ExactMatchScorer(), new RegexScorer({ pattern: /^\d+$/ })],
    };
    const result = await runEvalSuite(suite);
    expect(result.cases[0]!.aggregateScore).toBe(0.5); // (1.0 + 0.0) / 2
  });

  it('respects custom passThreshold', async () => {
    // aggregate will be 0.5 (exact passes, regex fails)
    const suite: EvalSuite = {
      name: 's',
      target: echoTarget,
      passThreshold: 0.4, // lower threshold — should pass
      cases: [{ id: 'c1', input: 'hello', expected: 'hello' }],
      scorers: [new ExactMatchScorer(), new RegexScorer({ pattern: /^\d+$/ })],
    };
    const result = await runEvalSuite(suite);
    expect(result.cases[0]!.pass).toBe(true);
  });

  it('handles empty cases array', async () => {
    const suite: EvalSuite = {
      name: 'empty',
      target: echoTarget,
      cases: [],
      scorers: [new ExactMatchScorer()],
    };
    const result = await runEvalSuite(suite);
    expect(result.cases).toHaveLength(0);
    expect(result.aggregateScore).toBe(0);
    expect(result.passRate).toBe(0);
  });

  it('handles empty scorers array', async () => {
    const suite: EvalSuite = {
      name: 'no-scorers',
      target: echoTarget,
      cases: [{ id: 'c1', input: 'a' }],
      scorers: [],
    };
    const result = await runEvalSuite(suite);
    expect(result.cases[0]!.aggregateScore).toBe(0);
    expect(result.cases[0]!.pass).toBe(false);
  });

  it('catches target errors and records them as output strings', async () => {
    const faultyTarget = async (_: string): Promise<never> => {
      throw new Error('boom');
    };
    const suite: EvalSuite = {
      name: 's',
      target: faultyTarget,
      cases: [{ id: 'c1', input: 'q', expected: 'q' }],
      scorers: [new ExactMatchScorer()],
    };
    const result = await runEvalSuite(suite);
    expect(result.cases[0]!.output).toContain('[target error:');
    expect(result.cases[0]!.pass).toBe(false);
  });

  it('multiple scorers all appear in case scorerScores', async () => {
    const suite: EvalSuite = {
      name: 's',
      target: upperTarget,
      cases: [{ id: 'c1', input: 'hello' }],
      scorers: [
        new ExactMatchScorer(),
        new RegexScorer({ pattern: /^[A-Z]+$/, id: 'all-caps' }),
      ],
    };
    const result = await runEvalSuite(suite);
    const ids = result.cases[0]!.scorerScores.map((s) => s.scorerId);
    expect(ids).toContain('exact-match');
    expect(ids).toContain('all-caps');
  });
});

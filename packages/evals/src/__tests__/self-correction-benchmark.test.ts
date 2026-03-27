import { describe, it, expect } from 'vitest';
import {
  SELF_CORRECTION_SUITE,
  CORRECTION_SCENARIOS,
  ALL_CORRECTION_CATEGORIES,
  createSelfCorrectionSuite,
} from '../benchmarks/suites/self-correction.js';
import type {
  CorrectionCategory,
  CorrectionScenario,
} from '../benchmarks/suites/self-correction.js';
import type { BenchmarkSuite } from '../benchmarks/benchmark-types.js';

// ---------------------------------------------------------------------------
// Suite structure validation
// ---------------------------------------------------------------------------

describe('SelfCorrectionBenchmark', () => {
  describe('SELF_CORRECTION_SUITE structure', () => {
    it('should have the correct id', () => {
      expect(SELF_CORRECTION_SUITE.id).toBe('self-correction');
    });

    it('should have a valid name and description', () => {
      expect(SELF_CORRECTION_SUITE.name).toBeTruthy();
      expect(SELF_CORRECTION_SUITE.description).toBeTruthy();
      expect(typeof SELF_CORRECTION_SUITE.name).toBe('string');
      expect(typeof SELF_CORRECTION_SUITE.description).toBe('string');
    });

    it('should have category "self-correction"', () => {
      expect(SELF_CORRECTION_SUITE.category).toBe('self-correction');
    });

    it('should have at least 10 dataset entries', () => {
      expect(SELF_CORRECTION_SUITE.dataset.length).toBeGreaterThanOrEqual(10);
    });

    it('should have at least one scorer', () => {
      expect(SELF_CORRECTION_SUITE.scorers.length).toBeGreaterThanOrEqual(1);
    });

    it('should have baseline thresholds for each scorer', () => {
      for (const scorer of SELF_CORRECTION_SUITE.scorers) {
        expect(SELF_CORRECTION_SUITE.baselineThresholds[scorer.id]).toBeDefined();
        expect(typeof SELF_CORRECTION_SUITE.baselineThresholds[scorer.id]).toBe('number');
      }
    });

    it('should have unique dataset entry IDs', () => {
      const ids = SELF_CORRECTION_SUITE.dataset.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should satisfy BenchmarkSuite interface', () => {
      const suite: BenchmarkSuite = SELF_CORRECTION_SUITE;
      expect(suite.id).toBeTruthy();
      expect(suite.name).toBeTruthy();
      expect(suite.description).toBeTruthy();
      expect(suite.category).toBeTruthy();
      expect(Array.isArray(suite.dataset)).toBe(true);
      expect(Array.isArray(suite.scorers)).toBe(true);
      expect(typeof suite.baselineThresholds).toBe('object');
    });
  });

  // ---------------------------------------------------------------------------
  // Dataset entry validation
  // ---------------------------------------------------------------------------

  describe('dataset entries', () => {
    it('each entry has valid id, input, expectedOutput, tags, and metadata', () => {
      for (const entry of SELF_CORRECTION_SUITE.dataset) {
        expect(entry.id).toBeTruthy();
        expect(typeof entry.id).toBe('string');

        expect(entry.input).toBeTruthy();
        expect(typeof entry.input).toBe('string');

        expect(entry.expectedOutput).toBeTruthy();
        expect(typeof entry.expectedOutput).toBe('string');

        expect(Array.isArray(entry.tags)).toBe(true);
        expect(entry.tags!.length).toBeGreaterThanOrEqual(1);

        expect(entry.metadata).toBeDefined();
        expect(typeof entry.metadata).toBe('object');
      }
    });

    it('each entry input contains the buggy code and bug description', () => {
      for (const entry of SELF_CORRECTION_SUITE.dataset) {
        expect(entry.input).toContain('Fix this code:');
        expect(entry.input).toContain('Bug:');
        expect(entry.input).toContain('```typescript');
      }
    });

    it('each entry metadata has category and difficulty', () => {
      for (const entry of SELF_CORRECTION_SUITE.dataset) {
        expect(entry.metadata).toHaveProperty('category');
        expect(entry.metadata).toHaveProperty('difficulty');
        expect(entry.metadata).toHaveProperty('expectedError');
        expect(typeof entry.metadata!['category']).toBe('string');
        expect(typeof entry.metadata!['difficulty']).toBe('number');
        expect(typeof entry.metadata!['expectedError']).toBe('string');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // CORRECTION_SCENARIOS validation
  // ---------------------------------------------------------------------------

  describe('CORRECTION_SCENARIOS', () => {
    it('should have at least 10 scenarios', () => {
      expect(CORRECTION_SCENARIOS.length).toBeGreaterThanOrEqual(10);
    });

    it('each scenario has unique id', () => {
      const ids = CORRECTION_SCENARIOS.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('each scenario has unique name', () => {
      const names = CORRECTION_SCENARIOS.map((s) => s.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('buggy code is different from correct code for every scenario', () => {
      for (const scenario of CORRECTION_SCENARIOS) {
        expect(scenario.buggyCode).not.toBe(scenario.correctCode);
        // Verify they are meaningfully different, not just whitespace
        const buggyTrimmed = scenario.buggyCode.replace(/\s+/g, ' ').trim();
        const correctTrimmed = scenario.correctCode.replace(/\s+/g, ' ').trim();
        expect(buggyTrimmed).not.toBe(correctTrimmed);
      }
    });

    it('each scenario has a non-empty bugDescription', () => {
      for (const scenario of CORRECTION_SCENARIOS) {
        expect(scenario.bugDescription.length).toBeGreaterThan(10);
      }
    });

    it('each scenario has a non-empty expectedError', () => {
      for (const scenario of CORRECTION_SCENARIOS) {
        expect(scenario.expectedError.length).toBeGreaterThan(0);
      }
    });

    it('each scenario has non-empty buggyCode and correctCode', () => {
      for (const scenario of CORRECTION_SCENARIOS) {
        expect(scenario.buggyCode.length).toBeGreaterThan(10);
        expect(scenario.correctCode.length).toBeGreaterThan(10);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Category coverage
  // ---------------------------------------------------------------------------

  describe('category coverage', () => {
    const ALL_CATEGORIES: CorrectionCategory[] = [
      'import_error',
      'type_error',
      'security_violation',
      'missing_validation',
      'test_failure',
      'lint_error',
      'logic_error',
    ];

    it('scenarios cover all 7 correction categories', () => {
      const coveredCategories = new Set(CORRECTION_SCENARIOS.map((s) => s.category));
      for (const cat of ALL_CATEGORIES) {
        expect(coveredCategories.has(cat)).toBe(true);
      }
    });

    it('ALL_CORRECTION_CATEGORIES contains all 7 categories', () => {
      expect(ALL_CORRECTION_CATEGORIES).toHaveLength(7);
      for (const cat of ALL_CATEGORIES) {
        expect(ALL_CORRECTION_CATEGORIES).toContain(cat);
      }
    });

    it('each category has at least one scenario', () => {
      for (const cat of ALL_CATEGORIES) {
        const count = CORRECTION_SCENARIOS.filter((s) => s.category === cat).length;
        expect(count).toBeGreaterThanOrEqual(1);
      }
    });

    it('dataset tags include the category for each entry', () => {
      for (const entry of SELF_CORRECTION_SUITE.dataset) {
        const category = entry.metadata!['category'] as string;
        expect(entry.tags).toContain(category);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Difficulty range
  // ---------------------------------------------------------------------------

  describe('difficulty', () => {
    it('all difficulties are between 1 and 5', () => {
      for (const scenario of CORRECTION_SCENARIOS) {
        expect(scenario.difficulty).toBeGreaterThanOrEqual(1);
        expect(scenario.difficulty).toBeLessThanOrEqual(5);
      }
    });

    it('difficulty range spans at least 1 to 4', () => {
      const difficulties = CORRECTION_SCENARIOS.map((s) => s.difficulty);
      expect(Math.min(...difficulties)).toBeLessThanOrEqual(1);
      expect(Math.max(...difficulties)).toBeGreaterThanOrEqual(4);
    });

    it('dataset tags include difficulty level', () => {
      for (const entry of SELF_CORRECTION_SUITE.dataset) {
        const difficulty = entry.metadata!['difficulty'] as number;
        expect(entry.tags).toContain(`difficulty-${difficulty}`);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // createSelfCorrectionSuite factory
  // ---------------------------------------------------------------------------

  describe('createSelfCorrectionSuite', () => {
    it('returns the same suite as SELF_CORRECTION_SUITE', () => {
      const suite = createSelfCorrectionSuite();
      expect(suite).toBe(SELF_CORRECTION_SUITE);
    });

    it('returned suite has the correct shape', () => {
      const suite = createSelfCorrectionSuite();
      expect(suite.id).toBe('self-correction');
      expect(suite.dataset.length).toBeGreaterThanOrEqual(10);
      expect(suite.scorers.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Scorer configuration
  // ---------------------------------------------------------------------------

  describe('scorers', () => {
    it('includes both deterministic and llm-judge scorers', () => {
      const types = SELF_CORRECTION_SUITE.scorers.map((s) => s.type);
      expect(types).toContain('deterministic');
      expect(types).toContain('llm-judge');
    });

    it('all baseline thresholds are between 0 and 1', () => {
      for (const [, threshold] of Object.entries(SELF_CORRECTION_SUITE.baselineThresholds)) {
        expect(threshold).toBeGreaterThanOrEqual(0);
        expect(threshold).toBeLessThanOrEqual(1);
      }
    });

    it('each scorer has a valid id and name', () => {
      for (const scorer of SELF_CORRECTION_SUITE.scorers) {
        expect(scorer.id).toBeTruthy();
        expect(scorer.name).toBeTruthy();
        expect(typeof scorer.id).toBe('string');
        expect(typeof scorer.name).toBe('string');
      }
    });
  });
});

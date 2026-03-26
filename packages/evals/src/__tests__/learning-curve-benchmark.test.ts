import { describe, it, expect, beforeEach } from 'vitest';
import {
  runLearningCurveBenchmark,
  generateSimulatedRun,
  createLearningCurveSuite,
  QUALITY_PATTERNS,
} from '../benchmarks/suites/learning-curve.js';
import type {
  LearningCurveStore,
  StoreItem,
  LearningCurveConfig,
} from '../benchmarks/suites/learning-curve.js';

// ---------------------------------------------------------------------------
// Minimal InMemoryStore (mirrors @langchain/langgraph InMemoryStore interface)
// ---------------------------------------------------------------------------

class TestInMemoryStore implements LearningCurveStore {
  private data = new Map<string, Map<string, Record<string, unknown>>>();

  private nsKey(namespace: string[]): string {
    return namespace.join('::');
  }

  async put(namespace: string[], key: string, value: Record<string, unknown>): Promise<void> {
    const nsKey = this.nsKey(namespace);
    if (!this.data.has(nsKey)) {
      this.data.set(nsKey, new Map());
    }
    this.data.get(nsKey)!.set(key, value);
  }

  async search(namespace: string[], options: { limit?: number }): Promise<StoreItem[]> {
    const nsKey = this.nsKey(namespace);
    const ns = this.data.get(nsKey);
    if (!ns) return [];
    const items: StoreItem[] = [];
    for (const [key, value] of ns.entries()) {
      items.push({ key, value });
      if (options.limit && items.length >= options.limit) break;
    }
    return items;
  }

  /** Helper to inspect stored data for assertions */
  getNamespaceSize(namespace: string[]): number {
    const nsKey = this.nsKey(namespace);
    return this.data.get(nsKey)?.size ?? 0;
  }
}

// ---------------------------------------------------------------------------
// QUALITY_PATTERNS
// ---------------------------------------------------------------------------

describe('QUALITY_PATTERNS', () => {
  it('should define all four patterns', () => {
    expect(QUALITY_PATTERNS).toHaveProperty('improving');
    expect(QUALITY_PATTERNS).toHaveProperty('degrading');
    expect(QUALITY_PATTERNS).toHaveProperty('inconsistent');
    expect(QUALITY_PATTERNS).toHaveProperty('plateau');
  });

  it('should have 10 scores per pattern', () => {
    for (const [name, scores] of Object.entries(QUALITY_PATTERNS)) {
      expect(scores).toHaveLength(10);
      for (const s of scores) {
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
      }
      // Suppress unused variable lint
      void name;
    }
  });

  it('improving pattern should have ascending trend', () => {
    const scores = QUALITY_PATTERNS['improving']!;
    expect(scores[scores.length - 1]!).toBeGreaterThan(scores[0]!);
  });

  it('degrading pattern should have descending trend', () => {
    const scores = QUALITY_PATTERNS['degrading']!;
    expect(scores[scores.length - 1]!).toBeLessThan(scores[0]!);
  });
});

// ---------------------------------------------------------------------------
// generateSimulatedRun
// ---------------------------------------------------------------------------

describe('generateSimulatedRun', () => {
  it('should produce a valid SimulatedRunAnalysis', () => {
    const run = generateSimulatedRun(0, 0.75, { featureType: 'crud' });

    expect(run.runId).toBe('run-000');
    expect(run.overallScore).toBe(0.75);
    expect(run.taskType).toBe('crud');
    expect(run.riskClass).toBe('standard');
    expect(run.nodeScores.size).toBeGreaterThan(0);
    expect(run.totalCostCents).toBeGreaterThan(0);
    expect(run.totalDurationMs).toBeGreaterThan(0);
  });

  it('should generate node scores within [0, 1]', () => {
    for (let i = 0; i < 10; i++) {
      const run = generateSimulatedRun(i, 0.5 + i * 0.04, {});
      for (const [_node, score] of run.nodeScores) {
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });

  it('should generate errors when includeErrors is true', () => {
    const run = generateSimulatedRun(0, 0.5, { includeErrors: true });
    expect(run.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('should not generate errors when includeErrors is false', () => {
    const run = generateSimulatedRun(0, 0.5, { includeErrors: false });
    expect(run.errors).toHaveLength(0);
  });

  it('should produce more errors for lower quality scores', () => {
    const lowQuality = generateSimulatedRun(0, 0.2, { includeErrors: true });
    const highQuality = generateSimulatedRun(0, 0.9, { includeErrors: true });
    expect(lowQuality.errors.length).toBeGreaterThanOrEqual(highQuality.errors.length);
  });

  it('should resolve more errors for higher quality runs', () => {
    const lowQuality = generateSimulatedRun(0, 0.3, { includeErrors: true });
    const highQuality = generateSimulatedRun(0, 0.8, { includeErrors: true });

    const lowResolved = lowQuality.errors.filter((e) => e.resolved).length;
    const highResolved = highQuality.errors.filter((e) => e.resolved).length;

    // High quality should resolve at least as many errors
    expect(highResolved).toBeGreaterThanOrEqual(lowResolved);
  });

  it('should approve runs with quality > 0.6', () => {
    const approved = generateSimulatedRun(0, 0.7, {});
    const notApproved = generateSimulatedRun(0, 0.4, {});

    expect(approved.approved).toBe(true);
    expect(notApproved.approved).toBe(false);
  });

  it('should use default featureType when not provided', () => {
    const run = generateSimulatedRun(0, 0.5, {});
    expect(run.taskType).toBe('crud');
  });

  it('should produce unique run IDs for different indices', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const run = generateSimulatedRun(i, 0.5, {});
      ids.add(run.runId);
    }
    expect(ids.size).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// runLearningCurveBenchmark — improving pattern
// ---------------------------------------------------------------------------

describe('runLearningCurveBenchmark', () => {
  let store: TestInMemoryStore;

  beforeEach(() => {
    store = new TestInMemoryStore();
  });

  describe('improving pattern', () => {
    it('should report isImproving === true', async () => {
      const result = await runLearningCurveBenchmark(store, {
        qualityPattern: 'improving',
      });

      expect(result.isImproving).toBe(true);
    });

    it('should have positive qualityImprovement', async () => {
      const result = await runLearningCurveBenchmark(store, {
        qualityPattern: 'improving',
      });

      expect(result.qualityImprovement).toBeGreaterThan(0);
    });

    it('should return correct number of quality scores', async () => {
      const result = await runLearningCurveBenchmark(store, {
        qualityPattern: 'improving',
        numRuns: 10,
      });

      expect(result.qualityScores).toHaveLength(10);
      expect(result.lessonCounts).toHaveLength(10);
      expect(result.ruleCounts).toHaveLength(10);
    });

    it('should accumulate lessons over runs', async () => {
      const result = await runLearningCurveBenchmark(store, {
        qualityPattern: 'improving',
      });

      // Lesson counts should be non-decreasing
      for (let i = 1; i < result.lessonCounts.length; i++) {
        expect(result.lessonCounts[i]).toBeGreaterThanOrEqual(result.lessonCounts[i - 1]!);
      }

      // Should have created some lessons
      const totalLessons = result.lessonCounts[result.lessonCounts.length - 1]!;
      expect(totalLessons).toBeGreaterThan(0);
    });

    it('should store skills (trajectories) for high-quality runs', async () => {
      const result = await runLearningCurveBenchmark(store, {
        qualityPattern: 'improving',
      });

      // Improving pattern has scores > 0.7 from run index 4 onward
      expect(result.skillCount).toBeGreaterThan(0);
    });

    it('should have positive avgLessonsPerRun', async () => {
      const result = await runLearningCurveBenchmark(store, {
        qualityPattern: 'improving',
      });

      expect(result.avgLessonsPerRun).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // degrading pattern
  // -------------------------------------------------------------------------

  describe('degrading pattern', () => {
    it('should report isImproving === false', async () => {
      const result = await runLearningCurveBenchmark(store, {
        qualityPattern: 'degrading',
      });

      expect(result.isImproving).toBe(false);
    });

    it('should have negative qualityImprovement', async () => {
      const result = await runLearningCurveBenchmark(store, {
        qualityPattern: 'degrading',
      });

      expect(result.qualityImprovement).toBeLessThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // plateau pattern
  // -------------------------------------------------------------------------

  describe('plateau pattern', () => {
    it('should report isImproving === true (small improvement)', async () => {
      const result = await runLearningCurveBenchmark(store, {
        qualityPattern: 'plateau',
      });

      // Plateau starts at 0.5 and ends at 0.69 — still improving
      expect(result.isImproving).toBe(true);
    });

    it('should have small qualityImprovement', async () => {
      const result = await runLearningCurveBenchmark(store, {
        qualityPattern: 'plateau',
      });

      // 0.69 - 0.5 = 0.19
      expect(result.qualityImprovement).toBeGreaterThan(0);
      expect(result.qualityImprovement).toBeLessThan(0.4);
    });
  });

  // -------------------------------------------------------------------------
  // inconsistent pattern
  // -------------------------------------------------------------------------

  describe('inconsistent pattern', () => {
    it('should still accumulate lessons', async () => {
      const result = await runLearningCurveBenchmark(store, {
        qualityPattern: 'inconsistent',
      });

      const totalLessons = result.lessonCounts[result.lessonCounts.length - 1]!;
      expect(totalLessons).toBeGreaterThan(0);
    });

    it('should report isImproving based on first/last windows', async () => {
      const result = await runLearningCurveBenchmark(store, {
        qualityPattern: 'inconsistent',
      });

      // inconsistent = [0.5, 0.8, 0.4, 0.9, 0.3, 0.85, 0.45, 0.75, 0.6, 0.7]
      // avg first 3 = (0.5+0.8+0.4)/3 = 0.567
      // avg last 3  = (0.75+0.6+0.7)/3 = 0.683
      // last > first => isImproving = true
      expect(result.isImproving).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // custom pattern
  // -------------------------------------------------------------------------

  describe('custom pattern', () => {
    it('should use custom quality scores', async () => {
      const customScores = [0.3, 0.4, 0.5, 0.6, 0.7];
      const result = await runLearningCurveBenchmark(store, {
        qualityPattern: 'custom',
        customScores,
        numRuns: 5,
      });

      expect(result.qualityScores).toEqual(customScores);
      expect(result.isImproving).toBe(true);
      expect(result.qualityImprovement).toBeCloseTo(0.4, 5);
    });

    it('should throw when custom pattern has no scores', async () => {
      await expect(
        runLearningCurveBenchmark(store, {
          qualityPattern: 'custom',
          customScores: [],
        }),
      ).rejects.toThrow('customScores must be provided');
    });

    it('should truncate custom scores to numRuns', async () => {
      const result = await runLearningCurveBenchmark(store, {
        qualityPattern: 'custom',
        customScores: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
        numRuns: 3,
      });

      expect(result.qualityScores).toEqual([0.1, 0.2, 0.3]);
    });
  });

  // -------------------------------------------------------------------------
  // numRuns
  // -------------------------------------------------------------------------

  describe('numRuns', () => {
    it('should respect custom numRuns', async () => {
      const result = await runLearningCurveBenchmark(store, {
        qualityPattern: 'improving',
        numRuns: 5,
      });

      expect(result.qualityScores).toHaveLength(5);
      expect(result.lessonCounts).toHaveLength(5);
      expect(result.ruleCounts).toHaveLength(5);
    });

    it('should extend pattern when numRuns exceeds pattern length', async () => {
      const result = await runLearningCurveBenchmark(store, {
        qualityPattern: 'improving',
        numRuns: 15,
      });

      expect(result.qualityScores).toHaveLength(15);
      // Extra runs should repeat the last pattern value
      const lastPatternValue = QUALITY_PATTERNS['improving']![9];
      expect(result.qualityScores[14]).toBe(lastPatternValue);
    });

    it('should default to 10 runs', async () => {
      const result = await runLearningCurveBenchmark(store, {
        qualityPattern: 'improving',
      });

      expect(result.qualityScores).toHaveLength(10);
    });
  });

  // -------------------------------------------------------------------------
  // Rule generation from errors
  // -------------------------------------------------------------------------

  describe('rule generation', () => {
    it('should accumulate rules over runs', async () => {
      const result = await runLearningCurveBenchmark(store, {
        qualityPattern: 'improving',
        includeErrors: true,
      });

      // Rule counts should be non-decreasing
      for (let i = 1; i < result.ruleCounts.length; i++) {
        expect(result.ruleCounts[i]).toBeGreaterThanOrEqual(result.ruleCounts[i - 1]!);
      }

      const totalRules = result.ruleCounts[result.ruleCounts.length - 1]!;
      expect(totalRules).toBeGreaterThan(0);
    });

    it('should produce no rules when no errors', async () => {
      const result = await runLearningCurveBenchmark(store, {
        qualityPattern: 'improving',
        includeErrors: false,
      });

      const totalRules = result.ruleCounts[result.ruleCounts.length - 1]!;
      expect(totalRules).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Store contents
  // -------------------------------------------------------------------------

  describe('store contents', () => {
    it('should store trajectories in the correct namespace', async () => {
      await runLearningCurveBenchmark(store, {
        qualityPattern: 'improving',
      });

      const trajectoryCount = store.getNamespaceSize(['learning_curve', 'trajectories']);
      expect(trajectoryCount).toBeGreaterThan(0);
    });

    it('should store lessons in the correct namespace', async () => {
      await runLearningCurveBenchmark(store, {
        qualityPattern: 'improving',
        includeErrors: true,
      });

      const lessonCount = store.getNamespaceSize(['learning_curve', 'lessons']);
      expect(lessonCount).toBeGreaterThan(0);
    });

    it('should store rules in the correct namespace', async () => {
      await runLearningCurveBenchmark(store, {
        qualityPattern: 'improving',
        includeErrors: true,
      });

      const ruleCount = store.getNamespaceSize(['learning_curve', 'rules']);
      expect(ruleCount).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should handle numRuns = 1', async () => {
      const result = await runLearningCurveBenchmark(store, {
        qualityPattern: 'improving',
        numRuns: 1,
      });

      expect(result.qualityScores).toHaveLength(1);
      expect(result.isImproving).toBe(false); // cannot determine trend from 1 value
    });

    it('should handle numRuns = 2', async () => {
      const result = await runLearningCurveBenchmark(store, {
        qualityPattern: 'improving',
        numRuns: 2,
      });

      expect(result.qualityScores).toHaveLength(2);
      expect(result.isImproving).toBe(true);
    });

    it('should handle all-zero quality scores', async () => {
      const result = await runLearningCurveBenchmark(store, {
        qualityPattern: 'custom',
        customScores: [0, 0, 0, 0, 0],
        numRuns: 5,
      });

      expect(result.isImproving).toBe(false);
      expect(result.qualityImprovement).toBe(0);
    });

    it('should handle all-max quality scores', async () => {
      const result = await runLearningCurveBenchmark(store, {
        qualityPattern: 'custom',
        customScores: [1, 1, 1, 1, 1],
        numRuns: 5,
      });

      expect(result.isImproving).toBe(false);
      expect(result.qualityImprovement).toBe(0);
      expect(result.skillCount).toBe(5); // all above trajectory threshold
    });
  });
});

// ---------------------------------------------------------------------------
// createLearningCurveSuite — BenchmarkSuite wrapper
// ---------------------------------------------------------------------------

describe('createLearningCurveSuite', () => {
  it('should return a valid BenchmarkSuite', () => {
    const suite = createLearningCurveSuite();

    expect(suite.id).toBe('learning-curve');
    expect(suite.name).toBeTruthy();
    expect(suite.description).toBeTruthy();
    expect(suite.category).toBe('multi-turn');
  });

  it('should have 4 dataset entries (one per pattern)', () => {
    const suite = createLearningCurveSuite();
    expect(suite.dataset).toHaveLength(4);
  });

  it('should have unique entry IDs', () => {
    const suite = createLearningCurveSuite();
    const ids = suite.dataset.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('should have entries with expected tags', () => {
    const suite = createLearningCurveSuite();
    for (const entry of suite.dataset) {
      expect(entry.tags).toContain('learning-curve');
    }
  });

  it('should have expectedOutput as valid JSON', () => {
    const suite = createLearningCurveSuite();
    for (const entry of suite.dataset) {
      expect(entry.expectedOutput).toBeTruthy();
      const parsed = JSON.parse(entry.expectedOutput!);
      expect(typeof parsed.isImproving).toBe('boolean');
    }
  });

  it('should have at least one scorer', () => {
    const suite = createLearningCurveSuite();
    expect(suite.scorers.length).toBeGreaterThanOrEqual(1);
  });

  it('should have baseline thresholds for each scorer', () => {
    const suite = createLearningCurveSuite();
    for (const scorer of suite.scorers) {
      expect(suite.baselineThresholds[scorer.id]).toBeDefined();
      expect(typeof suite.baselineThresholds[scorer.id]).toBe('number');
    }
  });

  it('should match expected isImproving for each pattern', () => {
    const suite = createLearningCurveSuite();

    const improvingEntry = suite.dataset.find((e) => e.id === 'lc-improving');
    expect(JSON.parse(improvingEntry!.expectedOutput!)).toEqual({ isImproving: true });

    const degradingEntry = suite.dataset.find((e) => e.id === 'lc-degrading');
    expect(JSON.parse(degradingEntry!.expectedOutput!)).toEqual({ isImproving: false });
  });
});

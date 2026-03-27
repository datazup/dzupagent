/**
 * Learning Curve Benchmark Suite
 *
 * Measures whether quality improves over sequential runs by simulating
 * the PostRunAnalyzer self-learning loop. Each run produces quality scores,
 * errors, and lessons that accumulate in a store. After all runs, we check
 * whether quality trend is positive and learning artifacts (lessons, rules,
 * trajectories) accumulate as expected.
 *
 * Uses a minimal store interface compatible with @langchain/langgraph BaseStore
 * to avoid coupling the evals package to that dependency.
 */

import type { BenchmarkSuite } from '../benchmark-types.js';

// ---------------------------------------------------------------------------
// Minimal Store Interface (BaseStore-compatible)
// ---------------------------------------------------------------------------

/** Minimal item returned by store.search(). */
export interface StoreItem {
  key: string;
  value: Record<string, unknown>;
}

/**
 * Minimal store interface matching @langchain/langgraph BaseStore.put/search.
 * Pass an InMemoryStore from langgraph or any compatible implementation.
 */
export interface LearningCurveStore {
  put(namespace: string[], key: string, value: Record<string, unknown>): Promise<void>;
  search(namespace: string[], options: { limit?: number }): Promise<StoreItem[]>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface LearningCurveConfig {
  /** Number of sequential runs to simulate (default: 10) */
  numRuns?: number;
  /** Quality pattern: how quality evolves per run */
  qualityPattern?: 'improving' | 'degrading' | 'inconsistent' | 'plateau' | 'custom';
  /** Custom quality scores per run (if qualityPattern === 'custom') */
  customScores?: number[];
  /** Feature type for all runs (default: 'crud') */
  featureType?: string;
  /** Whether to include error scenarios (default: true) */
  includeErrors?: boolean;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface LearningCurveResult {
  /** Quality scores per run */
  qualityScores: number[];
  /** Cumulative lessons after each run */
  lessonCounts: number[];
  /** Cumulative rules after each run */
  ruleCounts: number[];
  /** Skills crystallized after all runs (trajectories stored with score > 0.7) */
  skillCount: number;
  /** Quality improvement: last run score - first run score */
  qualityImprovement: number;
  /** Average lessons per run */
  avgLessonsPerRun: number;
  /** Whether quality trend is positive (avg of last 3 > avg of first 3) */
  isImproving: boolean;
}

// ---------------------------------------------------------------------------
// Simulated RunAnalysis (mirrors PostRunAnalyzer's RunAnalysis)
// ---------------------------------------------------------------------------

export interface SimulatedRunAnalysis {
  runId: string;
  nodeScores: Map<string, number>;
  errors: Array<{
    nodeId: string;
    error: string;
    resolved: boolean;
    resolution?: string;
    fixAttempt?: number;
  }>;
  overallScore: number;
  totalCostCents: number;
  totalDurationMs: number;
  taskType: string;
  riskClass: 'critical' | 'sensitive' | 'standard' | 'cosmetic';
  approved: boolean;
}

// ---------------------------------------------------------------------------
// Quality Patterns
// ---------------------------------------------------------------------------

export const QUALITY_PATTERNS: Record<string, number[]> = {
  improving: [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.82, 0.85, 0.87],
  degrading: [0.85, 0.82, 0.78, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45],
  inconsistent: [0.5, 0.8, 0.4, 0.9, 0.3, 0.85, 0.45, 0.75, 0.6, 0.7],
  plateau: [0.5, 0.6, 0.65, 0.67, 0.68, 0.68, 0.69, 0.69, 0.69, 0.69],
};

// ---------------------------------------------------------------------------
// Pipeline Nodes (used for simulated node scores)
// ---------------------------------------------------------------------------

const PIPELINE_NODES = [
  'intake',
  'plan',
  'gen_backend',
  'gen_frontend',
  'gen_tests',
  'validate',
] as const;

// ---------------------------------------------------------------------------
// Error Templates (used for simulated errors)
// ---------------------------------------------------------------------------

const ERROR_TEMPLATES: Array<{ error: string; resolution: string; nodeId: string }> = [
  { nodeId: 'gen_backend', error: 'Type error in generated service', resolution: 'Added missing type annotations' },
  { nodeId: 'gen_frontend', error: 'Missing import statement', resolution: 'Added auto-import for component' },
  { nodeId: 'gen_tests', error: 'Test assertion failed', resolution: 'Fixed expected value in assertion' },
  { nodeId: 'validate', error: 'Lint rule violation', resolution: 'Applied auto-fix for ESLint rules' },
  { nodeId: 'gen_backend', error: 'Circular dependency detected', resolution: 'Extracted shared types to separate module' },
  { nodeId: 'gen_frontend', error: 'Invalid prop type', resolution: 'Corrected prop type to match interface' },
];

// ---------------------------------------------------------------------------
// Thresholds (matching PostRunAnalyzer)
// ---------------------------------------------------------------------------

const TRAJECTORY_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// Simulated Run Generator
// ---------------------------------------------------------------------------

/**
 * Generate simulated run data for a given quality level.
 *
 * Node scores are distributed around the overall quality with small variance.
 * Errors are generated based on quality — lower quality means more errors.
 */
export function generateSimulatedRun(
  runIndex: number,
  quality: number,
  config: LearningCurveConfig,
): SimulatedRunAnalysis {
  const runId = `run-${String(runIndex).padStart(3, '0')}`;
  const taskType = config.featureType ?? 'crud';
  const includeErrors = config.includeErrors ?? true;

  // Generate node scores centered around quality with deterministic variance
  const nodeScores = new Map<string, number>();
  for (let i = 0; i < PIPELINE_NODES.length; i++) {
    const node = PIPELINE_NODES[i]!;
    // Deterministic variance based on run index and node index
    const variance = ((runIndex * 7 + i * 13) % 20 - 10) / 100;
    const score = Math.max(0, Math.min(1, quality + variance));
    nodeScores.set(node, score);
  }

  // Generate errors — more errors when quality is lower
  const errors: SimulatedRunAnalysis['errors'] = [];
  if (includeErrors) {
    // Number of errors inversely proportional to quality (1-3 errors)
    const numErrors = Math.max(1, Math.min(3, Math.ceil((1 - quality) * 5)));

    for (let i = 0; i < numErrors; i++) {
      const templateIdx = (runIndex * 3 + i) % ERROR_TEMPLATES.length;
      const template = ERROR_TEMPLATES[templateIdx]!;

      // Higher quality runs resolve more errors
      const resolved = quality > 0.5 || i === 0;

      errors.push({
        nodeId: template.nodeId,
        error: template.error,
        resolved,
        resolution: resolved ? template.resolution : undefined,
        fixAttempt: resolved ? 1 : undefined,
      });
    }
  }

  return {
    runId,
    nodeScores,
    errors,
    overallScore: quality,
    totalCostCents: Math.round(50 + quality * 100),
    totalDurationMs: Math.round(5000 + (1 - quality) * 10000),
    taskType,
    riskClass: 'standard',
    approved: quality > 0.6,
  };
}

// ---------------------------------------------------------------------------
// Store Operations (mirrors PostRunAnalyzer logic)
// ---------------------------------------------------------------------------

const NAMESPACE = ['learning_curve'];

async function storeTrajectory(
  store: LearningCurveStore,
  run: SimulatedRunAnalysis,
): Promise<void> {
  const ns = [...NAMESPACE, 'trajectories'];
  const steps: Record<string, unknown>[] = [];
  for (const [nodeId, score] of run.nodeScores) {
    steps.push({ nodeId, runId: run.runId, qualityScore: score });
  }
  await store.put(ns, run.runId, {
    runId: run.runId,
    steps,
    overallScore: run.overallScore,
    taskType: run.taskType,
    riskClass: run.riskClass,
    approved: run.approved,
    timestamp: new Date().toISOString(),
    text: `trajectory ${run.runId} ${run.taskType} score=${run.overallScore}`,
  });
}

async function storeErrorLessons(
  store: LearningCurveStore,
  run: SimulatedRunAnalysis,
): Promise<number> {
  const ns = [...NAMESPACE, 'lessons'];
  let count = 0;
  for (const err of run.errors) {
    if (!err.resolved || !err.resolution) continue;
    const key = `lesson_err_${run.runId}_${err.nodeId}_${count}`;
    await store.put(ns, key, {
      type: 'error_resolution',
      runId: run.runId,
      nodeId: err.nodeId,
      taskType: run.taskType,
      error: err.error,
      resolution: err.resolution,
      fixAttempt: err.fixAttempt ?? 1,
      timestamp: new Date().toISOString(),
      text: `error_resolution node=${err.nodeId} error="${err.error}"`,
    });
    count++;
  }
  return count;
}

async function storeSuccessPatterns(
  store: LearningCurveStore,
  run: SimulatedRunAnalysis,
): Promise<number> {
  if (run.overallScore <= 0.85) return 0;
  const ns = [...NAMESPACE, 'lessons'];
  let count = 0;
  for (const [nodeId, score] of run.nodeScores) {
    if (score < 0.9) continue;
    const key = `lesson_success_${run.runId}_${nodeId}`;
    await store.put(ns, key, {
      type: 'successful_pattern',
      runId: run.runId,
      nodeId,
      taskType: run.taskType,
      score,
      timestamp: new Date().toISOString(),
      text: `successful_pattern node=${nodeId} score=${score}`,
    });
    count++;
  }
  return count;
}

async function storeRulesFromErrors(
  store: LearningCurveStore,
  run: SimulatedRunAnalysis,
): Promise<number> {
  const ns = [...NAMESPACE, 'rules'];
  let count = 0;
  for (const err of run.errors) {
    if (!err.resolved || !err.resolution) continue;
    const key = `rule_${run.runId}_${err.nodeId}_${count}`;
    await store.put(ns, key, {
      type: 'error_prevention',
      runId: run.runId,
      nodeId: err.nodeId,
      taskType: run.taskType,
      errorPattern: err.error,
      resolution: err.resolution,
      timestamp: new Date().toISOString(),
      text: `rule node=${err.nodeId} when="${err.error}" then="${err.resolution}"`,
    });
    count++;
  }
  return count;
}

async function countItems(
  store: LearningCurveStore,
  subNamespace: string,
): Promise<number> {
  const ns = [...NAMESPACE, subNamespace];
  const items = await store.search(ns, { limit: 10000 });
  return items.length;
}

// ---------------------------------------------------------------------------
// Learning Curve Runner
// ---------------------------------------------------------------------------

/**
 * Run a learning curve simulation.
 *
 * Simulates N sequential runs, each producing quality scores and errors.
 * After each run, lessons and rules are stored (mirroring PostRunAnalyzer).
 * Returns metrics showing learning progression.
 */
export async function runLearningCurveBenchmark(
  store: LearningCurveStore,
  config?: LearningCurveConfig,
): Promise<LearningCurveResult> {
  const cfg: Required<LearningCurveConfig> = {
    numRuns: config?.numRuns ?? 10,
    qualityPattern: config?.qualityPattern ?? 'improving',
    customScores: config?.customScores ?? [],
    featureType: config?.featureType ?? 'crud',
    includeErrors: config?.includeErrors ?? true,
  };

  // Resolve quality scores for each run
  const qualityScores = resolveQualityScores(cfg);

  const lessonCounts: number[] = [];
  const ruleCounts: number[] = [];
  let skillCount = 0;

  for (let i = 0; i < qualityScores.length; i++) {
    const quality = qualityScores[i]!;
    const run = generateSimulatedRun(i, quality, cfg);

    // Store trajectory if quality is high enough
    if (run.overallScore > TRAJECTORY_THRESHOLD) {
      await storeTrajectory(store, run);
      skillCount++;
    }

    // Store lessons (error + success patterns)
    await storeErrorLessons(store, run);
    await storeSuccessPatterns(store, run);

    // Store rules from errors
    await storeRulesFromErrors(store, run);

    // Count cumulative totals
    lessonCounts.push(await countItems(store, 'lessons'));
    ruleCounts.push(await countItems(store, 'rules'));
  }

  const first = qualityScores[0]!;
  const last = qualityScores[qualityScores.length - 1]!;
  const qualityImprovement = last - first;

  const totalLessons = lessonCounts[lessonCounts.length - 1] ?? 0;
  const avgLessonsPerRun = qualityScores.length > 0 ? totalLessons / qualityScores.length : 0;

  // isImproving = avg of last 3 runs > avg of first 3 runs
  const isImproving = computeIsImproving(qualityScores);

  return {
    qualityScores,
    lessonCounts,
    ruleCounts,
    skillCount,
    qualityImprovement,
    avgLessonsPerRun,
    isImproving,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveQualityScores(cfg: Required<LearningCurveConfig>): number[] {
  if (cfg.qualityPattern === 'custom') {
    if (cfg.customScores.length === 0) {
      throw new Error('customScores must be provided when qualityPattern is "custom"');
    }
    return cfg.customScores.slice(0, cfg.numRuns);
  }

  const pattern = QUALITY_PATTERNS[cfg.qualityPattern];
  if (!pattern) {
    throw new Error(`Unknown quality pattern: ${cfg.qualityPattern}`);
  }

  // If numRuns differs from pattern length, interpolate or truncate
  if (cfg.numRuns <= pattern.length) {
    return pattern.slice(0, cfg.numRuns);
  }

  // Extend pattern by repeating the last value
  const result = [...pattern];
  const lastValue = pattern[pattern.length - 1]!;
  while (result.length < cfg.numRuns) {
    result.push(lastValue);
  }
  return result;
}

/**
 * Determine if quality trend is positive.
 * Simple heuristic: average of last 3 scores > average of first 3 scores.
 * For fewer than 6 scores, compare halves.
 */
function computeIsImproving(scores: number[]): boolean {
  if (scores.length < 2) return false;

  const windowSize = Math.min(3, Math.floor(scores.length / 2));
  const firstWindow = scores.slice(0, windowSize);
  const lastWindow = scores.slice(scores.length - windowSize);

  const avgFirst = firstWindow.reduce((a, b) => a + b, 0) / firstWindow.length;
  const avgLast = lastWindow.reduce((a, b) => a + b, 0) / lastWindow.length;

  return avgLast > avgFirst;
}

// ---------------------------------------------------------------------------
// BenchmarkSuite Wrapper
// ---------------------------------------------------------------------------

/**
 * Create a BenchmarkSuite that wraps learning curve scenarios as eval entries.
 *
 * Each entry represents one quality pattern. The target function is expected
 * to return a JSON string with `{ isImproving: boolean }`.
 *
 * The deterministic scorer checks whether `isImproving` matches the expected
 * value for each pattern.
 */
export function createLearningCurveSuite(): BenchmarkSuite {
  return {
    id: 'learning-curve',
    name: 'Learning Curve',
    description: 'Measures whether self-learning loop improves generation quality over sequential runs',
    category: 'multi-turn',
    dataset: [
      {
        id: 'lc-improving',
        input: 'improving',
        expectedOutput: JSON.stringify({ isImproving: true }),
        tags: ['learning-curve', 'improving'],
      },
      {
        id: 'lc-degrading',
        input: 'degrading',
        expectedOutput: JSON.stringify({ isImproving: false }),
        tags: ['learning-curve', 'degrading'],
      },
      {
        id: 'lc-inconsistent',
        input: 'inconsistent',
        expectedOutput: JSON.stringify({ isImproving: true }),
        tags: ['learning-curve', 'inconsistent'],
      },
      {
        id: 'lc-plateau',
        input: 'plateau',
        expectedOutput: JSON.stringify({ isImproving: true }),
        tags: ['learning-curve', 'plateau'],
      },
    ],
    scorers: [
      {
        id: 'learning-trend',
        name: 'Learning Trend Match',
        description: 'Checks if isImproving matches expected value for the quality pattern',
        type: 'deterministic',
      },
    ],
    baselineThresholds: {
      'learning-trend': 1.0,
    },
  };
}

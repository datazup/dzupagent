/**
 * Result of a single evaluation scoring.
 */
export interface EvalResult {
  /** Score between 0.0 and 1.0 */
  score: number;
  /** Whether this evaluation passed */
  pass: boolean;
  /** Human-readable reasoning */
  reasoning: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * A scorer evaluates an output against optional reference.
 */
export interface EvalScorer {
  /** Unique name for this scorer */
  readonly name: string;
  /** Score an output against optional reference */
  score(input: string, output: string, reference?: string): Promise<EvalResult>;
}

/**
 * A single evaluation test case.
 */
export interface EvalCase {
  id: string;
  input: string;
  expectedOutput?: string;
  metadata?: Record<string, unknown>;
}

/**
 * A suite of evaluation cases with associated scorers.
 */
export interface EvalSuite {
  name: string;
  description?: string;
  cases: EvalCase[];
  scorers: EvalScorer[];
  /** Pass threshold (default: 0.7) */
  passThreshold?: number;
}

/**
 * Result of running a full evaluation suite.
 */
export interface EvalRunResult {
  suiteId: string;
  timestamp: string;
  results: Array<{
    caseId: string;
    scorerResults: Array<{
      scorerName: string;
      result: EvalResult;
    }>;
    aggregateScore: number;
    pass: boolean;
  }>;
  aggregateScore: number;
  passRate: number;
}

// --- Enhanced Scorer Types (ECO-111) ---

/**
 * Enhanced evaluation input with metadata for richer scoring.
 */
export interface EvalInput {
  input: string;
  output: string;
  reference?: string;
  tags?: string[];
  latencyMs?: number;
  costCents?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Configuration for an enhanced scorer.
 */
export interface ScorerConfig {
  id: string;
  name: string;
  description?: string;
  type: 'deterministic' | 'llm-judge' | 'composite' | 'custom';
  threshold?: number;
  version?: string;
}

/**
 * Result from an enhanced scorer, with per-criterion breakdown.
 */
export interface ScorerResult {
  scorerId: string;
  scores: Array<{ criterion: string; score: number; reasoning: string }>;
  aggregateScore: number;
  passed: boolean;
  durationMs: number;
  costCents?: number;
}

/**
 * Enhanced scorer interface with typed config and rich results.
 */
export interface Scorer<TInput = EvalInput> {
  readonly config: ScorerConfig;
  score(input: TInput): Promise<ScorerResult>;
}

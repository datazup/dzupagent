/**
 * Type contracts for {@link RunReflector} run-quality scoring.
 */

/** Individual dimension scores, each in the range [0, 1]. */
export interface ReflectionDimensions {
  /** Did the output address the input question/task? (0-1) */
  completeness: number;
  /** Is the output well-structured and coherent? (0-1) */
  coherence: number;
  /** Were tool calls successful? (0-1) */
  toolSuccess: number;
  /** Was the response concise (not overly verbose)? (0-1) */
  conciseness: number;
  /** Were there any error/retry signals? (0-1, 1 = no errors) */
  reliability: number;
}

/** Configuration for optional LLM-enhanced reflection. */
export interface ReflectorConfig {
  /** Optional LLM for enhanced reflection scoring. */
  llm?: (prompt: string) => Promise<string>;
  /** Use LLM reflection on every run, or only when heuristic score is low. Default: 'on-low-score'. */
  llmMode?: "always" | "on-low-score";
  /** Threshold below which LLM reflection triggers in 'on-low-score' mode. Default: 0.6. */
  llmThreshold?: number;
}

/** Full reflection score returned by `RunReflector.score()`. */
export interface ReflectionScore {
  /** Overall quality score 0-1 */
  overall: number;
  /** Individual dimension scores */
  dimensions: ReflectionDimensions;
  /** Flags for notable patterns */
  flags: string[];
}

/** Parsed result from LLM reflection scoring. */
export interface LlmReflectionResult {
  completeness: number;
  coherence: number;
  relevance: number;
  reasoning: string;
}

/** Input data required for scoring a run. */
export interface ReflectionInput {
  /** The original input to the agent (string, object, etc.) */
  input: unknown;
  /** The agent's output (string, object, etc.) */
  output: unknown;
  /** Tool call results from the run */
  toolCalls?: Array<{ name: string; success: boolean; durationMs?: number }>;
  /** Token usage for the run */
  tokenUsage?: { input: number; output: number };
  /** Total wall-clock duration of the run in milliseconds */
  durationMs: number;
  /** Number of errors encountered during the run */
  errorCount?: number;
  /** Number of retries that occurred during the run */
  retryCount?: number;
}

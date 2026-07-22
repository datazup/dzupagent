/**
 * Generate/stream call surface — options, results, streaming events.
 *
 * Extracted from the original `agent-types.ts` barrel — see that file for the
 * authoritative re-exports.
 */
import type { BaseMessage } from "@langchain/core/messages";
import type { ToolStat, StopReason } from "./tool-loop.js";
import type { StuckError } from "./stuck-error.js";
import type { RunLearnings } from "./tool-loop-learning.js";

/** Options for a single generate/stream call */
export interface GenerateOptions {
  /**
   * Durable run identifier for per-run provenance. When provided, prompt
   * memory reads can cite this run without storing prompt content.
   */
  runId?: string;
  /** Override max iterations for this call */
  maxIterations?: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Additional context to inject as a system message suffix */
  context?: string;
  /** Callback for token usage per LLM call */
  onUsage?: (usage: {
    model: string;
    inputTokens: number;
    outputTokens: number;
  }) => void;
  /** Current intent for per-intent tool ranking (passed to ToolStatsTracker) */
  intent?: string;
  /**
   * Sampling temperature for this call (DZUPAGENT-CODE-H-02).
   *
   * When set, bound onto the resolved model before invocation so OpenAI-compat
   * callers (and any other host) can control sampling per request instead of
   * being silently pinned to the model's construction-time default.
   */
  temperature?: number;
  /**
   * Maximum output tokens for this call (DZUPAGENT-CODE-H-02).
   *
   * Bound onto the resolved model as `maxTokens` before invocation. This caps
   * the provider's generated-token budget for this call; it is distinct from
   * the agent's iteration/cost `guardrails`.
   */
  maxTokens?: number;
  /**
   * Stop sequence(s) for this call (DZUPAGENT-CODE-H-02).
   *
   * Bound onto the resolved model so generation halts at the given sequence(s),
   * matching the OpenAI `stop` parameter.
   */
  stop?: string | string[];
  /**
   * Optional structured-output schema name override.
   *
   * Used by `generateStructured()` for schema hashing, telemetry, and provider
   * diagnostics. When unset, the agent derives a stable default from `agentId`
   * and `intent`.
   */
  schemaName?: string;
  /**
   * Structured-output schema normalization target.
   *
   * - `openai` (default): strips unsupported constraints before native
   *   structured-output calls and hashes the provider-safe schema.
   * - `generic`: uses canonical JSON Schema without provider stripping.
   */
  schemaProvider?: "generic" | "openai";
  /**
   * Internal cross-agent `asTool` recursion depth (AGENT-M-14).
   *
   * Threaded by {@link agentAsTool} into the wrapped agent's `generate()` so
   * that the depth accumulates across nested `asTool` invocations. The agent
   * exposes this back to its own `asTool` tools (via
   * `DzupAgent.asTool()`), which reject once the configured ceiling is
   * reached, bounding otherwise-unbounded in-process cross-agent recursion.
   */
  _agentToolDepth?: number;
  /** Internal resume context — set by the server worker when re-enqueueing a paused run. */
  _resume?: {
    resumeToken?: string;
    checkpoint?: string;
    lastStateSeq?: number;
    input?: unknown;
  };
}

/**
 * A single compression event captured during a run.
 *
 * Populated by the run engine when {@link ToolLoopConfig.onCompressed}
 * fires (i.e. `maybeCompress` returned `compressed: true` and the loop
 * adopted the shrunken history). `ts` is the epoch-millisecond
 * timestamp at which the compression was observed.
 */
export interface CompressionLogEntry {
  before: number;
  after: number;
  summary: string | null;
  ts: number;
}

/** Result of a generate() call */
export interface GenerateResult {
  /** The final text response */
  content: string;
  /** All messages in the conversation (including tool calls) */
  messages: BaseMessage[];
  /** Token usage across all LLM calls in this generation */
  usage: {
    totalInputTokens: number;
    totalOutputTokens: number;
    llmCalls: number;
  };
  /** Whether the agent hit the max iteration limit */
  hitIterationLimit: boolean;
  /** Why the agent stopped (more granular than hitIterationLimit). */
  stopReason: StopReason;
  /** Per-tool execution statistics. */
  toolStats: ToolStat[];
  /**
   * When `stopReason` is `'stuck'`, contains the structured StuckError
   * with reason, repeatedTool, and escalationLevel.
   */
  stuckError?: StuckError;
  /**
   * Self-learning signals from this run.
   * Only present when `selfLearning.enabled` is true in the agent config.
   */
  learnings?: RunLearnings;
  /**
   * Per-run memory frame snapshot captured during `prepareMessages()`.
   * Threaded from the run state so observers (and the public `RunResult`)
   * can inspect exactly which memory context was attached to this run.
   * Opaque — the shape depends on the configured memory provider.
   */
  memoryFrame?: unknown;
  /**
   * Log of compression events that fired during this run.
   *
   * Populated by the run engine's `onCompressed` wiring; only present when
   * auto-compression triggered (i.e. `maybeCompress` returned
   * `compressed: true` at least once). Entries are appended in the order
   * compression was observed.
   */
  compressionLog?: CompressionLogEntry[];
  /**
   * Set when the run was abandoned because a durable approval gate threw
   * `ApprovalSuspendedError`. The accompanying `resumeToken` lets an
   * out-of-process resumer complete the approval and continue the run.
   *
   * When present, callers should treat the run as paused rather than
   * complete -- the textual `content` is empty and `messages` only contains
   * the prefix produced before suspension.
   */
  suspended?: {
    runId: string;
    resumeToken: string;
  };
}

/** A single streamed event from the agent */
export interface AgentStreamEvent {
  type:
    | "text"
    | "tool_call"
    | "tool_result"
    | "done"
    | "error"
    | "budget_warning"
    | "stuck";
  data: Record<string, unknown>;
}

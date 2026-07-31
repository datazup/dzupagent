/**
 * Auto-compression pipeline for agent conversations.
 *
 * 4-phase compression integrated into the agent loop:
 * 1. Tool result pruning (cheap, no LLM)
 * 2. Orphaned pair repair
 * 3. Boundary-aware split + LLM summarization
 * 4. Frozen snapshot support for prompt cache optimization
 *
 * This module orchestrates the primitives from @dzupagent/core's
 * message-manager into a single autoCompress() call suitable for
 * agent loop integration.
 */
import type { Table } from "apache-arrow";
import type { BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { batchOverlapAnalysis } from "@dzupagent/memory-ipc";
import {
  shouldSummarize,
  summarizeAndTrim,
  type CompressionDegradation,
  type MessageManagerConfig,
} from "./message-manager.js";
import type { OffloadSink } from "./context-eviction.js";
import type { TokenMeasurementResult } from "./token-lifecycle.js";

/**
 * Minimal structural tokenizer surface used by auto-compress (MC-08).
 *
 * We do not import the concrete `Tokenizer` interface from `@dzupagent/core`
 * because `@dzupagent/context` must stay independent of core. Callers can
 * safely pass any object that implements `countTokens`, including the
 * `Tokenizer` types exported from core.
 */
export interface AutoCompressTokenizer {
  /** Model identifier used for diagnostics, when known. */
  readonly model?: string;
  countTokens(text: string): number;
  /** Detailed provenance used by strict hard-budget enforcement. */
  countDetailed?(text: string): TokenMeasurementResult;
}

export interface AutoCompressConfig extends MessageManagerConfig {
  /** If true, memory context is frozen at init and not reloaded mid-session */
  frozenSnapshot?: boolean;

  /**
   * Hook called with the old messages that are about to be summarized away.
   * Use this to extract observations or other data before compression.
   * The hook receives the messages that will be lost after summarization.
   * Non-blocking: errors in the hook don't prevent compression.
   */
  onBeforeSummarize?: (messages: BaseMessage[]) => Promise<void> | void;

  /**
   * Hard token ceiling for the compressed output. If set and the post-
   * compression message array still exceeds this budget, we truncate from
   * the start, keeping only the most recent messages that fit.
   */
  budget?: number;

  /**
   * Telemetry callback invoked when a hard-budget truncation fallback
   * occurs. Receives a reason identifier plus before/after token counts.
   */
  onFallback?: (reason: string, before: number, after: number) => void;

  /**
   * Optional Arrow MemoryFrame. When set, batchOverlapAnalysis is called
   * before summarizeAndTrim to drop messages that duplicate memory content.
   * Zero impact when not set.
   */
  memoryFrame?: unknown;

  /**
   * Optional provenance-aware tokenizer used for hard-budget enforcement
   * (MC-08).
   *
   * A configured hard budget requires `countDetailed()` to report `exact` or
   * `encoding-fallback`. Missing provenance and chars/4 estimates return an
   * adoption-unsafe `token-measurement` degradation instead of claiming that
   * the ceiling was enforced.
   */
  tokenizer?: AutoCompressTokenizer;

  /**
   * When set, messages destroyed by summarization are appended (role-tagged,
   * newline-delimited) to `offload.path` via the sink before compression, and
   * the summary gains a final line naming that path so the agent can
   * read_file it to recover detail. Best-effort: sink errors are swallowed.
   */
  offload?: { sink: OffloadSink; path?: string };
}

export interface CompressResult {
  messages: BaseMessage[];
  summary: string | null;
  compressed: boolean;
  /** Set when a fallback strategy (e.g. hard truncation) was applied. */
  fallbackReason?: string;
  /** Stages that degraded while producing this result. */
  degradations?: CompressionDegradation[];
  /** Final measurement, or the rejected preflight measurement on failure. */
  tokenMeasurement?: TokenMeasurementResult;
}

/**
 * Token measurement for a message array.
 *
 * Detailed tokenizer provenance is preserved when available. Count-only
 * tokenizers and the legacy JSON-stringified char/4 path are explicitly
 * classified as heuristic so strict consumers cannot mistake them for
 * tokenizer-backed measurements.
 */
function measureMessageTokens(
  messages: BaseMessage[],
  tokenizer?: AutoCompressTokenizer
): TokenMeasurementResult {
  if (messages.length === 0) {
    return {
      tokens: 0,
      method: 'exact',
      ...(tokenizer?.model ? { model: tokenizer.model } : {}),
    };
  }
  const serialized = JSON.stringify(messages);
  if (tokenizer?.countDetailed) {
    try {
      const measurement = tokenizer.countDetailed(serialized);
      if (
        Number.isFinite(measurement.tokens) &&
        measurement.tokens >= 0 &&
        Number.isInteger(measurement.tokens)
      ) {
        return measurement;
      }
    } catch {
      // A failed detailed path is unproven even if countTokens still works.
    }
  }
  if (tokenizer) {
    return {
      tokens: tokenizer.countTokens(serialized),
      method: 'heuristic',
      ...(tokenizer.model ? { model: tokenizer.model } : {}),
      reason: tokenizer.countDetailed
        ? 'detailed token measurement failed'
        : 'tokenizer does not expose measurement provenance',
    };
  }
  return {
    tokens: Math.ceil(serialized.length / 4),
    method: 'heuristic',
    reason: 'no tokenizer configured; used chars-per-token estimate',
  };
}

let compactionSequence = 0;

/**
 * Serialize messages about to be destroyed by summarization into a
 * role-tagged, newline-delimited block suitable for appending to an
 * OffloadSink. Sequence-numbered (not timestamped) so offload is
 * deterministic and replayable in tests.
 */
function serializeForOffload(messages: BaseMessage[]): string {
  compactionSequence += 1;
  const lines = messages.map((m) => {
    const role = m.getType();
    const text =
      typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return `${role}: ${text}`;
  });
  return [`--- compacted ${compactionSequence} ---`, ...lines, ""].join("\n");
}

/**
 * Run the full 4-phase compression pipeline on a message array.
 *
 * Returns the compressed messages and updated summary. Invokes the LLM
 * summarizer when the message count/token threshold or hard budget is exceeded.
 */
export async function autoCompress(
  messages: BaseMessage[],
  existingSummary: string | null,
  model: BaseChatModel,
  config?: AutoCompressConfig
): Promise<CompressResult> {
  let hardBudgetMeasurement: TokenMeasurementResult | undefined;
  if (config?.budget !== undefined) {
    hardBudgetMeasurement = measureMessageTokens(messages, config.tokenizer);
    if (hardBudgetMeasurement.method === 'heuristic') {
      const reason = hardBudgetMeasurement.reason ?? 'heuristic token measurement';
      const degradation: CompressionDegradation = {
        stage: 'token-measurement',
        reason,
        adoptionSafe: false,
      };
      config.onFallback?.(
        'token_measurement_unreliable',
        hardBudgetMeasurement.tokens,
        hardBudgetMeasurement.tokens,
      );
      return {
        messages,
        summary: existingSummary,
        compressed: false,
        fallbackReason: `token-measurement: ${reason}`,
        degradations: [degradation],
        tokenMeasurement: hardBudgetMeasurement,
      };
    }
  }

  const exceedsHardBudget =
    config?.budget !== undefined &&
    hardBudgetMeasurement !== undefined &&
    hardBudgetMeasurement.tokens > config.budget;
  if (!exceedsHardBudget && !shouldSummarize(messages, config)) {
    return {
      messages,
      summary: existingSummary,
      compressed: false,
      ...(hardBudgetMeasurement
        ? { tokenMeasurement: hardBudgetMeasurement }
        : {}),
    };
  }

  // Estimate messages that will be lost for best-effort transcript offload.
  // The canonical onBeforeSummarize hook runs inside summarizeAndTrim after its
  // safe boundary alignment, so all summarization call paths share one seam.
  const keep = config?.keepRecentMessages ?? 10;
  const willBeLost =
    messages.length > keep ? messages.slice(0, messages.length - keep) : [];

  let offloadPath: string | undefined;
  let offloadFailure: string | undefined;
  const degradations: CompressionDegradation[] = [];
  if (willBeLost.length > 0 && config?.offload) {
    offloadPath = config.offload.path ?? ".dzup/history/conversation.log";
    try {
      await config.offload.sink.append(
        offloadPath,
        serializeForOffload(willBeLost)
      );
    } catch (error) {
      // Non-fatal: offload failure must not prevent compression, and must not
      // name a path in the summary that was never actually written.
      //
      // But compression proceeds and destroys these messages either way, so
      // staying silent here reports permanent transcript loss as an ordinary
      // successful compaction. Blanking the path alone only removes the
      // recovery pointer; it does not tell the caller there is nothing to
      // recover.
      offloadPath = undefined;
      offloadFailure = `offload-failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      degradations.push({
        stage: "offload",
        reason: offloadFailure,
        adoptionSafe: true,
      });
    }
  }

  // Arrow-aware overlap filtering: drop messages that duplicate memory content.
  // Only runs when config.memoryFrame is set — zero-impact otherwise.
  let messagesToCompress = messages;
  if (config?.memoryFrame) {
    try {
      const messageTexts = messages.map((m) =>
        typeof m.content === "string" ? m.content : JSON.stringify(m.content)
      );
      const analysis = batchOverlapAnalysis(
        messageTexts,
        config.memoryFrame as Table
      );
      // Drop duplicate messages (keep novel ones + recent messages unconditionally)
      const duplicateIndices = new Set(analysis.duplicate.map((d) => d.index));
      messagesToCompress = messages.filter(
        (_, i) => !duplicateIndices.has(i) || i >= messages.length - keep
      );
    } catch {
      // Non-fatal: Arrow analysis failure falls back to full message list
    }
  }

  // summarizeAndTrim internally runs:
  // 1. Tool result pruning (cheap, no LLM)
  // 2. Boundary-aware split that respects tool call/result pairs
  // 3. Orphaned pair repair on the recent section
  // 4. LLM-based structured summarization of old messages
  const {
    summary: rawSummary,
    trimmedMessages,
    degradation: summaryDegradation,
  } = await summarizeAndTrim(
    messagesToCompress,
    existingSummary,
    model,
    config
  );
  if (summaryDegradation !== undefined) {
    degradations.push(summaryDegradation);
  }

  if (summaryDegradation?.adoptionSafe === false) {
    return {
      messages,
      summary: existingSummary,
      compressed: false,
      fallbackReason: `${summaryDegradation.stage}: ${summaryDegradation.reason}`,
      degradations,
    };
  }

  const summary =
    offloadPath !== undefined && rawSummary !== null
      ? `${rawSummary}\nFull pre-summary transcript: ${offloadPath} (read_file to recover detail).`
      : rawSummary;

  // Enforce the hard token ceiling if one was configured. If summarization
  // still produced a result over budget, drop the oldest trimmed messages
  // until we fit.
  if (config?.budget !== undefined) {
    const tk = config.tokenizer;
    const beforeMeasurement = measureMessageTokens(trimmedMessages, tk);
    if (beforeMeasurement.tokens > config.budget) {
      let truncated = trimmedMessages;
      while (
        truncated.length > 0 &&
        measureMessageTokens(truncated, tk).tokens > config.budget
      ) {
        truncated = truncated.slice(1);
      }
      const afterMeasurement = measureMessageTokens(truncated, tk);
      config.onFallback?.(
        "truncation",
        beforeMeasurement.tokens,
        afterMeasurement.tokens,
      );
      return {
        messages: truncated,
        summary,
        compressed: true,
        tokenMeasurement: afterMeasurement,
        fallbackReason:
          offloadFailure !== undefined
            ? `truncation; ${offloadFailure}`
            : "truncation",
        ...(degradations.length > 0 ? { degradations } : {}),
      };
    }

    return {
      messages: trimmedMessages,
      summary,
      compressed: true,
      tokenMeasurement: beforeMeasurement,
      ...(offloadFailure !== undefined
        ? { fallbackReason: offloadFailure }
        : {}),
      ...(degradations.length > 0 ? { degradations } : {}),
    };
  }

  return {
    messages: trimmedMessages,
    summary,
    compressed: true,
    ...(offloadFailure !== undefined
      ? { fallbackReason: offloadFailure }
      : {}),
    ...(degradations.length > 0 ? { degradations } : {}),
  };
}

export { FrozenSnapshot } from './frozen-snapshot.js'
export type {
  FrozenSnapshotOptions,
  SnapshotComparisonFailureTelemetry,
  SnapshotInvalidationReason,
  SnapshotInvalidationResult,
} from './frozen-snapshot.js'

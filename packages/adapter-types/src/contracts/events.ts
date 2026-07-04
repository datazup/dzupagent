import type { TokenUsage } from "./token-usage.js";
import type { AdapterProviderId } from "./provider.js";
import type { RawAgentEvent } from "./run-store.js";

/** Unified agent event emitted by all adapters */
export type AgentEvent =
  | AgentStartedEvent
  | AgentMessageEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentCompletedEvent
  | AgentFailedEvent
  | AgentRecoveryCancelledEvent
  | AgentStreamDeltaEvent
  | AgentProgressEvent
  | AgentMemoryRecalledEvent
  | AgentSkillsCompiledEvent
  | AgentInteractionRequiredEvent
  | AgentInteractionResolvedEvent
  | AgentCacheStatsEvent;

export interface AgentStartedEvent {
  type: "adapter:started";
  providerId: AdapterProviderId;
  sessionId: string;
  timestamp: number;
  /** The input prompt (redacted if configured) */
  prompt?: string | undefined;
  /** The system prompt used */
  systemPrompt?: string | undefined;
  /** The model selected */
  model?: string | undefined;
  /** Working directory */
  workingDirectory?: string | undefined;
  /** Whether this is a resumed session */
  isResume?: boolean | undefined;
  /** Correlation ID from the originating request */
  correlationId?: string | undefined;
}

export interface AgentMessageEvent {
  type: "adapter:message";
  providerId: AdapterProviderId;
  content: string;
  role: "assistant" | "user" | "system";
  timestamp: number;
  /** Correlation ID from the originating request */
  correlationId?: string | undefined;
}

export interface AgentToolCallEvent {
  type: "adapter:tool_call";
  providerId: AdapterProviderId;
  toolName: string;
  toolCallId?: string | undefined;
  input: unknown;
  timestamp: number;
  /** Correlation ID from the originating request */
  correlationId?: string | undefined;
}

export interface AgentToolResultEvent {
  type: "adapter:tool_result";
  providerId: AdapterProviderId;
  toolName: string;
  toolCallId?: string | undefined;
  output: string;
  durationMs: number;
  timestamp: number;
  /** Correlation ID from the originating request */
  correlationId?: string | undefined;
}

export interface AgentCompletedEvent {
  type: "adapter:completed";
  providerId: AdapterProviderId;
  sessionId: string;
  result: string;
  usage?: TokenUsage | undefined;
  durationMs: number;
  timestamp: number;
  /** Correlation ID from the originating request */
  correlationId?: string | undefined;
}

export interface AgentFailedEvent {
  type: "adapter:failed";
  providerId: AdapterProviderId;
  sessionId?: string | undefined;
  error: string;
  code?: string | undefined;
  timestamp: number;
  /** Correlation ID from the originating request */
  correlationId?: string | undefined;
}

export interface AgentRecoveryCancelledEvent {
  type: "recovery:cancelled";
  providerId: AdapterProviderId;
  strategy: "abort";
  error: string;
  totalAttempts: number;
  totalDurationMs: number;
  timestamp: number;
  /** Correlation ID from the originating request */
  correlationId?: string | undefined;
}

export interface AgentStreamDeltaEvent {
  type: "adapter:stream_delta";
  providerId: AdapterProviderId;
  content: string;
  timestamp: number;
  /** Correlation ID from the originating request */
  correlationId?: string | undefined;
}

export interface AgentProgressEvent {
  type: "adapter:progress";
  providerId: AdapterProviderId;
  timestamp: number;
  /** Progress phase name */
  phase: string;
  /** Progress percentage (0-100). Undefined if indeterminate. */
  percentage?: number | undefined;
  /** Human-readable status message */
  message?: string | undefined;
  /** Current step/iteration number */
  current?: number | undefined;
  /** Total steps/iterations (if known) */
  total?: number | undefined;
  /** Optional structured progress metadata for machine consumers. */
  details?: Record<string, unknown> | undefined;
  /** Correlation ID from the originating request */
  correlationId?: string | undefined;
}

/** Map-reduce orchestration event emitted on the framework event bus. */
export type MapReduceRuntimeEvent =
  | { type: "mapreduce:started"; totalChunks: number; maxConcurrency: number }
  | {
      type: "mapreduce:map_completed";
      totalChunks: number;
      successfulChunks: number;
      failedChunks: number;
    }
  | {
      type: "mapreduce:completed";
      totalChunks: number;
      successfulChunks: number;
      failedChunks: number;
      totalDurationMs: number;
      reduceDurationMs: number;
    }
  | {
      type: "mapreduce:chunk_completed";
      chunkIndex: number;
      providerId: AdapterProviderId;
      durationMs: number;
      success: boolean;
    }
  | {
      type: "mapreduce:chunk_failed";
      chunkIndex: number;
      error: string;
      durationMs: number;
    };

/**
 * Background subagent runtime events emitted on the framework event bus by
 * `@dzupagent/subagents`. Provider-neutral orchestration/runtime state — kept
 * here (the canonical contract home) so both the subagents runtime and bus
 * subscribers share one definition.
 */
export type SubagentRuntimeEvent =
  | {
      type: "subagent:spawned";
      taskId: string;
      parentRunId: string;
      agentId: string;
      /** Fan-out batch this spawn belongs to, when spawned by a fan-out tool. */
      batchId?: string;
      /** Spawn depth (0 = spawned by the top-level run). */
      depth?: number;
    }
  | { type: "subagent:admitted"; taskId: string }
  | { type: "subagent:progress"; taskId: string; note: string }
  | { type: "subagent:completed"; taskId: string; durationMs: number }
  | {
      type: "subagent:failed";
      taskId: string;
      error: string;
      durationMs: number;
    }
  | { type: "subagent:cancelled"; taskId: string }
  | { type: "subagent:expired"; taskId: string };

/**
 * Task lifecycle statuses referenced by fan-out settlement events. Mirrors
 * `TaskStatus` in `@dzupagent/subagents` (kept in sync by intent —
 * adapter-types stays dependency-free).
 */
export type FanoutTaskStatus =
  | "queued"
  | "awaiting_approval"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

/**
 * Batch fan-out lifecycle events emitted on the framework event bus by the
 * `fanout_template` tool in `@dzupagent/subagents` (dynamic-subagents Spec 03
 * §5). Canonical contract home is here, alongside `SubagentRuntimeEvent`;
 * core's `event-types-shared.ts` mirrors this union into `DzupEvent`.
 *
 * Host UX contract: a consumer can render "M of N settled" from
 * `fanout:started.declared` + counting `fanout:item_settled`, without polling
 * the task store.
 */
export type FanoutRuntimeEvent =
  | {
      type: "fanout:started";
      batchId: string;
      parentRunId: string;
      mode: "template" | "script";
      declared: number;
    }
  | {
      type: "fanout:item_dispatched";
      batchId: string;
      itemKey: string;
      taskId: string;
    }
  | {
      type: "fanout:item_settled";
      batchId: string;
      itemKey: string;
      taskId: string;
      status: FanoutTaskStatus;
      durationMs?: number;
    }
  | {
      type: "fanout:completed";
      batchId: string;
      dispatched: number;
      succeeded: number;
      failed: number;
      uncovered: number;
      wallClockMs: number;
    }
  | {
      type: "fanout:aborted";
      batchId: string;
      reason:
        | "denied"
        | "script_error"
        | "budget_exceeded"
        | "timeout"
        | "validation_error";
      dispatched: number;
    }
  | { type: "fanout:progress"; batchId: string; message: string };

/**
 * Adapter-owned runtime events that are deliberately allowed on DzupEventBus.
 *
 * Keep this provider-neutral: it describes adapter orchestration/runtime state,
 * not product UI state.
 */
export type AdapterRuntimeEventBusEvent =
  | AgentProgressEvent
  | MapReduceRuntimeEvent
  | SubagentRuntimeEvent
  | FanoutRuntimeEvent;

/** Emitted after memory injection completes (withHierarchicalMemoryEnrichment) */
export interface AgentMemoryRecalledEvent {
  type: "adapter:memory_recalled";
  providerId: AdapterProviderId;
  timestamp: number;
  entries: Array<{
    level: "global" | "workspace" | "project" | "agent";
    name: string;
    /** Rough token estimate (chars / 4) */
    tokenEstimate: number;
  }>;
  /** Total tokens injected across all entries */
  totalTokens: number;
  /** Duration of the memory recall phase in milliseconds */
  durationMs: number;
  correlationId?: string | undefined;
}

/** Emitted after skills are compiled for a run (DzupAgentFileLoader) */
export interface AgentSkillsCompiledEvent {
  type: "adapter:skills_compiled";
  providerId: AdapterProviderId;
  timestamp: number;
  skills: Array<{
    skillId: string;
    /** Features that compiled at reduced capacity */
    degraded: string[];
    /** Features that were silently dropped (unsupported by provider) */
    dropped: string[];
  }>;
  /** Duration of the skills compilation phase in milliseconds */
  durationMs: number;
  correlationId?: string | undefined;
}

/**
 * Emitted when the adapter detects a mid-execution question, clarification
 * request, or permission prompt from the sub-agent.
 * Only emitted when interactionPolicy.mode === 'ask-caller'.
 */
export interface AgentInteractionRequiredEvent {
  type: "adapter:interaction_required";
  providerId: AdapterProviderId;
  /** Unique ID — pass back to InteractionResolver.respond(interactionId, answer) */
  interactionId: string;
  /** The raw question/prompt text from the sub-agent */
  question: string;
  /** Classified kind of interaction */
  kind: "permission" | "clarification" | "confirmation" | "unknown";
  timestamp: number;
  /** Epoch ms deadline — caller must respond before this or the timeout fires */
  expiresAt: number;
  correlationId?: string | undefined;
}

/**
 * Emitted when a mid-execution interaction is resolved (auto or manual).
 * Always emitted regardless of policy mode, for observability.
 */
export interface AgentInteractionResolvedEvent {
  type: "adapter:interaction_resolved";
  providerId: AdapterProviderId;
  interactionId: string;
  question: string;
  answer: string;
  /** How the answer was determined */
  resolvedBy:
    | "auto-approve"
    | "auto-deny"
    | "default-answers"
    | "ai-autonomous"
    | "caller"
    | "timeout-fallback";
  timestamp: number;
  correlationId?: string | undefined;
}

/**
 * Side-channel wrapper for a provider-native raw event emitted live alongside
 * normalized adapter events.
 */
export interface ProviderRawStreamEvent {
  type: "adapter:provider_raw";
  rawEvent: RawAgentEvent;
}

/** Stream item yielded by raw-capable adapters and orchestrators. */
export interface AgentCacheStatsEvent {
  type: "adapter:cache_stats";
  providerId: AdapterProviderId;
  sessionId: string;
  /** Tokens served from cache (billed at ~10% of input price) */
  cacheReadTokens: number;
  /** Tokens written to cache (billed at ~125% of input price) */
  cacheWriteTokens: number;
  /** Total input tokens for this run (including cached) */
  totalInputTokens: number;
  /** Fraction of input tokens that were cache hits (0–1) */
  cacheHitRatio: number;
  timestamp: number;
  correlationId?: string | undefined;
}

export type AgentStreamEvent = AgentEvent | ProviderRawStreamEvent;

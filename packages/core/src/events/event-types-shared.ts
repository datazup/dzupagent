/**
 * Shared payload shapes referenced by multiple event variants.
 *
 * These types are exported separately so that adapter-layer producers can
 * build the structured records before the discriminator is attached at
 * emission time.
 */

/**
 * Per-tool-call audit record emitted by the stream runner whenever an
 * `adapter:tool_call` / `adapter:tool_result` pair is observed.
 *
 * The record is delivered through a {@link ToolCallAuditSink} attached to
 * {@link AdapterStreamRunnerConfig.toolCallAuditSink}. Sink errors are
 * swallowed — audit emission must not break the LLM call path.
 */
export interface ToolCallAuditRecord {
  type: "tool_call";
  /** Name of the tool that was invoked. */
  toolName: string;
  /**
   * Short identifier derived from the input args — either a truncated JSON
   * string or a simple hash. Suitable for correlation / deduplication without
   * leaking full payload content to the audit log.
   */
  argsHash: string;
  /** Outcome of the tool invocation. */
  resultStatus: "success" | "error";
  /** Wall-clock duration of the tool call in milliseconds (>= 0). */
  durationMs: number;
  /** Optional tool call ID supplied by the adapter. */
  toolCallId?: string;
  /** ISO timestamp of when the tool call started. */
  startedAt: string;
}

/**
 * Sink function type for per-tool-call audit records.
 * Mirrors the design of {@link LlmAuditSink} — synchronous, best-effort,
 * errors swallowed by the caller.
 */
export type ToolCallAuditSink = (record: ToolCallAuditRecord) => void;

/**
 * Budget usage snapshot — emitted with budget warnings.
 */
export interface BudgetUsage {
  tokensUsed: number;
  tokensLimit: number;
  costCents: number;
  costLimitCents: number;
  iterations: number;
  iterationsLimit: number;
  percent: number;
}

/**
 * Structured payload for `llm:invocation_recorded` — exported separately so
 * adapter-layer producers can build the record (e.g. inside an audit sink
 * callback) before the event-type discriminator is attached at emission.
 *
 * All fields except `providerId`/`model`/`status`/`durationMs`/`startedAt`/
 * `promptCharCount` are best-effort; consumers must treat optionals as
 * "may be missing on this provider/path" rather than "always reported".
 */
export interface LlmInvocationRecord {
  /** Provider identifier — e.g. 'claude', 'openai', 'gemini'. */
  providerId: string;
  /** Resolved model name — e.g. 'claude-haiku-4-5-20251001', 'gpt-4o-mini'. */
  model: string;
  /** Optional — only present when the call ran inside a run context. */
  runId?: string;
  /** Optional — only present when the call ran inside a tenant-scoped context. */
  tenantId?: string;
  /** Size proxy when a tokenizer is unavailable. */
  promptCharCount: number;
  /** Size proxy for the system prompt, when one was supplied. */
  systemPromptCharCount?: number;
  /**
   * Outcome status. `'completed'` = the adapter produced a terminal completed
   * event; `'failed'` = the adapter or network layer reported a failure.
   */
  status: "completed" | "failed";
  /** Populated when `status === 'failed'`. */
  errorCode?: string;
  /** Adapter-reported duration when available, wall-clock otherwise. */
  durationMs: number;
  /** Token usage — present only when the adapter reports it. */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  /** Cost in cents — present only when computed by the adapter. */
  costCents?: number;
  /** ISO timestamp of when the call started. */
  startedAt: string;
}

/**
 * Per-tool execution statistics emitted with `agent:stop_reason`.
 */
export interface ToolStatSummary {
  name: string;
  calls: number;
  errors: number;
  totalMs: number;
  avgMs: number;
}

/**
 * Adapter runtime progress emitted by provider-neutral orchestration layers.
 *
 * This is the event-bus counterpart to adapter package progress events. The
 * provider is optional because supervisor-level progress can describe a group
 * of subtasks before a single provider is selected.
 */
export interface AdapterProgressDzupEvent {
  type: "adapter:progress";
  providerId?: string;
  timestamp: number;
  phase: string;
  percentage?: number;
  message?: string;
  current?: number;
  total?: number;
  correlationId?: string;
}

export type MapReduceDzupEvent =
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
      providerId: string;
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
 * Background subagent lifecycle events emitted by `@dzupagent/subagents` and
 * bridged onto the bus by `@dzupagent/agent-adapters`. Mirrors the
 * adapter-types `SubagentRuntimeEvent` contract (kept in sync by intent).
 */
export type SubagentRuntimeDzupEvent =
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
 * Batch fan-out lifecycle events emitted by the `fanout_template` tool in
 * `@dzupagent/subagents` and bridged onto the bus. Mirrors the adapter-types
 * `FanoutRuntimeEvent` contract (kept in sync by intent — see the
 * event-union-sync drift test in `@dzupagent/subagents`).
 */
export type FanoutRuntimeDzupEvent =
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
      status:
        | "queued"
        | "awaiting_approval"
        | "running"
        | "succeeded"
        | "failed"
        | "cancelled"
        | "expired";
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
 * Governance decisions surfaced by the subagent spawn gate. A focused subset of
 * the governance plane, emittable on the bus alongside runtime events.
 */
export type SubagentGovernanceDzupEvent = {
  type:
    | "governance:approval_requested"
    | "governance:approval_resolved"
    | "governance:rule_violation";
  runId: string;
  approvalId?: string;
  detail?: string;
};

export type AdapterRuntimeDzupEvent =
  | AdapterProgressDzupEvent
  | MapReduceDzupEvent
  | SubagentRuntimeDzupEvent
  | FanoutRuntimeDzupEvent
  | SubagentGovernanceDzupEvent;

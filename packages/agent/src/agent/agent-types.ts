/**
 * Core types for DzupAgent — the top-level agent abstraction.
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { BaseMessage } from '@langchain/core/messages'
import type {
  ModelTier,
  ModelRegistry,
  AgentMiddleware,
  DzupEventBus,
  StructuredOutputModelCapabilities,
  ToolGovernance,
  SafetyMonitor,
} from '@dzupagent/core'
import type { ToolPermissionPolicy } from '@dzupagent/agent-types'
import type { MemoryService } from '@dzupagent/memory'
import type { MessageManagerConfig } from '@dzupagent/context'
import type { ConversationPhase, FrozenSnapshot } from '@dzupagent/context'
import type { ToolStat, StopReason, ToolLoopTracer } from './tool-loop.js'
import type { ToolArgValidatorConfig } from './tool-arg-validator.js'
import type { StuckError } from './stuck-error.js'
import type { GuardrailConfig } from '../guardrails/guardrail-types.js'
import type { MemoryProfile } from './memory-profiles.js'
import type { ToolLoopLearningConfig, RunLearnings } from './tool-loop-learning.js'
import type { ReflectionSummary } from '../reflection/reflection-types.js'
import type { ReflectionAnalyzerConfig } from '../reflection/reflection-analyzer.js'
import type { MailboxStore } from '../mailbox/types.js'
import type { AgentLoopPlugin } from '../token-lifecycle-wiring.js'

/** Configuration for creating a DzupAgent */
export interface DzupAgentConfig {
  /** Unique agent identifier */
  id: string
  /** Human-readable name */
  name?: string
  /** System instructions for the agent */
  instructions: string
  /** Model to use — either a BaseChatModel instance, a ModelTier string, or a 'provider/model' string */
  model: BaseChatModel | ModelTier | string
  /**
   * Optional structured-output capability override for the resolved model.
   *
   * Use this when passing a direct BaseChatModel instance or other bypassed
   * runtime surface that would otherwise rely on heuristic detection.
   */
  structuredOutputCapabilities?: StructuredOutputModelCapabilities
  /** Model registry for resolving tier/name strings */
  registry?: ModelRegistry
  /** Tools available to this agent */
  tools?: StructuredToolInterface[]
  /** Middleware hooks (cost tracking, observability, etc.) */
  middleware?: AgentMiddleware[]
  /** Memory service for persistent context */
  memory?: MemoryService
  /** Memory scope for get/put operations */
  memoryScope?: Record<string, string>
  /** Memory namespace to use */
  memoryNamespace?: string
  /**
   * When true (default), the agent's response content is persisted to
   * MemoryService after each successful run. Set to false to disable
   * automatic write-back.
   */
  memoryWriteBack?: boolean
  /**
   * Optional TTL for written-back memory records, in milliseconds.
   *
   * When set, `maybeWriteBackMemory()` stamps each persisted record with an
   * `expiresAt = Date.now() + ttlMs` marker so consumers (e.g.
   * {@link buildFrozenSnapshot}) can filter out stale entries without a
   * separate sweeper.  When unset, records never expire.
   */
  ttlMs?: number
  /** Message compression config */
  messageConfig?: MessageManagerConfig
  /**
   * When set, applies phase-aware message retention windowing before each
   * prepareMessages() call. Uses PhaseAwareWindowManager.findRetentionSplit()
   * to score and trim low-value messages for the given phase.
   *
   * Gate: no effect when unset (zero impact on default path).
   */
  messagePhase?: ConversationPhase
  /** Safety guardrails */
  guardrails?: GuardrailConfig
  /** Maximum tool-call iterations before forcing a response (default: 10) */
  maxIterations?: number
  /** Description of what this agent does (used when agent is exposed as a tool) */
  description?: string
  /** Event bus for emitting telemetry and lifecycle events */
  eventBus?: DzupEventBus

  /**
   * Telemetry callback invoked when memory falls back or compression truncates.
   * Receives a reason identifier plus before/after token counts.
   */
  onFallback?: (reason: string, before: number, after: number) => void

  /**
   * Structured diagnostic callback with richer context than onFallback.
   * Receives reason code, human-readable detail, provider label, namespace,
   * and optional token estimates. Never receives raw scope keys/values or
   * memory record content.
   */
  onFallbackDetail?: (event: {
    reason: string
    detail: string
    namespace: string
    /** Provider label (e.g. 'arrow', 'standard', 'summary'). Optional for backwards compatibility. */
    provider?: string
    tokensBefore?: number
    tokensAfter?: number
  }) => void

  /**
   * Optional tool stats tracker for injecting preferred-tool hints
   * into the system prompt before the first LLM invocation.
   * Uses structural typing so callers can pass a ToolStatsTracker from core.
   */
  toolStatsTracker?: { formatAsPromptHint: (limit?: number, intent?: string) => string }

  /**
   * Arrow-based memory configuration (optional, enables token budgeting).
   *
   * When set, `prepareMessages()` uses `@dzupagent/memory-ipc`'s
   * `TokenBudgetAllocator` and `phaseWeightedSelection` to select only the
   * most relevant memory records that fit within a token budget, instead of
   * loading every record.
   *
   * The import is dynamic so `apache-arrow` is never required at install time.
   * If the import fails the agent falls back to the standard load-all path.
   */
  arrowMemory?: ArrowMemoryConfig

  /**
   * Memory budget profile preset.
   *
   * When set, provides default values for `arrowMemory` fields (totalBudget,
   * maxMemoryFraction, minResponseReserve).  Explicit values in `arrowMemory`
   * override the profile defaults.
   *
   * - `'minimal'`      — 32 K budget, 10 % memory, 8 K reserve (cost-constrained)
   * - `'balanced'`     — 128 K budget, 30 % memory, 4 K reserve (default)
   * - `'memory-heavy'` — 200 K budget, 50 % memory, 4 K reserve (knowledge-intensive)
   */
  memoryProfile?: MemoryProfile

  /**
   * Optional frozen memory snapshot.
   *
   * When set, the agent's memory context loader uses this pre-built snapshot
   * on subsequent calls instead of reloading from the memory service, avoiding
   * redundant loads for agents that share static knowledge.
   *
   * The snapshot is consulted via {@link FrozenSnapshot.isActive}; when active
   * the loader returns the cached context and skips the memory service fetch.
   * Callers are responsible for freezing the snapshot (typically on the first
   * successful load) and thawing it when the underlying memory changes.
   */
  frozenSnapshot?: FrozenSnapshot

  /**
   * How instructions are resolved:
   * - `'static'` (default): use only the `instructions` string
   * - `'static+agents'`: merge `instructions` with AGENTS.md files found
   *   in `agentsDir` (or the current working directory)
   */
  instructionsMode?: 'static' | 'static+agents'

  /**
   * Directory to scan for AGENTS.md files when `instructionsMode` is
   * `'static+agents'`. Defaults to `process.cwd()`.
   */
  agentsDir?: string

  /**
   * Self-learning configuration.
   *
   * When enabled, the agent records per-tool execution statistics via
   * SkillLearner, optionally loads specialist config from a SpecialistRegistry,
   * and fires learning callbacks after each tool call and after each run.
   *
   * Default: disabled (opt-in).
   */
  selfLearning?: ToolLoopLearningConfig

  /**
   * Called after each run completes with the reflection summary.
   *
   * Wire this to LearningMiddleware, ReflectionStore, or any custom handler
   * to close the feedback loop between ReflectionAnalyzer and the learning
   * system.
   *
   * Errors thrown by this callback are caught and never propagated --- the
   * run result is always returned regardless of callback success.
   */
  onReflectionComplete?: (summary: ReflectionSummary) => Promise<void>

  /**
   * Configuration for the ReflectionAnalyzer used in post-run analysis.
   *
   * Controls thresholds for pattern detection (slow steps, repeated tools,
   * error loops). When `onReflectionComplete` is set, the analyzer runs
   * automatically after each generate() call.
   */
  reflectionAnalyzerConfig?: ReflectionAnalyzerConfig

  /**
   * Inter-agent mailbox configuration.
   *
   * When set, the agent creates an {@link AgentMailbox} scoped to its ID and
   * auto-registers `send_mail` and `check_mail` tools so the LLM can
   * communicate with other agents asynchronously.
   *
   * The mailbox instance is also exposed as `agent.mailbox` for external access.
   */
  mailbox?: AgentMailboxConfig

  /**
   * Optional token lifecycle plugin — wires auto-compression and halt
   * behaviour into the default tool loop. Build with
   * {@link createTokenLifecyclePlugin} from `../token-lifecycle-wiring`.
   *
   * When present, the plugin's `shouldHalt()` method is consulted after
   * each LLM turn. A `true` return ends the loop with
   * `stopReason: 'token_exhausted'` and emits a
   * `run:halted:token-exhausted` event on `eventBus` (if configured).
   */
  tokenLifecyclePlugin?: AgentLoopPlugin

  /**
   * Tool-execution policy bundle (audit fix MJ-AGENT-01).
   *
   * Exposes the per-tool execution controls that already exist in
   * {@link ToolLoopConfig} via the public `DzupAgent` config surface so
   * callers using `DzupAgent.generate()` / `stream()` can govern tool
   * behaviour without dropping down to `runToolLoop()` directly.
   *
   * All fields are optional and backwards-compatible: when `toolExecution`
   * is omitted (or any individual field is omitted), the loop behaves
   * exactly as it did before this surface was added.
   *
   * Each field is threaded through to the corresponding option on
   * {@link ToolLoopConfig}:
   *
   * | toolExecution field   | tool-loop field          |
   * |-----------------------|--------------------------|
   * | `governance`          | `toolGovernance`         |
   * | `safetyMonitor`       | `safetyMonitor`          |
   * | `scanToolResults`     | `scanToolResults`        |
   * | `timeouts`            | `toolTimeouts`           |
   * | `tracer`              | `tracer`                 |
   * | `agentId`             | `agentId`                |
   * | `runId`               | `runId`                  |
   * | `argumentValidator`   | `validateToolArgs`       |
   * | `permissionPolicy`    | `toolPermissionPolicy`   |
   *
   * Note: the `resultScanner` slot in the audit spec is fulfilled by the
   * existing `safetyMonitor` (which scans tool results for unsafe content
   * via {@link SafetyMonitor.scanContent}). A dedicated content scanner
   * type is intentionally not introduced here; callers may pass the same
   * `SafetyMonitor` instance via either field.
   */
  toolExecution?: ToolExecutionConfig
}

/**
 * Per-tool execution timeout map.
 *
 * Keys are tool names; values are timeout durations in milliseconds.
 * Forwarded directly to {@link ToolLoopConfig.toolTimeouts}.
 *
 * Example: `{ fetchUrl: 10_000, expensiveQuery: 60_000 }`.
 */
export type PerToolTimeoutMap = Record<string, number>

/**
 * Argument validator configuration.
 *
 * - `true`            — validate with auto-repair enabled
 * - `false`           — disable validation (default)
 * - `ToolArgValidatorConfig` — explicit knob bag (e.g. `{ autoRepair: false }`)
 *
 * Forwarded directly to {@link ToolLoopConfig.validateToolArgs}.
 */
export type ArgumentValidator = boolean | ToolArgValidatorConfig

/**
 * Tool tracer, structurally compatible with `DzupTracer` / `OTelSpan` from
 * `@dzupagent/otel`. Re-exported as the public alias for the
 * `toolExecution.tracer` slot so consumers don't have to know the
 * tool-loop's internal naming.
 */
export type ToolTracer = ToolLoopTracer

/**
 * Public surface for governing tool execution from a top-level
 * {@link DzupAgentConfig} (audit fix MJ-AGENT-01).
 *
 * Each field is optional; omitting any field preserves the legacy default.
 * The bundle is passed through to {@link ToolLoopConfig} during
 * `generate()` / `stream()` execution.
 */
export interface ToolExecutionConfig {
  /**
   * Tool governance layer — declares blocked tools, approval-required
   * tools, audit handlers, and access checks. Forwarded to
   * {@link ToolLoopConfig.toolGovernance}.
   *
   * When set, every tool call passes through `governance.checkAccess` and
   * (for non-`success` outcomes) `governance.auditResult`. Approval-
   * required tools trigger a hard execution gate that halts the loop with
   * `stopReason: 'approval_pending'`.
   */
  governance?: ToolGovernance

  /**
   * Safety monitor used to scan tool RESULTS for unsafe content (prompt
   * injection, secrets exfiltration, etc.) before they reach the LLM.
   * Forwarded to {@link ToolLoopConfig.safetyMonitor}.
   *
   * Critical / `block` / `kill` violations replace the tool output with a
   * safe rejection message.
   */
  safetyMonitor?: SafetyMonitor

  /**
   * Alias for {@link safetyMonitor}, provided so the public surface
   * matches the audit-spec naming. If both fields are supplied,
   * `safetyMonitor` wins.
   */
  resultScanner?: SafetyMonitor

  /**
   * Disable scanning tool results via {@link safetyMonitor}.
   * Defaults to `true` when a safetyMonitor is provided. Set to `false`
   * to opt out (e.g. when upstream scanning already happened).
   *
   * Forwarded to {@link ToolLoopConfig.scanToolResults}.
   */
  scanToolResults?: boolean

  /**
   * Per-tool execution timeouts in milliseconds. Forwarded to
   * {@link ToolLoopConfig.toolTimeouts}.
   */
  timeouts?: PerToolTimeoutMap

  /**
   * Optional OTel tracer for emitting one span per tool invocation.
   * Forwarded to {@link ToolLoopConfig.tracer}.
   */
  tracer?: ToolTracer

  /**
   * Identity of the agent that owns this tool loop invocation.
   *
   * When omitted, falls back to {@link DzupAgentConfig.id}. Forwarded to
   * {@link ToolLoopConfig.agentId}.
   */
  agentId?: string

  /**
   * Durable run identifier for canonical tool lifecycle events. Used as
   * the correlation id on `approval:requested` events. Forwarded to
   * {@link ToolLoopConfig.runId}.
   */
  runId?: string

  /**
   * Validate tool arguments against the tool's schema before execution.
   * Forwarded to {@link ToolLoopConfig.validateToolArgs}.
   */
  argumentValidator?: ArgumentValidator

  /**
   * Pluggable permission policy. When omitted, no permission checks run.
   * Forwarded to {@link ToolLoopConfig.toolPermissionPolicy}.
   */
  permissionPolicy?: ToolPermissionPolicy
}

/** Configuration for enabling the inter-agent mailbox on a DzupAgent. */
export interface AgentMailboxConfig {
  /** Backing store for mail messages. Defaults to InMemoryMailboxStore. */
  store?: MailboxStore
  /** Event bus for real-time mail notifications. Falls back to the agent's own eventBus. */
  eventBus?: DzupEventBus
}

/** Configuration for Arrow-based token-budgeted memory selection. */
export interface ArrowMemoryConfig {
  /** Total context window budget in tokens (default: 128000) */
  totalBudget?: number
  /** Max fraction of budget for memory context (default: 0.3) */
  maxMemoryFraction?: number
  /** Min tokens reserved for response (default: 4000) */
  minResponseReserve?: number
  /** Current conversation phase for phase-weighted selection */
  currentPhase?: 'planning' | 'coding' | 'debugging' | 'reviewing' | 'general'
}

/** Options for a single generate/stream call */
export interface GenerateOptions {
  /** Override max iterations for this call */
  maxIterations?: number
  /** Abort signal for cancellation */
  signal?: AbortSignal
  /** Additional context to inject as a system message suffix */
  context?: string
  /** Callback for token usage per LLM call */
  onUsage?: (usage: { model: string; inputTokens: number; outputTokens: number }) => void
  /** Current intent for per-intent tool ranking (passed to ToolStatsTracker) */
  intent?: string
  /**
   * Optional structured-output schema name override.
   *
   * Used by `generateStructured()` for schema hashing, telemetry, and provider
   * diagnostics. When unset, the agent derives a stable default from `agentId`
   * and `intent`.
   */
  schemaName?: string
  /**
   * Structured-output schema normalization target.
   *
   * - `openai` (default): strips unsupported constraints before native
   *   structured-output calls and hashes the provider-safe schema.
   * - `generic`: uses canonical JSON Schema without provider stripping.
   */
  schemaProvider?: 'generic' | 'openai'
  /** Internal resume context — set by the server worker when re-enqueueing a paused run. */
  _resume?: {
    resumeToken?: string
    checkpoint?: string
    lastStateSeq?: number
    input?: unknown
  }
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
  before: number
  after: number
  summary: string | null
  ts: number
}

/** Result of a generate() call */
export interface GenerateResult {
  /** The final text response */
  content: string
  /** All messages in the conversation (including tool calls) */
  messages: BaseMessage[]
  /** Token usage across all LLM calls in this generation */
  usage: {
    totalInputTokens: number
    totalOutputTokens: number
    llmCalls: number
  }
  /** Whether the agent hit the max iteration limit */
  hitIterationLimit: boolean
  /** Why the agent stopped (more granular than hitIterationLimit). */
  stopReason: StopReason
  /** Per-tool execution statistics. */
  toolStats: ToolStat[]
  /**
   * When `stopReason` is `'stuck'`, contains the structured StuckError
   * with reason, repeatedTool, and escalationLevel.
   */
  stuckError?: StuckError
  /**
   * Self-learning signals from this run.
   * Only present when `selfLearning.enabled` is true in the agent config.
   */
  learnings?: RunLearnings
  /**
   * Per-run memory frame snapshot captured during `prepareMessages()`.
   * Threaded from the run state so observers (and the public `RunResult`)
   * can inspect exactly which memory context was attached to this run.
   * Opaque — the shape depends on the configured memory provider.
   */
  memoryFrame?: unknown
  /**
   * Log of compression events that fired during this run.
   *
   * Populated by the run engine's `onCompressed` wiring; only present when
   * auto-compression triggered (i.e. `maybeCompress` returned
   * `compressed: true` at least once). Entries are appended in the order
   * compression was observed.
   */
  compressionLog?: CompressionLogEntry[]
}

/** A single streamed event from the agent */
export interface AgentStreamEvent {
  type: 'text' | 'tool_call' | 'tool_result' | 'done' | 'error' | 'budget_warning' | 'stuck'
  data: Record<string, unknown>
}

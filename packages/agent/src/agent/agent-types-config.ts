/**
 * Top-level {@link DzupAgentConfig} — the configuration surface for creating
 * a {@link DzupAgent}.
 *
 * Composed from focused slice interfaces defined alongside this module:
 * - {@link MemoryConfigSlice}        — `agent-types-memory`
 * - {@link ObservabilityConfigSlice} — `agent-types-observability`
 * - {@link SecurityConfig}           — `agent-types-security`
 *
 * Extracted from the original `agent-types.ts` barrel — see that file for the
 * authoritative re-exports.
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { UnclassifiedToolPolicy } from '../tools/tool-tier-registry.js'
import type {
  ModelTier,
  ModelRegistry,
  AgentMiddleware,
  StructuredOutputModelCapabilities,
  TokenBucket,
  TokenBucketConfig,
} from '@dzupagent/core/llm'
import type { DzupEventBus } from '@dzupagent/core/events'
import type { AgentHooks, PluginRegistry } from '@dzupagent/core/orchestration'
import type { DzupRunStateStore } from '@dzupagent/core/persistence'
import type { PermissionTier } from '@dzupagent/core/tools'
import type { MessageManagerConfig, ConversationPhase } from '@dzupagent/context'
import type { GuardrailConfig } from '../guardrails/guardrail-types.js'
import type { ToolLoopLearningConfig } from './tool-loop-learning.js'
import type { ReflectionSummary } from '../reflection/reflection-types.js'
import type { ReflectionAnalyzerConfig } from '../reflection/reflection-analyzer.js'
import type { AgentLoopPlugin } from '../token-lifecycle-wiring.js'
import type { OutputFilter } from './output-filter.js'
import type { ToolExecutionConfig } from './agent-types-tool-execution.js'
import type { ProviderFailoverPolicy } from './agent-types-failover.js'
import type { AgentMailboxConfig } from './agent-types-mailbox.js'
import type { MemoryConfigSlice } from './agent-types-memory.js'
import type { ObservabilityConfigSlice } from './agent-types-observability.js'
import type { SecurityConfig } from './agent-types-security.js'
import type { AgentHardBudgetConfig } from './runtime-hard-budget.js'

/** Configuration for creating a DzupAgent */
export interface DzupAgentConfig extends MemoryConfigSlice, ObservabilityConfigSlice {
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
  /**
   * Permission tier for this agent (MC-AGT-05).
   *
   * Tools tagged with a higher `requiredTier` (via `setToolTier()` from
   * `@dzupagent/agent/tools/tool-tier-registry`) are filtered out at agent
   * construction time — the model never sees them. Untagged tools default
   * to `'read-only'`, so an agent on any tier can invoke them.
   *
   * Default: `'read-only'` (most restrictive).
   */
  permissionTier?: PermissionTier
  /**
   * Admission policy for third-party tools that do not register tier metadata.
   *
   * `'compatibility-read-only'` preserves the historical behavior and reports
   * the tool name in `agent:tools-filtered.unclassifiedTools`.
   * `'require-full-access'` fails closed for read-only/workspace-write agents.
   * Agent-owned framework tools are always explicitly classified.
   *
   * Default: `'compatibility-read-only'`.
   */
  unclassifiedToolPolicy?: UnclassifiedToolPolicy
  /** Middleware hooks (cost tracking, observability, etc.) */
  middleware?: AgentMiddleware[]
  /** Message compression config */
  messageConfig?: MessageManagerConfig
  /**
   * Opt-in, provenance-enforced ceiling for every model input.
   *
   * Output, rolling-summary, and provider/chat-envelope reservations are all
   * explicit. Unsafe compression retains the current transcript and aborts
   * before the provider is invoked.
   */
  hardBudget?: AgentHardBudgetConfig
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
   * Lifecycle hooks (WS3). Model-lifecycle hooks — `beforeModelCall`,
   * `afterModelCall`, `onModelError` — are dispatched around every LLM
   * invocation on all four call paths (generate, generate compression,
   * streaming compression, native structured output). `beforeModelCall`
   * may rewrite the message array and runs BEFORE prompt-cache injection so
   * cache breakpoints are computed on the final array. All hooks are
   * error-isolated: a throwing hook is swallowed (emitted on `eventBus`) and
   * never aborts the run.
   */
  hooks?: AgentHooks

  /**
   * Plugin registry whose contributions are folded into this agent.
   *
   * This is the field that makes `DzupPlugin.hooks` and `DzupPlugin.middleware`
   * REACHABLE. Before it existed, `PluginRegistry.getHooks()` and
   * `getMiddleware()` had no production consumer at all: a plugin could be
   * registered, its hooks aggregated, and nothing ever handed them to an agent
   * — so `onRunStart` / `beforeModelCall` / `beforeAgent` contributed by a
   * plugin were declared but never dispatched.
   *
   * ## What is merged, and in what order
   *
   * At CONSTRUCTION (see `applyPluginRegistry` in `agent-construction.ts`):
   *
   *  - `hooks` becomes `pluginRegistry.toAgentHooks(hooks, { eventBus })` —
   *    i.e. **every plugin in registration order, then this config's own
   *    `hooks` LAST**. For the three value-returning hooks
   *    (`beforeToolCall`, `afterToolCall`, `beforeModelCall`) the last
   *    contributor decides the value that escapes, so the application's own
   *    hook always has the final say and an ambient plugin can never silently
   *    overrule it. Contract owned by `composeAgentHooks`.
   *  - `middleware` becomes `[...pluginRegistry.getMiddleware(), ...middleware]`
   *    — same principle, plugins first and this config's own middleware last,
   *    so for the last-wins seams (`beforeAgent` state patches,
   *    `wrapToolCall` result transforms) the app wins.
   *
   *    ⚠️ ONE seam is first-wins and therefore inverts:
   *    `AgentMiddlewareRuntime.invokeModel` picks the FIRST middleware that
   *    declares `wrapModelCall` (`.find(...)`), so a plugin-supplied
   *    `wrapModelCall` pre-empts one supplied here. That asymmetry is
   *    pre-existing behaviour of the middleware runtime, not something this
   *    field introduces; it is pinned by a test rather than silently inherited.
   *
   * ## Timing
   *
   * The merge happens ONCE, at construction. Plugins registered on the
   * registry AFTER `new DzupAgent(...)` are NOT picked up by that agent —
   * build the registry first, then the agents. A registry may be shared by any
   * number of agents; the agent never registers anything itself and never
   * takes ownership of the registry's event bus (the registry already holds
   * one, given to its constructor).
   *
   * ## Idempotence
   *
   * The effective config exposed by `DzupAgent.agentConfig` has this field
   * REMOVED and the merged results baked in, so the documented
   * `new DzupAgent({ ...agent.agentConfig, ...overrides })` derivation cannot
   * compose the same plugin hooks twice.
   *
   * When this field is absent the config object is passed through by identity —
   * no clone, no composition, no behavioural change whatsoever.
   */
  pluginRegistry?: PluginRegistry

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
   * run result is always returned regardless of callback success. They are
   * NOT silent: see {@link DzupAgentConfig.onReflectionError}.
   */
  onReflectionComplete?: (summary: ReflectionSummary) => Promise<void>

  /**
   * Called when post-run reflection throws --- either the analyzer itself or the
   * {@link DzupAgentConfig.onReflectionComplete} callback (including a failing
   * reflection store behind it).
   *
   * Reflection is best-effort and its failure never affects the run result, so
   * without this hook a permanently broken reflection store produced no signal
   * anywhere: every run succeeded and the learning system stayed empty, which is
   * indistinguishable from a system that simply had nothing to reflect on.
   *
   * When unset, failures are reported with `console.warn` rather than dropped.
   */
  onReflectionError?: (error: unknown) => void

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
   */
  toolExecution?: ToolExecutionConfig

  /**
   * Opt-in run-level provider retry/failover policy.
   *
   * This is intentionally distinct from `ModelRegistry.getModelWithFallback`,
   * which only chooses an initial provider before a run starts. When enabled
   * for a tier-based model, transient invocation failures can be retried on
   * another selectable provider from the registry's fallback chain.
   *
   * Retries after tool results are blocked by default because the previous
   * phase may have executed side-effecting tools. Set
   * `allowRetryAfterToolResults` only for hosts that can prove the phase is
   * idempotent or otherwise retry-safe.
   */
  providerFailover?: ProviderFailoverPolicy

  /**
   * Optional client-side LLM call rate limiter (audit fix RF-11 / AG-10).
   *
   * When set, every LLM invocation in `generate()` and `stream()` calls
   * `rateLimiter.waitUntilAvailable(1)` before contacting the provider,
   * preventing runaway cost and provider throttling under load.
   *
   * Accepts either a pre-built {@link TokenBucket} (so callers can share
   * a bucket across agents for global throttling) or a
   * {@link TokenBucketConfig} object — the agent then constructs its own
   * per-instance bucket. Omitting this field preserves the legacy
   * unrestricted behaviour.
   */
  rateLimiter?: TokenBucket | TokenBucketConfig

  /** OWASP-aligned content scanning configuration (audit MC-01 / AG-08 / AG-09). */
  security?: SecurityConfig

  /**
   * Optional store for durable run-state snapshots (MC-AGT-04 Phase 1).
   *
   * When provided, the agent writes a {@link DzupRunState} snapshot at
   * each iteration boundary and on suspension/termination. Snapshots
   * are written fire-and-forget — a failing store never aborts a run.
   *
   * Phase 1 introduces the wiring; subsequent phases will replace the
   * per-subsystem stores (approvals, run journal, budget) with this
   * unified surface.
   */
  runStateStore?: DzupRunStateStore

  /**
   * Pluggable output filter chain (M-13).
   *
   * An ordered list of named {@link OutputFilter} steps applied to the
   * agent's final response content before it is returned from
   * `generate()`. Filters run sequentially; each step receives the
   * output produced by the previous step. A filter returning `null`
   * preserves the current content and skips all subsequent filters.
   *
   * The chain runs AFTER the legacy `guardrails.outputFilter` (single-
   * function contract) so existing callers are unaffected. When both are
   * present, `guardrails.outputFilter` runs first and the chain refines
   * its result.
   *
   * Example — strip Markdown fences then truncate:
   * ```ts
   * outputFilters: [stripMarkdownFilter, truncateFilter]
   * ```
   */
  outputFilters?: OutputFilter[]
}

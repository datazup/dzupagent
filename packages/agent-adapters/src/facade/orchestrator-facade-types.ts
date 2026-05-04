/**
 * Public option/result types for OrchestratorFacade. Extracted into a
 * dedicated module so that helpers can import them without creating
 * circular dependencies with `orchestrator-facade.ts`.
 */

import type { CircuitBreakerConfig, DzupEventBus } from '@dzupagent/core'

import type { AdapterApprovalGate } from '../approval/adapter-approval.js'
import type { AdapterGuardrails } from '../guardrails/adapter-guardrails.js'
import type { CostTrackingConfig } from '../middleware/cost-tracking.js'
import type { MemoryEnrichmentOptions } from '../middleware/memory-enrichment.js'
import type { AdapterPolicy } from '../policy/policy-compiler.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  TaskRoutingStrategy,
  TokenUsage,
} from '../types.js'

export interface OrchestratorConfig {
  /** Adapters to register */
  adapters: AgentCLIAdapter[]
  /** Event bus (optional, creates one if not provided) */
  eventBus?: DzupEventBus | undefined
  /** Routing strategy. Default: TagBasedRouter */
  router?: TaskRoutingStrategy | undefined
  /** Enable cost tracking. Default true */
  enableCostTracking?: boolean | undefined
  /** Cost tracking config */
  costTrackingConfig?: CostTrackingConfig | undefined
  /** Circuit breaker config */
  circuitBreakerConfig?: Partial<CircuitBreakerConfig> | undefined
  /** Optional approval gate for human-in-the-loop approval before execution. */
  approvalGate?: AdapterApprovalGate | undefined
  /** Optional guardrails for budget/stuck/tool enforcement on event streams. */
  guardrails?: AdapterGuardrails | undefined
  /** Default policy applied to all runs unless overridden per-run. */
  defaultPolicy?: AdapterPolicy | undefined
  /** When provided, all adapters are auto-wrapped with withMemoryEnrichment */
  memoryEnrichment?: MemoryEnrichmentOptions | undefined
  /**
   * Unified Capability Layer — when provided, skills and memory from the
   * `.dzupagent/` directory tree are automatically loaded and injected into
   * every `run()` call.
   */
  dzupagent?: {
    /** Project root for .dzupagent/ resolution. Defaults to process.cwd() */
    projectRoot?: string | undefined
    /** Skip memory injection entirely */
    skipMemory?: boolean | undefined
    /** Skip skill injection entirely */
    skipSkills?: boolean | undefined
  } | undefined
}

export interface RunOptions {
  tags?: string[] | undefined
  preferredProvider?: AdapterProviderId | undefined
  signal?: AbortSignal | undefined
  workingDirectory?: string | undefined
  systemPrompt?: string | undefined
  maxTurns?: number | undefined
  /** When true and an approvalGate is configured, requires approval before execution. */
  requireApproval?: boolean | undefined
  /** Approval context metadata forwarded to the approval gate. */
  approvalRunId?: string | undefined
  /** Per-run policy (overrides default policy if set). */
  policy?: AdapterPolicy | undefined
  /**
   * Persona ID to apply to this run. Resolved by the caller (app layer)
   * into a system prompt before invocation. Stored for observability.
   */
  personaId?: string | undefined
  /** Parent run ID for hierarchical orchestration tracking. */
  parentRunId?: string | undefined
  /** Branch identifier within a parallel/conditional execution tree. */
  branchId?: string | undefined
  /** Current depth in the orchestration hierarchy. Root = 0. */
  depth?: number | undefined
}

export interface RunResult {
  result: string
  providerId: AdapterProviderId
  durationMs: number
  usage?: TokenUsage | undefined
  cancelled?: true | undefined
  error?: string | undefined
}

export interface ChatOptions {
  /** Resume existing workflow or create new */
  workflowId?: string | undefined
  provider?: AdapterProviderId | undefined
  /** Default true */
  includeHistory?: boolean | undefined
  workingDirectory?: string | undefined
  systemPrompt?: string | undefined
  /** Maximum turns / iterations */
  maxTurns?: number | undefined
  /** Sampling temperature (0-1) */
  temperature?: number | undefined
  /** Maximum output tokens */
  maxTokens?: number | undefined
  /** Top-p nucleus sampling */
  topP?: number | undefined
  /** Per-turn adapter timeout override (milliseconds) */
  timeoutMs?: number | undefined
  /** When true and an approvalGate is configured, requires approval before execution. */
  requireApproval?: boolean | undefined
  /** Approval context metadata forwarded to the approval gate. */
  approvalRunId?: string | undefined
  /** Per-turn policy (overrides default policy if set). */
  policy?: AdapterPolicy | undefined
}

export interface InteractionResponseOptions {
  workflowId: string
  provider?: AdapterProviderId | undefined
}

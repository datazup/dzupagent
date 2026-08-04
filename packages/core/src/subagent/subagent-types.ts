import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { BaseMessage } from '@langchain/core/messages'
import type { PromptInjectionGuard } from '@dzupagent/security'
import type { ToolPermissionPolicy } from '@dzupagent/agent-types'
import type { ModelTier, StructuredOutputModelCapabilities } from '../llm/model-config.js'
import type { AgentMiddleware } from '../middleware/types.js'
import type { DzupEventBus } from '../events/event-bus.js'
import type { ToolGovernance } from '../tools/tool-governance.js'
import type { SkillLoader } from '../skills/skill-loader.js'

/** Configuration for spawning a sub-agent */
export interface SubAgentConfig {
  name: string
  description: string
  systemPrompt: string
  /** Use a specific model instance or a registry tier name */
  model?: BaseChatModel | ModelTier
  /** Optional structured-output capability override for the resolved model. */
  structuredOutputCapabilities?: StructuredOutputModelCapabilities
  tools?: StructuredToolInterface[]
  skills?: string[]
  middleware?: AgentMiddleware[]
  /** Maximum iterations for ReAct tool loop (default: 10) */
  maxIterations?: number
  /** Timeout in ms for the entire sub-agent execution (default: 120_000) */
  timeoutMs?: number
  /**
   * Current depth (internal — prevents infinite recursion). Do not set manually.
   *
   * When omitted, depth is resolved from the ambient spawn-depth context
   * (`spawn-depth-context.ts`), which `spawnReAct` increments around its whole
   * loop. Set it explicitly only to pin depth across a boundary the async
   * context cannot cross (process, queue, worker).
   */
  _depth?: number
  /**
   * Parent cancellation signal. Aborting it aborts the sub-agent's in-flight
   * model call and tool invocations, not merely the next iteration.
   */
  signal?: AbortSignal
  /**
   * Stable run id attached to every `tool:called` / `tool:result` /
   * `tool:error` event emitted by this sub-agent. Generated when omitted.
   */
  executionRunId?: string
  /** Filter parent state before passing to sub-agent */
  contextFilter?: (parentState: Record<string, unknown>) => Record<string, unknown>
}

/**
 * Construction-time options for {@link SubAgentSpawner}.
 *
 * The guardrail members are the core-visible subset of the main tool loop's
 * policy stack (DZUPAGENT-AGENT-C-04 / MJ-01). Each is inert when omitted, so
 * existing callers keep their current behaviour except for tool-result
 * injection fencing, which is on by default.
 */
export interface SubAgentSpawnerOptions {
  skillLoader?: SkillLoader
  /** Maximum sub-agent recursion depth (default: {@link REACT_DEFAULTS.maxDepth}). */
  maxDepth?: number
  /** Bus receiving sub-agent tool lifecycle events. Omit to emit nothing. */
  eventBus?: DzupEventBus
  /** Identity used for permission checks and event attribution. Defaults to the sub-agent name. */
  agentId?: string
  /**
   * Fence tool results in `<untrusted_content source="tool_result">`.
   * Defaults to `true`. Set `false` only when the caller applies its own
   * fencing downstream.
   */
  wrapToolResults?: boolean
  /** Custom injection guard. Defaults to a shared {@link PromptInjectionGuard}. */
  promptInjectionGuard?: PromptInjectionGuard
  /** Per-tool permission gate evaluated before every sub-agent tool call. */
  toolPermissionPolicy?: ToolPermissionPolicy
  /** Governance gate (allow / deny / approval-required) for sub-agent tool calls. */
  toolGovernance?: ToolGovernance
}

/** Token usage across all iterations of a sub-agent run */
export interface SubAgentUsage {
  inputTokens: number
  outputTokens: number
  llmCalls: number
}

/** Result returned after a sub-agent completes */
export interface SubAgentResult {
  messages: BaseMessage[]
  files: Record<string, string>
  metadata: Record<string, unknown>
  /** Token usage across all iterations */
  usage?: SubAgentUsage
  /** Whether the agent hit its iteration limit */
  hitIterationLimit?: boolean
}

/** Default values for ReAct loop configuration */
export const REACT_DEFAULTS = {
  maxIterations: 10,
  timeoutMs: 120_000,
  maxDepth: 3,
} as const

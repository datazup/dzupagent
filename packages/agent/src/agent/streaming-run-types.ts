/**
 * Shared types for the streaming run loop (MC-026b-1).
 *
 * Hosting {@link StreamRunContext} here lets the policy / tool-handler /
 * coordinator modules import it without creating an import cycle on
 * `streaming-run.ts`.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { ModelRegistry } from '@dzupagent/core/llm'
import type { DzupAgentConfig } from './agent-types.js'
import type { ProviderAttempt } from './streaming-run-provider.js'

/**
 * Callbacks and configuration a streaming run needs from its owning
 * agent.
 *
 * The agent supplies closures over its private state (model, tools,
 * memory, middleware, summary cache) without exposing those internals
 * publicly.
 */
export interface StreamRunContext {
  agentId: string
  config: DzupAgentConfig
  resolvedModel: BaseChatModel
  /**
   * Provider name returned by the registry when tier-based fallback was
   * used at agent construction time. Carries the selected provider into
   * the native streaming path so that stream success/failure can be
   * recorded against the same circuit breaker the non-streaming path
   * uses.
   *
   * Selection-time only: this provider is fixed for the lifetime of the
   * run; we do not switch providers mid-stream on transient failure.
   * `undefined` when the agent was constructed with an explicit model
   * instance or a model resolved by name (no fallback chain in play).
   */
  resolvedProvider?: string | undefined
  resolvedTier?: string | undefined
  /**
   * Registry used to resolve {@link resolvedProvider}. Required to
   * thread native-stream outcomes back to the circuit breaker via
   * `recordProviderSuccess` / `recordProviderFailure`. `undefined` when
   * `resolvedProvider` is also `undefined`.
   */
  registry?: ModelRegistry | undefined
  getProviderAttempts?: (tools: StructuredToolInterface[]) => ProviderAttempt[]
  prepareMessages: (
    messages: BaseMessage[],
  ) => Promise<{ messages: BaseMessage[]; memoryFrame?: unknown }>
  getTools: () => StructuredToolInterface[]
  bindTools: (
    model: BaseChatModel,
    tools: StructuredToolInterface[],
  ) => BaseChatModel
  runBeforeAgentHooks: () => Promise<void>
  invokeModelWithMiddleware: (
    model: BaseChatModel,
    messages: BaseMessage[],
    tools?: StructuredToolInterface[],
  ) => Promise<BaseMessage>
  transformToolResultWithMiddleware: (
    toolName: string,
    input: Record<string, unknown>,
    result: string,
  ) => Promise<string>
  maybeUpdateSummary: (
    messages: BaseMessage[],
    memoryFrame?: unknown,
  ) => Promise<void>
  maybeWriteBackMemory: (content: string, runId?: string) => Promise<void>
}

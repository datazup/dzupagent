/**
 * SessionRegistry — adapter-execution core.
 *
 * Composes the workflow store and provider-aware mixin with the
 * multi-turn execution engine: building effective prompts (including
 * compressed history), routing through the adapter registry's fallback
 * chain, and capturing session/token state from streamed events.
 */

import type {
  AdapterProviderId,
  AgentEvent,
  AgentInput,
  AgentStreamEvent,
} from '../types.js'
import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'

import { ProviderAwareWorkflowStore } from './session-registry-provider.js'
import type {
  MultiTurnOptions,
  SessionRegistryConfig,
} from './session-registry-types.js'

function isProviderRawStreamEvent(
  event: AgentStreamEvent,
): event is Extract<AgentStreamEvent, { type: 'adapter:provider_raw' }> {
  return event.type === 'adapter:provider_raw'
}

export class SessionRegistry extends ProviderAwareWorkflowStore {
  constructor(config?: SessionRegistryConfig) {
    super({
      eventBus: config?.eventBus,
      maxHistoryEntries: config?.maxHistoryEntries ?? 100,
      sessionTtlMs: config?.sessionTtlMs ?? 60 * 60 * 1000,
      compressorOptions: config?.compressorOptions,
    })
  }

  // -----------------------------------------------------------------------
  // Multi-turn execution
  // -----------------------------------------------------------------------

  /**
   * Execute a multi-turn interaction — wraps adapter execution with session tracking.
   *
   * 1. Validates the workflow
   * 2. If `includeHistory`, prepends conversation context to the prompt
   * 3. Determines which provider to use (explicit > active > auto via registry)
   * 4. Executes via the adapter registry (with fallback)
   * 5. Captures session IDs, conversation entries, and token counts from events
   * 6. Yields all events through
   */
  async *executeMultiTurn(
    input: AgentInput,
    options: MultiTurnOptions,
    registry: ProviderAdapterRegistry,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    for await (const event of this.executeMultiTurnWithRaw(input, options, registry)) {
      if (!isProviderRawStreamEvent(event)) {
        yield event
      }
    }
  }

  async *executeMultiTurnWithRaw(
    input: AgentInput,
    options: MultiTurnOptions,
    registry: ProviderAdapterRegistry,
  ): AsyncGenerator<AgentStreamEvent, void, undefined> {
    const workflow = this.requireWorkflow(options.workflowId)
    const now = new Date()
    workflow.lastActiveAt = now

    // --- Get or create per-workflow compressor ---
    const compressor = this.getOrCreateCompressor(options.workflowId)

    // --- Build effective prompt ---
    let effectivePrompt = input.prompt
    if (options.includeHistory) {
      const context = this.buildContextForHandoff(
        options.workflowId,
        options.maxContextEntries ?? 10,
      )
      if (context) {
        effectivePrompt = `${context}\n\n${input.prompt}`
      }
    }

    // --- Determine provider ---
    const targetProvider = options.provider ?? workflow.activeProvider

    // --- Build effective input ---
    const effectiveInput: AgentInput = {
      ...input,
      prompt: effectivePrompt,
    }

    // Inject compressed conversation history into the system prompt
    if (compressor.hasTurns) {
      const history = compressor.buildHistory()
      if (history) {
        const existing = effectiveInput.systemPrompt ?? ''
        effectiveInput.systemPrompt = existing
          ? `${history}\n\n${existing}`
          : history
      }
    }

    // If we have an existing provider session, set resumeSessionId
    if (targetProvider) {
      const providerSession = workflow.providerSessions.get(targetProvider)
      if (providerSession && !effectiveInput.resumeSessionId) {
        effectiveInput.resumeSessionId = providerSession.sessionId
      }
    }

    // --- Record the user turn ---
    if (targetProvider) {
      this.addConversationEntry(options.workflowId, {
        role: 'user',
        content: input.prompt,
        providerId: targetProvider,
        timestamp: now,
      })
    }

    // --- Execute ---
    const task = {
      prompt: effectivePrompt,
      tags: [],
      preferredProvider: targetProvider,
      approvedFallbackProviders: options.approvedFallbackProviders,
    }

    const registryWithOptionalRaw = registry as ProviderAdapterRegistry & {
      executeWithFallbackWithRaw?: (
        input: AgentInput,
        task: {
          prompt: string
          tags: string[]
          preferredProvider: AdapterProviderId | undefined
          approvedFallbackProviders: AdapterProviderId[] | undefined
        },
      ) => AsyncGenerator<AgentStreamEvent, void, undefined>
    }
    const eventStream = registryWithOptionalRaw.executeWithFallbackWithRaw
      ? registryWithOptionalRaw.executeWithFallbackWithRaw(effectiveInput, task)
      : registry.executeWithFallback(effectiveInput, task)

    let resolvedProvider: AdapterProviderId | undefined = targetProvider
    const startMs = Date.now()

    for await (const event of eventStream) {
      if (isProviderRawStreamEvent(event)) {
        yield event
        continue
      }

      // Feed every event to the compressor for future turns
      compressor.recordEvent(event)

      // --- Capture session ID from started events ---
      if (event.type === 'adapter:started') {
        resolvedProvider = event.providerId
        this.linkProviderSession(
          options.workflowId,
          event.providerId,
          event.sessionId,
        )

        // Update active provider if not explicitly set
        if (!workflow.activeProvider) {
          workflow.activeProvider = event.providerId
        }
      }

      // --- Record assistant messages ---
      if (event.type === 'adapter:message' && event.role === 'assistant') {
        this.addConversationEntry(options.workflowId, {
          role: 'assistant',
          content: event.content,
          providerId: event.providerId,
          timestamp: new Date(event.timestamp),
        })
      }

      // --- Update token counts from completed events ---
      if (event.type === 'adapter:completed') {
        const providerSession = workflow.providerSessions.get(event.providerId)
        if (providerSession && event.usage) {
          providerSession.totalTokens.input += event.usage.inputTokens
          providerSession.totalTokens.output += event.usage.outputTokens
          providerSession.lastActiveAt = new Date()
        }
      }

      yield event
    }

    this.emitEvent({
      type: 'session:multi_turn_completed',
      workflowId: options.workflowId,
      providerId: resolvedProvider,
      durationMs: Date.now() - startMs,
    })
  }

  async respondInteraction(
    workflowId: string,
    interactionId: string,
    answer: string,
    registry: ProviderAdapterRegistry,
    provider?: AdapterProviderId,
  ): Promise<boolean> {
    const workflow = this.requireWorkflow(workflowId)
    const orderedProviders = [
      provider,
      workflow.activeProvider,
      ...workflow.providerSessions.keys(),
    ].filter((value, index, array): value is AdapterProviderId =>
      typeof value === 'string' && array.indexOf(value) === index,
    )

    for (const candidate of orderedProviders) {
      const handled = await registry.respondInteraction(candidate, interactionId, answer)
      if (handled) return true
    }

    return false
  }
}

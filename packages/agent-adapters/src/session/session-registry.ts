/**
 * SessionRegistry — unified session management for multi-turn,
 * multi-provider agent conversations.
 *
 * Maps workflow IDs to provider-specific session IDs, enabling
 * conversation continuity across agent switches and session migration.
 */

import { randomUUID } from 'node:crypto'

import type { DzupEventBus } from '@dzupagent/core'

import type {
  AdapterProviderId,
  AgentEvent,
  AgentInput,
} from '../types.js'
import type { AdapterRegistry } from '../registry/adapter-registry.js'
import { ConversationCompressor } from './conversation-compressor.js'
import type { ConversationCompressorOptions } from './conversation-compressor.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderSession {
  providerId: AdapterProviderId
  /** Provider-specific session identifier (e.g. Claude session_id, Codex thread_id) */
  sessionId: string
  createdAt: Date
  lastActiveAt: Date
  turnCount: number
  totalTokens: { input: number; output: number }
}

export interface ConversationEntry {
  role: 'user' | 'assistant' | 'system'
  content: string
  providerId: AdapterProviderId
  timestamp: Date
  turnIndex: number
}

export interface WorkflowSession {
  workflowId: string
  createdAt: Date
  lastActiveAt: Date
  /** Provider sessions linked to this workflow */
  providerSessions: Map<AdapterProviderId, ProviderSession>
  /** Conversation history entries (provider-agnostic) */
  conversationHistory: ConversationEntry[]
  /** Metadata for the workflow */
  metadata: Record<string, unknown>
  /** Current active provider */
  activeProvider?: AdapterProviderId | undefined
}

export interface SessionRegistryConfig {
  eventBus?: DzupEventBus | undefined
  /** Max conversation history entries to keep per workflow. Default 100 */
  maxHistoryEntries?: number | undefined
  /** TTL for inactive sessions in ms. Default: 1 hour */
  sessionTtlMs?: number | undefined
  /** Options for per-workflow conversation compressors (token budget, etc.) */
  compressorOptions?: ConversationCompressorOptions | undefined
}

export interface MultiTurnOptions {
  /** The workflow to continue */
  workflowId: string
  /** Which provider to use for the next turn */
  provider?: AdapterProviderId | undefined
  /** Whether to include conversation history as context */
  includeHistory?: boolean | undefined
  /** Max history entries to include in context. Default 10 */
  maxContextEntries?: number | undefined
}

// ---------------------------------------------------------------------------
// SessionRegistry
// ---------------------------------------------------------------------------

export class SessionRegistry {
  private readonly workflows = new Map<string, WorkflowSession>()
  private readonly _compressors = new Map<string, ConversationCompressor>()
  private readonly eventBus: DzupEventBus | undefined
  private readonly maxHistoryEntries: number
  private readonly sessionTtlMs: number
  private readonly compressorOptions: ConversationCompressorOptions | undefined

  constructor(config?: SessionRegistryConfig) {
    this.eventBus = config?.eventBus
    this.maxHistoryEntries = config?.maxHistoryEntries ?? 100
    this.sessionTtlMs = config?.sessionTtlMs ?? 60 * 60 * 1000
    this.compressorOptions = config?.compressorOptions
  }

  // -----------------------------------------------------------------------
  // Workflow lifecycle
  // -----------------------------------------------------------------------

  /** Create a new workflow session. Returns the workflowId. */
  createWorkflow(metadata?: Record<string, unknown>, existingWorkflowId?: string): string {
    const workflowId = existingWorkflowId ?? randomUUID()
    const now = new Date()

    const session: WorkflowSession = {
      workflowId,
      createdAt: now,
      lastActiveAt: now,
      providerSessions: new Map(),
      conversationHistory: [],
      metadata: metadata ?? {},
    }

    this.workflows.set(workflowId, session)

    this.emitEvent({
      type: 'session:workflow_created',
      workflowId,
    })

    return workflowId
  }

  /** Get an existing workflow session. */
  getWorkflow(workflowId: string): WorkflowSession | undefined {
    return this.workflows.get(workflowId)
  }

  /** Delete a workflow and all its sessions. */
  deleteWorkflow(workflowId: string): boolean {
    const existed = this.workflows.delete(workflowId)
    this._compressors.delete(workflowId)
    if (existed) {
      this.emitEvent({
        type: 'session:workflow_deleted',
        workflowId,
      })
    }
    return existed
  }

  /** List all active workflows. */
  listWorkflows(): WorkflowSession[] {
    return [...this.workflows.values()]
  }

  // -----------------------------------------------------------------------
  // Provider session management
  // -----------------------------------------------------------------------

  /** Link a provider session to a workflow. */
  linkProviderSession(
    workflowId: string,
    providerId: AdapterProviderId,
    sessionId: string,
  ): void {
    const workflow = this.requireWorkflow(workflowId)
    const now = new Date()

    const existing = workflow.providerSessions.get(providerId)
    if (existing) {
      // Update the existing provider session with the new session ID
      existing.sessionId = sessionId
      existing.lastActiveAt = now
    } else {
      workflow.providerSessions.set(providerId, {
        providerId,
        sessionId,
        createdAt: now,
        lastActiveAt: now,
        turnCount: 0,
        totalTokens: { input: 0, output: 0 },
      })
    }

    workflow.lastActiveAt = now

    this.emitEvent({
      type: 'session:provider_linked',
      workflowId,
      providerId,
      sessionId,
    })
  }

  /** Get the provider session for a specific provider in a workflow. */
  getProviderSession(
    workflowId: string,
    providerId: AdapterProviderId,
  ): ProviderSession | undefined {
    const workflow = this.workflows.get(workflowId)
    return workflow?.providerSessions.get(providerId)
  }

  /** Switch the active provider for a workflow (session migration). */
  switchProvider(workflowId: string, newProvider: AdapterProviderId): void {
    const workflow = this.requireWorkflow(workflowId)
    const previousProvider = workflow.activeProvider
    workflow.activeProvider = newProvider
    workflow.lastActiveAt = new Date()

    this.emitEvent({
      type: 'session:provider_switched',
      workflowId,
      from: previousProvider,
      to: newProvider,
    })
  }

  // -----------------------------------------------------------------------
  // Conversation history
  // -----------------------------------------------------------------------

  /** Record a conversation entry. */
  addConversationEntry(
    workflowId: string,
    entry: Omit<ConversationEntry, 'turnIndex'>,
  ): void {
    const workflow = this.requireWorkflow(workflowId)
    const turnIndex = workflow.conversationHistory.length

    workflow.conversationHistory.push({ ...entry, turnIndex })
    workflow.lastActiveAt = new Date()

    // Enforce max history limit by trimming oldest entries
    if (workflow.conversationHistory.length > this.maxHistoryEntries) {
      const excess = workflow.conversationHistory.length - this.maxHistoryEntries
      workflow.conversationHistory.splice(0, excess)
    }

    // Update turn count on the provider session
    const providerSession = workflow.providerSessions.get(entry.providerId)
    if (providerSession) {
      providerSession.turnCount += 1
      providerSession.lastActiveAt = new Date()
    }
  }

  /** Get conversation history for a workflow (most recent first). */
  getHistory(workflowId: string, limit?: number): ConversationEntry[] {
    const workflow = this.workflows.get(workflowId)
    if (!workflow) return []

    const history = [...workflow.conversationHistory].reverse()
    return limit !== undefined ? history.slice(0, limit) : history
  }

  /** Build context string from conversation history for provider handoff. */
  buildContextForHandoff(workflowId: string, maxEntries?: number): string {
    const entries = this.getHistory(workflowId, maxEntries ?? 10)
    if (entries.length === 0) return ''

    // Reverse back to chronological order for readable context
    const chronological = [...entries].reverse()

    const lines = chronological.map((entry) => {
      const providerTag = `[${entry.providerId}]`
      const roleTag = entry.role.toUpperCase()
      return `${providerTag} ${roleTag}: ${entry.content}`
    })

    return [
      '--- Previous conversation context ---',
      ...lines,
      '--- End of context ---',
    ].join('\n')
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
    registry: AdapterRegistry,
  ): AsyncGenerator<AgentEvent, void, undefined> {
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
    }

    const eventStream = registry.executeWithFallback(effectiveInput, task)

    let resolvedProvider: AdapterProviderId | undefined = targetProvider
    const startMs = Date.now()

    for await (const event of eventStream) {
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

  // -----------------------------------------------------------------------
  // Maintenance
  // -----------------------------------------------------------------------

  /** Clean up expired sessions. Returns the number of workflows pruned. */
  pruneExpired(): number {
    const now = Date.now()
    let pruned = 0

    for (const [workflowId, workflow] of this.workflows) {
      const elapsed = now - workflow.lastActiveAt.getTime()
      if (elapsed > this.sessionTtlMs) {
        this.workflows.delete(workflowId)
        pruned += 1
      }
    }

    if (pruned > 0) {
      this.emitEvent({
        type: 'session:pruned',
        count: pruned,
      })
    }

    return pruned
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private getOrCreateCompressor(workflowId: string): ConversationCompressor {
    let compressor = this._compressors.get(workflowId)
    if (!compressor) {
      compressor = new ConversationCompressor(this.compressorOptions ?? {})
      this._compressors.set(workflowId, compressor)
    }
    return compressor
  }

  private requireWorkflow(workflowId: string): WorkflowSession {
    const workflow = this.workflows.get(workflowId)
    if (!workflow) {
      throw new Error(
        `Workflow "${workflowId}" not found. Create it first with createWorkflow().`,
      )
    }
    return workflow
  }

  private emitEvent(
    event:
      | { type: 'session:workflow_created'; workflowId: string }
      | { type: 'session:workflow_deleted'; workflowId: string }
      | { type: 'session:provider_linked'; workflowId: string; providerId: AdapterProviderId; sessionId: string }
      | { type: 'session:provider_switched'; workflowId: string; from: AdapterProviderId | undefined; to: AdapterProviderId }
      | { type: 'session:multi_turn_completed'; workflowId: string; providerId: AdapterProviderId | undefined; durationMs: number }
      | { type: 'session:pruned'; count: number },
  ): void {
    if (this.eventBus) {
      // Session events are adapter-layer extensions not in core DzupEvent union.
      // Cast through unknown to satisfy the type constraint.
      this.eventBus.emit(event as unknown as Parameters<DzupEventBus['emit']>[0])
    }
  }
}

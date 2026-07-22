/**
 * SessionRegistry workflow + history store.
 *
 * Owns workflow lifecycle (create / get / delete / list), conversation
 * history append/read, context-string generation for cross-provider
 * handoffs, and TTL-based maintenance pruning. Knows nothing about
 * adapter execution — that lives in `session-registry-core.ts`.
 */

import { randomUUID } from 'node:crypto'

import type { DzupEventBus } from '@dzupagent/core/events'
import { ForgeError, typedEmit } from '@dzupagent/core/events'

import { ConversationCompressor } from './conversation-compressor.js'
import type { ConversationCompressorOptions } from './conversation-compressor.js'
import type {
  ConversationEntry,
  SessionRegistryEvent,
  WorkflowSession,
} from './session-registry-types.js'

export class WorkflowStore {
  protected readonly workflows = new Map<string, WorkflowSession>()
  protected readonly compressors = new Map<string, ConversationCompressor>()
  protected readonly eventBus: DzupEventBus | undefined
  protected readonly maxHistoryEntries: number
  protected readonly sessionTtlMs: number
  protected readonly compressorOptions: ConversationCompressorOptions | undefined

  constructor(input: {
    eventBus: DzupEventBus | undefined
    maxHistoryEntries: number
    sessionTtlMs: number
    compressorOptions: ConversationCompressorOptions | undefined
  }) {
    this.eventBus = input.eventBus
    this.maxHistoryEntries = input.maxHistoryEntries
    this.sessionTtlMs = input.sessionTtlMs
    this.compressorOptions = input.compressorOptions
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
    this.compressors.delete(workflowId)
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
  // Shared helpers (protected for sibling modules)
  // -----------------------------------------------------------------------

  protected getOrCreateCompressor(workflowId: string): ConversationCompressor {
    let compressor = this.compressors.get(workflowId)
    if (!compressor) {
      compressor = new ConversationCompressor(this.compressorOptions ?? {})
      this.compressors.set(workflowId, compressor)
    }
    return compressor
  }

  protected requireWorkflow(workflowId: string): WorkflowSession {
    const workflow = this.workflows.get(workflowId)
    if (!workflow) {
      throw new ForgeError({
        code: 'ADAPTER_SESSION_NOT_FOUND',
        message: `Workflow "${workflowId}" not found. Create it first with createWorkflow().`,
        context: { workflowId },
      })
    }
    return workflow
  }

  protected emitEvent(event: SessionRegistryEvent): void {
    typedEmit(this.eventBus, event)
  }
}

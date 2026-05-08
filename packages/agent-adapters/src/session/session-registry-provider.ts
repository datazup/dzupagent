/**
 * SessionRegistry — provider-session management mixin.
 *
 * Extends the workflow store with provider-session linking and the
 * "active provider" switching primitive used during cross-provider
 * handoffs. Decoupled from adapter execution so the multi-turn engine
 * (`session-registry-core.ts`) can compose only the slices it needs.
 */

import type { AdapterProviderId } from '../types.js'
import { WorkflowStore } from './session-registry-store.js'
import type { ProviderSession } from './session-registry-types.js'

export class ProviderAwareWorkflowStore extends WorkflowStore {
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
}

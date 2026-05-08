/**
 * Supervisor multi-agent pattern — public types.
 *
 * Pure type definitions used by the SupervisorOrchestrator and its
 * decomposition / execution / feedback helpers. Lives alongside its
 * sibling modules (supervisor-decomposition, supervisor-executor,
 * supervisor-feedback) and is re-exported from `./supervisor.ts`.
 */

import type { DzupEventBus } from '@dzupagent/core/events'
import type { BaseSupervisorContract } from '@dzupagent/agent-types'
import type { AgentCLIAdapter } from '@dzupagent/adapter-types'

import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type { AdapterProviderId } from '../types.js'

/** A single subtask produced by a TaskDecomposer. */
export interface SubTask {
  description: string
  tags: string[]
  preferredProvider?: AdapterProviderId | undefined
  requiresReasoning?: boolean | undefined
  requiresExecution?: boolean | undefined
  /** Indices of subtasks that must complete before this one starts. */
  dependsOn?: number[] | undefined
}

/** Strategy that breaks a high-level goal into subtasks. */
export interface TaskDecomposer {
  decompose(goal: string, context?: string): Promise<SubTask[]>
}

/** Result of a single subtask delegation. */
export interface SubTaskResult {
  subtask: SubTask
  providerId: AdapterProviderId | null
  result: string
  success: boolean
  durationMs: number
  error?: string | undefined
  cancelled?: true | undefined
}

/** Aggregated result returned by `SupervisorOrchestrator.execute`. */
export interface SupervisorResult {
  goal: string
  subtaskResults: SubTaskResult[]
  totalDurationMs: number
  cancelled?: true | undefined
}

/** Options accepted by `SupervisorOrchestrator.execute`. */
export interface SupervisorOptions {
  /** Abort signal for cancellation. */
  signal?: AbortSignal | undefined
  /** Working directory forwarded to adapters. */
  workingDirectory?: string | undefined
  /** Optional context string passed to the decomposer. */
  context?: string | undefined
  /** Budget constraint forwarded to task descriptors. */
  budgetConstraint?: 'low' | 'medium' | 'high' | 'unlimited' | undefined
}

/** Configuration for the SupervisorOrchestrator. */
export interface SupervisorConfig extends BaseSupervisorContract<AgentCLIAdapter> {
  registry: ProviderAdapterRegistry
  eventBus?: DzupEventBus | undefined
  decomposer?: TaskDecomposer | undefined
  /** Maximum subtasks executing concurrently. Default 3. */
  maxConcurrentDelegations?: number | undefined
}

/** Discriminated union of supervisor lifecycle events emitted on the event bus. */
export type SupervisorLifecycleEvent =
  | {
      type: 'supervisor:plan_created'
      goal: string
      assignments: Array<{ task: string; specialistId: string }>
      source?: 'llm' | 'keyword'
    }
  | { type: 'supervisor:delegating'; specialistId: string; task: string }
  | {
      type: 'supervisor:delegation_complete'
      specialistId: string
      task: string
      success: boolean
    }

/**
 * WorkflowCheckpointer -- Checkpoint/resume for long-running multi-step orchestrations.
 *
 * Persists workflow state (completed steps, pending steps, provider sessions,
 * arbitrary state) so that a workflow can be suspended and later resumed from
 * exactly where it left off.
 *
 * Events emitted (all defined in @dzipagent/core DzipEvent):
 *   pipeline:checkpoint_saved
 *   pipeline:suspended
 *   pipeline:resumed
 */

import crypto from 'node:crypto'

import type { DzipEventBus } from '@dzipagent/core'

import type { AdapterProviderId } from '../types.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single step definition in a workflow. */
export interface StepDefinition {
  stepId: string
  description: string
  tags: string[]
  preferredProvider?: AdapterProviderId
  dependsOn?: string[]
}

/** Result of a completed step. */
export interface StepResult {
  stepId: string
  providerId: AdapterProviderId
  result: string
  success: boolean
  durationMs: number
  completedAt: Date
}

/** Serialized provider session state captured at checkpoint time. */
export interface SerializedProviderSession {
  providerId: AdapterProviderId
  sessionId: string
  turnCount: number
}

/** Full checkpoint of a workflow's state. */
export interface WorkflowCheckpoint {
  checkpointId: string
  workflowId: string
  version: number
  createdAt: Date
  /** Current step/phase of the workflow */
  currentStep: string
  /** Total steps planned */
  totalSteps: number
  /** Completed step results */
  completedSteps: StepResult[]
  /** Pending steps remaining */
  pendingSteps: StepDefinition[]
  /** Provider sessions state at checkpoint time */
  providerSessions: SerializedProviderSession[]
  /** Arbitrary workflow state */
  state: Record<string, unknown>
}

/** Pluggable persistence backend for checkpoints. */
export interface CheckpointStore {
  save(checkpoint: WorkflowCheckpoint): Promise<void>
  load(workflowId: string, version?: number): Promise<WorkflowCheckpoint | undefined>
  listVersions(workflowId: string): Promise<number[]>
  delete(workflowId: string, version?: number): Promise<void>
}

/** Configuration for WorkflowCheckpointer. */
export interface CheckpointerConfig {
  store?: CheckpointStore
  eventBus?: DzipEventBus
  /** Auto-checkpoint after each step. Default true */
  autoCheckpoint?: boolean
}

// ---------------------------------------------------------------------------
// InMemoryCheckpointStore
// ---------------------------------------------------------------------------

/**
 * Simple in-memory checkpoint store for development and testing.
 *
 * Checkpoints are stored in a nested Map keyed by workflowId then version.
 * No persistence -- all data is lost when the process exits.
 */
export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly data = new Map<string, Map<number, WorkflowCheckpoint>>()

  async save(checkpoint: WorkflowCheckpoint): Promise<void> {
    let versions = this.data.get(checkpoint.workflowId)
    if (!versions) {
      versions = new Map<number, WorkflowCheckpoint>()
      this.data.set(checkpoint.workflowId, versions)
    }
    versions.set(checkpoint.version, structuredClone(checkpoint))
  }

  async load(workflowId: string, version?: number): Promise<WorkflowCheckpoint | undefined> {
    const versions = this.data.get(workflowId)
    if (!versions || versions.size === 0) return undefined

    if (version !== undefined) {
      const cp = versions.get(version)
      return cp ? structuredClone(cp) : undefined
    }

    // Return the latest version
    const maxVersion = Math.max(...versions.keys())
    const cp = versions.get(maxVersion)
    return cp ? structuredClone(cp) : undefined
  }

  async listVersions(workflowId: string): Promise<number[]> {
    const versions = this.data.get(workflowId)
    if (!versions) return []
    return [...versions.keys()].sort((a, b) => a - b)
  }

  async delete(workflowId: string, version?: number): Promise<void> {
    if (version !== undefined) {
      const versions = this.data.get(workflowId)
      if (versions) {
        versions.delete(version)
        if (versions.size === 0) this.data.delete(workflowId)
      }
    } else {
      this.data.delete(workflowId)
    }
  }
}

// ---------------------------------------------------------------------------
// WorkflowCheckpointer
// ---------------------------------------------------------------------------

/**
 * Manages checkpoint/resume lifecycle for multi-step workflow orchestrations.
 *
 * Tracks in-flight workflows, records step completions, and persists
 * snapshots to a pluggable CheckpointStore. When `autoCheckpoint` is
 * enabled (the default), a checkpoint is saved after every step completion.
 */
export class WorkflowCheckpointer {
  private readonly store: CheckpointStore
  private readonly eventBus: DzipEventBus | undefined
  private readonly autoCheckpoint: boolean

  /** In-flight workflow states keyed by workflowId. */
  private readonly workflows = new Map<string, WorkflowCheckpoint>()

  constructor(config?: CheckpointerConfig) {
    this.store = config?.store ?? new InMemoryCheckpointStore()
    this.eventBus = config?.eventBus
    this.autoCheckpoint = config?.autoCheckpoint ?? true
  }

  /**
   * Create a new workflow with the given steps and optional initial state.
   * Returns the initial checkpoint (version 1).
   */
  async createWorkflow(
    workflowId: string,
    steps: StepDefinition[],
    initialState?: Record<string, unknown>,
  ): Promise<WorkflowCheckpoint> {
    const firstStep = steps[0]
    const checkpoint: WorkflowCheckpoint = {
      checkpointId: crypto.randomUUID(),
      workflowId,
      version: 1,
      createdAt: new Date(),
      currentStep: firstStep ? firstStep.stepId : '',
      totalSteps: steps.length,
      completedSteps: [],
      pendingSteps: [...steps],
      providerSessions: [],
      state: initialState ?? {},
    }

    this.workflows.set(workflowId, checkpoint)
    await this.store.save(checkpoint)

    this.emitEvent({
      type: 'pipeline:checkpoint_saved',
      pipelineId: workflowId,
      runId: checkpoint.checkpointId,
      version: checkpoint.version,
    })

    return structuredClone(checkpoint)
  }

  /**
   * Record a step completion. If `autoCheckpoint` is enabled, a new
   * checkpoint version is persisted automatically.
   *
   * Returns the updated checkpoint.
   */
  async completeStep(
    workflowId: string,
    stepId: string,
    result: Omit<StepResult, 'stepId' | 'completedAt'>,
  ): Promise<WorkflowCheckpoint> {
    const workflow = this.workflows.get(workflowId)
    if (!workflow) {
      throw new Error(`Workflow "${workflowId}" not found. Create it first or resume from a checkpoint.`)
    }

    // Build the full step result
    const stepResult: StepResult = {
      stepId,
      ...result,
      completedAt: new Date(),
    }

    // Move step from pending to completed
    workflow.completedSteps.push(stepResult)
    workflow.pendingSteps = workflow.pendingSteps.filter((s) => s.stepId !== stepId)

    // Advance currentStep to the next executable step
    const nextStep = this.findNextStep(workflow)
    workflow.currentStep = nextStep ? nextStep.stepId : ''

    if (this.autoCheckpoint) {
      return this.checkpoint(workflowId)
    }

    return structuredClone(workflow)
  }

  /**
   * Persist a checkpoint of the current workflow state.
   * Increments the version number and saves to the store.
   */
  async checkpoint(workflowId: string): Promise<WorkflowCheckpoint> {
    const workflow = this.workflows.get(workflowId)
    if (!workflow) {
      throw new Error(`Workflow "${workflowId}" not found.`)
    }

    workflow.version += 1
    workflow.checkpointId = crypto.randomUUID()
    workflow.createdAt = new Date()

    await this.store.save(workflow)

    this.emitEvent({
      type: 'pipeline:checkpoint_saved',
      pipelineId: workflowId,
      runId: workflow.checkpointId,
      version: workflow.version,
    })

    // Emit suspended if there are still pending steps
    if (workflow.pendingSteps.length > 0) {
      this.emitEvent({
        type: 'pipeline:suspended',
        pipelineId: workflowId,
        runId: workflow.checkpointId,
        nodeId: workflow.currentStep,
      })
    }

    return structuredClone(workflow)
  }

  /**
   * Resume a workflow from a persisted checkpoint.
   * Loads the checkpoint from the store and re-hydrates in-memory state.
   */
  async resume(workflowId: string, version?: number): Promise<WorkflowCheckpoint> {
    const checkpoint = await this.store.load(workflowId, version)
    if (!checkpoint) {
      throw new Error(
        version !== undefined
          ? `Checkpoint v${String(version)} not found for workflow "${workflowId}".`
          : `No checkpoints found for workflow "${workflowId}".`,
      )
    }

    this.workflows.set(workflowId, checkpoint)

    this.emitEvent({
      type: 'pipeline:resumed',
      pipelineId: workflowId,
      runId: checkpoint.checkpointId,
      nodeId: checkpoint.currentStep,
    })

    return structuredClone(checkpoint)
  }

  /** Get the current in-memory state of a workflow, or undefined if not loaded. */
  getState(workflowId: string): WorkflowCheckpoint | undefined {
    const workflow = this.workflows.get(workflowId)
    return workflow ? structuredClone(workflow) : undefined
  }

  /** Merge additional key-value pairs into the workflow's arbitrary state. */
  updateState(workflowId: string, state: Record<string, unknown>): void {
    const workflow = this.workflows.get(workflowId)
    if (!workflow) {
      throw new Error(`Workflow "${workflowId}" not found.`)
    }
    Object.assign(workflow.state, state)
  }

  /** Get the remaining pending steps for a workflow. */
  getPendingSteps(workflowId: string): StepDefinition[] {
    const workflow = this.workflows.get(workflowId)
    if (!workflow) return []
    return [...workflow.pendingSteps]
  }

  /**
   * Get the next step to execute, respecting dependency ordering.
   * A step is ready when all steps listed in its `dependsOn` have completed.
   * Returns undefined if no steps are ready or all steps are complete.
   */
  getNextStep(workflowId: string): StepDefinition | undefined {
    const workflow = this.workflows.get(workflowId)
    if (!workflow) return undefined
    return this.findNextStep(workflow)
  }

  /** List all persisted checkpoint versions for a workflow. */
  async listVersions(workflowId: string): Promise<number[]> {
    return this.store.listVersions(workflowId)
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Find the first pending step whose dependencies have all been completed.
   */
  private findNextStep(workflow: WorkflowCheckpoint): StepDefinition | undefined {
    const completedIds = new Set(workflow.completedSteps.map((s) => s.stepId))

    for (const step of workflow.pendingSteps) {
      const deps = step.dependsOn
      if (!deps || deps.length === 0) {
        return step
      }
      if (deps.every((depId) => completedIds.has(depId))) {
        return step
      }
    }

    return undefined
  }

  private emitEvent(
    event:
      | { type: 'pipeline:checkpoint_saved'; pipelineId: string; runId: string; version: number }
      | { type: 'pipeline:suspended'; pipelineId: string; runId: string; nodeId: string }
      | { type: 'pipeline:resumed'; pipelineId: string; runId: string; nodeId: string },
  ): void {
    if (this.eventBus) {
      this.eventBus.emit(event as Parameters<DzipEventBus['emit']>[0])
    }
  }
}

/**
 * In-memory implementation of PipelineCheckpointStore.
 *
 * Uses structuredClone for isolation — callers cannot mutate stored state.
 *
 * @module pipeline/in-memory-checkpoint-store
 */

import type {
  PipelineCheckpointStore,
  PipelineCheckpoint,
  PipelineCheckpointSummary,
} from '@dzupagent/core'

/**
 * In-memory pipeline checkpoint store with versioned history.
 *
 * Each `save()` appends a new version. `load()` returns the latest.
 * All returned objects are deep-cloned for isolation.
 */
export class InMemoryPipelineCheckpointStore implements PipelineCheckpointStore {
  private readonly store = new Map<string, PipelineCheckpoint[]>()

  async save(checkpoint: PipelineCheckpoint): Promise<void> {
    const cloned = structuredClone(checkpoint)
    const versions = this.store.get(cloned.pipelineRunId)
    if (versions) {
      versions.push(cloned)
    } else {
      this.store.set(cloned.pipelineRunId, [cloned])
    }
  }

  async load(pipelineRunId: string): Promise<PipelineCheckpoint | undefined> {
    const versions = this.store.get(pipelineRunId)
    if (!versions || versions.length === 0) return undefined
    // Return latest version (highest version number)
    const latest = versions.reduce((best, current) =>
      current.version > best.version ? current : best,
    )
    return structuredClone(latest)
  }

  async loadVersion(pipelineRunId: string, version: number): Promise<PipelineCheckpoint | undefined> {
    const versions = this.store.get(pipelineRunId)
    if (!versions) return undefined
    const match = versions.find(v => v.version === version)
    return match ? structuredClone(match) : undefined
  }

  async listVersions(pipelineRunId: string): Promise<PipelineCheckpointSummary[]> {
    const versions = this.store.get(pipelineRunId)
    if (!versions) return []
    return versions
      .map(v => ({
        pipelineRunId: v.pipelineRunId,
        version: v.version,
        createdAt: v.createdAt,
        completedNodeCount: v.completedNodeIds.length,
      }))
      .sort((a, b) => a.version - b.version)
  }

  async delete(pipelineRunId: string): Promise<void> {
    this.store.delete(pipelineRunId)
  }

  async prune(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs
    let pruned = 0

    for (const [runId, versions] of this.store.entries()) {
      const remaining = versions.filter(v => {
        const createdMs = new Date(v.createdAt).getTime()
        if (createdMs < cutoff) {
          pruned++
          return false
        }
        return true
      })
      if (remaining.length === 0) {
        this.store.delete(runId)
      } else {
        this.store.set(runId, remaining)
      }
    }

    return pruned
  }
}

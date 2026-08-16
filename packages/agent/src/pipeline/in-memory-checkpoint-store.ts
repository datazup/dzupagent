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
  PipelineCheckpointCommitReceipt,
  PipelineCheckpointSummary,
} from '@dzupagent/core/pipeline'

/**
 * Newest stored version for a run, or {@link NO_CHECKPOINT_VERSION} when the
 * run has no versions yet. Shared by `saveIfVersion` so an absent run and a
 * present run are compared on the same scale.
 */
function newestVersion(versions: PipelineCheckpoint[] | undefined): number {
  if (!versions || versions.length === 0) return NO_CHECKPOINT_VERSION
  return versions.reduce((best, cur) => (cur.version > best ? cur.version : best), NO_CHECKPOINT_VERSION)
}

/**
 * Observed version for a run with no stored checkpoint.
 *
 * `writeCheckpoint` starts its version tracker at 0 and pre-increments, so the
 * first checkpoint ever written for a run carries version 1. An empty run
 * therefore reports 0 — the version its first write expects — and 0 is never a
 * stored version, so this does not alias a real one.
 */
const NO_CHECKPOINT_VERSION = 0

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

  /**
   * Compare-and-set write: commit only if the newest stored version for this
   * run is exactly `expectedVersion`.
   *
   * Two concurrent callers cannot both commit the same expected version: the
   * base `save` appends synchronously before yielding, so the compare and the
   * append are not interleaved. A subclass whose `save` yields before writing
   * would weaken that; this store is the single-process implementation, and
   * cross-process safety comes from the Redis (`SET NX`) and Postgres
   * (`UNIQUE` + `ON CONFLICT DO NOTHING`) stores instead.
   *
   * A conflict is reported, never thrown.
   *
   * A run with nothing stored observes 0, which is the version the first write
   * (carrying version 1) expects — so a first write needs no special case.
   *
   * The commit itself delegates to `save` so that a subclass overriding `save`
   * — fault-injection stores in the test suite, instrumentation, or an
   * alternate persistence path — stays on the write path instead of being
   * bypassed by this method.
   */
  async saveIfVersion(
    checkpoint: PipelineCheckpoint,
    expectedVersion: number,
  ): Promise<PipelineCheckpointCommitReceipt> {
    const observed = newestVersion(this.store.get(checkpoint.pipelineRunId))
    if (observed !== expectedVersion) {
      return { committed: false, observedVersion: observed }
    }
    await this.save(checkpoint)
    return { committed: true, observedVersion: checkpoint.version }
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

  async pruneVersions(pipelineRunId: string, keepLatest: number): Promise<number> {
    const versions = this.store.get(pipelineRunId)
    if (!versions || versions.length <= keepLatest) return 0

    const sorted = [...versions].sort((a, b) => a.version - b.version)
    const remaining = sorted.slice(-keepLatest)
    this.store.set(pipelineRunId, remaining)
    return sorted.length - remaining.length
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

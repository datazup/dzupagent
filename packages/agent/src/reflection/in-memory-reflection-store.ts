/**
 * InMemoryReflectionStore -- simple in-memory implementation of RunReflectionStore.
 *
 * Suitable for testing, dev, and short-lived processes. Data is lost when the
 * process exits. For production use, implement RunReflectionStore against a
 * persistent backend (database, file system, etc.).
 *
 * @module reflection/in-memory-reflection-store
 */

import type {
  ReflectionPattern,
  ReflectionSummary,
  RunReflectionStore,
} from './reflection-types.js'

export class InMemoryReflectionStore implements RunReflectionStore {
  private readonly summaries = new Map<string, ReflectionSummary>()

  async save(summary: ReflectionSummary): Promise<void> {
    this.summaries.set(summary.runId, summary)
  }

  async get(runId: string): Promise<ReflectionSummary | undefined> {
    return this.summaries.get(runId)
  }

  async list(limit?: number): Promise<ReflectionSummary[]> {
    const all = [...this.summaries.values()].sort(
      (a, b) => b.completedAt.getTime() - a.completedAt.getTime(),
    )
    return limit !== undefined ? all.slice(0, limit) : all
  }

  async getPatterns(
    type: ReflectionPattern['type'],
  ): Promise<ReflectionPattern[]> {
    const result: ReflectionPattern[] = []
    for (const summary of this.summaries.values()) {
      for (const pattern of summary.patterns) {
        if (pattern.type === type) {
          result.push(pattern)
        }
      }
    }
    return result
  }

  /** Number of stored summaries (useful for tests). */
  get size(): number {
    return this.summaries.size
  }

  /** Remove all stored summaries. */
  clear(): void {
    this.summaries.clear()
  }
}

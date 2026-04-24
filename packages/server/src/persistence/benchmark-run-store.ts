/**
 * As of MC-A02 the benchmark record and store interfaces are canonically
 * defined in @dzupagent/eval-contracts. This module re-exports them and keeps
 * the `InMemoryBenchmarkRunStore` implementation.
 */
export type {
  BenchmarkRunArtifactRecord,
  BenchmarkRunRecord,
  BenchmarkBaselineRecord,
  BenchmarkCompareRecord,
  BenchmarkRunListFilter,
  BenchmarkRunListPage,
  BenchmarkRunStore,
} from '@dzupagent/eval-contracts'

import type {
  BenchmarkBaselineRecord,
  BenchmarkRunListFilter,
  BenchmarkRunListPage,
  BenchmarkRunRecord,
  BenchmarkRunStore,
} from '@dzupagent/eval-contracts'

interface BenchmarkRunCursor {
  createdAt: string
  id: string
}

function compareRunsByCreatedAtDesc(a: BenchmarkRunCursor, b: BenchmarkRunCursor): number {
  const createdAtOrder = b.createdAt.localeCompare(a.createdAt)
  if (createdAtOrder !== 0) {
    return createdAtOrder
  }

  return b.id.localeCompare(a.id)
}

function cloneArtifact(artifact: BenchmarkRunArtifactRecord | undefined): BenchmarkRunArtifactRecord | undefined {
  return artifact ? { ...artifact } : undefined
}

function cloneRun(run: BenchmarkRunRecord): BenchmarkRunRecord {
  return {
    ...run,
    metadata: run.metadata ? { ...run.metadata } : undefined,
    artifact: cloneArtifact(run.artifact),
  }
}

function encodeCursor(cursor: BenchmarkRunCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeCursor(rawCursor: string): BenchmarkRunCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }

    const cursor = parsed as Partial<BenchmarkRunCursor>
    if (typeof cursor.createdAt !== 'string' || typeof cursor.id !== 'string') {
      return null
    }

    return {
      createdAt: cursor.createdAt,
      id: cursor.id,
    }
  } catch {
    return null
  }
}

export class InMemoryBenchmarkRunStore implements BenchmarkRunStore {
  private readonly runs = new Map<string, BenchmarkRunRecord>()
  private readonly baselines = new Map<string, BenchmarkBaselineRecord>()

  async saveRun(run: BenchmarkRunRecord): Promise<void> {
    this.runs.set(run.id, cloneRun(run))
  }

  async getRun(runId: string): Promise<BenchmarkRunRecord | null> {
    const run = this.runs.get(runId)
    return run ? cloneRun(run) : null
  }

  async listRuns(filter?: BenchmarkRunListFilter): Promise<BenchmarkRunListPage> {
    const runs = Array.from(this.runs.values())
      .filter((r) => !filter?.suiteId || r.suiteId === filter.suiteId)
      .filter((r) => !filter?.targetId || r.targetId === filter.targetId)
      .sort(compareRunsByCreatedAtDesc)
    const limit = filter?.limit ?? 50
    const normalizedLimit = Math.max(1, Math.min(500, limit))
    const cursor = filter?.cursor ? decodeCursor(filter.cursor) : null
    const startIndex = cursor
      ? runs.findIndex((run) => compareRunsByCreatedAtDesc(run, cursor) > 0)
      : 0
    const pageStart = startIndex >= 0 ? startIndex : runs.length
    const data = runs.slice(pageStart, pageStart + normalizedLimit).map((run) => cloneRun(run))
    const hasMore = pageStart + data.length < runs.length

    return {
      data,
      hasMore,
      nextCursor: hasMore && data.length > 0
        ? encodeCursor({
          createdAt: data[data.length - 1]!.createdAt,
          id: data[data.length - 1]!.id,
        })
        : null,
    }
  }

  async saveBaseline(baseline: BenchmarkBaselineRecord): Promise<void> {
    this.baselines.set(this.baselineKey(baseline.suiteId, baseline.targetId), baseline)
  }

  async getBaseline(suiteId: string, targetId: string): Promise<BenchmarkBaselineRecord | null> {
    return this.baselines.get(this.baselineKey(suiteId, targetId)) ?? null
  }

  async listBaselines(filter?: { suiteId?: string; targetId?: string }): Promise<BenchmarkBaselineRecord[]> {
    return Array.from(this.baselines.values())
      .filter((b) => !filter?.suiteId || b.suiteId === filter.suiteId)
      .filter((b) => !filter?.targetId || b.targetId === filter.targetId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  private baselineKey(suiteId: string, targetId: string): string {
    return `${suiteId}::${targetId}`
  }
}

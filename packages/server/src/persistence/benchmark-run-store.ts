import type { BenchmarkComparison, BenchmarkResult } from '@dzipagent/evals'

export interface BenchmarkRunRecord {
  id: string
  suiteId: string
  targetId: string
  result: BenchmarkResult
  createdAt: string
  strict: boolean
  metadata?: Record<string, unknown>
}

export interface BenchmarkBaselineRecord {
  suiteId: string
  targetId: string
  runId: string
  result: BenchmarkResult
  updatedAt: string
}

export interface BenchmarkCompareRecord {
  currentRunId: string
  previousRunId: string
  comparison: BenchmarkComparison
  createdAt: string
}

export interface BenchmarkRunStore {
  saveRun(run: BenchmarkRunRecord): Promise<void>
  getRun(runId: string): Promise<BenchmarkRunRecord | null>
  listRuns(filter?: { suiteId?: string; targetId?: string; limit?: number }): Promise<BenchmarkRunRecord[]>

  saveBaseline(baseline: BenchmarkBaselineRecord): Promise<void>
  getBaseline(suiteId: string, targetId: string): Promise<BenchmarkBaselineRecord | null>
  listBaselines(filter?: { suiteId?: string; targetId?: string }): Promise<BenchmarkBaselineRecord[]>
}

export class InMemoryBenchmarkRunStore implements BenchmarkRunStore {
  private readonly runs = new Map<string, BenchmarkRunRecord>()
  private readonly baselines = new Map<string, BenchmarkBaselineRecord>()

  async saveRun(run: BenchmarkRunRecord): Promise<void> {
    this.runs.set(run.id, run)
  }

  async getRun(runId: string): Promise<BenchmarkRunRecord | null> {
    return this.runs.get(runId) ?? null
  }

  async listRuns(filter?: { suiteId?: string; targetId?: string; limit?: number }): Promise<BenchmarkRunRecord[]> {
    const runs = Array.from(this.runs.values())
      .filter((r) => !filter?.suiteId || r.suiteId === filter.suiteId)
      .filter((r) => !filter?.targetId || r.targetId === filter.targetId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const limit = filter?.limit ?? 50
    return runs.slice(0, Math.max(1, Math.min(500, limit)))
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


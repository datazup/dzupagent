import { randomUUID } from 'node:crypto'
import type { BenchmarkSuite, BenchmarkComparison } from '@dzipagent/evals'
import { runBenchmark, compareBenchmarks } from '@dzipagent/evals'
import type {
  BenchmarkRunStore,
  BenchmarkRunRecord,
  BenchmarkBaselineRecord,
} from '../persistence/benchmark-run-store.js'

export interface BenchmarkOrchestratorConfig {
  suites: Record<string, BenchmarkSuite>
  executeTarget: (
    targetId: string,
    input: string,
    metadata?: Record<string, unknown>,
  ) => Promise<string>
  store: BenchmarkRunStore
}

export class BenchmarkOrchestrator {
  constructor(private readonly config: BenchmarkOrchestratorConfig) {}

  async runSuite(input: {
    suiteId: string
    targetId: string
    strict?: boolean
    metadata?: Record<string, unknown>
  }): Promise<BenchmarkRunRecord> {
    const suite = this.config.suites[input.suiteId]
    if (!suite) {
      throw new Error(`Benchmark suite "${input.suiteId}" not found`)
    }

    const benchmarkConfig = input.strict === true
      ? ({ strict: true } as unknown as Parameters<typeof runBenchmark>[2])
      : undefined

    const result = await runBenchmark(
      suite,
      async (datasetInput) => this.config.executeTarget(input.targetId, datasetInput, input.metadata),
      benchmarkConfig,
    )

    const record: BenchmarkRunRecord = {
      id: randomUUID(),
      suiteId: suite.id,
      targetId: input.targetId,
      result,
      strict: input.strict === true,
      createdAt: new Date().toISOString(),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    }
    await this.config.store.saveRun(record)
    return record
  }

  async getRun(runId: string): Promise<BenchmarkRunRecord | null> {
    return this.config.store.getRun(runId)
  }

  async compareRuns(currentRunId: string, previousRunId: string): Promise<{
    currentRun: BenchmarkRunRecord
    previousRun: BenchmarkRunRecord
    comparison: BenchmarkComparison
  }> {
    const currentRun = await this.config.store.getRun(currentRunId)
    if (!currentRun) throw new Error(`Current run "${currentRunId}" not found`)
    const previousRun = await this.config.store.getRun(previousRunId)
    if (!previousRun) throw new Error(`Previous run "${previousRunId}" not found`)

    return {
      currentRun,
      previousRun,
      comparison: compareBenchmarks(currentRun.result, previousRun.result),
    }
  }

  async setBaseline(input: {
    suiteId: string
    targetId: string
    runId: string
  }): Promise<BenchmarkBaselineRecord> {
    const run = await this.config.store.getRun(input.runId)
    if (!run) {
      throw new Error(`Run "${input.runId}" not found`)
    }
    if (run.suiteId !== input.suiteId) {
      throw new Error(`Run "${input.runId}" does not belong to suite "${input.suiteId}"`)
    }
    if (run.targetId !== input.targetId) {
      throw new Error(`Run "${input.runId}" does not belong to target "${input.targetId}"`)
    }

    const baseline: BenchmarkBaselineRecord = {
      suiteId: input.suiteId,
      targetId: input.targetId,
      runId: run.id,
      result: run.result,
      updatedAt: new Date().toISOString(),
    }
    await this.config.store.saveBaseline(baseline)
    return baseline
  }

  async getBaseline(suiteId: string, targetId: string): Promise<BenchmarkBaselineRecord | null> {
    return this.config.store.getBaseline(suiteId, targetId)
  }

  async listBaselines(filter?: { suiteId?: string; targetId?: string }): Promise<BenchmarkBaselineRecord[]> {
    return this.config.store.listBaselines(filter)
  }
}

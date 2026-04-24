/**
 * BenchmarkOrchestrator — suite runner + baseline management.
 *
 * Moved from @dzupagent/server (packages/server/src/services/benchmark-orchestrator.ts)
 * to @dzupagent/evals in MC-A02 to eliminate the server -> evals layer
 * inversion. Server consumes it via dependency injection through the
 * BenchmarkOrchestratorLike contract in @dzupagent/eval-contracts.
 */

import { randomUUID } from 'node:crypto'
import type {
  BenchmarkBaselineRecord,
  BenchmarkCompareResult,
  BenchmarkOrchestratorLike,
  BenchmarkRunArtifactRecord,
  BenchmarkRunListFilter,
  BenchmarkRunListPage,
  BenchmarkRunRecord,
  BenchmarkRunStore,
  BenchmarkSuite,
} from '@dzupagent/eval-contracts'
import { compareBenchmarks, runBenchmark } from '../benchmarks/benchmark-runner.js'

export interface BenchmarkOrchestratorConfig {
  suites: Record<string, BenchmarkSuite>
  executeTarget: (
    targetId: string,
    input: string,
    metadata?: Record<string, unknown>,
  ) => Promise<string>
  allowNonStrictExecution?: boolean
  store: BenchmarkRunStore
}

export interface BenchmarkRunArtifactInput extends BenchmarkRunArtifactRecord {}

export class BenchmarkOrchestrator implements BenchmarkOrchestratorLike {
  constructor(private readonly config: BenchmarkOrchestratorConfig) {}

  async runSuite(input: {
    suiteId: string
    targetId: string
    strict?: boolean
    metadata?: Record<string, unknown>
    artifact?: BenchmarkRunArtifactInput
  }): Promise<BenchmarkRunRecord> {
    const suite = this.config.suites[input.suiteId]
    if (!suite) {
      throw new Error(`Benchmark suite "${input.suiteId}" not found`)
    }

    const strict = input.strict === false ? false : true
    if (!strict && this.config.allowNonStrictExecution !== true) {
      throw new Error(
        'Benchmark non-strict execution is disabled. Set allowNonStrictExecution to true to opt out of strict mode.',
      )
    }

    const benchmarkConfig = strict
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
      strict,
      createdAt: new Date().toISOString(),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.artifact ? { artifact: input.artifact } : {}),
    }
    await this.config.store.saveRun(record)
    return record
  }

  async getRun(runId: string): Promise<BenchmarkRunRecord | null> {
    return this.config.store.getRun(runId)
  }

  async listRuns(filter?: BenchmarkRunListFilter): Promise<BenchmarkRunListPage> {
    return this.config.store.listRuns(filter)
  }

  async compareRuns(currentRunId: string, previousRunId: string): Promise<BenchmarkCompareResult> {
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

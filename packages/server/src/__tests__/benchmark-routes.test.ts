import { describe, it, expect } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'
import type { BenchmarkSuite } from '@dzupagent/eval-contracts'
import { BenchmarkOrchestrator } from '@dzupagent/evals'
import {
  InMemoryBenchmarkRunStore,
  type BenchmarkRunRecord,
} from '../persistence/benchmark-run-store.js'

const defaultQaSuite: BenchmarkSuite = {
  id: 'qa',
  name: 'QA Suite',
  description: 'Default QA benchmark suite for tests',
  category: 'qa',
  dataset: [{ id: 'q1', input: 'hello', expectedOutput: 'answer:hello' }],
  scorers: [],
  baselineThresholds: {},
}

function createTestConfig(
  store?: InMemoryBenchmarkRunStore,
  suites?: Record<string, BenchmarkSuite>,
  options?: { allowNonStrictExecution?: boolean },
): ForgeServerConfig {
  const resolvedSuites = suites ?? { qa: defaultQaSuite }
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    benchmark: {
      suites: resolvedSuites,
      executeTarget: async (_targetId, input) => `answer:${input}`,
      orchestratorFactory: (deps) => new BenchmarkOrchestrator(deps),
      ...(options?.allowNonStrictExecution === true
        ? { allowNonStrictExecution: true }
        : {}),
      ...(store ? { store } : {}),
    },
  }
}

async function req(app: ReturnType<typeof createForgeApp>, method: string, path: string, body?: unknown) {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (body) init.body = JSON.stringify(body)
  return app.request(path, init)
}

function buildResult(suiteId: string, scoreSeed: number) {
  return {
    suiteId,
    timestamp: new Date(Date.UTC(2026, 2, 31, 0, 0, scoreSeed)).toISOString(),
    scores: {
      accuracy: scoreSeed / 100,
      latency: scoreSeed / 200,
    },
    passedBaseline: scoreSeed % 2 === 0,
    regressions: scoreSeed % 2 === 0 ? [] : ['accuracy'],
  }
}

function buildArtifact(overrides?: Partial<{
  suiteVersion: string
  datasetHash: string
  promptConfigVersion: string
  buildSha: string
  modelProfile: string
  promptVersion: string
}>) {
  return {
    suiteVersion: overrides?.suiteVersion ?? 'suite-v1',
    datasetHash: overrides?.datasetHash ?? 'dataset-hash-1',
    promptConfigVersion: overrides?.promptConfigVersion ?? 'prompt-config-v1',
    buildSha: overrides?.buildSha ?? 'build-sha-1',
    modelProfile: overrides?.modelProfile ?? 'gpt-5.4-mini',
    ...(overrides?.promptVersion ? { promptVersion: overrides.promptVersion } : {}),
  }
}

function buildRun(overrides: Partial<BenchmarkRunRecord> & Pick<BenchmarkRunRecord, 'id' | 'suiteId' | 'targetId' | 'createdAt'>): BenchmarkRunRecord {
  return {
    id: overrides.id,
    suiteId: overrides.suiteId,
    targetId: overrides.targetId,
    createdAt: overrides.createdAt,
    strict: overrides.strict ?? false,
    result: overrides.result ?? buildResult(overrides.suiteId, 1),
    ...(overrides.metadata ? { metadata: overrides.metadata } : {}),
    ...(overrides.artifact ? { artifact: overrides.artifact } : {}),
  }
}

async function seedRuns(store: InMemoryBenchmarkRunStore, runs: BenchmarkRunRecord[]): Promise<void> {
  for (const run of runs) {
    await store.saveRun(run)
  }
}

describe('Benchmark routes', () => {
  it('creates benchmark run and fetches it by id', async () => {
    const app = createForgeApp(createTestConfig())
    const artifact = buildArtifact({ promptVersion: 'prompt-v2' })
    const createRes = await req(app, 'POST', '/api/benchmarks/runs', {
      suiteId: 'qa',
      targetId: 'target-1',
      artifact,
    })
    expect(createRes.status).toBe(201)
    const created = await createRes.json() as {
      data: {
        id: string
        suiteId: string
        targetId: string
        strict: boolean
        result: { suiteId: string }
        artifact: typeof artifact
      }
    }
    expect(created.data.suiteId).toBe('qa')
    expect(created.data.targetId).toBe('target-1')
    expect(typeof created.data.strict).toBe('boolean')
    expect(created.data.strict).toBe(true)
    expect(created.data.result.suiteId).toBe('qa')
    expect(created.data.artifact).toEqual(artifact)

    const listRes = await app.request('/api/benchmarks/runs?limit=1')
    expect(listRes.status).toBe(200)
    const listBody = await listRes.json() as {
      data: Array<{ id: string; artifact: typeof artifact }>
      count: number
    }
    expect(listBody.count).toBe(1)
    expect(listBody.data[0]?.id).toBe(created.data.id)
    expect(listBody.data[0]?.artifact).toEqual(artifact)

    const getRes = await app.request(`/api/benchmarks/runs/${created.data.id}`)
    expect(getRes.status).toBe(200)
    const fetched = await getRes.json() as { data: { id: string; artifact: typeof artifact } }
    expect(fetched.data.id).toBe(created.data.id)
    expect(fetched.data.artifact).toEqual(artifact)
  })

  it('sets and lists baselines, then compares current run against baseline', async () => {
    const app = createForgeApp(createTestConfig())
    const run1Res = await req(app, 'POST', '/api/benchmarks/runs', {
      suiteId: 'qa',
      targetId: 'target-1',
    })
    const run1 = await run1Res.json() as { data: { id: string } }

    const baselineRes = await req(app, 'PUT', '/api/benchmarks/baselines/qa', {
      targetId: 'target-1',
      runId: run1.data.id,
    })
    expect(baselineRes.status).toBe(200)

    const listRes = await app.request('/api/benchmarks/baselines?suiteId=qa&targetId=target-1')
    expect(listRes.status).toBe(200)
    const listed = await listRes.json() as { count: number; data: Array<{ runId: string }> }
    expect(listed.count).toBe(1)
    expect(listed.data[0]?.runId).toBe(run1.data.id)

    const run2Res = await req(app, 'POST', '/api/benchmarks/runs', {
      suiteId: 'qa',
      targetId: 'target-1',
    })
    const run2 = await run2Res.json() as { data: { id: string } }

    const compareRes = await req(app, 'POST', '/api/benchmarks/compare', {
      currentRunId: run2.data.id,
    })
    expect(compareRes.status).toBe(200)
    const compared = await compareRes.json() as {
      data: {
        currentRun: { id: string }
        previousRun: { id: string }
        comparison: { improved: string[]; regressed: string[]; unchanged: string[] }
      }
    }
    expect(compared.data.currentRun.id).toBe(run2.data.id)
    expect(compared.data.previousRun.id).toBe(run1.data.id)
    expect(Array.isArray(compared.data.comparison.unchanged)).toBe(true)
  })

  it('rejects non-boolean strict values with a validation error', async () => {
    const app = createForgeApp(createTestConfig())
    const res = await req(app, 'POST', '/api/benchmarks/runs', {
      suiteId: 'qa',
      targetId: 'target-1',
      strict: 'false',
    })

    expect(res.status).toBe(400)
    const body = await res.json() as {
      error: { code: string; message: string }
    }
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toContain('strict must be a boolean')
  })

  it('returns 404 for unknown benchmark suite', async () => {
    const app = createForgeApp(createTestConfig())
    const res = await req(app, 'POST', '/api/benchmarks/runs', {
      suiteId: 'does-not-exist',
      targetId: 'target-1',
    })
    expect(res.status).toBe(404)
  })

  it('defaults benchmark runs to strict mode when llm-judge config is missing', async () => {
    const strictSuite: BenchmarkSuite = {
      id: 'strict-llm',
      name: 'Strict LLM Judge',
      description: 'Strict benchmark route coverage',
      category: 'qa',
      dataset: [
        {
          id: 'case-1',
          input: 'hello',
          expectedOutput: 'world',
        },
      ],
      scorers: [
        { id: 'judge', name: 'judge', type: 'llm-judge' },
      ],
      baselineThresholds: {},
    }

    const app = createForgeApp(createTestConfig(undefined, { 'strict-llm': strictSuite }))
    const res = await req(app, 'POST', '/api/benchmarks/runs', {
      suiteId: 'strict-llm',
      targetId: 'target-1',
    })

    expect(res.status).toBe(400)
    const body = await res.json() as {
      error: {
        code: string
        message: string
      }
    }
    expect(body.error.code).toBe('BENCHMARK_RUN_FAILED')
    expect(body.error.message).toContain('strict mode')
  })

  it('allows explicit non-strict benchmark opt-out only when enabled in config', async () => {
    const lenientSuite: BenchmarkSuite = {
      id: 'lenient-llm',
      name: 'Lenient LLM Judge',
      description: 'Non-strict benchmark fallback coverage',
      category: 'qa',
      dataset: [
        {
          id: 'case-1',
          input: 'hello',
          expectedOutput: 'world',
        },
      ],
      scorers: [
        { id: 'judge', name: 'judge', type: 'llm-judge' },
      ],
      baselineThresholds: {},
    }

    const disabledApp = createForgeApp(createTestConfig(undefined, { 'lenient-llm': lenientSuite }))
    const disabledRes = await req(disabledApp, 'POST', '/api/benchmarks/runs', {
      suiteId: 'lenient-llm',
      targetId: 'target-1',
      strict: false,
    })

    expect(disabledRes.status).toBe(400)
    const disabledBody = await disabledRes.json() as {
      error: { code: string; message: string }
    }
    expect(disabledBody.error.code).toBe('BENCHMARK_RUN_FAILED')
    expect(disabledBody.error.message).toContain('allowNonStrictExecution')

    const enabledApp = createForgeApp(
      createTestConfig(undefined, { 'lenient-llm': lenientSuite }, { allowNonStrictExecution: true }),
    )
    const enabledRes = await req(enabledApp, 'POST', '/api/benchmarks/runs', {
      suiteId: 'lenient-llm',
      targetId: 'target-1',
      strict: false,
    })

    expect(enabledRes.status).toBe(201)
    const enabledBody = await enabledRes.json() as {
      data: {
        strict: boolean
        result: {
          scores: Record<string, number>
        }
      }
    }
    expect(typeof enabledBody.data.strict).toBe('boolean')
    expect(enabledBody.data.strict).toBe(false)
    expect(enabledBody.data.result.scores.judge).toBe(0.5)
  })

  it('lists benchmark runs with filters and metadata', async () => {
    const store = new InMemoryBenchmarkRunStore()
    await seedRuns(store, [
      buildRun({
        id: 'run-1',
        suiteId: 'qa',
        targetId: 'target-1',
        createdAt: '2026-03-31T00:00:01.000Z',
        artifact: buildArtifact({ suiteVersion: 'suite-v1', buildSha: 'build-1' }),
      }),
      buildRun({
        id: 'run-2',
        suiteId: 'qa',
        targetId: 'target-2',
        createdAt: '2026-03-31T00:00:02.000Z',
      }),
      buildRun({
        id: 'run-3',
        suiteId: 'tool-use',
        targetId: 'target-1',
        createdAt: '2026-03-31T00:00:03.000Z',
      }),
    ])

    const app = createForgeApp(createTestConfig(store))

    const listRes = await app.request('/api/benchmarks/runs')
    expect(listRes.status).toBe(200)
    const listBody = await listRes.json() as {
      success: boolean
      data: Array<{ id: string; artifact?: ReturnType<typeof buildArtifact> }>
      count: number
      meta: {
        service: string
        filters: {
          limit: number
        }
        pagination: {
          nextCursor: string | null
          hasMore: boolean
        }
      }
    }
    expect(listBody.success).toBe(true)
    expect(listBody.count).toBe(3)
    expect(listBody.data.map((run) => run.id)).toEqual(['run-3', 'run-2', 'run-1'])
    expect(listBody.data.find((run) => run.id === 'run-1')?.artifact).toEqual(buildArtifact({ suiteVersion: 'suite-v1', buildSha: 'build-1' }))
    expect(listBody.meta.service).toBe('benchmarks')
    expect(listBody.meta.filters.limit).toBe(50)
    expect(listBody.meta.pagination.hasMore).toBe(false)
    expect(listBody.meta.pagination.nextCursor).toBeNull()

    const filteredRes = await app.request('/api/benchmarks/runs?suiteId=qa&targetId=target-2')
    expect(filteredRes.status).toBe(200)
    const filteredBody = await filteredRes.json() as {
      success: boolean
      data: Array<{ id: string; suiteId: string; targetId: string }>
      count: number
      meta: {
        filters: {
          suiteId: string
          targetId: string
          limit: number
        }
        pagination: {
          nextCursor: string | null
          hasMore: boolean
        }
      }
    }
    expect(filteredBody.success).toBe(true)
    expect(filteredBody.count).toBe(1)
    expect(filteredBody.data[0]?.id).toBe('run-2')
    expect(filteredBody.meta.filters).toMatchObject({
      suiteId: 'qa',
      targetId: 'target-2',
      limit: 50,
    })
    expect(filteredBody.meta.pagination.hasMore).toBe(false)
    expect(filteredBody.meta.pagination.nextCursor).toBeNull()
  })

  it('rejects malformed benchmark artifact payloads', async () => {
    const app = createForgeApp(createTestConfig())

    const invalidTypeRes = await req(app, 'POST', '/api/benchmarks/runs', {
      suiteId: 'qa',
      targetId: 'target-1',
      artifact: {
        suiteVersion: 'suite-v1',
        datasetHash: 'dataset-hash-1',
        promptConfigVersion: 'prompt-config-v1',
        buildSha: 123,
        modelProfile: 'gpt-5.4-mini',
      },
    })

    expect(invalidTypeRes.status).toBe(400)
    const invalidTypeBody = await invalidTypeRes.json() as {
      success?: boolean
      error: { code: string; message: string }
    }
    expect(invalidTypeBody.error.code).toBe('VALIDATION_ERROR')
    expect(invalidTypeBody.error.message).toContain('artifact')

    const emptyStringRes = await req(app, 'POST', '/api/benchmarks/runs', {
      suiteId: 'qa',
      targetId: 'target-1',
      artifact: {
        suiteVersion: 'suite-v1',
        datasetHash: '',
        promptConfigVersion: 'prompt-config-v1',
        buildSha: 'build-sha-1',
        modelProfile: 'gpt-5.4-mini',
      },
    })

    expect(emptyStringRes.status).toBe(400)
    const emptyStringBody = await emptyStringRes.json() as {
      success?: boolean
      error: { code: string; message: string }
    }
    expect(emptyStringBody.error.code).toBe('VALIDATION_ERROR')
    expect(emptyStringBody.error.message).toContain('artifact')

    const whitespaceRes = await req(app, 'POST', '/api/benchmarks/runs', {
      suiteId: 'qa',
      targetId: 'target-1',
      artifact: {
        suiteVersion: 'suite-v1',
        datasetHash: 'dataset-hash-1',
        promptConfigVersion: '   ',
        buildSha: 'build-sha-1',
        modelProfile: 'gpt-5.4-mini',
      },
    })

    expect(whitespaceRes.status).toBe(400)
    const whitespaceBody = await whitespaceRes.json() as {
      success?: boolean
      error: { code: string; message: string }
    }
    expect(whitespaceBody.error.code).toBe('VALIDATION_ERROR')
    expect(whitespaceBody.error.message).toContain('artifact')
  })

  it('accepts compatible extra string artifact keys', async () => {
    const app = createForgeApp(createTestConfig())
    const artifact = {
      ...buildArtifact({ promptVersion: 'prompt-v2' }),
      promptVariant: 'control',
    }

    const createRes = await req(app, 'POST', '/api/benchmarks/runs', {
      suiteId: 'qa',
      targetId: 'target-1',
      artifact,
    })

    expect(createRes.status).toBe(201)
    const created = await createRes.json() as {
      data: {
        id: string
        artifact: typeof artifact
      }
    }
    expect(created.data.artifact).toEqual(artifact)

    const getRes = await app.request(`/api/benchmarks/runs/${created.data.id}`)
    expect(getRes.status).toBe(200)
    const fetched = await getRes.json() as {
      data: {
        id: string
        artifact: typeof artifact
      }
    }
    expect(fetched.data.artifact).toEqual(artifact)
  })

  it('paginates benchmark runs with cursor metadata', async () => {
    const store = new InMemoryBenchmarkRunStore()
    await seedRuns(store, [
      buildRun({
        id: 'run-1',
        suiteId: 'qa',
        targetId: 'target-1',
        createdAt: '2026-03-31T00:00:01.000Z',
      }),
      buildRun({
        id: 'run-2',
        suiteId: 'qa',
        targetId: 'target-1',
        createdAt: '2026-03-31T00:00:02.000Z',
      }),
      buildRun({
        id: 'run-3',
        suiteId: 'qa',
        targetId: 'target-1',
        createdAt: '2026-03-31T00:00:03.000Z',
      }),
    ])

    const app = createForgeApp(createTestConfig(store))

    const firstPageRes = await app.request('/api/benchmarks/runs?limit=2')
    expect(firstPageRes.status).toBe(200)
    const firstPageBody = await firstPageRes.json() as {
      success: boolean
      data: Array<{ id: string }>
      count: number
      meta: {
        pagination: {
          nextCursor: string | null
          hasMore: boolean
        }
      }
    }

    expect(firstPageBody.success).toBe(true)
    expect(firstPageBody.data.map((run) => run.id)).toEqual(['run-3', 'run-2'])
    expect(firstPageBody.count).toBe(2)
    expect(firstPageBody.meta.pagination.hasMore).toBe(true)
    expect(firstPageBody.meta.pagination.nextCursor).toBeTruthy()

    const secondPageRes = await app.request(
      `/api/benchmarks/runs?limit=2&cursor=${encodeURIComponent(firstPageBody.meta.pagination.nextCursor ?? '')}`,
    )
    expect(secondPageRes.status).toBe(200)
    const secondPageBody = await secondPageRes.json() as {
      success: boolean
      data: Array<{ id: string }>
      count: number
      meta: {
        pagination: {
          nextCursor: string | null
          hasMore: boolean
        }
      }
    }

    expect(secondPageBody.success).toBe(true)
    expect(secondPageBody.data.map((run) => run.id)).toEqual(['run-1'])
    expect(secondPageBody.count).toBe(1)
    expect(secondPageBody.meta.pagination.hasMore).toBe(false)
    expect(secondPageBody.meta.pagination.nextCursor).toBeNull()
  })

  it('caps benchmark listing limits and rejects invalid values', async () => {
    const store = new InMemoryBenchmarkRunStore()
    await seedRuns(store, Array.from({ length: 260 }, (_, index) => {
      const createdAt = new Date(Date.UTC(2026, 2, 31, 0, 0, index)).toISOString()
      return buildRun({
        id: `run-${index}`,
        suiteId: 'qa',
        targetId: 'target-1',
        createdAt,
      })
    }))

    const app = createForgeApp(createTestConfig(store))

    const cappedRes = await app.request('/api/benchmarks/runs?limit=999')
    expect(cappedRes.status).toBe(200)
    const cappedBody = await cappedRes.json() as {
      success: boolean
      data: Array<{ id: string }>
      count: number
      meta: {
        filters: {
          limit: number
        }
      }
    }
    expect(cappedBody.success).toBe(true)
    expect(cappedBody.count).toBe(250)
    expect(cappedBody.data).toHaveLength(250)
    expect(cappedBody.data[0]?.id).toBe('run-259')
    expect(cappedBody.meta.filters.limit).toBe(250)

    const invalidRes = await app.request('/api/benchmarks/runs?limit=0')
    expect(invalidRes.status).toBe(400)
    const invalidBody = await invalidRes.json() as {
      success: boolean
      error: { code: string; message: string }
    }
    expect(invalidBody.success).toBe(false)
    expect(invalidBody.error.code).toBe('VALIDATION_ERROR')
    expect(invalidBody.error.message).toContain('limit')
  })

  it('rejects malformed benchmark listing cursors', async () => {
    const app = createForgeApp(createTestConfig())

    const invalidRes = await app.request('/api/benchmarks/runs?cursor=not-a-valid-cursor')
    expect(invalidRes.status).toBe(400)

    const invalidBody = await invalidRes.json() as {
      success: boolean
      error: { code: string; message: string }
    }

    expect(invalidBody.success).toBe(false)
    expect(invalidBody.error.code).toBe('VALIDATION_ERROR')
    expect(invalidBody.error.message).toContain('cursor')
  })
})

/**
 * Tests for PromptFeedbackLoop — Step 2 of the closed-loop self-improvement
 * system. Verifies subscription lifecycle, prompt extraction, optimizer
 * invocation, auto-publish policy, and error handling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createEventBus, type DzupEventBus } from '@dzupagent/core'
import type {
  OptimizationResult,
  PromptOptimizer,
  PromptVersion,
  PromptVersionStore,
} from '@dzupagent/evals'
import { runLogRoot } from '@dzupagent/agent-adapters'
import type { AgentEvent } from '@dzupagent/agent-adapters'

import { PromptFeedbackLoop } from '../prompt-feedback-loop.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_TS = 1_700_000_000_000

function startedEvent(prompt: string): AgentEvent {
  return {
    type: 'adapter:started',
    providerId: 'claude',
    sessionId: 's-1',
    timestamp: BASE_TS,
    prompt,
  }
}

function completedEvent(result: string): AgentEvent {
  return {
    type: 'adapter:completed',
    providerId: 'claude',
    sessionId: 's-1',
    result,
    durationMs: 25,
    timestamp: BASE_TS + 10,
  }
}

async function writeEvents(dir: string, events: AgentEvent[]): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'normalized-events.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  )
}

function makeVersion(overrides: Partial<PromptVersion> = {}): PromptVersion {
  return {
    id: overrides.id ?? 'version-1',
    promptKey: overrides.promptKey ?? 'run-prompt:abc',
    content: overrides.content ?? 'You are helpful.',
    version: overrides.version ?? 1,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    active: overrides.active ?? true,
    metadata: overrides.metadata,
    evalScores: overrides.evalScores,
    parentVersionId: overrides.parentVersionId,
  }
}

/**
 * In-memory version store with the same subset of behaviour our loop uses:
 * getActive / save / activate. Other methods throw — the loop doesn't call
 * them.
 */
function makeVersionStore(): PromptVersionStore {
  const byId = new Map<string, PromptVersion>()
  let counter = 0

  const api = {
    async getActive(promptKey: string): Promise<PromptVersion | null> {
      for (const v of byId.values()) {
        if (v.promptKey === promptKey && v.active) return v
      }
      return null
    },
    async save(params: {
      promptKey: string
      content: string
      parentVersionId?: string
      metadata?: Record<string, unknown>
      evalScores?: PromptVersion['evalScores']
      active?: boolean
    }): Promise<PromptVersion> {
      counter++
      let maxVersion = 0
      for (const v of byId.values()) {
        if (v.promptKey === params.promptKey && v.version > maxVersion) maxVersion = v.version
      }
      if (params.active) {
        for (const v of byId.values()) {
          if (v.promptKey === params.promptKey) v.active = false
        }
      }
      const version: PromptVersion = {
        id: `v-${counter}`,
        promptKey: params.promptKey,
        content: params.content,
        version: maxVersion + 1,
        parentVersionId: params.parentVersionId,
        createdAt: new Date().toISOString(),
        metadata: params.metadata,
        evalScores: params.evalScores,
        active: params.active ?? false,
      }
      byId.set(version.id, version)
      return version
    },
    async activate(versionId: string): Promise<void> {
      const target = byId.get(versionId)
      if (!target) throw new Error(`PromptVersion not found: ${versionId}`)
      for (const v of byId.values()) {
        if (v.promptKey === target.promptKey) v.active = false
      }
      target.active = true
    },
    async getById(id: string): Promise<PromptVersion | null> {
      return byId.get(id) ?? null
    },
    async listVersions(promptKey: string): Promise<PromptVersion[]> {
      const out: PromptVersion[] = []
      for (const v of byId.values()) {
        if (v.promptKey === promptKey) out.push(v)
      }
      return out.sort((a, b) => b.version - a.version)
    },
    async listPromptKeys(): Promise<string[]> {
      const s = new Set<string>()
      for (const v of byId.values()) s.add(v.promptKey)
      return [...s].sort()
    },
    async rollback(): Promise<never> {
      throw new Error('not implemented in tests')
    },
    async compare(): Promise<never> {
      throw new Error('not implemented in tests')
    },
  }

  return api as unknown as PromptVersionStore
}

/**
 * Build a mock PromptOptimizer with a deterministic behaviour script. The
 * returned optimizer honours whatever `optimize` script you pass — typically
 * a single fixed `OptimizationResult`.
 */
function makeOptimizer(
  behaviour: (params: {
    promptKey: string
    dataset: unknown
    failures?: unknown
  }) => Promise<OptimizationResult>,
): { optimizer: PromptOptimizer; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(behaviour)
  const optimizer = { optimize: spy } as unknown as PromptOptimizer
  return { optimizer, spy }
}

function makeResult(overrides: Partial<OptimizationResult> = {}): OptimizationResult {
  const originalVersion = overrides.originalVersion ?? makeVersion({ id: 'orig' })
  const bestVersion =
    overrides.bestVersion ??
    makeVersion({ id: 'best', version: 2, parentVersionId: originalVersion.id })
  return {
    improved: overrides.improved ?? true,
    originalVersion,
    bestVersion,
    scoreImprovement: overrides.scoreImprovement ?? 0.1,
    candidates: overrides.candidates ?? [],
    rounds: overrides.rounds ?? 1,
    exitReason: overrides.exitReason ?? 'improved',
    durationMs: overrides.durationMs ?? 10,
  }
}

interface Breakdown {
  scorerName: string
  score: number
  pass: boolean
  reasoning: string
}

function breakdown(name: string, score: number, pass: boolean, reasoning = 'r'): Breakdown {
  return { scorerName: name, score, pass, reasoning }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('PromptFeedbackLoop', () => {
  let projectDir: string
  let runId: string
  let runDir: string
  let bus: DzupEventBus
  let versionStore: PromptVersionStore

  beforeEach(async () => {
    projectDir = join(tmpdir(), `pfl-${Math.random().toString(36).slice(2, 10)}`)
    runId = `run-${Math.random().toString(36).slice(2, 10)}`
    runDir = runLogRoot(projectDir, runId)
    await mkdir(projectDir, { recursive: true })
    bus = createEventBus()
    versionStore = makeVersionStore()
  })

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true }).catch(() => { /* best-effort */ })
  })

  // --- constructor ---

  it('constructor: throws when eventBus is missing', () => {
    const { optimizer } = makeOptimizer(async () => makeResult())
    expect(
      () =>
        new PromptFeedbackLoop({
          eventBus: undefined as unknown as DzupEventBus,
          promptOptimizer: optimizer,
          promptVersionStore: versionStore,
          projectDir,
        }),
    ).toThrow(/eventBus is required/)
  })

  it('constructor: throws when promptOptimizer is missing', () => {
    expect(
      () =>
        new PromptFeedbackLoop({
          eventBus: bus,
          promptOptimizer: undefined as unknown as PromptOptimizer,
          promptVersionStore: versionStore,
          projectDir,
        }),
    ).toThrow(/promptOptimizer is required/)
  })

  it('constructor: throws when promptVersionStore is missing', () => {
    const { optimizer } = makeOptimizer(async () => makeResult())
    expect(
      () =>
        new PromptFeedbackLoop({
          eventBus: bus,
          promptOptimizer: optimizer,
          promptVersionStore: undefined as unknown as PromptVersionStore,
          projectDir,
        }),
    ).toThrow(/promptVersionStore is required/)
  })

  it('constructor: throws when projectDir is empty', () => {
    const { optimizer } = makeOptimizer(async () => makeResult())
    expect(
      () =>
        new PromptFeedbackLoop({
          eventBus: bus,
          promptOptimizer: optimizer,
          promptVersionStore: versionStore,
          projectDir: '',
        }),
    ).toThrow(/projectDir is required/)
  })

  // --- processRun: threshold gating ---

  it('processRun: skips runs at or above threshold', async () => {
    const { optimizer, spy } = makeOptimizer(async () => makeResult())
    const loop = new PromptFeedbackLoop({
      eventBus: bus,
      promptOptimizer: optimizer,
      promptVersionStore: versionStore,
      projectDir,
      poorRunThreshold: 0.7,
    })

    const result = await loop.processRun(runId, 0.9, [breakdown('a', 0.9, true)])
    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe('above-threshold')
    expect(spy).not.toHaveBeenCalled()
  })

  it('processRun: processes runs just below threshold', async () => {
    await writeEvents(runDir, [startedEvent('be helpful'), completedEvent('bad')])
    const { optimizer, spy } = makeOptimizer(async () => makeResult({ scoreImprovement: 0 }))

    const loop = new PromptFeedbackLoop({
      eventBus: bus,
      promptOptimizer: optimizer,
      promptVersionStore: versionStore,
      projectDir,
      poorRunThreshold: 0.7,
    })

    const result = await loop.processRun(runId, 0.5, [breakdown('a', 0.5, false)])
    expect(result.skipped).toBe(false)
    expect(result.promptsProcessed).toBe(1)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('processRun: skips when runId is empty', async () => {
    const errors: string[] = []
    const { optimizer, spy } = makeOptimizer(async () => makeResult())
    const loop = new PromptFeedbackLoop({
      eventBus: bus,
      promptOptimizer: optimizer,
      promptVersionStore: versionStore,
      projectDir,
      onError: (_rid, msg) => errors.push(msg),
    })

    const result = await loop.processRun('', 0.1, [])
    expect(result.skipped).toBe(true)
    expect(errors).toHaveLength(1)
    expect(spy).not.toHaveBeenCalled()
  })

  // --- processRun: prompt extraction ---

  it('processRun: extracts prompt from adapter:started event', async () => {
    await writeEvents(runDir, [
      startedEvent('You are a world-class haiku writer.'),
      completedEvent('oops not a haiku'),
    ])
    const { optimizer, spy } = makeOptimizer(async () => makeResult())
    const loop = new PromptFeedbackLoop({
      eventBus: bus,
      promptOptimizer: optimizer,
      promptVersionStore: versionStore,
      projectDir,
    })

    await loop.processRun(runId, 0.3, [breakdown('quality', 0.3, false)])

    expect(spy).toHaveBeenCalledTimes(1)
    const call = spy.mock.calls[0]![0] as { promptKey: string }
    expect(call.promptKey).toMatch(/^run-prompt:[0-9a-f]{12}$/)
  })

  it('processRun: dedupes identical prompts across the same run', async () => {
    await writeEvents(runDir, [
      startedEvent('system prompt v1'),
      startedEvent('system prompt v1'),
      completedEvent('meh'),
    ])
    const { optimizer, spy } = makeOptimizer(async () => makeResult())
    const loop = new PromptFeedbackLoop({
      eventBus: bus,
      promptOptimizer: optimizer,
      promptVersionStore: versionStore,
      projectDir,
    })

    const result = await loop.processRun(runId, 0.2, [breakdown('s', 0.2, false)])
    expect(result.promptsProcessed).toBe(1)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('processRun: processes multiple distinct prompts in one run', async () => {
    await writeEvents(runDir, [
      startedEvent('prompt-alpha'),
      startedEvent('prompt-beta'),
      completedEvent('bad'),
    ])
    const { optimizer, spy } = makeOptimizer(async () => makeResult())
    const loop = new PromptFeedbackLoop({
      eventBus: bus,
      promptOptimizer: optimizer,
      promptVersionStore: versionStore,
      projectDir,
    })

    const result = await loop.processRun(runId, 0.2, [breakdown('s', 0.2, false)])
    expect(result.promptsProcessed).toBe(2)
    expect(spy).toHaveBeenCalledTimes(2)
    const keys = spy.mock.calls.map((c) => (c[0] as { promptKey: string }).promptKey)
    expect(new Set(keys).size).toBe(2)
  })

  it('processRun: skips when no prompts are found in events', async () => {
    await writeEvents(runDir, [completedEvent('no prompt recorded')])
    const { optimizer, spy } = makeOptimizer(async () => makeResult())
    const loop = new PromptFeedbackLoop({
      eventBus: bus,
      promptOptimizer: optimizer,
      promptVersionStore: versionStore,
      projectDir,
    })

    const result = await loop.processRun(runId, 0.2, [breakdown('s', 0.2, false)])
    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe('no-prompts')
    expect(spy).not.toHaveBeenCalled()
  })

  // --- processRun: baseline seeding ---

  it('processRun: seeds baseline version when none exists', async () => {
    await writeEvents(runDir, [
      startedEvent('seed me please'),
      completedEvent('bad'),
    ])
    const { optimizer } = makeOptimizer(async (params) => {
      const orig = await versionStore.getActive(params.promptKey)
      return makeResult({
        originalVersion: orig!,
        bestVersion: orig!,
        improved: false,
        scoreImprovement: 0,
        exitReason: 'no_improvement',
      })
    })
    const loop = new PromptFeedbackLoop({
      eventBus: bus,
      promptOptimizer: optimizer,
      promptVersionStore: versionStore,
      projectDir,
    })

    await loop.processRun(runId, 0.3, [breakdown('s', 0.3, false)])
    const keys = await versionStore.listPromptKeys()
    expect(keys).toHaveLength(1)
    const active = await versionStore.getActive(keys[0]!)
    expect(active?.content).toBe('seed me please')
    expect(active?.metadata).toMatchObject({ source: 'prompt-feedback-loop-baseline' })
  })

  it('processRun: reuses existing baseline version on repeat runs', async () => {
    await writeEvents(runDir, [startedEvent('stable prompt'), completedEvent('bad')])

    // Pre-seed a baseline so the loop must reuse it.
    const seeded = await versionStore.save({
      promptKey: 'run-prompt:aaaa', // placeholder — will be overwritten by actual derived key
      content: 'stable prompt',
      active: true,
    })

    // Use the actual derived key by inspecting what the loop will compute.
    const saveSpy = vi.spyOn(versionStore, 'save')

    const { optimizer } = makeOptimizer(async (params) => {
      const active = await versionStore.getActive(params.promptKey)
      return makeResult({
        originalVersion: active ?? seeded,
        bestVersion: active ?? seeded,
        improved: false,
        scoreImprovement: 0,
      })
    })
    const loop = new PromptFeedbackLoop({
      eventBus: bus,
      promptOptimizer: optimizer,
      promptVersionStore: versionStore,
      projectDir,
    })

    const beforeCalls = saveSpy.mock.calls.length
    await loop.processRun(runId, 0.3, [breakdown('s', 0.3, false)])
    const afterCalls = saveSpy.mock.calls.length
    // First run: 1 baseline seed (since dervied key ≠ 'run-prompt:aaaa').
    // Second run: 0 new baseline saves.
    const secondRunId = `run-${Math.random().toString(36).slice(2, 10)}`
    const secondDir = runLogRoot(projectDir, secondRunId)
    await writeEvents(secondDir, [startedEvent('stable prompt'), completedEvent('still bad')])

    saveSpy.mockClear()
    await loop.processRun(secondRunId, 0.3, [breakdown('s', 0.3, false)])
    expect(saveSpy).not.toHaveBeenCalled() // Reuse path taken.
    expect(afterCalls - beforeCalls).toBeGreaterThan(0) // First run did seed.
  })

  // --- processRun: auto-publish policy ---

  it('processRun: auto-publishes when improvement meets delta', async () => {
    await writeEvents(runDir, [startedEvent('improve me'), completedEvent('mid')])
    const { optimizer } = makeOptimizer(async () =>
      makeResult({
        originalVersion: makeVersion({ id: 'orig', active: false }),
        bestVersion: makeVersion({ id: 'best', version: 2, active: true }),
        improved: true,
        scoreImprovement: 0.2,
      }),
    )
    const activateSpy = vi.spyOn(versionStore, 'activate')

    const loop = new PromptFeedbackLoop({
      eventBus: bus,
      promptOptimizer: optimizer,
      promptVersionStore: versionStore,
      projectDir,
      autoPublishDelta: 0.1,
    })

    const result = await loop.processRun(runId, 0.3, [breakdown('s', 0.3, false)])
    expect(result.optimizations[0]!.published).toBe(true)
    expect(activateSpy).toHaveBeenCalledWith('best')
  })

  it('processRun: does NOT auto-publish when delta is below threshold', async () => {
    await writeEvents(runDir, [startedEvent('slight improvement'), completedEvent('mid')])
    const baseline = await versionStore.save({
      promptKey: 'pre-seed',
      content: 'slight improvement',
      active: true,
    })

    const { optimizer } = makeOptimizer(async (params) => {
      const baseActive = await versionStore.getActive(params.promptKey)
      const best = await versionStore.save({
        promptKey: params.promptKey,
        content: `${baseActive?.content ?? ''} + candidate`,
        parentVersionId: baseActive?.id,
        active: true,
      })
      return makeResult({
        originalVersion: baseActive!,
        bestVersion: best,
        improved: true,
        scoreImprovement: 0.02,
      })
    })

    const loop = new PromptFeedbackLoop({
      eventBus: bus,
      promptOptimizer: optimizer,
      promptVersionStore: versionStore,
      projectDir,
      autoPublishDelta: 0.1,
    })

    const result = await loop.processRun(runId, 0.3, [breakdown('s', 0.3, false)])
    expect(result.optimizations[0]!.published).toBe(false)
    // Baseline for the run's derived key should be re-activated (not `baseline`
    // from above, which is for a different promptKey).
    const derivedKey = result.optimizations[0]!.promptKey
    const active = await versionStore.getActive(derivedKey)
    expect(active?.content).toBe('slight improvement') // original baseline content
    // The unrelated `baseline` should still exist too.
    expect(baseline.id).toBeTruthy()
  })

  it('processRun: does NOT auto-publish when optimizer returns no improvement', async () => {
    await writeEvents(runDir, [startedEvent('nothing works'), completedEvent('mid')])
    const activateSpy = vi.spyOn(versionStore, 'activate')

    const { optimizer } = makeOptimizer(async (params) => {
      const active = await versionStore.getActive(params.promptKey)
      return makeResult({
        originalVersion: active!,
        bestVersion: active!,
        improved: false,
        scoreImprovement: 0,
        exitReason: 'no_improvement',
      })
    })

    const loop = new PromptFeedbackLoop({
      eventBus: bus,
      promptOptimizer: optimizer,
      promptVersionStore: versionStore,
      projectDir,
      autoPublishDelta: 0.05,
    })

    const result = await loop.processRun(runId, 0.3, [breakdown('s', 0.3, false)])
    expect(result.optimizations[0]!.published).toBe(false)
    // Never calls activate() because nothing improved.
    expect(activateSpy).not.toHaveBeenCalled()
  })

  // --- failure feedback forwarding ---

  it('processRun: forwards failed scorers as failure feedback to optimizer', async () => {
    await writeEvents(runDir, [startedEvent('p'), completedEvent('o')])
    const { optimizer, spy } = makeOptimizer(async () => makeResult())

    const loop = new PromptFeedbackLoop({
      eventBus: bus,
      promptOptimizer: optimizer,
      promptVersionStore: versionStore,
      projectDir,
    })

    await loop.processRun(runId, 0.2, [
      breakdown('accuracy', 0.1, false, 'wrong answer'),
      breakdown('style', 0.9, true, 'nice'),
    ])

    const call = spy.mock.calls[0]![0] as {
      failures: Array<{ feedback: string }>
    }
    expect(call.failures).toHaveLength(1)
    expect(call.failures[0]!.feedback).toContain('accuracy')
    expect(call.failures[0]!.feedback).toContain('wrong answer')
  })

  it('processRun: falls back to summary feedback when no scorers failed', async () => {
    await writeEvents(runDir, [startedEvent('p'), completedEvent('o')])
    const { optimizer, spy } = makeOptimizer(async () => makeResult())

    const loop = new PromptFeedbackLoop({
      eventBus: bus,
      promptOptimizer: optimizer,
      promptVersionStore: versionStore,
      projectDir,
    })

    await loop.processRun(runId, 0.5, [breakdown('soft', 0.5, true, 'borderline')])
    const call = spy.mock.calls[0]![0] as {
      failures: Array<{ feedback: string }>
    }
    expect(call.failures).toHaveLength(1)
    expect(call.failures[0]!.feedback).toContain('soft')
  })

  // --- error handling ---

  it('processRun: surfaces optimizer errors via onError and continues', async () => {
    await writeEvents(runDir, [
      startedEvent('prompt-A'),
      startedEvent('prompt-B'),
      completedEvent('bad'),
    ])
    const errors: string[] = []

    let callIndex = 0
    const { optimizer } = makeOptimizer(async () => {
      callIndex++
      if (callIndex === 1) throw new Error('optimizer-boom')
      return makeResult({ improved: false, scoreImprovement: 0 })
    })

    const loop = new PromptFeedbackLoop({
      eventBus: bus,
      promptOptimizer: optimizer,
      promptVersionStore: versionStore,
      projectDir,
      onError: (_rid, msg) => errors.push(msg),
    })

    const result = await loop.processRun(runId, 0.2, [breakdown('s', 0.2, false)])
    expect(errors.some((m) => m.includes('optimizer-boom'))).toBe(true)
    // Second prompt still got processed.
    expect(result.optimizations).toHaveLength(1)
  })

  it('processRun: surfaces missing run files via onError (no prompts found)', async () => {
    const errors: string[] = []
    const { optimizer, spy } = makeOptimizer(async () => makeResult())

    const loop = new PromptFeedbackLoop({
      eventBus: bus,
      promptOptimizer: optimizer,
      promptVersionStore: versionStore,
      projectDir,
      onError: (_rid, msg) => errors.push(msg),
    })

    const result = await loop.processRun('no-such-run', 0.2, [breakdown('s', 0.2, false)])
    expect(errors.some((m) => m.includes('normalized-events.jsonl'))).toBe(true)
    expect(result.skipReason).toBe('no-prompts')
    expect(spy).not.toHaveBeenCalled()
  })

  // --- subscription lifecycle ---

  it('start: subscribes to run:scored events and processes them', async () => {
    await writeEvents(runDir, [startedEvent('live prompt'), completedEvent('bad')])
    const { optimizer, spy } = makeOptimizer(async () => makeResult({ scoreImprovement: 0 }))

    const loop = new PromptFeedbackLoop({
      eventBus: bus,
      promptOptimizer: optimizer,
      promptVersionStore: versionStore,
      projectDir,
      poorRunThreshold: 0.7,
    })
    loop.start()

    bus.emit({
      type: 'run:scored',
      runId,
      score: 0.2,
      passed: false,
      scorerBreakdown: [breakdown('s', 0.2, false)],
      metrics: { totalEvents: 2, toolCalls: 0, toolErrors: 0, errors: 0 },
      scoredAt: Date.now(),
    })

    // Allow async handler to run.
    await new Promise((r) => setTimeout(r, 10))
    expect(spy).toHaveBeenCalledTimes(1)

    loop.stop()
  })

  it('stop: unsubscribes and stops processing subsequent events', async () => {
    await writeEvents(runDir, [startedEvent('p'), completedEvent('o')])
    const { optimizer, spy } = makeOptimizer(async () => makeResult({ scoreImprovement: 0 }))

    const loop = new PromptFeedbackLoop({
      eventBus: bus,
      promptOptimizer: optimizer,
      promptVersionStore: versionStore,
      projectDir,
    })
    loop.start()
    loop.stop()

    bus.emit({
      type: 'run:scored',
      runId,
      score: 0.1,
      passed: false,
      scorerBreakdown: [breakdown('s', 0.1, false)],
      metrics: { totalEvents: 2, toolCalls: 0, toolErrors: 0, errors: 0 },
      scoredAt: Date.now(),
    })

    await new Promise((r) => setTimeout(r, 10))
    expect(spy).not.toHaveBeenCalled()
  })

  it('start: is idempotent — calling twice does not double-subscribe', async () => {
    await writeEvents(runDir, [startedEvent('p'), completedEvent('o')])
    const { optimizer, spy } = makeOptimizer(async () => makeResult({ scoreImprovement: 0 }))

    const loop = new PromptFeedbackLoop({
      eventBus: bus,
      promptOptimizer: optimizer,
      promptVersionStore: versionStore,
      projectDir,
    })
    loop.start()
    loop.start()

    bus.emit({
      type: 'run:scored',
      runId,
      score: 0.1,
      passed: false,
      scorerBreakdown: [breakdown('s', 0.1, false)],
      metrics: { totalEvents: 2, toolCalls: 0, toolErrors: 0, errors: 0 },
      scoredAt: Date.now(),
    })

    await new Promise((r) => setTimeout(r, 10))
    expect(spy).toHaveBeenCalledTimes(1)

    loop.stop()
  })

  it('stop: is safe to call without start()', () => {
    const { optimizer } = makeOptimizer(async () => makeResult())
    const loop = new PromptFeedbackLoop({
      eventBus: bus,
      promptOptimizer: optimizer,
      promptVersionStore: versionStore,
      projectDir,
    })
    expect(() => loop.stop()).not.toThrow()
  })

  // --- concurrency / duplicate guard ---

  it('processRun: de-dupes concurrent processing of the same runId', async () => {
    await writeEvents(runDir, [startedEvent('slow'), completedEvent('slow')])

    let resolveOptimize: (value: OptimizationResult) => void = () => {}
    const gate = new Promise<OptimizationResult>((resolve) => {
      resolveOptimize = resolve
    })
    const { optimizer, spy } = makeOptimizer(async () => gate)

    const loop = new PromptFeedbackLoop({
      eventBus: bus,
      promptOptimizer: optimizer,
      promptVersionStore: versionStore,
      projectDir,
    })

    const p1 = loop.processRun(runId, 0.1, [breakdown('s', 0.1, false)])
    const p2 = loop.processRun(runId, 0.1, [breakdown('s', 0.1, false)])

    const r2 = await p2
    expect(r2.skipped).toBe(true)
    expect(r2.skipReason).toBe('already-processing')

    resolveOptimize(makeResult({ improved: false, scoreImprovement: 0 }))
    const r1 = await p1
    expect(r1.skipped).toBe(false)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  // --- malformed files ---

  it('processRun: tolerates malformed JSONL lines', async () => {
    await mkdir(runDir, { recursive: true })
    await writeFile(
      join(runDir, 'normalized-events.jsonl'),
      `${JSON.stringify(startedEvent('ok'))}\nnot-json\n${JSON.stringify(completedEvent('done'))}\n`,
      'utf8',
    )
    const { optimizer, spy } = makeOptimizer(async () => makeResult({ scoreImprovement: 0 }))

    const loop = new PromptFeedbackLoop({
      eventBus: bus,
      promptOptimizer: optimizer,
      promptVersionStore: versionStore,
      projectDir,
    })

    const result = await loop.processRun(runId, 0.2, [breakdown('s', 0.2, false)])
    expect(result.skipped).toBe(false)
    expect(result.promptsProcessed).toBe(1)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('processRun: ignores empty prompt strings', async () => {
    await writeEvents(runDir, [startedEvent('   '), completedEvent('bad')])
    const { optimizer, spy } = makeOptimizer(async () => makeResult())
    const loop = new PromptFeedbackLoop({
      eventBus: bus,
      promptOptimizer: optimizer,
      promptVersionStore: versionStore,
      projectDir,
    })

    const result = await loop.processRun(runId, 0.2, [breakdown('s', 0.2, false)])
    expect(result.skipReason).toBe('no-prompts')
    expect(spy).not.toHaveBeenCalled()
  })

  // --- custom configuration ---

  it('processRun: honours custom promptKeyPrefix', async () => {
    await writeEvents(runDir, [startedEvent('hello'), completedEvent('bad')])
    const { optimizer, spy } = makeOptimizer(async () => makeResult({ scoreImprovement: 0 }))

    const loop = new PromptFeedbackLoop({
      eventBus: bus,
      promptOptimizer: optimizer,
      promptVersionStore: versionStore,
      projectDir,
      promptKeyPrefix: 'my-prefix',
    })

    await loop.processRun(runId, 0.2, [breakdown('s', 0.2, false)])
    const call = spy.mock.calls[0]![0] as { promptKey: string }
    expect(call.promptKey).toMatch(/^my-prefix:[0-9a-f]{12}$/)
  })

  it('processRun: autoPublishDelta=Infinity disables auto-publish entirely', async () => {
    await writeEvents(runDir, [startedEvent('p'), completedEvent('o')])
    const activateSpy = vi.spyOn(versionStore, 'activate')

    const { optimizer } = makeOptimizer(async (params) => {
      const active = await versionStore.getActive(params.promptKey)
      const best = await versionStore.save({
        promptKey: params.promptKey,
        content: 'new content',
        parentVersionId: active?.id,
        active: true,
      })
      return makeResult({
        originalVersion: active!,
        bestVersion: best,
        improved: true,
        scoreImprovement: 0.99,
      })
    })

    const loop = new PromptFeedbackLoop({
      eventBus: bus,
      promptOptimizer: optimizer,
      promptVersionStore: versionStore,
      projectDir,
      autoPublishDelta: Infinity,
    })

    const result = await loop.processRun(runId, 0.2, [breakdown('s', 0.2, false)])
    expect(result.optimizations[0]!.published).toBe(false)
    // activate() IS still called to revert to baseline. It should NOT be called
    // with the "best" version ID.
    const calledWithBestId = activateSpy.mock.calls.some((c) => c[0] === result.optimizations[0]!.optimizationResult.bestVersion.id)
    expect(calledWithBestId).toBe(false)
  })
})

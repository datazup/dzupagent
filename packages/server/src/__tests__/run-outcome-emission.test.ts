/**
 * Session M: End-to-end verification that `run:scored` is actually emitted
 * on the event bus in production, both:
 *   (a) when `RunOutcomeAnalyzer.analyze()` runs successfully with fixtures
 *       on disk, and
 *   (b) when the run-worker wires the analyzer into the completion path.
 *
 * Covers graceful degradation (missing events file), per-scorer resilience
 * (safeScore wrapper), log entries, and metric shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  InMemoryAgentStore,
  InMemoryRunStore,
  ModelRegistry,
  createEventBus,
  type DzupEvent,
  type DzupEventBus,
} from '@dzupagent/core'
import type { EvalResult, EvalScorer } from '@dzupagent/eval-contracts'
import { runLogRoot } from '@dzupagent/agent-adapters'
import type { AgentEvent } from '@dzupagent/agent-adapters'
import { waitForCondition } from '@dzupagent/test-utils'

import { RunOutcomeAnalyzer } from '../services/run-outcome-analyzer.js'
import { InMemoryRunQueue } from '../queue/run-queue.js'
import { startRunWorker } from '../runtime/run-worker.js'
import type { RunOutcomeAnalyzerLike } from '../runtime/run-worker.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ScoredEvent = Extract<DzupEvent, { type: 'run:scored' }>

function collectScoredEvents(bus: DzupEventBus): ScoredEvent[] {
  const events: ScoredEvent[] = []
  bus.on('run:scored', (event) => {
    events.push(event)
  })
  return events
}

function makeScorer(
  overrides: Partial<EvalScorer> & Partial<EvalResult> = {},
): EvalScorer {
  const result: EvalResult = {
    score: typeof overrides.score === 'number' ? overrides.score : 0.9,
    pass: typeof overrides.pass === 'boolean' ? overrides.pass : true,
    reasoning: overrides.reasoning ?? 'stub-ok',
  }
  return {
    name: overrides.name ?? 'stub',
    async score(): Promise<EvalResult> {
      return result
    },
  }
}

function makeFailingScorer(name = 'broken'): EvalScorer {
  return {
    name,
    async score(): Promise<EvalResult> {
      throw new Error('scorer-explosion')
    },
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

function toolCallEvent(toolName = 'search'): AgentEvent {
  return {
    type: 'adapter:tool_call',
    providerId: 'claude',
    toolName,
    input: { q: 'x' },
    timestamp: BASE_TS + 10,
  }
}

function toolResultEvent(toolName = 'search'): AgentEvent {
  return {
    type: 'adapter:tool_result',
    providerId: 'claude',
    toolName,
    output: 'ok',
    durationMs: 12,
    timestamp: BASE_TS + 20,
  }
}

function completedEvent(result: string): AgentEvent {
  return {
    type: 'adapter:completed',
    providerId: 'claude',
    sessionId: 's-1',
    result,
    durationMs: 50,
    timestamp: BASE_TS + 100,
  }
}

// ---------------------------------------------------------------------------
// RunOutcomeAnalyzer — direct emission suite (file-backed)
// ---------------------------------------------------------------------------

describe('run:scored emission — RunOutcomeAnalyzer', () => {
  let projectDir: string
  let runId: string
  let runDir: string

  beforeEach(async () => {
    projectDir = join(tmpdir(), `roa-emit-${Math.random().toString(36).slice(2, 10)}`)
    runId = `run-${Math.random().toString(36).slice(2, 10)}`
    runDir = runLogRoot(projectDir, runId)
    await mkdir(projectDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true }).catch(() => { /* best-effort */ })
  })

  // -------------------------------------------------------------------------
  // Scenario 1: run:scored is emitted on successful analyze()
  // -------------------------------------------------------------------------
  it('emits run:scored on the event bus when analyzer completes successfully', async () => {
    await writeEvents(runDir, [
      startedEvent('hello'),
      toolCallEvent(),
      toolResultEvent(),
      completedEvent('world'),
    ])

    const bus = createEventBus()
    const emitted = collectScoredEvents(bus)
    const analyzer = new RunOutcomeAnalyzer({
      eventBus: bus,
      projectDir,
      scorers: [{ scorer: makeScorer({ name: 'happy', score: 0.9, pass: true }) }],
    })

    const analysis = await analyzer.analyze(runId)

    expect(analysis).not.toBeNull()
    expect(emitted).toHaveLength(1)
    const event = emitted[0]!
    expect(event.type).toBe('run:scored')
  })

  // -------------------------------------------------------------------------
  // Scenario 2: emitted event contains runId, score, passed, scorerBreakdown
  // -------------------------------------------------------------------------
  it('run:scored contains runId, score, passed, and scorerBreakdown', async () => {
    await writeEvents(runDir, [completedEvent('done')])

    const bus = createEventBus()
    const emitted = collectScoredEvents(bus)
    const analyzer = new RunOutcomeAnalyzer({
      eventBus: bus,
      projectDir,
      passThreshold: 0.5,
      scorers: [
        { scorer: makeScorer({ name: 'alpha', score: 0.8 }) },
        { scorer: makeScorer({ name: 'beta', score: 0.6 }) },
      ],
    })

    await analyzer.analyze(runId)

    expect(emitted).toHaveLength(1)
    const event = emitted[0]!
    expect(event.runId).toBe(runId)
    expect(typeof event.score).toBe('number')
    expect(event.score).toBeGreaterThanOrEqual(0)
    expect(event.score).toBeLessThanOrEqual(1)
    expect(typeof event.passed).toBe('boolean')
    expect(Array.isArray(event.scorerBreakdown)).toBe(true)
    expect(event.scorerBreakdown).toHaveLength(2)
    expect(event.scorerBreakdown.map((r) => r.scorerName).sort()).toEqual(['alpha', 'beta'])
    // Each breakdown entry has the required keys
    for (const b of event.scorerBreakdown) {
      expect(typeof b.scorerName).toBe('string')
      expect(typeof b.score).toBe('number')
      expect(typeof b.pass).toBe('boolean')
      expect(typeof b.reasoning).toBe('string')
    }
  })

  // -------------------------------------------------------------------------
  // Scenario 3: emitted event contains agentId when provided
  // -------------------------------------------------------------------------
  it('propagates agentId onto run:scored when supplied via options', async () => {
    await writeEvents(runDir, [completedEvent('done')])

    const bus = createEventBus()
    const emitted = collectScoredEvents(bus)
    const analyzer = new RunOutcomeAnalyzer({
      eventBus: bus,
      projectDir,
      scorers: [{ scorer: makeScorer() }],
    })

    await analyzer.analyze(runId, { agentId: 'agent-m' })

    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.agentId).toBe('agent-m')
  })

  it('omits agentId from run:scored when not supplied', async () => {
    await writeEvents(runDir, [completedEvent('done')])

    const bus = createEventBus()
    const emitted = collectScoredEvents(bus)
    const analyzer = new RunOutcomeAnalyzer({
      eventBus: bus,
      projectDir,
      scorers: [{ scorer: makeScorer() }],
    })

    await analyzer.analyze(runId)

    expect(emitted).toHaveLength(1)
    // When agentId is not provided, the field is conditionally spread — so
    // it should be absent from the event.
    expect('agentId' in emitted[0]!).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Scenario 4: graceful degradation when events file is missing
  // -------------------------------------------------------------------------
  it('still emits run:scored (with totalEvents=0) when events file is missing', async () => {
    const bus = createEventBus()
    const emitted = collectScoredEvents(bus)
    // Scorer returns 0 so we can assert score=0 on the emit path.
    const analyzer = new RunOutcomeAnalyzer({
      eventBus: bus,
      projectDir,
      scorers: [{ scorer: makeScorer({ score: 0, pass: false }) }],
      onError: () => { /* swallow — we assert on the emit, not on onError */ },
    })

    // Note: runDir is never created, so normalized-events.jsonl does not exist.
    const analysis = await analyzer.analyze('missing-run', { input: 'i', output: 'o' })

    expect(analysis).not.toBeNull()
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.score).toBe(0)
    expect(emitted[0]!.metrics.totalEvents).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Scenario 5: a single scorer throwing does NOT block the emit
  // -------------------------------------------------------------------------
  it('emits run:scored even when one scorer throws (safeScore wrapper)', async () => {
    await writeEvents(runDir, [completedEvent('out')])

    const bus = createEventBus()
    const emitted = collectScoredEvents(bus)
    const errors: string[] = []
    const analyzer = new RunOutcomeAnalyzer({
      eventBus: bus,
      projectDir,
      scorers: [
        { scorer: makeScorer({ name: 'ok', score: 1 }) },
        { scorer: makeFailingScorer('explode') },
      ],
      onError: (_rid, msg) => errors.push(msg),
    })

    const analysis = await analyzer.analyze(runId)

    expect(analysis).not.toBeNull()
    expect(emitted).toHaveLength(1)
    // The broken scorer degraded to 0, the healthy one returned 1 → avg 0.5
    expect(emitted[0]!.score).toBeCloseTo(0.5, 5)
    // The healthy scorer is still present in the breakdown
    expect(emitted[0]!.scorerBreakdown.some((b) => b.scorerName === 'ok' && b.pass)).toBe(true)
    // The failing scorer surfaces via onError AND is present as a failing row.
    expect(errors.some((m) => m.includes('explode'))).toBe(true)
    expect(emitted[0]!.scorerBreakdown.some((b) => b.scorerName === 'explode' && !b.pass)).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Scenario 8: metrics include totalEvents
  // -------------------------------------------------------------------------
  it('run:scored.metrics includes totalEvents derived from normalized-events.jsonl', async () => {
    await writeEvents(runDir, [
      startedEvent('go'),
      toolCallEvent('a'),
      toolResultEvent('a'),
      completedEvent('ok'),
    ])

    const bus = createEventBus()
    const emitted = collectScoredEvents(bus)
    const analyzer = new RunOutcomeAnalyzer({
      eventBus: bus,
      projectDir,
      scorers: [{ scorer: makeScorer() }],
    })

    await analyzer.analyze(runId)

    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.metrics.totalEvents).toBe(4)
    expect(emitted[0]!.metrics.toolCalls).toBe(1)
    expect(typeof emitted[0]!.metrics.errors).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// run-worker integration suite — analyzer is actually called + logs emitted
// ---------------------------------------------------------------------------

async function waitForTerminalStatus(
  store: InMemoryRunStore,
  runId: string,
  timeoutMs = 3000,
): Promise<string> {
  let status: string | undefined
  await waitForCondition(
    async () => {
      const run = await store.get(runId)
      if (
        run?.status === 'completed' ||
        run?.status === 'failed' ||
        run?.status === 'cancelled' ||
        run?.status === 'rejected'
      ) {
        status = run.status
        return true
      }
      return false
    },
    { timeoutMs, intervalMs: 20 },
  )
  return status!
}

describe('run:scored emission — run-worker wiring', () => {
  // -------------------------------------------------------------------------
  // Scenario 6: success path emits an `info` log after analyze() completes
  // -------------------------------------------------------------------------
  it('writes an info log in phase=run-outcome after successful analyze', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'a-outcome-ok',
      name: 'Outcome OK Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    const analyzer: RunOutcomeAnalyzerLike = {
      analyze: vi.fn(async (_runId: string, options?: { agentId?: string }) => {
        // Simulate a real analyze() result so the success-path log can format it.
        eventBus.emit({
          type: 'run:scored',
          runId: _runId,
          ...(options?.agentId !== undefined ? { agentId: options.agentId } : {}),
          score: 0.82,
          passed: true,
          scorerBreakdown: [
            { scorerName: 'stub', score: 0.82, pass: true, reasoning: 'ok' },
          ],
          metrics: { totalEvents: 3, toolCalls: 1, toolErrors: 0, errors: 0 },
          scoredAt: Date.now(),
        })
        return {
          runId: _runId,
          score: 0.82,
          passed: true,
          scorerBreakdown: [],
          metrics: { totalEvents: 3, toolCalls: 1, toolErrors: 0, errors: 0 },
          scoredAt: Date.now(),
        }
      }),
    }

    const scored: ScoredEvent[] = []
    eventBus.on('run:scored', (event) => scored.push(event))

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({ content: 'done' }),
      runOutcomeAnalyzer: analyzer,
    })

    const run = await runStore.create({ agentId: 'a-outcome-ok', input: { message: 'hi' } })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'a-outcome-ok',
      input: { message: 'hi' },
      priority: 1,
    })

    const status = await waitForTerminalStatus(runStore, run.id)
    expect(status).toBe('completed')

    // Analyzer was called with agentId wired through.
    expect(analyzer.analyze).toHaveBeenCalledTimes(1)
    const [firstArg, secondArg] = (analyzer.analyze as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { agentId?: string; input?: string; output?: string },
    ]
    expect(firstArg).toBe(run.id)
    expect(secondArg.agentId).toBe('a-outcome-ok')

    // Event was actually emitted on the bus.
    expect(scored).toHaveLength(1)
    expect(scored[0]!.agentId).toBe('a-outcome-ok')

    // Success log at phase=run-outcome, level=info
    const logs = await runStore.getLogs(run.id)
    const okLog = logs.find(
      (l) => l.phase === 'run-outcome' && l.level === 'info',
    )
    expect(okLog).toBeDefined()
    expect(okLog!.message).toMatch(/Run outcome scored/)
    const data = okLog!.data as { score?: number; passed?: boolean }
    expect(data.score).toBeCloseTo(0.82, 5)
    expect(data.passed).toBe(true)

    await runQueue.stop(false)
  })

  // -------------------------------------------------------------------------
  // Scenario 7: error path writes a warn log and swallows the failure
  // -------------------------------------------------------------------------
  it('writes a warn log in phase=run-outcome when analyze() throws', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'a-outcome-err',
      name: 'Outcome Err Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    const analyzer: RunOutcomeAnalyzerLike = {
      analyze: vi.fn(async () => {
        throw new Error('analyze-kaboom')
      }),
    }

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({ content: 'done' }),
      runOutcomeAnalyzer: analyzer,
    })

    const run = await runStore.create({ agentId: 'a-outcome-err', input: { message: 'hi' } })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'a-outcome-err',
      input: { message: 'hi' },
      priority: 1,
    })

    // Despite analyzer throwing, the run still completes.
    const status = await waitForTerminalStatus(runStore, run.id)
    expect(status).toBe('completed')

    const logs = await runStore.getLogs(run.id)
    const warnLog = logs.find(
      (l) => l.phase === 'run-outcome' && l.level === 'warn',
    )
    expect(warnLog).toBeDefined()
    expect(warnLog!.message).toMatch(/Run outcome analyzer failed/)
    const data = warnLog!.data as { error?: string }
    expect(data.error).toContain('analyze-kaboom')

    await runQueue.stop(false)
  })

  // -------------------------------------------------------------------------
  // Sanity: analyzer receives stringified input/output for non-string values
  // -------------------------------------------------------------------------
  it('run-worker stringifies non-string input/output before passing to analyze()', async () => {
    const runStore = new InMemoryRunStore()
    const agentStore = new InMemoryAgentStore()
    const eventBus = createEventBus()
    const runQueue = new InMemoryRunQueue({ concurrency: 1 })
    const modelRegistry = new ModelRegistry()

    await agentStore.save({
      id: 'a-outcome-str',
      name: 'Outcome Stringify Agent',
      instructions: 'test',
      modelTier: 'chat',
      active: true,
    })

    const analyzer: RunOutcomeAnalyzerLike = {
      analyze: vi.fn(async () => undefined),
    }

    startRunWorker({
      runQueue,
      runStore,
      agentStore,
      eventBus,
      modelRegistry,
      runExecutor: async () => ({ foo: 'bar' }),
      runOutcomeAnalyzer: analyzer,
    })

    const run = await runStore.create({ agentId: 'a-outcome-str', input: { query: 'xyz' } })
    await runQueue.enqueue({
      runId: run.id,
      agentId: 'a-outcome-str',
      input: { query: 'xyz' },
      priority: 1,
    })

    await waitForTerminalStatus(runStore, run.id)

    const call = (analyzer.analyze as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { agentId?: string; input?: string; output?: string },
    ]
    expect(typeof call[1].input).toBe('string')
    expect(typeof call[1].output).toBe('string')
    expect(call[1].input).toContain('xyz')
    expect(call[1].output).toContain('bar')

    await runQueue.stop(false)
  })
})

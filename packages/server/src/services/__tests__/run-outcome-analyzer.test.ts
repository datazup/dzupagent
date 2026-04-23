/**
 * Tests for RunOutcomeAnalyzer — reads persisted run events from a tmp
 * `.dzupagent/runs/<runId>/` directory, scores them with stub eval scorers,
 * and asserts the emitted `run:scored` event shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createEventBus, type DzupEvent, type DzupEventBus } from '@dzupagent/core'
import type { EvalResult, EvalScorer } from '@dzupagent/evals'
import { runLogRoot } from '@dzupagent/agent-adapters'
import type { AgentEvent, RunSummary } from '@dzupagent/agent-adapters'

import { RunOutcomeAnalyzer } from '../run-outcome-analyzer.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScorer(overrides: Partial<EvalScorer> & Partial<EvalResult> = {}): EvalScorer {
  const result: EvalResult = {
    score: typeof overrides.score === 'number' ? overrides.score : 1,
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

function makeFailingScorer(name = 'boom'): EvalScorer {
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

async function writeSummary(dir: string, summary: RunSummary): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'summary.json'), JSON.stringify(summary), 'utf8')
}

function collectScoredEvents(bus: DzupEventBus): Array<Extract<DzupEvent, { type: 'run:scored' }>> {
  const events: Array<Extract<DzupEvent, { type: 'run:scored' }>> = []
  bus.on('run:scored', (event) => {
    events.push(event)
  })
  return events
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

function messageEvent(content: string): AgentEvent {
  return {
    type: 'adapter:message',
    providerId: 'claude',
    content,
    role: 'assistant',
    timestamp: BASE_TS + 10,
  }
}

function toolCallEvent(toolName = 'search'): AgentEvent {
  return {
    type: 'adapter:tool_call',
    providerId: 'claude',
    toolName,
    input: { q: 'x' },
    timestamp: BASE_TS + 20,
  }
}

function toolResultEvent(toolName = 'search'): AgentEvent {
  return {
    type: 'adapter:tool_result',
    providerId: 'claude',
    toolName,
    output: 'ok',
    durationMs: 12,
    timestamp: BASE_TS + 30,
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

function failedEvent(error = 'boom'): AgentEvent {
  return {
    type: 'adapter:failed',
    providerId: 'claude',
    sessionId: 's-1',
    error,
    timestamp: BASE_TS + 50,
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('RunOutcomeAnalyzer', () => {
  let projectDir: string
  let runId: string
  let runDir: string

  beforeEach(async () => {
    projectDir = join(tmpdir(), `roa-${Math.random().toString(36).slice(2, 10)}`)
    runId = `run-${Math.random().toString(36).slice(2, 10)}`
    runDir = runLogRoot(projectDir, runId)
    await mkdir(projectDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true }).catch(() => { /* best-effort */ })
  })

  // --- constructor ---

  it('constructor: throws when eventBus is missing', () => {
    expect(() => new RunOutcomeAnalyzer({
      eventBus: undefined as unknown as DzupEventBus,
      scorers: [{ scorer: makeScorer() }],
      projectDir,
    })).toThrow(/eventBus is required/)
  })

  it('constructor: throws when no scorers are provided', () => {
    expect(() => new RunOutcomeAnalyzer({
      eventBus: createEventBus(),
      scorers: [],
      projectDir,
    })).toThrow(/at least one scorer/)
  })

  it('constructor: throws when projectDir is missing', () => {
    expect(() => new RunOutcomeAnalyzer({
      eventBus: createEventBus(),
      scorers: [{ scorer: makeScorer() }],
      projectDir: '',
    })).toThrow(/projectDir is required/)
  })

  // --- happy path ---

  it('analyze: emits run:scored with aggregate score and per-scorer breakdown', async () => {
    await writeEvents(runDir, [
      startedEvent('hi'),
      toolCallEvent(),
      toolResultEvent(),
      completedEvent('hello'),
    ])

    const bus = createEventBus()
    const emitted = collectScoredEvents(bus)
    const analyzer = new RunOutcomeAnalyzer({
      eventBus: bus,
      projectDir,
      scorers: [
        { scorer: makeScorer({ name: 'a', score: 0.8, pass: true }) },
        { scorer: makeScorer({ name: 'b', score: 0.4, pass: false }) },
      ],
    })

    const analysis = await analyzer.analyze(runId)

    expect(analysis).not.toBeNull()
    expect(analysis?.score).toBeCloseTo(0.6, 5)
    expect(analysis?.passed).toBe(false) // default threshold 0.7
    expect(analysis?.scorerBreakdown).toHaveLength(2)
    expect(analysis?.scorerBreakdown[0]).toMatchObject({ scorerName: 'a', score: 0.8 })
    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.type).toBe('run:scored')
    expect(emitted[0]?.runId).toBe(runId)
  })

  it('analyze: weighted average honours per-scorer weights', async () => {
    await writeEvents(runDir, [completedEvent('done')])

    const bus = createEventBus()
    const analyzer = new RunOutcomeAnalyzer({
      eventBus: bus,
      projectDir,
      scorers: [
        { scorer: makeScorer({ name: 'heavy', score: 1.0 }), weight: 3 },
        { scorer: makeScorer({ name: 'light', score: 0.0 }), weight: 1 },
      ],
    })

    const analysis = await analyzer.analyze(runId)
    // (1.0*3 + 0.0*1) / 4 = 0.75
    expect(analysis?.score).toBeCloseTo(0.75, 5)
  })

  it('analyze: passed=true when aggregate >= passThreshold', async () => {
    await writeEvents(runDir, [completedEvent('done')])

    const bus = createEventBus()
    const analyzer = new RunOutcomeAnalyzer({
      eventBus: bus,
      projectDir,
      passThreshold: 0.5,
      scorers: [{ scorer: makeScorer({ score: 0.6 }) }],
    })

    const analysis = await analyzer.analyze(runId)
    expect(analysis?.passed).toBe(true)
  })

  it('analyze: passed=false when aggregate below threshold', async () => {
    await writeEvents(runDir, [completedEvent('done')])

    const bus = createEventBus()
    const analyzer = new RunOutcomeAnalyzer({
      eventBus: bus,
      projectDir,
      passThreshold: 0.9,
      scorers: [{ scorer: makeScorer({ score: 0.8 }) }],
    })

    const analysis = await analyzer.analyze(runId)
    expect(analysis?.passed).toBe(false)
  })

  // --- metrics derivation ---

  it('analyze: metrics count tool calls and errors from normalized events', async () => {
    await writeEvents(runDir, [
      startedEvent('go'),
      toolCallEvent('a'),
      toolResultEvent('a'),
      toolCallEvent('b'),
      failedEvent('nope'),
    ])

    const bus = createEventBus()
    const emitted = collectScoredEvents(bus)
    const analyzer = new RunOutcomeAnalyzer({
      eventBus: bus,
      projectDir,
      scorers: [{ scorer: makeScorer() }],
    })

    const analysis = await analyzer.analyze(runId)
    expect(analysis?.metrics.totalEvents).toBe(5)
    expect(analysis?.metrics.toolCalls).toBe(2)
    expect(analysis?.metrics.errors).toBe(1)
    expect(emitted[0]?.metrics.toolCalls).toBe(2)
  })

  it('analyze: picks up durationMs from summary.json when available', async () => {
    await writeEvents(runDir, [completedEvent('ok')])
    await writeSummary(runDir, {
      runId,
      providerId: 'claude',
      startedAt: BASE_TS,
      completedAt: BASE_TS + 750,
      durationMs: 750,
      toolCallCount: 0,
      artifactCount: 0,
      status: 'completed',
    })

    const bus = createEventBus()
    const analyzer = new RunOutcomeAnalyzer({
      eventBus: bus,
      projectDir,
      scorers: [{ scorer: makeScorer() }],
    })

    const analysis = await analyzer.analyze(runId)
    expect(analysis?.metrics.durationMs).toBe(750)
  })

  it('analyze: falls back to summary counts when no normalized events file', async () => {
    await writeSummary(runDir, {
      runId,
      providerId: 'claude',
      startedAt: BASE_TS,
      completedAt: BASE_TS + 10,
      durationMs: 10,
      toolCallCount: 4,
      artifactCount: 0,
      status: 'failed',
      errorMessage: 'oh no',
    })

    const bus = createEventBus()
    const errors: string[] = []
    const analyzer = new RunOutcomeAnalyzer({
      eventBus: bus,
      projectDir,
      scorers: [{ scorer: makeScorer() }],
      onError: (_rid, msg) => errors.push(msg),
    })

    const analysis = await analyzer.analyze(runId)
    expect(analysis?.metrics.totalEvents).toBe(0)
    expect(analysis?.metrics.toolCalls).toBe(4)
    expect(analysis?.metrics.errors).toBe(1)
    // ENOENT read of normalized-events should have surfaced via onError.
    expect(errors.some((m) => m.includes('normalized-events.jsonl'))).toBe(true)
  })

  // --- input / output derivation ---

  it('analyze: derives input from adapter:started and output from adapter:completed', async () => {
    const scoreSpy = vi.fn(async (_input: string, _output: string) => ({
      score: 1,
      pass: true,
      reasoning: 'ok',
    } satisfies EvalResult))
    const scorer: EvalScorer = { name: 'spy', score: scoreSpy }

    await writeEvents(runDir, [
      startedEvent('user-prompt'),
      completedEvent('final-answer'),
    ])

    const analyzer = new RunOutcomeAnalyzer({
      eventBus: createEventBus(),
      projectDir,
      scorers: [{ scorer }],
    })

    await analyzer.analyze(runId)
    expect(scoreSpy).toHaveBeenCalledWith('user-prompt', 'final-answer', undefined)
  })

  it('analyze: concatenates messages when no adapter:completed event exists', async () => {
    const scoreSpy = vi.fn(async (_input: string, output: string) => ({
      score: 1,
      pass: true,
      reasoning: output,
    } satisfies EvalResult))
    const scorer: EvalScorer = { name: 'spy', score: scoreSpy }

    await writeEvents(runDir, [
      startedEvent('hi'),
      messageEvent('part-1'),
      messageEvent('part-2'),
    ])

    const analyzer = new RunOutcomeAnalyzer({
      eventBus: createEventBus(),
      projectDir,
      scorers: [{ scorer }],
    })

    await analyzer.analyze(runId)
    expect(scoreSpy).toHaveBeenCalledWith('hi', 'part-1part-2', undefined)
  })

  it('analyze: explicit options.input/output/reference override derived values', async () => {
    const scoreSpy = vi.fn(async (input: string, output: string, reference?: string) => ({
      score: 0.9,
      pass: true,
      reasoning: `${input}|${output}|${reference ?? ''}`,
    } satisfies EvalResult))
    const scorer: EvalScorer = { name: 'spy', score: scoreSpy }

    await writeEvents(runDir, [completedEvent('persisted-output')])

    const analyzer = new RunOutcomeAnalyzer({
      eventBus: createEventBus(),
      projectDir,
      scorers: [{ scorer }],
    })

    await analyzer.analyze(runId, {
      input: 'override-in',
      output: 'override-out',
      reference: 'override-ref',
    })
    expect(scoreSpy).toHaveBeenCalledWith('override-in', 'override-out', 'override-ref')
  })

  // --- emit contract ---

  it('analyze: emitted event propagates agentId', async () => {
    await writeEvents(runDir, [completedEvent('done')])

    const bus = createEventBus()
    const emitted = collectScoredEvents(bus)
    const analyzer = new RunOutcomeAnalyzer({
      eventBus: bus,
      projectDir,
      scorers: [{ scorer: makeScorer() }],
    })

    await analyzer.analyze(runId, { agentId: 'agent-99' })
    expect(emitted[0]?.agentId).toBe('agent-99')
  })

  it('analyze: emitted event includes scoredAt epoch-ms', async () => {
    await writeEvents(runDir, [completedEvent('done')])

    const bus = createEventBus()
    const emitted = collectScoredEvents(bus)
    const analyzer = new RunOutcomeAnalyzer({
      eventBus: bus,
      projectDir,
      scorers: [{ scorer: makeScorer() }],
    })

    const before = Date.now()
    await analyzer.analyze(runId)
    const after = Date.now()
    expect(emitted[0]?.scoredAt).toBeGreaterThanOrEqual(before)
    expect(emitted[0]?.scoredAt).toBeLessThanOrEqual(after)
  })

  // --- error handling ---

  it('analyze: returns null and surfaces error when runId is empty', async () => {
    const errors: string[] = []
    const analyzer = new RunOutcomeAnalyzer({
      eventBus: createEventBus(),
      projectDir,
      scorers: [{ scorer: makeScorer() }],
      onError: (_rid, msg) => errors.push(msg),
    })
    const analysis = await analyzer.analyze('')
    expect(analysis).toBeNull()
    expect(errors).toHaveLength(1)
  })

  it('analyze: individual scorer failure degrades to score=0 and is surfaced via onError', async () => {
    await writeEvents(runDir, [completedEvent('out')])

    const bus = createEventBus()
    const errors: string[] = []
    const analyzer = new RunOutcomeAnalyzer({
      eventBus: bus,
      projectDir,
      scorers: [
        { scorer: makeScorer({ name: 'ok', score: 1 }), weight: 1 },
        { scorer: makeFailingScorer('broken'), weight: 1 },
      ],
      onError: (_rid, msg) => errors.push(msg),
    })

    const analysis = await analyzer.analyze(runId)
    // (1 + 0) / 2 = 0.5
    expect(analysis?.score).toBeCloseTo(0.5, 5)
    expect(errors.some((m) => m.includes('broken'))).toBe(true)
  })

  it('analyze: skips malformed JSONL lines without throwing', async () => {
    await mkdir(runDir, { recursive: true })
    await writeFile(
      join(runDir, 'normalized-events.jsonl'),
      `${JSON.stringify(startedEvent('hi'))}\nnot-json\n${JSON.stringify(completedEvent('ok'))}\n`,
      'utf8',
    )

    const bus = createEventBus()
    const analyzer = new RunOutcomeAnalyzer({
      eventBus: bus,
      projectDir,
      scorers: [{ scorer: makeScorer() }],
    })

    const analysis = await analyzer.analyze(runId)
    expect(analysis).not.toBeNull()
    expect(analysis?.metrics.totalEvents).toBe(2) // malformed line skipped
  })

  it('analyze: missing run directory surfaces via onError but still emits', async () => {
    const bus = createEventBus()
    const emitted = collectScoredEvents(bus)
    const errors: string[] = []
    const analyzer = new RunOutcomeAnalyzer({
      eventBus: bus,
      projectDir,
      scorers: [{ scorer: makeScorer({ score: 0.2 }) }],
      onError: (_rid, msg) => errors.push(msg),
    })

    const analysis = await analyzer.analyze('no-such-run', { input: 'i', output: 'o' })
    expect(analysis).not.toBeNull()
    expect(analysis?.score).toBeCloseTo(0.2, 5)
    expect(errors.some((m) => m.includes('normalized-events.jsonl'))).toBe(true)
    expect(emitted).toHaveLength(1)
  })

  // --- clamping & numeric safety ---

  it('analyze: clamps aggregate scores above 1 back to 1', async () => {
    await writeEvents(runDir, [completedEvent('done')])

    const bus = createEventBus()
    const analyzer = new RunOutcomeAnalyzer({
      eventBus: bus,
      projectDir,
      scorers: [{ scorer: makeScorer({ score: 2 /* out of range */ }) }],
    })

    const analysis = await analyzer.analyze(runId)
    expect(analysis?.score).toBeLessThanOrEqual(1)
    expect(analysis?.score).toBeGreaterThanOrEqual(0)
  })

  it('analyze: default threshold is 0.7 (boundary inclusive)', async () => {
    await writeEvents(runDir, [completedEvent('done')])

    const bus = createEventBus()
    const analyzer = new RunOutcomeAnalyzer({
      eventBus: bus,
      projectDir,
      scorers: [{ scorer: makeScorer({ score: 0.7 }) }],
    })

    const analysis = await analyzer.analyze(runId)
    expect(analysis?.passed).toBe(true)
  })

  it('analyze: invalid weights fall back to 1 (zero/negative treated as default)', async () => {
    await writeEvents(runDir, [completedEvent('done')])

    const bus = createEventBus()
    const analyzer = new RunOutcomeAnalyzer({
      eventBus: bus,
      projectDir,
      scorers: [
        { scorer: makeScorer({ name: 'zero', score: 0 }), weight: 0 },
        { scorer: makeScorer({ name: 'one', score: 1 }), weight: -5 },
      ],
    })

    const analysis = await analyzer.analyze(runId)
    // Both weights coerce to 1 => (0 + 1) / 2 = 0.5
    expect(analysis?.score).toBeCloseTo(0.5, 5)
  })
})

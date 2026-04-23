/**
 * Tests for {@link EnrichmentPipeline} observability + telemetry.
 *
 * Covers:
 *   - Static `metrics()` accessor returns per-phase timings.
 *   - `durationMs` is plumbed into `AgentSkillsCompiledEvent` and
 *     `AgentMemoryRecalledEvent` payloads.
 *   - Metrics reset between consecutive `apply()` invocations.
 *   - Skipping a phase omits it from the metrics snapshot.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — DzupAgentFileLoader / DzupAgentMemoryLoader are stubbed so the test
// does not touch the filesystem. Each test can override the mocked class's
// `loadSkills()` / `loadEntries()` behaviour via `mockImplementationOnce`.
// ---------------------------------------------------------------------------

const loadSkillsMock = vi.fn()
const loadEntriesMock = vi.fn()

// Captures the options passed to the DzupAgentMemoryLoader constructor so the
// test harness can invoke the `onRecalled` callback the pipeline registers.
let capturedMemoryOptions: {
  onRecalled?: (
    entries: Array<{ level: string; name: string; tokenEstimate: number }>,
    totalTokens: number,
  ) => void
} = {}

vi.mock('../dzupagent/file-loader.js', () => ({
  DzupAgentFileLoader: vi.fn().mockImplementation(() => ({
    loadSkills: loadSkillsMock,
  })),
}))

vi.mock('../dzupagent/memory-loader.js', () => ({
  DzupAgentMemoryLoader: vi.fn().mockImplementation((opts: typeof capturedMemoryOptions) => {
    capturedMemoryOptions = opts
    return {
      loadEntries: loadEntriesMock,
    }
  }),
}))

// Minimise behaviour of getMaxMemoryTokens / getCodexMemoryStrategy — both
// return deterministic values so the mocked loader construction is trivial.
vi.mock('../dzupagent/config.js', () => ({
  getMaxMemoryTokens: () => 2000,
  getCodexMemoryStrategy: () => 'inject-on-new-thread' as const,
}))

// ---------------------------------------------------------------------------
// Imports — must come AFTER vi.mock calls so the mocked modules are used.
// ---------------------------------------------------------------------------

import { EnrichmentPipeline, type EnrichmentContext } from '../enrichment/enrichment-pipeline.js'
import type {
  AgentInput,
  AgentMemoryRecalledEvent,
  AgentSkillsCompiledEvent,
  DzupAgentConfig,
  DzupAgentPaths,
} from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePaths(): DzupAgentPaths {
  return {
    globalDir: '/tmp/nonexistent/global',
    workspaceDir: undefined,
    projectDir: '/tmp/nonexistent/project',
    stateFile: '/tmp/nonexistent/project/.dzupagent/state.json',
    projectConfig: '/tmp/nonexistent/project/.dzupagent/config.json',
  }
}

function makeContext(
  overrides: Partial<EnrichmentContext> = {},
): EnrichmentContext {
  const emitted: Array<AgentSkillsCompiledEvent | AgentMemoryRecalledEvent> = []
  const emitEvent = (e: AgentSkillsCompiledEvent | AgentMemoryRecalledEvent): void => {
    emitted.push(e)
  }
  return {
    paths: makePaths(),
    dzupConfig: {} as DzupAgentConfig,
    providerId: 'claude',
    emitEvent,
    ...overrides,
  }
}

function makeSkillBundle(bundleId: string): {
  bundleId: string
  skillSetId: string
  skillSetVersion: string
  constraints: Record<string, never>
  promptSections: Array<{ id: string; purpose: 'task'; content: string; priority: number }>
  toolBindings: []
  metadata: { owner: string; createdAt: string; updatedAt: string }
} {
  return {
    bundleId,
    skillSetId: 'set-1',
    skillSetVersion: '1.0.0',
    constraints: {},
    promptSections: [
      { id: 'p-1', purpose: 'task', content: 'Do the task.', priority: 10 },
    ],
    toolBindings: [],
    metadata: { owner: 'test', createdAt: '', updatedAt: '' },
  }
}

function makeMemoryEntry(name: string): {
  name: string
  description: string
  type: 'project'
  tags: string[]
  content: string
  tokenEstimate: number
  filePath: string
} {
  return {
    name,
    description: '',
    type: 'project',
    tags: [],
    content: `memory content for ${name}`,
    tokenEstimate: 10,
    filePath: `/tmp/${name}.md`,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EnrichmentPipeline.metrics() — observability + telemetry', () => {
  beforeEach(() => {
    loadSkillsMock.mockReset()
    loadEntriesMock.mockReset()
    capturedMemoryOptions = {}
    // Default: no skills, no memory entries.
    loadSkillsMock.mockResolvedValue([])
    loadEntriesMock.mockResolvedValue([])
    // Clear metrics left over from other describe/it blocks.
    ;(EnrichmentPipeline as unknown as { _lastRunMetrics: Record<string, unknown> })._lastRunMetrics = {}
  })

  it('returns an empty object before the first run', () => {
    const snapshot = EnrichmentPipeline.metrics()
    expect(snapshot).toEqual({})
  })

  it('records a non-negative skills durationMs when skills are enabled', async () => {
    loadSkillsMock.mockResolvedValueOnce([makeSkillBundle('skill-a')])

    await EnrichmentPipeline.apply({ prompt: 'hi' } as AgentInput, makeContext())

    const snap = EnrichmentPipeline.metrics()
    expect(snap.skills).toBeDefined()
    expect(typeof snap.skills?.durationMs).toBe('number')
    expect(snap.skills!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('records a non-negative memory durationMs when memory is enabled', async () => {
    loadEntriesMock.mockResolvedValueOnce([makeMemoryEntry('m-1')])

    await EnrichmentPipeline.apply({ prompt: 'hi' } as AgentInput, makeContext())

    const snap = EnrichmentPipeline.metrics()
    expect(snap.memory).toBeDefined()
    expect(typeof snap.memory?.durationMs).toBe('number')
    expect(snap.memory!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('always populates promptShaping durationMs after a run', async () => {
    loadSkillsMock.mockResolvedValueOnce([makeSkillBundle('s-1')])

    await EnrichmentPipeline.apply({ prompt: 'hi' } as AgentInput, makeContext())

    const snap = EnrichmentPipeline.metrics()
    expect(snap.promptShaping).toBeDefined()
    expect(typeof snap.promptShaping?.durationMs).toBe('number')
    expect(snap.promptShaping!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('emits AgentSkillsCompiledEvent payload with durationMs', async () => {
    loadSkillsMock.mockResolvedValueOnce([makeSkillBundle('skill-z')])

    const emitted: Array<AgentSkillsCompiledEvent | AgentMemoryRecalledEvent> = []
    const ctx = makeContext({ emitEvent: (e) => emitted.push(e) })

    await EnrichmentPipeline.apply({ prompt: 'hello' } as AgentInput, ctx)

    const skillsEvents = emitted.filter(
      (e): e is AgentSkillsCompiledEvent => e.type === 'adapter:skills_compiled',
    )
    expect(skillsEvents).toHaveLength(1)
    expect(skillsEvents[0]!.durationMs).toBeGreaterThanOrEqual(0)
    expect(typeof skillsEvents[0]!.durationMs).toBe('number')
  })

  it('emits AgentMemoryRecalledEvent payload with durationMs', async () => {
    // The memory-loader mock triggers onRecalled via the captured options.
    loadEntriesMock.mockImplementationOnce(async () => {
      if (capturedMemoryOptions.onRecalled) {
        capturedMemoryOptions.onRecalled(
          [{ level: 'project', name: 'm-1', tokenEstimate: 10 }],
          10,
        )
      }
      return [makeMemoryEntry('m-1')]
    })

    const emitted: Array<AgentSkillsCompiledEvent | AgentMemoryRecalledEvent> = []
    const ctx = makeContext({ emitEvent: (e) => emitted.push(e) })

    await EnrichmentPipeline.apply({ prompt: 'hello' } as AgentInput, ctx)

    const memoryEvents = emitted.filter(
      (e): e is AgentMemoryRecalledEvent => e.type === 'adapter:memory_recalled',
    )
    expect(memoryEvents).toHaveLength(1)
    expect(memoryEvents[0]!.durationMs).toBeGreaterThanOrEqual(0)
    expect(typeof memoryEvents[0]!.durationMs).toBe('number')
  })

  it('resets metrics between consecutive apply() calls — skipped phases do not bleed', async () => {
    // First run: skills + memory enabled, both populate.
    loadSkillsMock.mockResolvedValueOnce([makeSkillBundle('s-a')])
    loadEntriesMock.mockResolvedValueOnce([makeMemoryEntry('m-a')])

    await EnrichmentPipeline.apply({ prompt: 'run-1' } as AgentInput, makeContext())

    const firstSnap = EnrichmentPipeline.metrics()
    expect(firstSnap.skills).toBeDefined()
    expect(firstSnap.memory).toBeDefined()

    // Second run: skip skills and memory — their metrics MUST NOT leak over.
    await EnrichmentPipeline.apply(
      { prompt: 'run-2' } as AgentInput,
      makeContext({ skipSkills: true, skipMemory: true }),
    )

    const secondSnap = EnrichmentPipeline.metrics()
    expect(secondSnap.skills).toBeUndefined()
    expect(secondSnap.memory).toBeUndefined()
    // promptShaping always runs — even with an undefined systemPrompt —
    // so its timing is still populated on the second call.
    expect(secondSnap.promptShaping).toBeDefined()
  })

  it('records durationMs as finite, non-negative numbers (not NaN, not negative)', async () => {
    loadSkillsMock.mockResolvedValueOnce([makeSkillBundle('s-x')])
    loadEntriesMock.mockResolvedValueOnce([makeMemoryEntry('m-x')])

    await EnrichmentPipeline.apply({ prompt: 'check' } as AgentInput, makeContext())

    const snap = EnrichmentPipeline.metrics()
    for (const phase of ['skills', 'memory', 'promptShaping'] as const) {
      const d = snap[phase]?.durationMs
      expect(d).toBeTypeOf('number')
      expect(Number.isFinite(d)).toBe(true)
      expect(Number.isNaN(d)).toBe(false)
      expect(d).toBeGreaterThanOrEqual(0)
    }
  })

  it('omits metrics.skills when skipSkills is true', async () => {
    await EnrichmentPipeline.apply(
      { prompt: 'skip-skills' } as AgentInput,
      makeContext({ skipSkills: true }),
    )

    const snap = EnrichmentPipeline.metrics()
    expect(snap.skills).toBeUndefined()
    // The other phases still execute.
    expect(snap.promptShaping).toBeDefined()
  })

  it('omits metrics.memory when skipMemory is true', async () => {
    await EnrichmentPipeline.apply(
      { prompt: 'skip-memory' } as AgentInput,
      makeContext({ skipMemory: true }),
    )

    const snap = EnrichmentPipeline.metrics()
    expect(snap.memory).toBeUndefined()
    expect(snap.promptShaping).toBeDefined()
  })

  it('returns an independent snapshot — mutating the returned object does not mutate internal state', async () => {
    loadSkillsMock.mockResolvedValueOnce([makeSkillBundle('s-iso')])

    await EnrichmentPipeline.apply({ prompt: 'iso' } as AgentInput, makeContext())

    const snap = EnrichmentPipeline.metrics()
    // Mutate the returned object — a second call should not reflect the mutation.
    ;(snap as { skills?: { durationMs: number } }).skills = { durationMs: 9999 }

    const freshSnap = EnrichmentPipeline.metrics()
    expect(freshSnap.skills?.durationMs).not.toBe(9999)
  })
})

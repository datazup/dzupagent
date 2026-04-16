import { describe, expect, it, vi } from 'vitest'

import { withMemoryEnrichment, withHierarchicalMemoryEnrichment, type MemoryServiceLike, type HierarchicalMemoryEnrichmentOptions } from '../middleware/memory-enrichment.js'
import type { AgentCLIAdapter, AgentEvent, AgentInput } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(partial: Partial<AgentEvent> & { type: AgentEvent['type'] }): AgentEvent {
  return partial as AgentEvent
}

function makeStartedEvent(): AgentEvent {
  return makeEvent({
    type: 'adapter:started',
    providerId: 'claude',
    sessionId: 'sess-1',
    prompt: 'test',
    isResume: false,
    timestamp: Date.now(),
  })
}

function makeCompletedEvent(): AgentEvent {
  return makeEvent({
    type: 'adapter:completed',
    providerId: 'claude',
    sessionId: 'sess-1',
    result: 'done',
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0,
    durationMs: 100,
    timestamp: Date.now(),
  })
}

/** Create a fake adapter that captures the AgentInput passed to execute(). */
function makeCaptureAdapter(): {
  adapter: AgentCLIAdapter
  capturedInputs: AgentInput[]
} {
  const capturedInputs: AgentInput[] = []

  const adapter: AgentCLIAdapter = {
    providerId: 'claude',

    getCapabilities: () => ({
      supportsResume: true,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: true,
    }),

    configure: () => {},
    interrupt: () => {},
    healthCheck: async () => ({ healthy: true, providerId: 'claude', sdkInstalled: true, cliAvailable: false }),

    async *execute(input: AgentInput) {
      capturedInputs.push(input)
      yield makeStartedEvent()
      yield makeCompletedEvent()
    },

    async *resumeSession(_sessionId: string, input: AgentInput) {
      capturedInputs.push(input)
      yield makeStartedEvent()
      yield makeCompletedEvent()
    },
  }

  return { adapter, capturedInputs }
}

function makeMemoryService(records: Record<string, unknown>[]): MemoryServiceLike {
  return {
    search: vi.fn().mockResolvedValue(records),
  }
}

async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const e of gen) events.push(e)
  return events
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('withMemoryEnrichment', () => {
  it('delegates providerId from wrapped adapter', () => {
    const { adapter } = makeCaptureAdapter()
    const enriched = withMemoryEnrichment(adapter, {
      memoryService: makeMemoryService([]),
      namespace: 'ctx',
      scope: {},
    })
    expect(enriched.providerId).toBe('claude')
  })

  it('delegates getCapabilities from wrapped adapter', () => {
    const { adapter } = makeCaptureAdapter()
    const enriched = withMemoryEnrichment(adapter, {
      memoryService: makeMemoryService([]),
      namespace: 'ctx',
      scope: {},
    })
    expect(enriched.getCapabilities().supportsResume).toBe(true)
  })

  it('passes input unchanged when no memories are recalled', async () => {
    const { adapter, capturedInputs } = makeCaptureAdapter()
    const enriched = withMemoryEnrichment(adapter, {
      memoryService: makeMemoryService([]),
      namespace: 'ctx',
      scope: {},
    })

    await collectEvents(enriched.execute({ prompt: 'Hello' }))

    expect(capturedInputs).toHaveLength(1)
    expect(capturedInputs[0]?.systemPrompt).toBeUndefined()
  })

  it('injects recalled memory into systemPrompt (text field)', async () => {
    const { adapter, capturedInputs } = makeCaptureAdapter()
    const enriched = withMemoryEnrichment(adapter, {
      memoryService: makeMemoryService([
        { text: 'User prefers TypeScript over JavaScript.' },
        { text: 'Project uses Vitest for testing.' },
      ]),
      namespace: 'ctx',
      scope: { tenantId: 'acme' },
    })

    await collectEvents(enriched.execute({ prompt: 'How to test?' }))

    const systemPrompt = capturedInputs[0]?.systemPrompt ?? ''
    expect(systemPrompt).toContain('## Recalled context')
    expect(systemPrompt).toContain('User prefers TypeScript over JavaScript.')
    expect(systemPrompt).toContain('Project uses Vitest for testing.')
  })

  it('appends memory block to existing systemPrompt', async () => {
    const { adapter, capturedInputs } = makeCaptureAdapter()
    const enriched = withMemoryEnrichment(adapter, {
      memoryService: makeMemoryService([{ text: 'Memory snippet.' }]),
      namespace: 'ctx',
      scope: {},
    })

    await collectEvents(enriched.execute({ prompt: 'Go', systemPrompt: 'Be concise.' }))

    const sp = capturedInputs[0]?.systemPrompt ?? ''
    expect(sp).toContain('Be concise.')
    expect(sp).toContain('Memory snippet.')
    expect(sp.indexOf('Be concise.')).toBeLessThan(sp.indexOf('Memory snippet.'))
  })

  it('uses custom header when provided', async () => {
    const { adapter, capturedInputs } = makeCaptureAdapter()
    const enriched = withMemoryEnrichment(adapter, {
      memoryService: makeMemoryService([{ text: 'A fact.' }]),
      namespace: 'ctx',
      scope: {},
      header: '## My Custom Header\n',
    })

    await collectEvents(enriched.execute({ prompt: 'Test' }))

    expect(capturedInputs[0]?.systemPrompt).toContain('## My Custom Header')
  })

  it('uses custom formatRecord when provided', async () => {
    const { adapter, capturedInputs } = makeCaptureAdapter()
    const enriched = withMemoryEnrichment(adapter, {
      memoryService: makeMemoryService([{ id: '42', note: 'Custom note here.' }]),
      namespace: 'ctx',
      scope: {},
      formatRecord: (r) => `[${r['id']}] ${r['note']}`,
    })

    await collectEvents(enriched.execute({ prompt: 'Test' }))

    expect(capturedInputs[0]?.systemPrompt).toContain('[42] Custom note here.')
  })

  it('passes search scope and limit to memoryService', async () => {
    const mockSearch = vi.fn().mockResolvedValue([])
    const ms: MemoryServiceLike = { search: mockSearch }
    const { adapter } = makeCaptureAdapter()

    const enriched = withMemoryEnrichment(adapter, {
      memoryService: ms,
      namespace: 'decisions',
      scope: { tenantId: 'acme', projectId: 'proj-1' },
      limit: 3,
    })

    await collectEvents(enriched.execute({ prompt: 'Test query' }))

    expect(mockSearch).toHaveBeenCalledWith('decisions', { tenantId: 'acme', projectId: 'proj-1' }, 'Test query', 3)
  })

  it('is non-fatal: continues on memory recall error', async () => {
    const failingMs: MemoryServiceLike = {
      search: vi.fn().mockRejectedValue(new Error('DB unavailable')),
    }
    const { adapter, capturedInputs } = makeCaptureAdapter()
    const onRecallError = vi.fn()

    const enriched = withMemoryEnrichment(adapter, {
      memoryService: failingMs,
      namespace: 'ctx',
      scope: {},
      onRecallError,
    })

    const events = await collectEvents(enriched.execute({ prompt: 'Test' }))

    expect(events).toHaveLength(2) // still gets started + completed
    expect(capturedInputs[0]?.systemPrompt).toBeUndefined() // no enrichment
    expect(onRecallError).toHaveBeenCalledWith(expect.any(Error))
  })

  it('enriches resumeSession the same way as execute', async () => {
    const { adapter, capturedInputs } = makeCaptureAdapter()
    const enriched = withMemoryEnrichment(adapter, {
      memoryService: makeMemoryService([{ text: 'Resume fact.' }]),
      namespace: 'ctx',
      scope: {},
    })

    await collectEvents(enriched.resumeSession('sess-abc', { prompt: 'Continue' }))

    const sp = capturedInputs[0]?.systemPrompt ?? ''
    expect(sp).toContain('Resume fact.')
  })

  it('delegates interrupt to wrapped adapter', () => {
    const interruptSpy = vi.fn()
    const { adapter } = makeCaptureAdapter()
    ;(adapter as { interrupt: typeof adapter.interrupt }).interrupt = interruptSpy

    const enriched = withMemoryEnrichment(adapter, {
      memoryService: makeMemoryService([]),
      namespace: 'ctx',
      scope: {},
    })
    enriched.interrupt()

    expect(interruptSpy).toHaveBeenCalledOnce()
  })

  it('delegates healthCheck to wrapped adapter', async () => {
    const { adapter } = makeCaptureAdapter()
    const enriched = withMemoryEnrichment(adapter, {
      memoryService: makeMemoryService([]),
      namespace: 'ctx',
      scope: {},
    })
    const health = await enriched.healthCheck()
    expect(health.healthy).toBe(true)
  })

  it('falls back to JSON stringify for records with no text field', async () => {
    const { adapter, capturedInputs } = makeCaptureAdapter()
    const enriched = withMemoryEnrichment(adapter, {
      memoryService: makeMemoryService([{ key: 'val', num: 42 }]),
      namespace: 'ctx',
      scope: {},
    })

    await collectEvents(enriched.execute({ prompt: 'Test' }))

    expect(capturedInputs[0]?.systemPrompt).toContain('"key":"val"')
  })
})

// ---------------------------------------------------------------------------
// Hierarchical Memory Enrichment Tests
// ---------------------------------------------------------------------------

describe('withHierarchicalMemoryEnrichment', () => {
  it('merges records from multiple sources into systemPrompt', async () => {
    const { adapter, capturedInputs } = makeCaptureAdapter()
    const enriched = withHierarchicalMemoryEnrichment(adapter, {
      sources: [
        { level: 'global', loader: makeMemoryService([{ text: 'Global rule: be polite.' }]) },
        { level: 'project', loader: makeMemoryService([{ text: 'Project uses Vitest.' }]) },
      ],
    })

    await collectEvents(enriched.execute({ prompt: 'Hello' }))

    const sp = capturedInputs[0]?.systemPrompt ?? ''
    expect(sp).toContain('## Project Context')
    expect(sp).toContain('Global rule: be polite.')
    expect(sp).toContain('Project uses Vitest.')
  })

  it('skips sources with skip: true', async () => {
    const { adapter, capturedInputs } = makeCaptureAdapter()
    const skippedLoader = makeMemoryService([{ text: 'Should not appear.' }])

    const enriched = withHierarchicalMemoryEnrichment(adapter, {
      sources: [
        { level: 'global', loader: makeMemoryService([{ text: 'Included.' }]) },
        { level: 'workspace', loader: skippedLoader, skip: true },
      ],
    })

    await collectEvents(enriched.execute({ prompt: 'Test' }))

    const sp = capturedInputs[0]?.systemPrompt ?? ''
    expect(sp).toContain('Included.')
    expect(sp).not.toContain('Should not appear.')
    expect(skippedLoader.search).not.toHaveBeenCalled()
  })

  it('enforces maxTotalTokens budget with whole-record truncation', async () => {
    const { adapter, capturedInputs } = makeCaptureAdapter()
    // Each record text ~20 chars => ~5 tokens each
    const enriched = withHierarchicalMemoryEnrichment(adapter, {
      sources: [
        { level: 'global', loader: makeMemoryService([{ text: 'AAAA BBBB CCCC DDDD' }]) },   // ~5 tokens
        { level: 'workspace', loader: makeMemoryService([{ text: 'EEEE FFFF GGGG HHHH' }]) }, // ~5 tokens
        { level: 'project', loader: makeMemoryService([{ text: 'IIII JJJJ KKKK LLLL' }]) },   // ~5 tokens
      ],
      maxTotalTokens: 10, // allows only ~2 sources
    })

    await collectEvents(enriched.execute({ prompt: 'Test' }))

    const sp = capturedInputs[0]?.systemPrompt ?? ''
    expect(sp).toContain('AAAA BBBB CCCC DDDD')
    expect(sp).toContain('EEEE FFFF GGGG HHHH')
    expect(sp).not.toContain('IIII JJJJ KKKK LLLL')
  })

  it('calls onRecalled with correct metadata', async () => {
    const { adapter } = makeCaptureAdapter()
    const onRecalled = vi.fn()

    const enriched = withHierarchicalMemoryEnrichment(adapter, {
      sources: [
        { level: 'global', loader: makeMemoryService([{ name: 'rule-1', text: 'Be polite.' }]) },
        { level: 'agent', loader: makeMemoryService([{ key: 'pref-1', text: 'Use TS.' }]) },
      ],
      onRecalled,
    })

    await collectEvents(enriched.execute({ prompt: 'Test' }))

    expect(onRecalled).toHaveBeenCalledOnce()
    const [entries, totalTokens] = onRecalled.mock.calls[0] as [
      Array<{ level: string; name: string; tokenEstimate: number }>,
      number,
    ]
    expect(entries).toHaveLength(2)
    expect(entries[0]?.level).toBe('global')
    expect(entries[0]?.name).toBe('rule-1')
    expect(entries[0]?.tokenEstimate).toBeGreaterThan(0)
    expect(entries[1]?.level).toBe('agent')
    expect(entries[1]?.name).toBe('pref-1')
    expect(totalTokens).toBe(entries[0]!.tokenEstimate + entries[1]!.tokenEstimate)
  })

  it('isolates source errors — other sources still load', async () => {
    const { adapter, capturedInputs } = makeCaptureAdapter()
    const onRecallError = vi.fn()
    const failingLoader: MemoryServiceLike = {
      search: vi.fn().mockRejectedValue(new Error('DB down')),
    }

    const enriched = withHierarchicalMemoryEnrichment(adapter, {
      sources: [
        { level: 'global', loader: failingLoader },
        { level: 'project', loader: makeMemoryService([{ text: 'Surviving record.' }]) },
      ],
      onRecallError,
    })

    const events = await collectEvents(enriched.execute({ prompt: 'Test' }))

    expect(events).toHaveLength(2)
    expect(onRecallError).toHaveBeenCalledWith(expect.any(Error))
    const sp = capturedInputs[0]?.systemPrompt ?? ''
    expect(sp).toContain('Surviving record.')
  })

  it('delegates providerId from wrapped adapter', () => {
    const { adapter } = makeCaptureAdapter()
    const enriched = withHierarchicalMemoryEnrichment(adapter, { sources: [] })
    expect(enriched.providerId).toBe('claude')
  })

  it('enriches resumeSession the same way as execute', async () => {
    const { adapter, capturedInputs } = makeCaptureAdapter()
    const enriched = withHierarchicalMemoryEnrichment(adapter, {
      sources: [
        { level: 'project', loader: makeMemoryService([{ text: 'Resume context.' }]) },
      ],
    })

    await collectEvents(enriched.resumeSession('sess-resume', { prompt: 'Continue' }))

    const sp = capturedInputs[0]?.systemPrompt ?? ''
    expect(sp).toContain('Resume context.')
  })
})

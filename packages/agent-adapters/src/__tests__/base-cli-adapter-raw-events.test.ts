import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BaseCliAdapter } from '../base/base-cli-adapter.js'
import { RunEventStore } from '../runs/run-event-store.js'
import { runLogRoot } from '../runs/run-log-root.js'
import type { AdapterProviderId, AgentEvent, AgentStreamEvent, AgentInput, RawAgentEvent } from '../types.js'
import { collectEvents, getProcessHelperMocks } from './test-helpers.js'

// ---------------------------------------------------------------------------
// Module-level mock — must precede the SUT import that resolves process-helpers
// ---------------------------------------------------------------------------

vi.mock('../utils/process-helpers.js', () => ({
  isBinaryAvailable: vi.fn().mockResolvedValue(true),
  spawnAndStreamJsonl: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Minimal concrete subclass — provider id is configurable so we can exercise
// the codex guard with the same mapping logic.
// ---------------------------------------------------------------------------

class TestCliAdapter extends BaseCliAdapter {
  constructor(providerId: AdapterProviderId = 'gemini') {
    super(providerId)
  }

  protected getBinaryName(): string {
    return 'test-bin'
  }

  protected buildArgs(input: AgentInput): string[] {
    return ['--prompt', input.prompt]
  }

  protected mapProviderEvent(
    record: Record<string, unknown>,
    sessionId: string,
  ): AgentEvent | undefined {
    if (record['type'] === 'completed') {
      return {
        type: 'adapter:completed',
        providerId: this.providerId,
        sessionId,
        result: String(record['result'] ?? 'done'),
        durationMs: 0,
        timestamp: Date.now(),
      }
    }
    if (record['type'] === 'message') {
      return {
        type: 'adapter:message',
        providerId: this.providerId,
        sessionId,
        content: String(record['content'] ?? ''),
        timestamp: Date.now(),
      }
    }
    // 'noise' records map to nothing — exercises the no-normalized-event path.
    return undefined
  }
}

async function collectRaw(
  gen: AsyncGenerator<AgentStreamEvent, void, undefined>,
): Promise<AgentStreamEvent[]> {
  return collectEvents(gen)
}

function rawEventsOf(events: AgentStreamEvent[]): RawAgentEvent[] {
  return events
    .filter((e): e is Extract<AgentStreamEvent, { type: 'adapter:provider_raw' }> =>
      e.type === 'adapter:provider_raw',
    )
    .map((e) => e.rawEvent)
}

// ---------------------------------------------------------------------------

describe('BaseCliAdapter — adapter:provider_raw emission', () => {
  const { mockSpawnAndStreamJsonl } = getProcessHelperMocks()
  const cleanup: string[] = []

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    for (const dir of cleanup.splice(0)) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  async function makeTmpDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'cli-raw-events-test-'))
    cleanup.push(dir)
    return dir
  }

  // -------------------------------------------------------------------------
  // 1. Non-Codex CLI adapter emits a raw event per processed record
  // -------------------------------------------------------------------------

  it('emits adapter:provider_raw for every raw record a non-Codex CLI adapter processes', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'message', content: 'thinking…' }
      yield { type: 'completed', result: 'all good' }
    })

    const adapter = new TestCliAdapter('gemini')
    const events = await collectRaw(adapter.executeWithRaw({ prompt: 'do the thing' }))

    const raw = rawEventsOf(events)
    expect(raw).toHaveLength(2)
    expect(raw[0]).toMatchObject({
      providerId: 'gemini',
      source: 'stdout',
      payload: { type: 'message', content: 'thinking…' },
    })
    expect(raw[1]).toMatchObject({
      providerId: 'gemini',
      payload: { type: 'completed', result: 'all good' },
    })
    // Each raw event carries a distinct, stable provider event id.
    expect(raw[0]?.providerEventId).not.toBe(raw[1]?.providerEventId)
  })

  it('orders each adapter:provider_raw immediately before the record’s normalized event', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'message', content: 'hi' }
      yield { type: 'completed', result: 'ok' }
    })

    const adapter = new TestCliAdapter('qwen')
    const events = await collectRaw(adapter.executeWithRaw({ prompt: 'order test' }))
    const types = events.map((e) => e.type)

    // started, raw(message), message, raw(completed), completed
    expect(types).toEqual([
      'adapter:started',
      'adapter:provider_raw',
      'adapter:message',
      'adapter:provider_raw',
      'adapter:completed',
    ])
  })

  it('emits a raw event even for records that produce no normalized event', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'noise', detail: 'unmapped' }
      yield { type: 'completed', result: 'done' }
    })

    const adapter = new TestCliAdapter('qwen')
    const events = await collectRaw(adapter.executeWithRaw({ prompt: 'noise test' }))

    const raw = rawEventsOf(events)
    expect(raw).toHaveLength(2)
    expect(raw.map((r) => (r.payload as { type: string }).type)).toEqual(['noise', 'completed'])
  })

  it('propagates correlationId onto raw events', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'completed', result: 'done' }
    })

    const adapter = new TestCliAdapter('gemini')
    const events = await collectRaw(
      adapter.executeWithRaw({ prompt: 'corr test', correlationId: 'corr-123' }),
    )

    const raw = rawEventsOf(events)
    expect(raw).toHaveLength(1)
    expect(raw[0]?.correlationId).toBe('corr-123')
  })

  // -------------------------------------------------------------------------
  // 2. execute() (normalized-only) never surfaces raw events
  // -------------------------------------------------------------------------

  it('execute() filters out adapter:provider_raw events', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'message', content: 'hi' }
      yield { type: 'completed', result: 'ok' }
    })

    const adapter = new TestCliAdapter('gemini')
    const events = await collectEvents(adapter.execute({ prompt: 'normalized only' }))

    expect(events.some((e) => e.type === 'adapter:provider_raw')).toBe(false)
    expect(events.some((e) => e.type === 'adapter:completed')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // 3. Codex provider does NOT double-emit via the CLI raw channel
  // -------------------------------------------------------------------------

  it('does NOT emit adapter:provider_raw for the codex provider (own raw channel)', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'message', content: 'thinking…' }
      yield { type: 'completed', result: 'all good' }
    })

    const adapter = new TestCliAdapter('codex')
    const events = await collectRaw(adapter.executeWithRaw({ prompt: 'codex run' }))

    expect(rawEventsOf(events)).toHaveLength(0)
    // Normalized events still flow as usual.
    expect(events.some((e) => e.type === 'adapter:completed')).toBe(true)
  })

  it('does NOT persist raw events to the run store for the codex provider', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'message', content: 'hi' }
      yield { type: 'completed', result: 'ok' }
    })

    const projectDir = await makeTmpDir()
    const runId = 'codex-run'
    const store = new RunEventStore({ runId, projectDir })
    await store.open()
    const appendSpy = vi.spyOn(store, 'appendRaw')

    const adapter = new TestCliAdapter('codex')
    adapter.setRunStore(store)
    await collectRaw(adapter.executeWithRaw({ prompt: 'codex persist test' }))

    expect(appendSpy).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 4. Persistence via RunEventStore
  // -------------------------------------------------------------------------

  it('persists every raw event to raw-events.jsonl via the attached RunEventStore', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'message', content: 'step 1' }
      yield { type: 'message', content: 'step 2' }
      yield { type: 'completed', result: 'done' }
    })

    const projectDir = await makeTmpDir()
    const runId = 'gemini-persist-run'
    const store = new RunEventStore({ runId, projectDir })
    await store.open()

    const adapter = new TestCliAdapter('gemini')
    adapter.setRunStore(store)
    // correlationId becomes the adapter run-context id stamped on each raw event.
    await collectRaw(
      adapter.executeWithRaw({ prompt: 'persist test', correlationId: 'run-ctx-1' }),
    )

    const filePath = join(runLogRoot(projectDir, runId), 'raw-events.jsonl')
    const content = await readFile(filePath, 'utf8')
    const lines = content.trim().split('\n').filter(Boolean)

    expect(lines).toHaveLength(3)
    const payloads = lines.map((l) => (JSON.parse(l) as RawAgentEvent).payload as { type: string })
    expect(payloads.map((p) => p.type)).toEqual(['message', 'message', 'completed'])

    const first = JSON.parse(lines[0]!) as RawAgentEvent
    expect(first.providerId).toBe('gemini')
    expect(first.runId).toBe('run-ctx-1')
    expect(first.correlationId).toBe('run-ctx-1')
    expect(first.source).toBe('stdout')
  })

  it('is a no-op (no throw) when no run store is attached', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'completed', result: 'done' }
    })

    const adapter = new TestCliAdapter('gemini')
    // No setRunStore() call — raw events still emit live but are not persisted.
    const events = await collectRaw(adapter.executeWithRaw({ prompt: 'no store' }))

    expect(rawEventsOf(events)).toHaveLength(1)
  })
})

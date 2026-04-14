import { describe, it, expect, vi, beforeEach } from 'vitest'

import { GeminiCLIAdapter } from '../gemini/gemini-adapter.js'
import { QwenAdapter } from '../qwen/qwen-adapter.js'
import { CrushAdapter } from '../crush/crush-adapter.js'
import type { AgentEvent, AgentCLIAdapter, AgentProgressEvent, AgentStartedEvent } from '../types.js'
import { collectEvents, getProcessHelperMocks, loadJsonFixture } from './test-helpers.js'
import { assertDeterministicAdapterFixtureShape } from './fixture-schema-helpers.js'

vi.mock('../utils/process-helpers.js', () => ({
  isBinaryAvailable: vi.fn().mockResolvedValue(true),
  spawnAndStreamJsonl: vi.fn(),
}))

function fixtureRecords(name: string): Record<string, unknown>[] {
  return loadJsonFixture<Record<string, unknown>[]>(
    import.meta.url,
    `fixtures/${name}.json`,
  )
}

function normalizeEvent(event: AgentEvent): Record<string, unknown> {
  switch (event.type) {
    case 'adapter:started':
      return { type: event.type, providerId: event.providerId }
    case 'adapter:message':
      return { type: event.type, providerId: event.providerId, role: event.role, content: event.content }
    case 'adapter:tool_call':
      return { type: event.type, providerId: event.providerId, toolName: event.toolName, input: event.input }
    case 'adapter:tool_result':
      return {
        type: event.type,
        providerId: event.providerId,
        toolName: event.toolName,
        output: event.output,
        durationMs: event.durationMs,
      }
    case 'adapter:stream_delta':
      return { type: event.type, providerId: event.providerId, content: event.content }
    case 'adapter:completed':
      return {
        type: event.type,
        providerId: event.providerId,
        result: event.result,
        durationMs: event.durationMs,
      }
    case 'adapter:failed':
      return {
        type: event.type,
        providerId: event.providerId,
        error: event.error,
        code: event.code,
      }
    case 'recovery:cancelled':
      return {
        type: event.type,
        providerId: event.providerId,
        strategy: event.strategy,
        error: event.error,
        totalAttempts: event.totalAttempts,
        totalDurationMs: event.totalDurationMs,
      }
    case 'adapter:progress':
      return {
        type: event.type,
        providerId: event.providerId,
        phase: event.phase,
        current: event.current,
        total: event.total,
        message: event.message,
      }
    default: {
      const _exhaustive: never = event
      return _exhaustive
    }
  }
}

describe('Adapter event contracts (fixture-based)', () => {
  const { mockIsBinaryAvailable, mockSpawnAndStreamJsonl } = getProcessHelperMocks()

  beforeEach(() => {
    vi.clearAllMocks()
    mockIsBinaryAvailable.mockResolvedValue(true)
  })

  const cases: Array<{
    fixture: string
    adapter: AgentCLIAdapter
    expected: Array<Record<string, unknown>>
  }> = [
    {
      fixture: 'gemini-events',
      adapter: new GeminiCLIAdapter(),
      expected: [
        { type: 'adapter:started', providerId: 'gemini' },
        { type: 'adapter:message', providerId: 'gemini', role: 'assistant', content: 'hello from gemini' },
        { type: 'adapter:tool_call', providerId: 'gemini', toolName: 'search', input: { query: 'dzip' } },
        { type: 'adapter:tool_result', providerId: 'gemini', toolName: 'search', output: '{"hits":2}', durationMs: 15 },
        { type: 'adapter:stream_delta', providerId: 'gemini', content: 'part-1' },
        { type: 'adapter:completed', providerId: 'gemini', result: 'gemini done', durationMs: 101 },
      ],
    },
    {
      fixture: 'gemini-error-events',
      adapter: new GeminiCLIAdapter(),
      expected: [
        { type: 'adapter:started', providerId: 'gemini' },
        { type: 'adapter:failed', providerId: 'gemini', error: 'gemini failed', code: 'GEMINI_ERR' },
        { type: 'adapter:completed', providerId: 'gemini', result: 'gemini recovered', durationMs: 33 },
      ],
    },
    {
      fixture: 'qwen-events',
      adapter: new QwenAdapter(),
      expected: [
        { type: 'adapter:started', providerId: 'qwen' },
        { type: 'adapter:message', providerId: 'qwen', role: 'assistant', content: 'hello from qwen' },
        { type: 'adapter:tool_call', providerId: 'qwen', toolName: 'search', input: { query: 'dzip' } },
        { type: 'adapter:tool_result', providerId: 'qwen', toolName: 'search', output: '{"hits":3}', durationMs: 19 },
        { type: 'adapter:stream_delta', providerId: 'qwen', content: 'qwen part' },
        { type: 'adapter:completed', providerId: 'qwen', result: 'qwen done', durationMs: 202 },
      ],
    },
    {
      fixture: 'qwen-error-events',
      adapter: new QwenAdapter(),
      expected: [
        { type: 'adapter:started', providerId: 'qwen' },
        { type: 'adapter:failed', providerId: 'qwen', error: 'qwen failed', code: 'QWEN_ERR' },
        { type: 'adapter:completed', providerId: 'qwen', result: 'qwen recovered', durationMs: 44 },
      ],
    },
    {
      fixture: 'crush-events',
      adapter: new CrushAdapter(),
      expected: [
        { type: 'adapter:started', providerId: 'crush' },
        { type: 'adapter:message', providerId: 'crush', role: 'assistant', content: 'hello from crush' },
        { type: 'adapter:tool_call', providerId: 'crush', toolName: 'bash', input: { cmd: 'pwd' } },
        { type: 'adapter:tool_result', providerId: 'crush', toolName: 'bash', output: 'ok', durationMs: 8 },
        { type: 'adapter:stream_delta', providerId: 'crush', content: 'crush part' },
        { type: 'adapter:completed', providerId: 'crush', result: 'crush done', durationMs: 303 },
      ],
    },
    {
      fixture: 'crush-error-events',
      adapter: new CrushAdapter(),
      expected: [
        { type: 'adapter:started', providerId: 'crush' },
        { type: 'adapter:failed', providerId: 'crush', error: 'crush failed', code: 'CRUSH_ERR' },
        { type: 'adapter:completed', providerId: 'crush', result: 'crush recovered', durationMs: 55 },
      ],
    },
  ]

  for (const testCase of cases) {
    it(`normalizes records for ${testCase.fixture}`, async () => {
      const records = fixtureRecords(testCase.fixture)
      assertDeterministicAdapterFixtureShape(testCase.fixture, records)
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        for (const record of records) {
          yield record
        }
      })

      const events = await collectEvents(testCase.adapter.execute({ prompt: 'contract-check' }))
      expect(events.map(normalizeEvent)).toEqual(testCase.expected)
    })
  }

  const unknownEventCases: Array<{
    provider: string
    adapter: AgentCLIAdapter
    records: Record<string, unknown>[]
    expected: Array<Record<string, unknown>>
  }> = [
    {
      provider: 'gemini',
      adapter: new GeminiCLIAdapter(),
      records: [
        { type: 'unknown_event', payload: 'ignored' },
        { type: 'error', error: { message: 'gemini failed', code: 'GEMINI_ERR' } },
        { type: 'completed', output: 'gemini recovered', duration_ms: 33 },
      ],
      expected: [
        { type: 'adapter:started', providerId: 'gemini' },
        { type: 'adapter:failed', providerId: 'gemini', error: 'gemini failed', code: 'GEMINI_ERR' },
        { type: 'adapter:completed', providerId: 'gemini', result: 'gemini recovered', durationMs: 33 },
      ],
    },
    {
      provider: 'qwen',
      adapter: new QwenAdapter(),
      records: [
        { type: 'unknown_event', payload: 'ignored' },
        { type: 'error', error: { message: 'qwen failed', code: 'QWEN_ERR' } },
        { type: 'completed', content: 'qwen recovered', duration_ms: 44 },
      ],
      expected: [
        { type: 'adapter:started', providerId: 'qwen' },
        { type: 'adapter:failed', providerId: 'qwen', error: 'qwen failed', code: 'QWEN_ERR' },
        { type: 'adapter:completed', providerId: 'qwen', result: 'qwen recovered', durationMs: 44 },
      ],
    },
    {
      provider: 'crush',
      adapter: new CrushAdapter(),
      records: [
        { type: 'unknown_event', payload: 'ignored' },
        { type: 'error', error: { message: 'crush failed', code: 'CRUSH_ERR' } },
        { type: 'completed', output: 'crush recovered', duration_ms: 55 },
      ],
      expected: [
        { type: 'adapter:started', providerId: 'crush' },
        { type: 'adapter:failed', providerId: 'crush', error: 'crush failed', code: 'CRUSH_ERR' },
        { type: 'adapter:completed', providerId: 'crush', result: 'crush recovered', durationMs: 55 },
      ],
    },
  ]

  for (const testCase of unknownEventCases) {
    it(`ignores unknown ${testCase.provider} events without dropping known records`, async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        for (const record of testCase.records) {
          yield record
        }
      })

      const events = await collectEvents(testCase.adapter.execute({ prompt: 'unknown-event-check' }))
      expect(events.map(normalizeEvent)).toEqual(testCase.expected)
    })
  }

  describe('AgentStartedEvent input capture (E1)', () => {
    it('started event includes prompt, model, and workingDirectory fields', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed', output: 'done', duration_ms: 10 }
      })

      const adapter = new GeminiCLIAdapter({ model: 'gemini-pro' })
      const events = await collectEvents(
        adapter.execute({
          prompt: 'hello world',
          systemPrompt: 'be helpful',
          workingDirectory: '/tmp/test',
        }),
      )

      const started = events.find((e): e is AgentStartedEvent => e.type === 'adapter:started')
      expect(started).toBeDefined()
      expect(started!.prompt).toBe('hello world')
      expect(started!.systemPrompt).toBe('be helpful')
      expect(started!.model).toBe('gemini-pro')
      expect(started!.workingDirectory).toBe('/tmp/test')
      expect(started!.isResume).toBe(false)
    })

    it('started event marks isResume true for resumed sessions', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed', output: 'resumed', duration_ms: 5 }
      })

      const adapter = new QwenAdapter()
      const events = await collectEvents(
        adapter.resumeSession('sess-123', { prompt: 'continue' }),
      )

      const started = events.find((e): e is AgentStartedEvent => e.type === 'adapter:started')
      expect(started).toBeDefined()
      expect(started!.isResume).toBe(true)
      expect(started!.prompt).toBe('continue')
    })

    it('started event omits optional fields when not provided', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed', output: 'ok', duration_ms: 1 }
      })

      const adapter = new CrushAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'test' }))

      const started = events.find((e): e is AgentStartedEvent => e.type === 'adapter:started')
      expect(started).toBeDefined()
      expect(started!.systemPrompt).toBeUndefined()
      expect(started!.model).toBeUndefined()
      expect(started!.isResume).toBe(false)
    })
  })

  describe('AgentProgressEvent shape (E2)', () => {
    it('AgentProgressEvent matches expected shape at type level', () => {
      const event: AgentProgressEvent = {
        type: 'adapter:progress',
        providerId: 'gemini',
        timestamp: Date.now(),
        phase: 'executing',
        current: 2,
        total: 5,
        percentage: 40,
        message: 'Completed 2/5',
      }

      expect(event.type).toBe('adapter:progress')
      expect(event.providerId).toBe('gemini')
      expect(event.phase).toBe('executing')
      expect(event.current).toBe(2)
      expect(event.total).toBe(5)
      expect(event.percentage).toBe(40)
      expect(event.message).toBe('Completed 2/5')
    })

    it('AgentProgressEvent is included in AgentEvent union', () => {
      const progress: AgentProgressEvent = {
        type: 'adapter:progress',
        providerId: 'claude',
        timestamp: Date.now(),
        phase: 'planning',
      }

      // Assigning to AgentEvent verifies union membership at compile time
      const agentEvent: AgentEvent = progress
      expect(agentEvent.type).toBe('adapter:progress')
    })

    it('AgentProgressEvent allows optional fields to be omitted', () => {
      const minimal: AgentProgressEvent = {
        type: 'adapter:progress',
        providerId: 'codex',
        timestamp: Date.now(),
        phase: 'initializing',
      }

      expect(minimal.percentage).toBeUndefined()
      expect(minimal.message).toBeUndefined()
      expect(minimal.current).toBeUndefined()
      expect(minimal.total).toBeUndefined()
    })
  })
})

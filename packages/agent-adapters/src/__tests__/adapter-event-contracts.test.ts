import { describe, it, expect, vi, beforeEach } from 'vitest'

import { GeminiCLIAdapter } from '../gemini/gemini-adapter.js'
import { QwenAdapter } from '../qwen/qwen-adapter.js'
import { CrushAdapter } from '../crush/crush-adapter.js'
import type { AgentEvent, AgentCLIAdapter } from '../types.js'
import { collectEvents, getProcessHelperMocks, loadJsonFixture } from './test-helpers.js'

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
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        for (const record of records) {
          yield record
        }
      })

      const events = await collectEvents(testCase.adapter.execute({ prompt: 'contract-check' }))
      expect(events.map(normalizeEvent)).toEqual(testCase.expected)
    })
  }
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentEvent } from '../types.js'

// The Claude Agent SDK reports a provider API rejection (for example an HTTP
// 400 for an unsupported model) as a `result` message whose subtype is still
// `success` but whose `is_error` flag is true and whose `result` text carries
// the error. That must surface as `adapter:failed`, never as a completion.

function asyncIterableOf<T>(items: T[]): AsyncIterable<T> & { interrupt: ReturnType<typeof vi.fn> } {
  return {
    interrupt: vi.fn(),
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item
    },
  }
}

const mockQuery = vi.fn()

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mockQuery }))

const { ClaudeAgentAdapter } = await import('../claude/claude-adapter.js')

const system = { type: 'system', subtype: 'init', session_id: 'sess-err', model: 'claude-opus-5-5', tools: [] }
const apiError =
  'API Error: 400 Claude Code 2.1.195 does not support this model; version 2.1.280 or newer is required'

async function run(messages: unknown[]): Promise<AgentEvent[]> {
  mockQuery.mockReturnValue(asyncIterableOf(messages))
  const adapter = new ClaudeAgentAdapter({ interactionPolicy: { mode: 'auto-approve' } })
  const events: AgentEvent[] = []
  try {
    for await (const event of adapter.execute({ prompt: 'review' })) events.push(event)
  } catch {
    // A thrown terminal failure is acceptable; the emitted events are asserted below.
  }
  return events
}

describe('Claude SDK is_error result (A22-C1-CLAUDE-IS-ERROR-20261015-R1)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('maps a success-subtype result with is_error true to adapter:failed', async () => {
    const events = await run([
      system,
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: apiError,
        session_id: 'sess-err',
        duration_ms: 5,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    ])

    expect(events.some(e => e.type === 'adapter:completed')).toBe(false)
    const failed = events.find(e => e.type === 'adapter:failed')
    expect(failed).toBeDefined()
    expect(failed).toMatchObject({ providerId: 'claude', error: apiError, code: 'is_error' })
  })

  it('keeps a success-subtype result with is_error false as adapter:completed', async () => {
    const events = await run([
      system,
      { type: 'result', subtype: 'success', is_error: false, result: 'Done', session_id: 'sess-err', duration_ms: 5 },
    ])

    expect(events.some(e => e.type === 'adapter:failed')).toBe(false)
    expect(events.find(e => e.type === 'adapter:completed')).toMatchObject({ result: 'Done' })
  })
})

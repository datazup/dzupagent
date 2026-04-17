import { describe, it, expect, vi, beforeEach } from 'vitest'

import { GooseAdapter } from '../goose/goose-adapter.js'
import { collectEvents, getProcessHelperMocks } from './test-helpers.js'

vi.mock('../utils/process-helpers.js', () => ({
  isBinaryAvailable: vi.fn().mockResolvedValue(true),
  spawnAndStreamJsonl: vi.fn(),
}))

describe('GooseAdapter - branch coverage', () => {
  const { mockSpawnAndStreamJsonl } = getProcessHelperMocks()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps user role correctly', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'message', role: 'user', content: 'from user' }
      yield { type: 'completed', result: 'ok' }
    })
    const events = await collectEvents(
      new GooseAdapter().execute({ prompt: 'x' }),
    )
    const msg = events.find((e) => e.type === 'adapter:message')
    expect(msg).toBeDefined()
    if (msg?.type === 'adapter:message') {
      expect(msg.role).toBe('user')
    }
  })

  it('defaults to assistant role for unknown role', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'message', role: 'system', content: 'sys' }
      yield { type: 'completed', result: 'ok' }
    })
    const events = await collectEvents(
      new GooseAdapter().execute({ prompt: 'x' }),
    )
    const msg = events.find((e) => e.type === 'adapter:message')
    expect(msg).toBeDefined()
    if (msg?.type === 'adapter:message') {
      // Only user becomes 'user'; anything else becomes 'assistant'
      expect(msg.role).toBe('assistant')
    }
  })

  it('defaults to assistant role when role is missing', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'message', content: 'no role' }
      yield { type: 'completed', result: 'ok' }
    })
    const events = await collectEvents(
      new GooseAdapter().execute({ prompt: 'x' }),
    )
    const msg = events.find((e) => e.type === 'adapter:message')
    expect(msg).toBeDefined()
    if (msg?.type === 'adapter:message') {
      expect(msg.role).toBe('assistant')
    }
  })

  it('reads tool input field when arguments missing', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'tool_call', tool: { name: 'x', input: { foo: 1 } } }
      yield { type: 'completed', result: 'ok' }
    })
    const events = await collectEvents(
      new GooseAdapter().execute({ prompt: 'x' }),
    )
    const tc = events.find((e) => e.type === 'adapter:tool_call')
    expect(tc).toBeDefined()
    if (tc?.type === 'adapter:tool_call') {
      expect(tc.input).toEqual({ foo: 1 })
    }
  })

  it('defaults tool input to empty object when neither arguments nor input present', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'tool_call', tool: { name: 'x' } }
      yield { type: 'completed', result: 'ok' }
    })
    const events = await collectEvents(
      new GooseAdapter().execute({ prompt: 'x' }),
    )
    const tc = events.find((e) => e.type === 'adapter:tool_call')
    expect(tc).toBeDefined()
    if (tc?.type === 'adapter:tool_call') {
      expect(tc.input).toEqual({})
    }
  })

  it('falls back to record itself when tool/function_call field missing', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'tool_call', name: 'from-record', arguments: { a: 1 } }
      yield { type: 'completed', result: 'ok' }
    })
    const events = await collectEvents(
      new GooseAdapter().execute({ prompt: 'x' }),
    )
    const tc = events.find((e) => e.type === 'adapter:tool_call')
    expect(tc).toBeDefined()
    if (tc?.type === 'adapter:tool_call') {
      expect(tc.toolName).toBe('from-record')
      expect(tc.input).toEqual({ a: 1 })
    }
  })

  it('tool_result uses content field when output missing', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield {
        type: 'tool_result',
        tool_result: { name: 't', content: 'content-field' },
      }
      yield { type: 'completed', result: 'ok' }
    })
    const events = await collectEvents(
      new GooseAdapter().execute({ prompt: 'x' }),
    )
    const tr = events.find((e) => e.type === 'adapter:tool_result')
    expect(tr).toBeDefined()
    if (tr?.type === 'adapter:tool_result') {
      expect(tr.output).toBe('content-field')
    }
  })

  it('tool_result falls back to record when tool_result/function_response missing', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'tool_result', name: 'flat', output: 'flat-output' }
      yield { type: 'completed', result: 'ok' }
    })
    const events = await collectEvents(
      new GooseAdapter().execute({ prompt: 'x' }),
    )
    const tr = events.find((e) => e.type === 'adapter:tool_result')
    expect(tr).toBeDefined()
    if (tr?.type === 'adapter:tool_result') {
      expect(tr.toolName).toBe('flat')
      expect(tr.output).toBe('flat-output')
    }
  })

  it('tool_result defaults toolName to unknown when name missing', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'tool_result', tool_result: { output: 'o' } }
      yield { type: 'completed', result: 'ok' }
    })
    const events = await collectEvents(
      new GooseAdapter().execute({ prompt: 'x' }),
    )
    const tr = events.find((e) => e.type === 'adapter:tool_result')
    expect(tr).toBeDefined()
    if (tr?.type === 'adapter:tool_result') {
      expect(tr.toolName).toBe('unknown')
    }
  })

  it('completed uses output field when result missing', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'completed', output: 'output-text' }
    })
    const events = await collectEvents(
      new GooseAdapter().execute({ prompt: 'x' }),
    )
    const c = events.find((e) => e.type === 'adapter:completed')
    expect(c).toBeDefined()
    if (c?.type === 'adapter:completed') {
      expect(c.result).toBe('output-text')
    }
  })

  it('completed defaults to empty result when both missing', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'completed' }
    })
    const events = await collectEvents(
      new GooseAdapter().execute({ prompt: 'x' }),
    )
    const c = events.find((e) => e.type === 'adapter:completed')
    expect(c).toBeDefined()
    if (c?.type === 'adapter:completed') {
      expect(c.result).toBe('')
    }
  })

  it('error with string error uses it', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'error', error: 'plain string error' }
    })
    const events = await collectEvents(
      new GooseAdapter().execute({ prompt: 'x' }),
    )
    const f = events.find((e) => e.type === 'adapter:failed')
    expect(f).toBeDefined()
    if (f?.type === 'adapter:failed') {
      expect(f.error).toBe('plain string error')
    }
  })

  it('error defaults message when missing', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'error' }
    })
    const events = await collectEvents(
      new GooseAdapter().execute({ prompt: 'x' }),
    )
    const f = events.find((e) => e.type === 'adapter:failed')
    expect(f).toBeDefined()
    if (f?.type === 'adapter:failed') {
      expect(f.error).toBe('Unknown error')
    }
  })

  it('stream_delta uses text field as fallback', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'stream_delta', text: 'text-content' }
      yield { type: 'completed', result: 'ok' }
    })
    const events = await collectEvents(
      new GooseAdapter().execute({ prompt: 'x' }),
    )
    const d = events.find((e) => e.type === 'adapter:stream_delta')
    expect(d).toBeDefined()
    if (d?.type === 'adapter:stream_delta') {
      expect(d.content).toBe('text-content')
    }
  })

  it('tool_call field alias maps correctly for function_call case', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield {
        type: 'function_call',
        function_call: { name: 'fc', input: { y: 2 } },
      }
      yield { type: 'completed', result: 'ok' }
    })
    const events = await collectEvents(
      new GooseAdapter().execute({ prompt: 'x' }),
    )
    const tc = events.find((e) => e.type === 'adapter:tool_call')
    expect(tc).toBeDefined()
    if (tc?.type === 'adapter:tool_call') {
      expect(tc.toolName).toBe('fc')
      expect(tc.input).toEqual({ y: 2 })
    }
  })

  it('function_response maps correctly to tool_result', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield {
        type: 'function_response',
        function_response: { name: 'fr', output: 'resp' },
      }
      yield { type: 'completed', result: 'ok' }
    })
    const events = await collectEvents(
      new GooseAdapter().execute({ prompt: 'x' }),
    )
    const tr = events.find((e) => e.type === 'adapter:tool_result')
    expect(tr).toBeDefined()
    if (tr?.type === 'adapter:tool_result') {
      expect(tr.toolName).toBe('fr')
      expect(tr.output).toBe('resp')
    }
  })
})

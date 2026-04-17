import { describe, it, expect, vi, beforeEach } from 'vitest'

import { GeminiCLIAdapter } from '../gemini/gemini-adapter.js'
import { collectEvents, getProcessHelperMocks } from './test-helpers.js'

vi.mock('../utils/process-helpers.js', () => ({
  isBinaryAvailable: vi.fn().mockResolvedValue(true),
  spawnAndStreamJsonl: vi.fn(),
}))

describe('GeminiCLIAdapter - branch coverage', () => {
  const { mockSpawnAndStreamJsonl } = getProcessHelperMocks()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('role resolution', () => {
    it('maps user role correctly', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'message', role: 'user', content: 'hi' }
        yield { type: 'completed', result: 'ok' }
      })
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'x' }),
      )
      const msg = events.find((e) => e.type === 'adapter:message')
      expect(msg).toBeDefined()
      if (msg?.type === 'adapter:message') {
        expect(msg.role).toBe('user')
      }
    })

    it('maps system role correctly', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'message', role: 'system', content: 'sys' }
        yield { type: 'completed', result: 'ok' }
      })
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'x' }),
      )
      const msg = events.find((e) => e.type === 'adapter:message')
      expect(msg).toBeDefined()
      if (msg?.type === 'adapter:message') {
        expect(msg.role).toBe('system')
      }
    })

    it('defaults to assistant role for unknown role', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'message', role: 'robot', content: 'beep' }
        yield { type: 'completed', result: 'ok' }
      })
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'x' }),
      )
      const msg = events.find((e) => e.type === 'adapter:message')
      expect(msg).toBeDefined()
      if (msg?.type === 'adapter:message') {
        expect(msg.role).toBe('assistant')
      }
    })

    it('handles message with text field instead of content', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'message', text: 'text content' }
        yield { type: 'completed', result: 'ok' }
      })
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'x' }),
      )
      const msg = events.find((e) => e.type === 'adapter:message')
      expect(msg).toBeDefined()
      if (msg?.type === 'adapter:message') {
        expect(msg.content).toBe('text content')
      }
    })

    it('handles message with message field', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'message', message: 'msg body' }
        yield { type: 'completed', result: 'ok' }
      })
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'x' }),
      )
      const msg = events.find((e) => e.type === 'adapter:message')
      expect(msg).toBeDefined()
      if (msg?.type === 'adapter:message') {
        expect(msg.content).toBe('msg body')
      }
    })
  })

  describe('tool_call fallback fields', () => {
    it('finds tool name via record.name', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'tool_call', name: 'search', arguments: { q: 'a' } }
        yield { type: 'completed', result: 'ok' }
      })
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'x' }),
      )
      const tc = events.find((e) => e.type === 'adapter:tool_call')
      expect(tc).toBeDefined()
      if (tc?.type === 'adapter:tool_call') {
        expect(tc.toolName).toBe('search')
        expect(tc.input).toEqual({ q: 'a' })
      }
    })

    it('falls back to tool_name field', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'tool_call', tool_name: 'fallback', input: { a: 1 } }
        yield { type: 'completed', result: 'ok' }
      })
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'x' }),
      )
      const tc = events.find((e) => e.type === 'adapter:tool_call')
      expect(tc).toBeDefined()
      if (tc?.type === 'adapter:tool_call') {
        expect(tc.toolName).toBe('fallback')
        expect(tc.input).toEqual({ a: 1 })
      }
    })

    it('defaults toolName to unknown when no name fields', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'tool_call', input: { a: 1 } }
        yield { type: 'completed', result: 'ok' }
      })
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'x' }),
      )
      const tc = events.find((e) => e.type === 'adapter:tool_call')
      expect(tc).toBeDefined()
      if (tc?.type === 'adapter:tool_call') {
        expect(tc.toolName).toBe('unknown')
      }
    })

    it('uses parameters field for input when arguments/input missing', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'tool_call', name: 'toolX', parameters: { x: 1 } }
        yield { type: 'completed', result: 'ok' }
      })
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'x' }),
      )
      const tc = events.find((e) => e.type === 'adapter:tool_call')
      expect(tc).toBeDefined()
      if (tc?.type === 'adapter:tool_call') {
        expect(tc.input).toEqual({ x: 1 })
      }
    })

    it('defaults input to empty object when nothing provided', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'tool_call', name: 'toolX' }
        yield { type: 'completed', result: 'ok' }
      })
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'x' }),
      )
      const tc = events.find((e) => e.type === 'adapter:tool_call')
      expect(tc).toBeDefined()
      if (tc?.type === 'adapter:tool_call') {
        expect(tc.input).toEqual({})
      }
    })
  })

  describe('tool_result fallback fields', () => {
    it('reads output/result/content fields', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'tool_result', name: 't1', content: 'hello', durationMs: 5 }
        yield { type: 'completed', result: 'ok' }
      })
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'x' }),
      )
      const tr = events.find((e) => e.type === 'adapter:tool_result')
      expect(tr).toBeDefined()
      if (tr?.type === 'adapter:tool_result') {
        expect(tr.output).toBe('hello')
        expect(tr.durationMs).toBe(5)
      }
    })

    it('reads elapsed_ms as duration fallback', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'tool_result', name: 't1', output: 'x', elapsed_ms: 99 }
        yield { type: 'completed', result: 'ok' }
      })
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'x' }),
      )
      const tr = events.find((e) => e.type === 'adapter:tool_result')
      expect(tr).toBeDefined()
      if (tr?.type === 'adapter:tool_result') {
        expect(tr.durationMs).toBe(99)
      }
    })

    it('defaults durationMs to 0 when missing', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'tool_result', name: 't1', output: 'done' }
        yield { type: 'completed', result: 'ok' }
      })
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'x' }),
      )
      const tr = events.find((e) => e.type === 'adapter:tool_result')
      expect(tr).toBeDefined()
      if (tr?.type === 'adapter:tool_result') {
        expect(tr.durationMs).toBe(0)
      }
    })
  })

  describe('stream_delta variants', () => {
    it('handles delta event with content field', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'delta', content: 'c' }
        yield { type: 'completed', result: 'ok' }
      })
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'x' }),
      )
      const d = events.find((e) => e.type === 'adapter:stream_delta')
      expect(d).toBeDefined()
      if (d?.type === 'adapter:stream_delta') {
        expect(d.content).toBe('c')
      }
    })

    it('handles stream_delta with delta field', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'stream_delta', delta: 'piece' }
        yield { type: 'completed', result: 'ok' }
      })
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'x' }),
      )
      const d = events.find((e) => e.type === 'adapter:stream_delta')
      expect(d).toBeDefined()
      if (d?.type === 'adapter:stream_delta') {
        expect(d.content).toBe('piece')
      }
    })

    it('emits empty-content stream_delta when no text found', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'stream_delta' }
        yield { type: 'completed', result: 'ok' }
      })
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'x' }),
      )
      // Gemini adapter yields adapter:stream_delta with empty content
      const d = events.find((e) => e.type === 'adapter:stream_delta')
      expect(d).toBeDefined()
      if (d?.type === 'adapter:stream_delta') {
        expect(d.content).toBe('')
      }
    })
  })

  describe('completed variants', () => {
    it('reads content field for result', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed', content: 'content-result' }
      })
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'x' }),
      )
      const c = events.find((e) => e.type === 'adapter:completed')
      expect(c).toBeDefined()
      if (c?.type === 'adapter:completed') {
        expect(c.result).toBe('content-result')
      }
    })

    it('reads text field for result', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed', text: 'text-result' }
      })
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'x' }),
      )
      const c = events.find((e) => e.type === 'adapter:completed')
      expect(c).toBeDefined()
      if (c?.type === 'adapter:completed') {
        expect(c.result).toBe('text-result')
      }
    })

    it('reads durationMs field as fallback', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed', result: 'r', durationMs: 777 }
      })
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'x' }),
      )
      const c = events.find((e) => e.type === 'adapter:completed')
      expect(c).toBeDefined()
      if (c?.type === 'adapter:completed') {
        expect(c.durationMs).toBe(777)
      }
    })
  })

  describe('error variants', () => {
    it('omits code when error has no code', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'error', error: { message: 'simple' } }
      })
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'x' }),
      )
      const f = events.find((e) => e.type === 'adapter:failed')
      expect(f).toBeDefined()
      if (f?.type === 'adapter:failed') {
        expect(f.error).toBe('simple')
        expect(f.code).toBeUndefined()
      }
    })

    it('defaults error message when missing', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'error' }
      })
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'x' }),
      )
      const f = events.find((e) => e.type === 'adapter:failed')
      expect(f).toBeDefined()
      if (f?.type === 'adapter:failed') {
        expect(f.error).toContain('Unknown')
      }
    })
  })

  describe('buildArgs variants', () => {
    it('does not add --max-turns when maxTurns is undefined', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed', result: 'ok' }
      })
      await collectEvents(new GeminiCLIAdapter().execute({ prompt: 'x' }))
      const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
      expect(args).not.toContain('--max-turns')
    })

    it('adds --system-prompt when systemPrompt given', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed', result: 'ok' }
      })
      await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'x', systemPrompt: 'sys' }),
      )
      const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
      expect(args).toContain('--system-prompt')
      expect(args).toContain('sys')
    })

    it('maps read-only sandbox mode', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed', result: 'ok' }
      })
      await collectEvents(
        new GeminiCLIAdapter({ sandboxMode: 'read-only' }).execute({
          prompt: 'x',
        }),
      )
      const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
      expect(args).toContain('--sandbox')
      expect(args).toContain('sandbox')
    })

    it('maps full-access sandbox mode', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed', result: 'ok' }
      })
      await collectEvents(
        new GeminiCLIAdapter({ sandboxMode: 'full-access' }).execute({
          prompt: 'x',
        }),
      )
      const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
      expect(args).toContain('--sandbox')
      expect(args).toContain('none')
    })

    it('ignores unmapped sandbox mode', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed', result: 'ok' }
      })
      await collectEvents(
        new GeminiCLIAdapter({
          sandboxMode: 'bogus' as unknown as 'read-only',
        }).execute({ prompt: 'x' }),
      )
      const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
      expect(args).not.toContain('--sandbox')
    })

    it('adds --session on resume', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed', result: 'ok' }
      })
      await collectEvents(
        new GeminiCLIAdapter().resumeSession('session-42', { prompt: 'x' }),
      )
      const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
      expect(args).toContain('--session')
      expect(args).toContain('session-42')
    })

    it('does not add model arg when config has no model', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed', result: 'ok' }
      })
      await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'x' }),
      )
      const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
      expect(args).not.toContain('--model')
    })
  })

  describe('getCapabilities', () => {
    it('returns expected capability profile', () => {
      const adapter = new GeminiCLIAdapter()
      expect(adapter.getCapabilities()).toEqual({
        supportsResume: true,
        supportsFork: false,
        supportsToolCalls: true,
        supportsStreaming: true,
        supportsCostUsage: true,
      })
    })
  })
})

/**
 * Wave 19 — Gemini adapter deep coverage tests.
 *
 * Focus areas not heavily covered in gemini-adapter.test.ts /
 * gemini-adapter-branches.test.ts / gemini-sdk-adapter.test.ts:
 *   - Function-call/function-response variant payloads
 *   - Multi-turn context (resumeSessionId emits --session arg)
 *   - Sandbox mode mappings (read-only, full-access)
 *   - Stream-delta payload variants (content/text/delta)
 *   - Empty/missing fields in tool_call records
 *   - Args order and presence (--output-format json, -p prompt)
 *
 * The gemini binary is mocked through process-helpers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { GeminiCLIAdapter } from '../gemini/gemini-adapter.js'
import { collectEvents, getProcessHelperMocks } from './test-helpers.js'
import type { AgentEvent } from '../types.js'

vi.mock('../utils/process-helpers.js', () => ({
  isBinaryAvailable: vi.fn().mockResolvedValue(true),
  spawnAndStreamJsonl: vi.fn(),
}))

describe('GeminiCLIAdapter — deep coverage', () => {
  const { mockSpawnAndStreamJsonl, mockIsBinaryAvailable } = getProcessHelperMocks()

  beforeEach(() => {
    vi.clearAllMocks()
    mockIsBinaryAvailable.mockResolvedValue(true)
  })

  // ── Function-call format variants ─────────────────────

  describe('function-call payload variants', () => {
    it('extracts toolName from top-level "name" field', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'function_call', name: 'search', arguments: { q: 'rust' } }
        yield { type: 'completed', result: 'done' }
      })
      const adapter = new GeminiCLIAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const call = events.find(e => e.type === 'adapter:tool_call') as Extract<
        AgentEvent,
        { type: 'adapter:tool_call' }
      >
      expect(call.toolName).toBe('search')
      expect(call.input).toEqual({ q: 'rust' })
    })

    it('falls back to nested tool.name when top-level name missing', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'function_call', tool: { name: 'fetch', input: { url: 'x' } } }
        yield { type: 'completed' }
      })
      const adapter = new GeminiCLIAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const call = events.find(e => e.type === 'adapter:tool_call') as Extract<
        AgentEvent,
        { type: 'adapter:tool_call' }
      >
      expect(call.toolName).toBe('fetch')
      expect(call.input).toEqual({ url: 'x' })
    })

    it('uses "unknown" toolName when neither top-level nor nested name', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'function_call' }
        yield { type: 'completed' }
      })
      const adapter = new GeminiCLIAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const call = events.find(e => e.type === 'adapter:tool_call') as Extract<
        AgentEvent,
        { type: 'adapter:tool_call' }
      >
      expect(call.toolName).toBe('unknown')
      expect(call.input).toEqual({})
    })

    it('extracts input from "parameters" field (Gemini variant)', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'function_call', name: 'calc', parameters: { x: 1, y: 2 } }
        yield { type: 'completed' }
      })
      const adapter = new GeminiCLIAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const call = events.find(e => e.type === 'adapter:tool_call') as Extract<
        AgentEvent,
        { type: 'adapter:tool_call' }
      >
      expect(call.input).toEqual({ x: 1, y: 2 })
    })
  })

  // ── Function-response format variants ─────────────────

  describe('function-response payload variants', () => {
    it('extracts duration from elapsed_ms field on the record', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'function_response', name: 'search', result: 'ok', elapsed_ms: 42 }
        yield { type: 'completed' }
      })
      const adapter = new GeminiCLIAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const result = events.find(e => e.type === 'adapter:tool_result') as Extract<
        AgentEvent,
        { type: 'adapter:tool_result' }
      >
      expect(result.durationMs).toBe(42)
    })

    it('uses 0 duration when no timing fields are present', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'function_response', name: 'x', result: 'y' }
        yield { type: 'completed' }
      })
      const adapter = new GeminiCLIAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const result = events.find(e => e.type === 'adapter:tool_result') as Extract<
        AgentEvent,
        { type: 'adapter:tool_result' }
      >
      expect(result.durationMs).toBe(0)
    })

    it('serializes object output via JSON.stringify', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield {
          type: 'function_response',
          name: 'fetch',
          result: { items: [1, 2, 3], total: 3 },
        }
        yield { type: 'completed' }
      })
      const adapter = new GeminiCLIAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const result = events.find(e => e.type === 'adapter:tool_result') as Extract<
        AgentEvent,
        { type: 'adapter:tool_result' }
      >
      expect(result.output).toBe('{"items":[1,2,3],"total":3}')
    })
  })

  // ── Stream delta variants ─────────────────────────────

  describe('stream_delta payload variants', () => {
    it('reads delta content from "delta" field', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'stream_delta', delta: 'partial' }
        yield { type: 'completed' }
      })
      const adapter = new GeminiCLIAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const stream = events.find(e => e.type === 'adapter:stream_delta') as Extract<
        AgentEvent,
        { type: 'adapter:stream_delta' }
      >
      expect(stream.content).toBe('partial')
    })

    it('reads delta content from "text" field', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'delta', text: 'token' }
        yield { type: 'completed' }
      })
      const adapter = new GeminiCLIAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const stream = events.find(e => e.type === 'adapter:stream_delta') as Extract<
        AgentEvent,
        { type: 'adapter:stream_delta' }
      >
      expect(stream.content).toBe('token')
    })

    it('reads delta content from "content" field', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'stream_delta', content: 'chunk' }
        yield { type: 'completed' }
      })
      const adapter = new GeminiCLIAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const stream = events.find(e => e.type === 'adapter:stream_delta') as Extract<
        AgentEvent,
        { type: 'adapter:stream_delta' }
      >
      expect(stream.content).toBe('chunk')
    })

    it('uses empty string when no delta payload field is present', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'stream_delta' }
        yield { type: 'completed' }
      })
      const adapter = new GeminiCLIAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'p' }))
      const stream = events.find(e => e.type === 'adapter:stream_delta') as Extract<
        AgentEvent,
        { type: 'adapter:stream_delta' }
      >
      expect(stream.content).toBe('')
    })
  })

  // ── CLI argument shaping ──────────────────────────────

  describe('CLI argument shaping', () => {
    it('includes --output-format json by default', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed' }
      })
      await collectEvents(new GeminiCLIAdapter().execute({ prompt: 'p' }))
      const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
      expect(args).toContain('--output-format')
      expect(args).toContain('json')
    })

    it('includes -p with prompt', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed' }
      })
      await collectEvents(new GeminiCLIAdapter().execute({ prompt: 'hello world' }))
      const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
      const promptIdx = args.indexOf('-p')
      expect(promptIdx).toBeGreaterThanOrEqual(0)
      expect(args[promptIdx + 1]).toBe('hello world')
    })

    it('passes --session when resumeSessionId provided', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed' }
      })
      await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'p', resumeSessionId: 'sess-X' }),
      )
      const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
      const idx = args.indexOf('--session')
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(args[idx + 1]).toBe('sess-X')
    })

    it('passes --system-prompt when provided', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed' }
      })
      await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'p', systemPrompt: 'Be terse.' }),
      )
      const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
      const idx = args.indexOf('--system-prompt')
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(args[idx + 1]).toBe('Be terse.')
    })

    it('omits --session when no resumeSessionId provided', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed' }
      })
      await collectEvents(new GeminiCLIAdapter().execute({ prompt: 'p' }))
      const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
      expect(args).not.toContain('--session')
    })

    it('maps "read-only" sandbox to --sandbox sandbox', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed' }
      })
      await collectEvents(
        new GeminiCLIAdapter({ sandboxMode: 'read-only' }).execute({ prompt: 'p' }),
      )
      const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
      const idx = args.indexOf('--sandbox')
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(args[idx + 1]).toBe('sandbox')
    })

    it('maps "full-access" sandbox to --sandbox none', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed' }
      })
      await collectEvents(
        new GeminiCLIAdapter({ sandboxMode: 'full-access' }).execute({ prompt: 'p' }),
      )
      const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
      const idx = args.indexOf('--sandbox')
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(args[idx + 1]).toBe('none')
    })

    it('omits --sandbox when no sandboxMode is configured', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed' }
      })
      await collectEvents(new GeminiCLIAdapter().execute({ prompt: 'p' }))
      const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
      expect(args).not.toContain('--sandbox')
    })

    it('passes --max-turns when input.maxTurns is provided', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed' }
      })
      await collectEvents(new GeminiCLIAdapter().execute({ prompt: 'p', maxTurns: 8 }))
      const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
      const idx = args.indexOf('--max-turns')
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(args[idx + 1]).toBe('8')
    })
  })

  // ── Capabilities + lifecycle ──────────────────────────

  describe('capabilities and lifecycle', () => {
    it('reports supportsResume=true', () => {
      const adapter = new GeminiCLIAdapter()
      const caps = adapter.getCapabilities()
      expect(caps.supportsResume).toBe(true)
    })

    it('reports supportsFork=false', () => {
      const adapter = new GeminiCLIAdapter()
      const caps = adapter.getCapabilities()
      expect(caps.supportsFork).toBe(false)
    })

    it('isResume=true on started event when resumeSessionId is set', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed' }
      })
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'p', resumeSessionId: 's' }),
      )
      const started = events.find(e => e.type === 'adapter:started') as Extract<
        AgentEvent,
        { type: 'adapter:started' }
      >
      expect(started.isResume).toBe(true)
    })

    it('isResume=false on started event when no resumeSessionId', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed' }
      })
      const events = await collectEvents(
        new GeminiCLIAdapter().execute({ prompt: 'p' }),
      )
      const started = events.find(e => e.type === 'adapter:started') as Extract<
        AgentEvent,
        { type: 'adapter:started' }
      >
      expect(started.isResume).toBe(false)
    })
  })

  // ── Error event handling ──────────────────────────────

  describe('error event handling', () => {
    it('preserves error message and code from {error: {message, code}}', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'error', error: { message: 'safety violation', code: 'SAFETY_BLOCK' } }
      })
      const events = await collectEvents(new GeminiCLIAdapter().execute({ prompt: 'p' }))
      const failed = events.find(e => e.type === 'adapter:failed') as Extract<
        AgentEvent,
        { type: 'adapter:failed' }
      >
      expect(failed.error).toBe('safety violation')
      expect(failed.code).toBe('SAFETY_BLOCK')
    })

    it('uses default error message when none is provided', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'error' }
      })
      const events = await collectEvents(new GeminiCLIAdapter().execute({ prompt: 'p' }))
      const failed = events.find(e => e.type === 'adapter:failed') as Extract<
        AgentEvent,
        { type: 'adapter:failed' }
      >
      expect(failed.error).toBe('Unknown Gemini CLI error')
    })

    it('omits error code when not provided', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'error', error: { message: 'bare error' } }
      })
      const events = await collectEvents(new GeminiCLIAdapter().execute({ prompt: 'p' }))
      const failed = events.find(e => e.type === 'adapter:failed') as Extract<
        AgentEvent,
        { type: 'adapter:failed' }
      >
      expect(failed.error).toBe('bare error')
      expect(failed.code).toBeUndefined()
    })
  })
})

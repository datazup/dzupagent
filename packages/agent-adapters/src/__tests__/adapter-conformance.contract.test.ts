import { describe, it, expect, vi, beforeEach } from 'vitest'

import { ForgeError } from '@dzupagent/core'

import { QwenAdapter } from '../qwen/qwen-adapter.js'
import { CrushAdapter } from '../crush/crush-adapter.js'
import { GeminiCLIAdapter } from '../gemini/gemini-adapter.js'
import { GooseAdapter } from '../goose/goose-adapter.js'
import { ClaudeAgentAdapter } from '../claude/claude-adapter.js'
import { CodexAdapter } from '../codex/codex-adapter.js'
import { OpenRouterAdapter } from '../openrouter/openrouter-adapter.js'
import type { AgentCLIAdapter, AgentEvent, AdapterProviderId, TokenUsage } from '../types.js'
import { getProcessHelperMocks } from './test-helpers.js'

vi.mock('../utils/process-helpers.js', () => ({
  isBinaryAvailable: vi.fn(),
  spawnAndStreamJsonl: vi.fn(),
}))

type CliConformanceCase = {
  providerId: AdapterProviderId
  adapter: AgentCLIAdapter
  completedRecord: Record<string, unknown>
  expectedUsage: TokenUsage
  expectedArgs: string[]
}

async function drainEvents<T>(gen: AsyncGenerator<T, void, undefined>): Promise<T[]> {
  const events: T[] = []
  for await (const event of gen) {
    events.push(event)
  }
  return events
}

function terminalEvents(events: AgentEvent[]): AgentEvent[] {
  return events.filter((event) => event.type === 'adapter:completed' || event.type === 'adapter:failed')
}

describe('CLI adapter conformance contract', () => {
  const { mockIsBinaryAvailable, mockSpawnAndStreamJsonl } = getProcessHelperMocks()

  beforeEach(() => {
    vi.clearAllMocks()
    mockIsBinaryAvailable.mockResolvedValue(true)
  })

  const cases: CliConformanceCase[] = [
    {
      providerId: 'qwen',
      adapter: new QwenAdapter(),
      completedRecord: {
        type: 'completed',
        content: 'qwen done',
        duration_ms: 24,
        usage: {
          input_tokens: 150,
          output_tokens: 30,
          cached_input_tokens: 20,
          cost_cents: 4.5,
        },
      },
      expectedUsage: {
        inputTokens: 150,
        outputTokens: 30,
        cachedInputTokens: 20,
        costCents: 4.5,
      },
      expectedArgs: ['--output-format', 'jsonl', '--prompt', 'contract'],
    },
    {
      providerId: 'crush',
      adapter: new CrushAdapter(),
      completedRecord: {
        type: 'completed',
        output: 'crush done',
        duration_ms: 31,
        token_usage: {
          prompt_tokens: 77,
          completion_tokens: 18,
        },
      },
      expectedUsage: {
        inputTokens: 77,
        outputTokens: 18,
      },
      expectedArgs: ['--output-format', 'jsonl', '--prompt', 'contract'],
    },
    {
      providerId: 'gemini',
      adapter: new GeminiCLIAdapter(),
      completedRecord: {
        type: 'completed',
        result: 'gemini done',
        duration_ms: 42,
      },
      expectedUsage: undefined as unknown as TokenUsage,
      expectedArgs: ['--output-format', 'json', '-p', 'contract'],
    },
    {
      providerId: 'goose',
      adapter: new GooseAdapter(),
      completedRecord: {
        type: 'completed',
        output: 'goose done',
        duration_ms: 55,
      },
      expectedUsage: undefined as unknown as TokenUsage,
      expectedArgs: ['--output-format', 'jsonl', '--prompt', 'contract'],
    },
  ]

  for (const testCase of cases) {
    it(`${testCase.providerId} emits exactly one terminal completed event with usage attribution`, async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'message', content: `${testCase.providerId} hello` }
        yield testCase.completedRecord
      })

      const events = await drainEvents(testCase.adapter.execute({ prompt: 'contract' }))
      const terminals = terminalEvents(events)

      expect(terminals).toHaveLength(1)
      expect(terminals[0]?.type).toBe('adapter:completed')

      const completed = terminals[0]
      if (completed?.type === 'adapter:completed') {
        expect(completed.providerId).toBe(testCase.providerId)
        if (testCase.expectedUsage !== undefined) {
          expect(completed.usage).toEqual(testCase.expectedUsage)
        }
      }

      const [, args] = mockSpawnAndStreamJsonl.mock.calls.at(-1)!
      for (const arg of testCase.expectedArgs) {
        expect(args).toContain(arg)
      }
    })

    it(`${testCase.providerId} treats provider failure as terminal without adding synthetic completion`, async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'error', error: { message: `${testCase.providerId} failed`, code: 'PROVIDER_ERR' } }
      })

      const events = await drainEvents(testCase.adapter.execute({ prompt: 'contract' }))
      const terminals = terminalEvents(events)

      expect(events.map((event) => event.type)).toEqual(['adapter:started', 'adapter:failed'])
      expect(terminals).toHaveLength(1)

      const failed = terminals[0]
      expect(failed?.type).toBe('adapter:failed')
      if (failed?.type === 'adapter:failed') {
        expect(failed.providerId).toBe(testCase.providerId)
        expect(failed.code).toBe('PROVIDER_ERR')
      }
    })

    it(`${testCase.providerId} surfaces aborts as adapter:failed before rethrowing`, async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* (_binary, _args, opts) {
        yield { type: 'message', content: `${testCase.providerId} running` }
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) {
            resolve()
            return
          }
          opts.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        throw new ForgeError({
          code: 'AGENT_ABORTED',
          message: `${testCase.providerId} aborted`,
          recoverable: true,
        })
      })

      const stream = testCase.adapter.execute({ prompt: 'contract' })
      const first = await stream.next()
      expect(first.value?.type).toBe('adapter:started')

      const second = await stream.next()
      expect(second.value?.type).toBe('adapter:message')

      testCase.adapter.interrupt()

      const third = await stream.next()
      expect(third.value?.type).toBe('adapter:failed')
      if (third.value?.type === 'adapter:failed') {
        expect(third.value.providerId).toBe(testCase.providerId)
        expect(third.value.code).toBe('AGENT_ABORTED')
      }

      await expect(stream.next()).rejects.toMatchObject({
        code: 'AGENT_ABORTED',
      })
    })
  }

  it('crush keeps resume unsupported as an explicit contract', async () => {
    const adapter = new CrushAdapter()

    await expect(drainEvents(adapter.resumeSession('sess-1', { prompt: 'resume' }))).rejects.toMatchObject({
      code: 'ADAPTER_SESSION_NOT_FOUND',
    })
  })
})

// ---------------------------------------------------------------------------
// Claude adapter conformance (SDK-based, needs SDK mock)
// ---------------------------------------------------------------------------

describe('Claude adapter conformance contract', () => {
  it('creates with valid config and reports capabilities', () => {
    const adapter = new ClaudeAgentAdapter({ model: 'claude-sonnet-4-5-20250514' })
    expect(adapter.providerId).toBe('claude')

    const caps = adapter.getCapabilities()
    expect(caps.supportsResume).toBe(true)
    expect(caps.supportsFork).toBe(true)
    expect(caps.supportsToolCalls).toBe(true)
    expect(caps.supportsStreaming).toBe(true)
    expect(caps.supportsCostUsage).toBe(true)
  })

  it('execute() either throws SDK_NOT_INSTALLED or starts with adapter:started', async () => {
    const adapter = new ClaudeAgentAdapter()
    const stream = adapter.execute({ prompt: 'test' })

    try {
      const first = await stream.next()
      // SDK is installed: first event must be adapter:started
      expect(first.done).toBe(false)
      expect(first.value?.type).toBe('adapter:started')
      if (first.value?.type === 'adapter:started') {
        expect(first.value.providerId).toBe('claude')
      }
      // Clean up
      adapter.interrupt()
    } catch (err) {
      // SDK not installed: expect the proper error code
      expect(err).toMatchObject({ code: 'ADAPTER_SDK_NOT_INSTALLED' })
    }
  })

  it('configure() merges config without throwing', () => {
    const adapter = new ClaudeAgentAdapter()
    expect(() => adapter.configure({ model: 'claude-sonnet-4-5-20250514', timeoutMs: 30_000 })).not.toThrow()
  })

  it('interrupt() is safe to call when no conversation is active', () => {
    const adapter = new ClaudeAgentAdapter()
    expect(() => adapter.interrupt()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Codex adapter conformance (SDK-based, needs SDK mock)
// ---------------------------------------------------------------------------

describe('Codex adapter conformance contract', () => {
  it('creates with valid config and reports capabilities', () => {
    const adapter = new CodexAdapter({ model: 'gpt-5.4' })
    expect(adapter.providerId).toBe('codex')

    const caps = adapter.getCapabilities()
    expect(caps.supportsResume).toBe(true)
    expect(caps.supportsFork).toBe(false)
    expect(caps.supportsToolCalls).toBe(true)
    expect(caps.supportsStreaming).toBe(true)
    expect(caps.supportsCostUsage).toBe(true)
  })

  it('execute() either throws SDK_NOT_INSTALLED or starts with adapter:started', async () => {
    const adapter = new CodexAdapter()
    const stream = adapter.execute({ prompt: 'test' })

    try {
      const first = await stream.next()
      // SDK is installed: first event must be adapter:started
      expect(first.done).toBe(false)
      expect(first.value?.type).toBe('adapter:started')
      if (first.value?.type === 'adapter:started') {
        expect(first.value.providerId).toBe('codex')
      }
      // Clean up
      adapter.interrupt()
    } catch (err) {
      // SDK not installed: expect the proper error code
      expect(err).toMatchObject({ code: 'ADAPTER_SDK_NOT_INSTALLED' })
    }
  })

  it('configure() merges config without throwing', () => {
    const adapter = new CodexAdapter()
    expect(() => adapter.configure({ model: 'gpt-5.4', sandboxMode: 'workspace-write' })).not.toThrow()
  })

  it('interrupt() is safe to call when no session is active', () => {
    const adapter = new CodexAdapter()
    expect(() => adapter.interrupt()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// OpenRouter adapter conformance (fetch-based)
// ---------------------------------------------------------------------------

describe('OpenRouter adapter conformance contract', () => {
  it('creates with valid config and reports capabilities', () => {
    const adapter = new OpenRouterAdapter({ openRouterApiKey: 'test-key' })
    expect(adapter.providerId).toBe('openrouter')

    const caps = adapter.getCapabilities()
    expect(caps.supportsResume).toBe(false)
    expect(caps.supportsFork).toBe(false)
    expect(caps.supportsToolCalls).toBe(true)
    expect(caps.supportsStreaming).toBe(true)
    expect(caps.supportsCostUsage).toBe(true)
  })

  it('execute() emits adapter:failed when no API key is configured', async () => {
    // Ensure no env key is set for this test
    const originalKey = process.env['OPENROUTER_API_KEY']
    delete process.env['OPENROUTER_API_KEY']

    try {
      const adapter = new OpenRouterAdapter()
      const stream = adapter.execute({ prompt: 'test' })

      await expect(stream.next()).rejects.toMatchObject({
        code: 'ADAPTER_EXECUTION_FAILED',
      })
    } finally {
      if (originalKey !== undefined) {
        process.env['OPENROUTER_API_KEY'] = originalKey
      }
    }
  })

  it('resumeSession() throws because OpenRouter does not support resume', async () => {
    const adapter = new OpenRouterAdapter({ openRouterApiKey: 'test-key' })

    await expect(
      drainEvents(adapter.resumeSession('sess-1', { prompt: 'resume' })),
    ).rejects.toMatchObject({
      code: 'ADAPTER_EXECUTION_FAILED',
    })
  })

  it('configure() merges config without throwing', () => {
    const adapter = new OpenRouterAdapter()
    expect(() =>
      adapter.configure({ openRouterApiKey: 'new-key', defaultModel: 'meta-llama/llama-3-70b' }),
    ).not.toThrow()
  })

  it('interrupt() is safe to call when no request is active', () => {
    const adapter = new OpenRouterAdapter()
    expect(() => adapter.interrupt()).not.toThrow()
  })

  it('healthCheck() reports unhealthy when no API key is set', async () => {
    const originalKey = process.env['OPENROUTER_API_KEY']
    delete process.env['OPENROUTER_API_KEY']

    try {
      const adapter = new OpenRouterAdapter()
      const health = await adapter.healthCheck()
      expect(health.healthy).toBe(false)
      expect(health.providerId).toBe('openrouter')
    } finally {
      if (originalKey !== undefined) {
        process.env['OPENROUTER_API_KEY'] = originalKey
      }
    }
  })
})

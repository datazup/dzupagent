import { ForgeError } from '@dzupagent/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runAgentExecution } from '../integration/run-agent-execution.js'
import type {
  AdapterCapabilityProfile,
  AdapterConfig,
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
} from '../types.js'

const adapterFactories = vi.hoisted(() => ({
  createClaudeAdapter: vi.fn(),
  createCodexAdapter: vi.fn(),
}))

vi.mock('../codex/codex-adapter.js', () => ({
  createCodexAdapter: adapterFactories.createCodexAdapter,
}))

vi.mock('../claude/claude-adapter.js', () => ({
  createClaudeAdapter: adapterFactories.createClaudeAdapter,
}))

const capabilities: AdapterCapabilityProfile = {
  supportsResume: true,
  supportsFork: false,
  supportsToolCalls: true,
  supportsStreaming: true,
  supportsCostUsage: true,
}

interface FakeAdapterOptions {
  result?: string | undefined
  usage?: AgentEvent extends infer _ ? NonNullable<Extract<AgentEvent, { type: 'adapter:completed' }>['usage']> : never
  fail?: { message: string; code?: string | undefined } | undefined
  throwError?: unknown
  onExecute?: ((input: AgentInput) => void) | undefined
}

function createFakeAdapter(
  providerId: AdapterProviderId,
  options: FakeAdapterOptions = {},
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      options.onExecute?.(input)
      if (options.throwError) throw options.throwError

      yield {
        type: 'adapter:started',
        providerId,
        sessionId: `session-${providerId}`,
        timestamp: 100,
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      }

      if (options.fail) {
        yield {
          type: 'adapter:failed',
          providerId,
          error: options.fail.message,
          ...(options.fail.code ? { code: options.fail.code } : {}),
          timestamp: 101,
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        }
        return
      }

      yield {
        type: 'adapter:completed',
        providerId,
        sessionId: `session-${providerId}`,
        result: options.result ?? `result:${providerId}`,
        ...(options.usage ? { usage: options.usage } : {}),
        durationMs: 12,
        timestamp: 112,
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      }
    },
    async *resumeSession(): AsyncGenerator<AgentEvent, void, undefined> {},
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
    getCapabilities() {
      return capabilities
    },
  }
}

describe('runAgentExecution', () => {
  beforeEach(() => {
    adapterFactories.createCodexAdapter.mockReset()
    adapterFactories.createClaudeAdapter.mockReset()
  })

  it('registers default Codex and Claude adapters and returns completed text, events, usage, and timing', async () => {
    const usage = { inputTokens: 10, outputTokens: 20 }
    adapterFactories.createCodexAdapter.mockReturnValue(createFakeAdapter('codex', {
      result: 'codex text',
      usage,
    }))
    adapterFactories.createClaudeAdapter.mockReturnValue(createFakeAdapter('claude', {
      result: 'claude text',
    }))

    const result = await runAgentExecution({
      providerId: 'codex',
      prompt: 'Implement this',
      workingDirectory: '/repo',
      model: 'gpt-test',
      reasoning: 'medium',
      timeoutMs: 30_000,
      correlationId: 'corr-1',
      runId: 'run-1',
      packetId: 'P001',
      sandboxMode: 'workspace-write',
    }, { now: vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_025) })

    expect(result).toMatchObject({
      ok: true,
      providerId: 'codex',
      model: 'gpt-test',
      text: 'codex text',
      usage,
      durationMs: 25,
      attemptedProviders: ['codex'],
    })
    expect(result.events.map((event) => event.type)).toContain('adapter:completed')
    expect(adapterFactories.createCodexAdapter).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-test',
      timeoutMs: 30_000,
      workingDirectory: '/repo',
      sandboxMode: 'workspace-write',
      reasoning: 'medium',
      providerOptions: {
        runId: 'run-1',
        packetId: 'P001',
        correlationId: 'corr-1',
      },
    } satisfies Partial<AdapterConfig>))
    expect(adapterFactories.createClaudeAdapter).toHaveBeenCalled()
  })

  it('routes an explicit Claude request through the registry without invoking Codex first', async () => {
    const codexInputs: AgentInput[] = []
    const claudeInputs: AgentInput[] = []

    const result = await runAgentExecution({
      providerId: 'claude',
      prompt: 'Review this plan',
      timeoutMs: 5_000,
    }, {
      adapters: [
        createFakeAdapter('codex', { onExecute: (input) => codexInputs.push(input) }),
        createFakeAdapter('claude', {
          result: 'claude answer',
          onExecute: (input) => claudeInputs.push(input),
        }),
      ],
    })

    expect(result.ok).toBe(true)
    expect(result.providerId).toBe('claude')
    expect(result.text).toBe('claude answer')
    expect(claudeInputs).toHaveLength(1)
    expect(codexInputs).toHaveLength(0)
  })

  it('preserves failed events when the registry falls back to a later provider', async () => {
    const result = await runAgentExecution({
      providerId: 'codex',
      prompt: 'Try fallback',
    }, {
      adapters: [
        createFakeAdapter('codex', {
          fail: { message: 'codex missing sdk', code: 'ADAPTER_SDK_NOT_INSTALLED' },
        }),
        createFakeAdapter('claude', { result: 'fallback text' }),
      ],
    })

    expect(result.ok).toBe(true)
    expect(result.providerId).toBe('claude')
    expect(result.text).toBe('fallback text')
    expect(result.attemptedProviders).toEqual(['codex', 'claude'])
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'adapter:failed',
        providerId: 'codex',
        code: 'ADAPTER_SDK_NOT_INSTALLED',
      }),
      expect.objectContaining({
        type: 'adapter:completed',
        providerId: 'claude',
      }),
    ]))
  })

  it('returns a structured failure when every adapter fails', async () => {
    const result = await runAgentExecution({
      providerId: 'codex',
      prompt: 'Fail all',
      model: 'model-x',
    }, {
      adapters: [
        createFakeAdapter('codex', {
          fail: { message: 'codex failed', code: 'CODEX_FAILED' },
        }),
        createFakeAdapter('claude', {
          fail: { message: 'claude failed', code: 'CLAUDE_FAILED' },
        }),
      ],
    })

    expect(result).toMatchObject({
      ok: false,
      providerId: 'claude',
      model: 'model-x',
      text: '',
      code: 'CLAUDE_FAILED',
      error: {
        code: 'CLAUDE_FAILED',
        message: 'claude failed',
        providerId: 'claude',
      },
      attemptedProviders: ['codex', 'claude'],
    })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('maps optional SDK import failures into structured adapter failure state', async () => {
    const result = await runAgentExecution({
      providerId: 'codex',
      prompt: 'Needs SDK',
    }, {
      adapters: [
        createFakeAdapter('codex', {
          throwError: new ForgeError({
            code: 'ADAPTER_SDK_NOT_INSTALLED',
            message: '@openai/codex-sdk is not installed',
            recoverable: false,
          }),
        }),
      ],
    })

    expect(result.ok).toBe(false)
    expect(result.text).toBe('')
    expect(result.code).toBe('ADAPTER_EXECUTION_FAILED')
    expect(result.error).toEqual(expect.objectContaining({
      code: 'ADAPTER_EXECUTION_FAILED',
      message: '@openai/codex-sdk is not installed',
      providerId: 'codex',
    }))
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'adapter:failed',
        providerId: 'codex',
        error: '@openai/codex-sdk is not installed',
      }),
    ]))
  })

  it('projects timeout and packet metadata into AgentInput options', async () => {
    let captured: AgentInput | undefined

    await runAgentExecution({
      providerId: 'codex',
      prompt: 'Capture input',
      timeoutMs: 1234,
      runId: 'run-123',
      packetId: 'P001',
      sandboxMode: 'read-only',
      reasoning: 'low',
      correlationId: 'corr-123',
    }, {
      adapters: [
        createFakeAdapter('codex', {
          onExecute: (input) => {
            captured = input
          },
        }),
      ],
    })

    expect(captured).toMatchObject({
      prompt: 'Capture input',
      correlationId: 'corr-123',
      options: {
        timeoutMs: 1234,
        runId: 'run-123',
        packetId: 'P001',
        sandboxMode: 'read-only',
        reasoning: 'low',
      },
    })
    expect(captured?.signal).toBeInstanceOf(AbortSignal)
  })
})

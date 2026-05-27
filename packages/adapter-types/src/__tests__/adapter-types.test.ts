import { describe, expect, it } from 'vitest'
import type {
  AdapterCapabilityProfile,
  AdapterConfig,
  AdapterProviderId,
  AgentInput,
  AgentToolCallEvent,
  AgentToolResultEvent,
  HealthStatus,
  SessionInfo,
  TokenUsage,
} from '../index.js'

describe('adapter-types public surface', () => {
  it('keeps the core configuration and runtime payload contracts aligned', () => {
    const providerIds = [
      'claude',
      'codex',
      'gemini',
      'qwen',
      'crush',
      'goose',
      'openrouter',
    ] as const satisfies readonly AdapterProviderId[]

    const capabilityProfile: AdapterCapabilityProfile = {
      supportsResume: true,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: false,
      maxContextTokens: 128_000,
    }

    const config: AdapterConfig = {
      apiKey: 'test-api-key',
      model: 'test-model',
      timeoutMs: 30_000,
      workingDirectory: '/workspace/project',
      sandboxMode: 'workspace-write',
      env: {
        TEST_FLAG: '1',
      },
      envFilter: {
        disableFilter: false,
        blockedPatterns: [/SECRET/i],
        allowedVars: ['TEST_FLAG'],
      },
      providerOptions: {
        capabilities: capabilityProfile,
        metadata: {
          team: 'platform',
        },
      },
    }

    const input: AgentInput = {
      prompt: 'Review this change',
      workingDirectory: '/workspace/project',
      systemPrompt: 'Be concise.',
      maxTurns: 8,
      maxBudgetUsd: 2.5,
      signal: new AbortController().signal,
      resumeSessionId: 'session-123',
      options: {
        mode: 'fast',
      },
      correlationId: 'corr-123',
    }

    const health: HealthStatus = {
      healthy: true,
      providerId: 'claude',
      sdkInstalled: true,
      cliAvailable: true,
      lastSuccessTimestamp: Date.now(),
    }

    const session: SessionInfo = {
      sessionId: 'session-123',
      providerId: 'claude',
      createdAt: new Date('2026-04-02T12:00:00.000Z'),
      lastActiveAt: new Date('2026-04-02T12:05:00.000Z'),
      workingDirectory: '/workspace/project',
      metadata: {
        runMode: 'test',
      },
    }

    const usage: TokenUsage = {
      inputTokens: 42,
      outputTokens: 18,
      cachedInputTokens: 4,
      costCents: 12,
    }

    expect(providerIds).toHaveLength(7)
    expect(providerIds).toContain('openrouter')
    expect(capabilityProfile.maxContextTokens).toBe(128_000)
    expect(config.providerOptions).toEqual(
      expect.objectContaining({
        capabilities: expect.objectContaining({
          supportsStreaming: true,
        }),
      }),
    )
    expect(input.prompt).toBe('Review this change')
    expect(health.healthy).toBe(true)
    expect(session.providerId).toBe('claude')
    expect(usage.inputTokens).toBe(42)
  })

  it('keeps tool call/result events backward-compatible when toolCallId is omitted', () => {
    const toolCallEvent: AgentToolCallEvent = {
      type: 'adapter:tool_call',
      providerId: 'claude',
      toolName: 'search_docs',
      input: { q: 'contract widening' },
      timestamp: 1,
    }
    const toolResultEvent: AgentToolResultEvent = {
      type: 'adapter:tool_result',
      providerId: 'claude',
      toolName: 'search_docs',
      output: 'ok',
      durationMs: 2,
      timestamp: 3,
    }

    expect('toolCallId' in toolCallEvent).toBe(false)
    expect('toolCallId' in toolResultEvent).toBe(false)
  })

  it('passes through explicit toolCallId for tool call/result events', () => {
    const toolCallEvent: AgentToolCallEvent = {
      type: 'adapter:tool_call',
      providerId: 'claude',
      toolName: 'search_docs',
      toolCallId: 'call_123',
      input: { q: 'identity' },
      timestamp: 10,
    }
    const toolResultEvent: AgentToolResultEvent = {
      type: 'adapter:tool_result',
      providerId: 'claude',
      toolName: 'search_docs',
      toolCallId: 'call_123',
      output: 'done',
      durationMs: 5,
      timestamp: 15,
    }

    expect(toolCallEvent.toolCallId).toBe('call_123')
    expect(toolResultEvent.toolCallId).toBe('call_123')
  })
})

import { describe, expect, it } from 'vitest'
import type {
  AdapterCapabilityProfile,
  AdapterConfig,
  AdapterProviderId,
  AgentEvent,
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

  it('keeps tool call/result contracts backward compatible when toolCallId is omitted', () => {
    const toolCall: AgentToolCallEvent = {
      type: 'adapter:tool_call',
      providerId: 'claude',
      toolName: 'search',
      input: { q: 'latest release notes' },
      timestamp: 1,
    }

    const toolResult: AgentToolResultEvent = {
      type: 'adapter:tool_result',
      providerId: 'claude',
      toolName: 'search',
      output: 'ok',
      durationMs: 12,
      timestamp: 2,
    }

    expect(Object.hasOwn(toolCall, 'toolCallId')).toBe(false)
    expect(Object.hasOwn(toolResult, 'toolCallId')).toBe(false)
    expect(toolCall.toolCallId).toBeUndefined()
    expect(toolResult.toolCallId).toBeUndefined()
  })

  it('preserves toolCallId only when explicitly supplied across mixed event sequences', () => {
    const events: AgentEvent[] = [
      {
        type: 'adapter:tool_call',
        providerId: 'claude',
        toolName: 'legacy-tool',
        input: { mode: 'legacy' },
        timestamp: 10,
      },
      {
        type: 'adapter:tool_call',
        providerId: 'claude',
        toolName: 'modern-tool',
        input: { mode: 'modern' },
        toolCallId: 'tool-call-2',
        timestamp: 11,
      },
      {
        type: 'adapter:tool_result',
        providerId: 'claude',
        toolName: 'legacy-tool',
        output: 'legacy-ok',
        durationMs: 5,
        timestamp: 12,
      },
      {
        type: 'adapter:tool_result',
        providerId: 'claude',
        toolName: 'modern-tool',
        output: 'modern-ok',
        durationMs: 6,
        toolCallId: 'tool-call-2',
        timestamp: 13,
      },
    ]

    const [legacyCall, identifiedCall, legacyResult, identifiedResult] = events
    expect(legacyCall?.type).toBe('adapter:tool_call')
    if (legacyCall?.type === 'adapter:tool_call') {
      expect(legacyCall.toolCallId).toBeUndefined()
      expect(Object.hasOwn(legacyCall, 'toolCallId')).toBe(false)
    }

    expect(identifiedCall?.type).toBe('adapter:tool_call')
    if (identifiedCall?.type === 'adapter:tool_call') {
      expect(identifiedCall.toolCallId).toBe('tool-call-2')
    }

    expect(legacyResult?.type).toBe('adapter:tool_result')
    if (legacyResult?.type === 'adapter:tool_result') {
      expect(legacyResult.toolCallId).toBeUndefined()
      expect(Object.hasOwn(legacyResult, 'toolCallId')).toBe(false)
    }

    expect(identifiedResult?.type).toBe('adapter:tool_result')
    if (identifiedResult?.type === 'adapter:tool_result') {
      expect(identifiedResult.toolCallId).toBe('tool-call-2')
    }
  })
})

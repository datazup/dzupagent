import { describe, expect, it } from 'vitest'
import type {
  AgentArtifactEvent,
  GovernanceEvent,
  RawAgentEvent,
  RunSummary,
} from '../index.js'

function roundTripJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function summarizeGovernanceEvent(event: GovernanceEvent): string {
  switch (event.type) {
    case 'governance:approval_requested':
      return `approval_requested:${event.runId}:${event.interactionId}:${event.providerId}`
    case 'governance:approval_resolved':
      return `approval_resolved:${event.runId}:${event.interactionId}:${event.resolution}`
    case 'governance:hook_executed':
      return `hook_executed:${event.runId}:${event.hookName}:${event.exitCode ?? 'na'}`
    case 'governance:rule_violation':
      return `rule_violation:${event.runId}:${event.ruleId}:${event.severity}`
    case 'governance:dangerous_command':
      return `dangerous_command:${event.runId}:${event.blocked}:${event.command}`
  }
}

describe('adapter run-store contract fixtures', () => {
  it('round-trips a persisted raw provider event without widening required fields', () => {
    const rawEvent: RawAgentEvent = {
      providerId: 'codex',
      runId: 'run-123',
      sessionId: 'session-123',
      providerEventId: 'provider-evt-1',
      parentProviderEventId: 'provider-evt-root',
      timestamp: 1_746_000_001_000,
      source: 'sdk',
      payload: {
        type: 'response.output_text.delta',
        delta: 'hello',
      },
      correlationId: 'corr-123',
    }

    const parsed = roundTripJson(rawEvent)

    expect(parsed).toEqual(rawEvent)
    expect(parsed.payload).toMatchObject({
      type: 'response.output_text.delta',
      delta: 'hello',
    })
  })

  it('keeps artifact mutation events serializable for jsonl persistence', () => {
    const artifact: AgentArtifactEvent = {
      runId: 'run-123',
      providerId: 'claude',
      timestamp: 1_746_000_002_000,
      artifactType: 'checkpoint',
      path: '/workspace/project/.dzupagent/runs/run-123/checkpoint.json',
      action: 'updated',
      metadata: {
        bytesWritten: 512,
        format: 'json',
      },
      correlationId: 'corr-123',
    }

    const parsed = roundTripJson(artifact)

    expect(parsed).toEqual(artifact)
    expect(parsed.action).toBe('updated')
    expect(parsed.artifactType).toBe('checkpoint')
  })

  it('preserves governance union exhaustiveness across the side-channel event plane', () => {
    const events = [
      {
        type: 'governance:approval_requested',
        runId: 'run-123',
        sessionId: 'session-123',
        interactionId: 'approval-1',
        providerId: 'codex',
        timestamp: 1,
        prompt: 'Allow running `git status`?',
        commandPreview: 'git status',
      },
      {
        type: 'governance:approval_resolved',
        runId: 'run-123',
        sessionId: 'session-123',
        interactionId: 'approval-1',
        providerId: 'codex',
        timestamp: 2,
        resolution: 'approved',
      },
      {
        type: 'governance:hook_executed',
        runId: 'run-123',
        sessionId: 'session-123',
        providerId: 'codex',
        timestamp: 3,
        hookName: 'pre-command',
        exitCode: 0,
      },
      {
        type: 'governance:rule_violation',
        runId: 'run-123',
        sessionId: 'session-123',
        providerId: 'codex',
        timestamp: 4,
        ruleId: 'no-network',
        severity: 'block',
        detail: 'Outbound curl denied',
      },
      {
        type: 'governance:dangerous_command',
        runId: 'run-123',
        sessionId: 'session-123',
        providerId: 'codex',
        timestamp: 5,
        command: 'rm -rf /tmp/demo',
        blocked: true,
      },
    ] satisfies GovernanceEvent[]

    expect(events.map(summarizeGovernanceEvent)).toEqual([
      'approval_requested:run-123:approval-1:codex',
      'approval_resolved:run-123:approval-1:approved',
      'hook_executed:run-123:pre-command:0',
      'rule_violation:run-123:no-network:block',
      'dangerous_command:run-123:true:rm -rf /tmp/demo',
    ])
  })

  it('models a terminal run summary with persisted usage telemetry', () => {
    const summary: RunSummary = {
      runId: 'run-123',
      providerId: 'openrouter',
      sessionId: 'session-123',
      startedAt: 1_746_000_000_000,
      completedAt: 1_746_000_010_000,
      durationMs: 10_000,
      toolCallCount: 3,
      artifactCount: 2,
      tokenUsage: {
        inputTokens: 512,
        outputTokens: 96,
        cachedInputTokens: 128,
        costCents: 44,
      },
      status: 'completed',
      correlationId: 'corr-123',
    }

    const parsed = roundTripJson(summary)

    expect(parsed).toEqual(summary)
    expect(parsed.tokenUsage?.cachedInputTokens).toBe(128)
    expect(parsed.status).toBe('completed')
  })
})

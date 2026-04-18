import { describe, expect, it } from 'vitest'
import type {
  AgentCompletedEvent,
  AgentEvent,
  AgentFailedEvent,
  AgentMessageEvent,
  AgentProgressEvent,
  AgentRecoveryCancelledEvent,
  AgentStartedEvent,
  AgentToolCallEvent,
  AgentToolResultEvent,
  AgentStreamDeltaEvent,
} from '../index.js'

function assertNever(value: never): never {
  throw new Error(`Unexpected event: ${JSON.stringify(value)}`)
}

function summarizeAdapterEvents(events: AgentEvent[]): string {
  return events
    .map((event) => {
      switch (event.type) {
        case 'adapter:started':
          return `started:${event.sessionId}:${event.providerId}`
        case 'adapter:message':
          return `message:${event.role}:${event.content}`
        case 'adapter:tool_call':
          return `tool_call:${event.toolName}`
        case 'adapter:tool_result':
          return `tool_result:${event.toolName}:${event.durationMs}`
        case 'adapter:completed':
          return `completed:${event.sessionId}:${event.result}`
        case 'adapter:failed':
          return `failed:${event.code ?? 'unknown'}:${event.error}`
        case 'recovery:cancelled':
          return `recovery_cancelled:${event.totalAttempts}:${event.strategy}`
        case 'adapter:stream_delta':
          return `stream_delta:${event.content}`
        case 'adapter:progress':
          return `progress:${event.phase}:${event.percentage ?? 'na'}`
        case 'adapter:memory_recalled':
          return `memory_recalled:${event.totalTokens}`
        case 'adapter:skills_compiled':
          return `skills_compiled:${event.skills.length}`
        case 'adapter:interaction_required':
          return `interaction_required:${event.interactionId}:${event.kind}`
        case 'adapter:interaction_resolved':
          return `interaction_resolved:${event.interactionId}:${event.resolvedBy}`
        default:
          return assertNever(event)
      }
    })
    .join(' -> ')
}

describe('adapter-types integration contract', () => {
  it('models a complete adapter lifecycle with typed discriminated events', () => {
    const started: AgentStartedEvent = {
      type: 'adapter:started',
      providerId: 'qwen',
      sessionId: 'session-456',
      timestamp: 1,
      prompt: 'Summarize this pull request',
      systemPrompt: 'Be rigorous.',
      model: 'qwen-max',
      workingDirectory: '/workspace/project',
      isResume: false,
      correlationId: 'corr-456',
    }

    const message: AgentMessageEvent = {
      type: 'adapter:message',
      providerId: 'qwen',
      content: 'Acknowledged.',
      role: 'assistant',
      timestamp: 2,
      correlationId: 'corr-456',
    }

    const progress: AgentProgressEvent = {
      type: 'adapter:progress',
      providerId: 'qwen',
      timestamp: 3,
      phase: 'planning',
      percentage: 25,
      message: 'Planning the work',
      current: 1,
      total: 4,
      correlationId: 'corr-456',
    }

    const toolCall: AgentToolCallEvent = {
      type: 'adapter:tool_call',
      providerId: 'qwen',
      toolName: 'read_file',
      input: { path: 'README.md' },
      timestamp: 4,
      correlationId: 'corr-456',
    }

    const toolResult: AgentToolResultEvent = {
      type: 'adapter:tool_result',
      providerId: 'qwen',
      toolName: 'read_file',
      output: 'file contents',
      durationMs: 14,
      timestamp: 5,
      correlationId: 'corr-456',
    }

    const delta: AgentStreamDeltaEvent = {
      type: 'adapter:stream_delta',
      providerId: 'qwen',
      content: 'partial output',
      timestamp: 6,
      correlationId: 'corr-456',
    }

    const completed: AgentCompletedEvent = {
      type: 'adapter:completed',
      providerId: 'qwen',
      sessionId: 'session-456',
      result: 'done',
      usage: {
        inputTokens: 128,
        outputTokens: 32,
        costCents: 17,
      },
      durationMs: 1024,
      timestamp: 7,
      correlationId: 'corr-456',
    }

    const events = [started, message, progress, toolCall, toolResult, delta, completed] satisfies AgentEvent[]

    expect(summarizeAdapterEvents(events)).toBe(
      'started:session-456:qwen -> message:assistant:Acknowledged. -> progress:planning:25 -> tool_call:read_file -> tool_result:read_file:14 -> stream_delta:partial output -> completed:session-456:done',
    )
  })

  it('preserves failure and recovery terminal contracts without widening the union', () => {
    const failed: AgentFailedEvent = {
      type: 'adapter:failed',
      providerId: 'crush',
      sessionId: 'session-789',
      error: 'Process exited with code 1',
      code: 'CLI_FAILURE',
      timestamp: 10,
      correlationId: 'corr-789',
    }

    const cancelled: AgentRecoveryCancelledEvent = {
      type: 'recovery:cancelled',
      providerId: 'crush',
      strategy: 'abort',
      error: 'Timed out while recovering',
      totalAttempts: 3,
      totalDurationMs: 88,
      timestamp: 11,
      correlationId: 'corr-789',
    }

    const events = [failed, cancelled] satisfies AgentEvent[]

    expect(summarizeAdapterEvents(events)).toBe(
      'failed:CLI_FAILURE:Process exited with code 1 -> recovery_cancelled:3:abort',
    )
  })
})

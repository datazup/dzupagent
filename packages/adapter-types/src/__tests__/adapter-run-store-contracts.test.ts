import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'
import type {
  AgentArtifactEvent,
  GovernanceEvent,
  ProviderRawStreamEvent,
  RawAgentEvent,
  RunSummary,
} from '../index.js'

function roundTripJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function loadJsonFixture<T>(name: string): T {
  const path = resolve(import.meta.dirname, 'fixtures', name)
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function expectStringField(record: Record<string, unknown>, key: string): void {
  expect(typeof record[key]).toBe('string')
}

function expectNumberField(record: Record<string, unknown>, key: string): void {
  expect(typeof record[key]).toBe('number')
}

function expectOptionalStringField(record: Record<string, unknown>, key: string): void {
  if (key in record) {
    expect(typeof record[key]).toBe('string')
  }
}

function expectRawAgentEventShape(value: unknown): asserts value is RawAgentEvent {
  expect(isRecord(value)).toBe(true)
  const record = value as Record<string, unknown>
  expectStringField(record, 'providerId')
  expectStringField(record, 'runId')
  expectNumberField(record, 'timestamp')
  expect(['stdout', 'stderr', 'sdk', 'ipc']).toContain(record['source'])
  expect('payload' in record).toBe(true)
  expectOptionalStringField(record, 'sessionId')
  expectOptionalStringField(record, 'providerEventId')
  expectOptionalStringField(record, 'parentProviderEventId')
  expectOptionalStringField(record, 'correlationId')
}

function expectAgentArtifactEventShape(value: unknown): asserts value is AgentArtifactEvent {
  expect(isRecord(value)).toBe(true)
  const record = value as Record<string, unknown>
  expectStringField(record, 'runId')
  expectStringField(record, 'providerId')
  expectNumberField(record, 'timestamp')
  expect(['transcript', 'checkpoint', 'output', 'log', 'other']).toContain(record['artifactType'])
  expectStringField(record, 'path')
  expect(['created', 'updated', 'deleted']).toContain(record['action'])
  if ('metadata' in record) {
    expect(isRecord(record['metadata'])).toBe(true)
  }
  expectOptionalStringField(record, 'correlationId')
}

function expectRunSummaryShape(value: unknown): asserts value is RunSummary {
  expect(isRecord(value)).toBe(true)
  const record = value as Record<string, unknown>
  expectStringField(record, 'runId')
  expectStringField(record, 'providerId')
  expectNumberField(record, 'startedAt')
  expectNumberField(record, 'completedAt')
  expectNumberField(record, 'durationMs')
  expectNumberField(record, 'toolCallCount')
  expectNumberField(record, 'artifactCount')
  expect(['completed', 'failed', 'cancelled']).toContain(record['status'])
  expectOptionalStringField(record, 'sessionId')
  expectOptionalStringField(record, 'errorMessage')
  expectOptionalStringField(record, 'correlationId')
  if ('tokenUsage' in record) {
    expect(isRecord(record['tokenUsage'])).toBe(true)
    const tokenUsage = record['tokenUsage'] as Record<string, unknown>
    expectNumberField(tokenUsage, 'inputTokens')
    expectNumberField(tokenUsage, 'outputTokens')
    if ('cachedInputTokens' in tokenUsage) {
      expect(typeof tokenUsage['cachedInputTokens']).toBe('number')
    }
    if ('costCents' in tokenUsage) {
      expect(typeof tokenUsage['costCents']).toBe('number')
    }
  }
}

function expectProviderRawStreamEventShape(value: unknown): asserts value is ProviderRawStreamEvent {
  expect(isRecord(value)).toBe(true)
  const record = value as Record<string, unknown>
  expect(record['type']).toBe('adapter:provider_raw')
  expect('rawEvent' in record).toBe(true)
  expectRawAgentEventShape(record['rawEvent'])
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
  it('keeps backward-compatible persisted raw provider fixtures valid at runtime', () => {
    const minimalFixture = loadJsonFixture<unknown>('raw-agent-event.v1-minimal.json')
    const richFixture = loadJsonFixture<unknown>('raw-agent-event.v1-rich.json')

    expectRawAgentEventShape(minimalFixture)
    expectRawAgentEventShape(richFixture)
    expect(roundTripJson(minimalFixture)).toEqual(minimalFixture)
    expect(roundTripJson(richFixture)).toEqual(richFixture)

    expect((richFixture.payload as Record<string, unknown>)).toMatchObject({
      type: 'response.output_text.delta',
      delta: 'hello',
    })
  })

  it('keeps backward-compatible artifact fixtures valid for jsonl persistence', () => {
    const minimalFixture = loadJsonFixture<unknown>('agent-artifact-event.v1-minimal.json')
    const richFixture = loadJsonFixture<unknown>('agent-artifact-event.v1-rich.json')

    expectAgentArtifactEventShape(minimalFixture)
    expectAgentArtifactEventShape(richFixture)
    expect(roundTripJson(minimalFixture)).toEqual(minimalFixture)
    expect(roundTripJson(richFixture)).toEqual(richFixture)

    expect((richFixture as AgentArtifactEvent).action).toBe('updated')
    expect((richFixture as AgentArtifactEvent).artifactType).toBe('checkpoint')
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

  it('keeps backward-compatible run summary fixtures valid with usage telemetry', () => {
    const minimalFixture = loadJsonFixture<unknown>('run-summary.v1-minimal.json')
    const richFixture = loadJsonFixture<unknown>('run-summary.v1-rich.json')

    expectRunSummaryShape(minimalFixture)
    expectRunSummaryShape(richFixture)
    expect(roundTripJson(minimalFixture)).toEqual(minimalFixture)
    expect(roundTripJson(richFixture)).toEqual(richFixture)

    expect((richFixture as RunSummary).tokenUsage?.cachedInputTokens).toBe(128)
    expect((richFixture as RunSummary).status).toBe('completed')
  })

  it('keeps the live provider-raw wrapper aligned with the persisted raw-event plane', () => {
    const fixture = loadJsonFixture<unknown>('provider-raw-stream-event.v1-rich.json')

    expectProviderRawStreamEventShape(fixture)
    expect(roundTripJson(fixture)).toEqual(fixture)

    const typedFixture = fixture as ProviderRawStreamEvent
    expect(typedFixture.type).toBe('adapter:provider_raw')
    expect(typedFixture.rawEvent.providerEventId).toBe('provider-evt-1')
  })
})

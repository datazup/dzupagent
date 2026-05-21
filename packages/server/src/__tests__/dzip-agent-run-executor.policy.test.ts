import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryRunStore, ModelRegistry, createEventBus } from '@dzupagent/core'
import type { RunExecutionContext } from '../runtime/run-worker.js'

/**
 * AGENT-H-01 — createDzupAgentRunExecutor must forward policy/observability
 * surfaces (guardrails, auditStore, auditRedaction, toolExecution,
 * providerFailover, memoryScope, eventBus) into DzupAgent on every run.
 * Without this wiring, the server executor bypasses framework-level
 * safety, compliance, and tenant-isolation guarantees.
 */

let capturedConfig: Record<string, unknown> = {}

vi.mock('@dzupagent/agent/runtime', () => ({
  DzupAgent: class {
    constructor(config: Record<string, unknown>) {
      capturedConfig = config
    }
    async *stream(): AsyncGenerator<{ type: string; data: Record<string, unknown> }, void, undefined> {
      yield { type: 'done', data: { content: 'ok', hitIterationLimit: false } }
    }
  },
}))

vi.mock('../runtime/tool-resolver.js', () => ({
  resolveAgentTools: async () => ({
    tools: [],
    activated: [],
    unresolved: [],
    warnings: [],
    cleanup: async () => {},
  }),
}))

import { createDzupAgentRunExecutor } from '../runtime/dzip-agent-run-executor.js'
import type { GuardrailConfig, ToolExecutionConfig, ProviderFailoverPolicy, AuditRedactionPolicy, LlmCallAuditSink } from '@dzupagent/agent/runtime'

function baseContext(overrides?: Partial<RunExecutionContext>): RunExecutionContext {
  return {
    runId: 'run-policy-1',
    agentId: 'agent-policy-1',
    input: 'run the task',
    metadata: {},
    agent: {
      id: 'agent-policy-1',
      name: 'PolicyAgent',
      instructions: 'You are helpful',
      modelTier: 'chat',
    },
    runStore: new InMemoryRunStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe('dzip-agent-run-executor policy forwarding (AGENT-H-01)', () => {
  beforeEach(() => {
    capturedConfig = {}
    vi.clearAllMocks()
  })

  it('forwards eventBus from ctx into DzupAgent', async () => {
    const eventBus = createEventBus()
    const executor = createDzupAgentRunExecutor()
    await executor(baseContext({ eventBus }))
    expect(capturedConfig['eventBus']).toBe(eventBus)
  })

  it('forwards guardrails option into DzupAgent', async () => {
    const guardrails: GuardrailConfig = { maxTokens: 50000, blockedTools: ['rm'] }
    const executor = createDzupAgentRunExecutor({ guardrails })
    await executor(baseContext())
    expect(capturedConfig['guardrails']).toBe(guardrails)
  })

  it('forwards auditStore option into DzupAgent', async () => {
    const auditStore: LlmCallAuditSink = { record: vi.fn().mockResolvedValue(undefined) }
    const executor = createDzupAgentRunExecutor({ auditStore })
    await executor(baseContext())
    expect(capturedConfig['auditStore']).toBe(auditStore)
  })

  it('forwards auditRedaction option into DzupAgent', async () => {
    const auditRedaction: AuditRedactionPolicy = { mode: 'secrets', includeFullPayloads: false }
    const executor = createDzupAgentRunExecutor({ auditRedaction })
    await executor(baseContext())
    expect(capturedConfig['auditRedaction']).toEqual(auditRedaction)
  })

  it('forwards toolExecution option into DzupAgent', async () => {
    const toolExecution: ToolExecutionConfig = {}
    const executor = createDzupAgentRunExecutor({ toolExecution })
    await executor(baseContext())
    expect(capturedConfig['toolExecution']).toBe(toolExecution)
  })

  it('forwards providerFailover option into DzupAgent', async () => {
    const providerFailover: ProviderFailoverPolicy = { maxAttempts: 2 } as ProviderFailoverPolicy
    const executor = createDzupAgentRunExecutor({ providerFailover })
    await executor(baseContext())
    expect(capturedConfig['providerFailover']).toBe(providerFailover)
  })

  it('uses explicit memoryScope option over derived tenantId', async () => {
    const memoryScope = { tenantId: 'explicit-tenant', region: 'us-east-1' }
    const executor = createDzupAgentRunExecutor({ memoryScope })
    await executor(baseContext({ metadata: { tenantId: 'ctx-tenant' } }))
    expect(capturedConfig['memoryScope']).toEqual(memoryScope)
  })

  it('derives memoryScope from ctx.metadata.tenantId when no explicit memoryScope', async () => {
    const executor = createDzupAgentRunExecutor()
    await executor(baseContext({ metadata: { tenantId: 'tenant-abc' } }))
    expect(capturedConfig['memoryScope']).toEqual({ tenantId: 'tenant-abc' })
  })

  it('omits memoryScope when no tenantId and no explicit scope', async () => {
    const executor = createDzupAgentRunExecutor()
    await executor(baseContext({ metadata: {} }))
    expect(capturedConfig['memoryScope']).toBeUndefined()
  })

  it('omits policy fields from DzupAgent when no options provided', async () => {
    const executor = createDzupAgentRunExecutor()
    await executor(baseContext())
    expect(capturedConfig['guardrails']).toBeUndefined()
    expect(capturedConfig['auditStore']).toBeUndefined()
    expect(capturedConfig['toolExecution']).toBeUndefined()
    expect(capturedConfig['providerFailover']).toBeUndefined()
  })
})

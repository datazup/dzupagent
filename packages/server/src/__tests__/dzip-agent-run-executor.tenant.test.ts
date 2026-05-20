import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryRunStore, ModelRegistry, createEventBus, type DzupEvent } from '@dzupagent/core'
import type { RunExecutionContext } from '../runtime/run-worker.js'

/**
 * SEC-M-01-FOLLOWUP — every envelope emitted by the DzupAgent run executor
 * must carry `tenantId` when `ctx.metadata.tenantId` is set. The SSE route
 * relies on this tenant stamp to filter events per tenant via
 * `getEnvelopeTenantId`. Without the stamp, the gateway falls back to
 * `DEFAULT_TENANT_ID` and tenant scoping is a no-op.
 */

const streamedEvents: Array<{ type: string; data: Record<string, unknown> }> = []

vi.mock('@dzupagent/agent/runtime', () => ({
  DzupAgent: class {
    async *stream(): AsyncGenerator<{ type: string; data: Record<string, unknown> }, void, undefined> {
      for (const event of streamedEvents) {
        yield event
      }
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

function makeContext(
  eventBus: ReturnType<typeof createEventBus>,
  tenantId: string | undefined,
  runId = 'run-tenant-1',
): RunExecutionContext {
  return {
    runId,
    agentId: 'agent-tenant-1',
    input: { message: 'hello' },
    metadata: tenantId !== undefined ? { tenantId } : {},
    agent: {
      id: 'agent-tenant-1',
      name: 'Agent Tenant',
      instructions: 'Be concise',
      modelTier: 'chat',
    },
    runStore: new InMemoryRunStore(),
    eventBus,
    modelRegistry: new ModelRegistry(),
    signal: new AbortController().signal,
  }
}

type WithTenant = { tenantId?: string }

describe('dzip-agent-run-executor tenant stamping (SEC-M-01-FOLLOWUP)', () => {
  beforeEach(() => {
    streamedEvents.length = 0
    vi.clearAllMocks()
  })

  it('stamps tenantId on tool_call, tool_result, stream_delta, and stream_done envelopes', async () => {
    streamedEvents.push(
      { type: 'text', data: { content: 'thinking...' } },
      { type: 'tool_call', data: { name: 'read_file', args: { path: '/tmp/a.ts' } } },
      { type: 'tool_result', data: { name: 'read_file', result: 'ok' } },
      { type: 'done', data: { content: 'final output', hitIterationLimit: false } },
    )

    const bus = createEventBus()
    const emitted: DzupEvent[] = []
    bus.onAny((event) => emitted.push(event))

    const executor = createDzupAgentRunExecutor()
    await executor(makeContext(bus, 'tenant-A'))

    const inspected = ['agent:stream_delta', 'tool:called', 'tool:result', 'agent:stream_done']
    for (const type of inspected) {
      const env = emitted.find((event) => event.type === type) as DzupEvent & WithTenant
      expect(env, `expected to emit ${type}`).toBeDefined()
      expect(env.tenantId, `${type} must carry tenantId`).toBe('tenant-A')
    }
  })

  it('stamps tenantId on tool:error when the stream errors during a tool call', async () => {
    streamedEvents.push(
      { type: 'tool_call', data: { name: 'failing_tool', args: {} } },
      { type: 'error', data: { message: 'boom' } },
    )

    const bus = createEventBus()
    const emitted: DzupEvent[] = []
    bus.onAny((event) => emitted.push(event))

    const executor = createDzupAgentRunExecutor()
    await expect(executor(makeContext(bus, 'tenant-B'))).rejects.toThrow(/boom/)

    const toolError = emitted.find((event) => event.type === 'tool:error') as DzupEvent & WithTenant
    expect(toolError).toBeDefined()
    expect(toolError.tenantId).toBe('tenant-B')
  })

  it('stamps tenantId on run:halted:token-exhausted', async () => {
    streamedEvents.push(
      {
        type: 'done',
        data: { content: '', hitIterationLimit: false, stopReason: 'token_exhausted', iterations: 7 },
      },
    )

    const bus = createEventBus()
    const emitted: DzupEvent[] = []
    bus.onAny((event) => emitted.push(event))

    const executor = createDzupAgentRunExecutor()
    await executor(makeContext(bus, 'tenant-C'))

    const halted = emitted.find((event) => event.type === 'run:halted:token-exhausted') as DzupEvent & WithTenant
    expect(halted).toBeDefined()
    expect(halted.tenantId).toBe('tenant-C')
  })

  it('omits tenantId when ctx.metadata has no tenantId (legacy single-tenant)', async () => {
    streamedEvents.push(
      { type: 'tool_call', data: { name: 'read_file', args: {} } },
      { type: 'tool_result', data: { name: 'read_file', result: 'ok' } },
      { type: 'done', data: { content: 'done', hitIterationLimit: false } },
    )

    const bus = createEventBus()
    const emitted: DzupEvent[] = []
    bus.onAny((event) => emitted.push(event))

    const executor = createDzupAgentRunExecutor()
    await executor(makeContext(bus, undefined))

    // No tenant stamp; gateway will fall back to DEFAULT_TENANT_ID.
    for (const event of emitted as Array<DzupEvent & WithTenant>) {
      expect(event.tenantId).toBeUndefined()
    }
  })
})

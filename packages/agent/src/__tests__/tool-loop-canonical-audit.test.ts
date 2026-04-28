/**
 * RF-AGENT-05 — canonical tool lifecycle telemetry contract.
 *
 * Verifies that the primary tool execution path in `runToolLoop` emits
 * `tool:called` + `tool:result` (success) and `tool:called` + `tool:error`
 * (failure) events with the canonical fields:
 *   - agentId, runId, toolCallId
 *   - toolName
 *   - inputMetadataKeys (KEYS only — never values)
 *   - status ('success' | 'error' | 'timeout' | 'denied')
 *   - durationMs
 *   - errorCode + errorMessage on terminal error events
 *
 * Critically: secrets/values from tool inputs MUST NOT leak into the
 * emitted events. Only the top-level metadata keys are allowed.
 */

import { describe, it, expect, vi } from 'vitest'
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { createEventBus, type DzupEvent, type DzupEventBus } from '@dzupagent/core'
import { runToolLoop } from '../agent/tool-loop.js'

function mockTool(name: string, result = 'ok'): StructuredToolInterface {
  return {
    name,
    description: `Mock ${name}`,
    schema: {} as never,
    lc_namespace: [] as string[],
    invoke: vi.fn(async () => result),
  } as unknown as StructuredToolInterface
}

function failingTool(name: string, errorMsg = 'kaboom'): StructuredToolInterface {
  return {
    name,
    description: `Failing ${name}`,
    schema: {} as never,
    lc_namespace: [] as string[],
    invoke: vi.fn(async () => {
      throw new Error(errorMsg)
    }),
  } as unknown as StructuredToolInterface
}

function createMockModel(responses: AIMessage[]): BaseChatModel {
  let callIdx = 0
  return {
    invoke: vi.fn(async (_msgs: BaseMessage[]) => {
      const resp = responses[callIdx] ?? new AIMessage('done')
      callIdx++
      return resp
    }),
  } as unknown as BaseChatModel
}

function aiWithToolCalls(calls: Array<{ name: string; args: Record<string, unknown> }>) {
  const msg = new AIMessage({ content: '' })
  ;(msg as AIMessage & { tool_calls: unknown[] }).tool_calls = calls.map((c, i) => ({
    id: `tc_${i}`,
    name: c.name,
    args: c.args,
  }))
  return msg
}

function captureToolEvents(bus: DzupEventBus): DzupEvent[] {
  const events: DzupEvent[] = []
  bus.onAny((e) => {
    if (e.type === 'tool:called' || e.type === 'tool:result' || e.type === 'tool:error') {
      events.push(e)
    }
  })
  return events
}

describe('Tool Loop — RF-AGENT-05 canonical lifecycle events', () => {
  it('emits tool:called + tool:result with sanitized input keys on success', async () => {
    const bus = createEventBus()
    const events = captureToolEvents(bus)

    const tool = mockTool('read_file', 'file contents')
    const model = createMockModel([
      aiWithToolCalls([
        {
          name: 'read_file',
          args: { path: '/etc/passwd', apiKey: 'sk-secret-do-not-log' },
        },
      ]),
      new AIMessage('done'),
    ])

    await runToolLoop(model, [new HumanMessage('go')], [tool], {
      maxIterations: 5,
      eventBus: bus,
      agentId: 'agent_42',
      runId: 'run_xyz',
    })

    expect(events).toHaveLength(2)

    const called = events[0]!
    expect(called.type).toBe('tool:called')
    if (called.type !== 'tool:called') throw new Error('unreachable')
    expect(called.toolName).toBe('read_file')
    expect(called.toolCallId).toBe('tc_0')
    expect(called.agentId).toBe('agent_42')
    expect(called.runId).toBe('run_xyz')
    expect(called.executionRunId).toBe('run_xyz')
    expect(called.inputMetadataKeys).toEqual(['path', 'apiKey'])
    expect(called).not.toHaveProperty('input')

    const terminal = events[1]!
    expect(terminal.type).toBe('tool:result')
    if (terminal.type !== 'tool:result') throw new Error('unreachable')
    expect(terminal.toolName).toBe('read_file')
    expect(terminal.toolCallId).toBe('tc_0')
    expect(terminal.agentId).toBe('agent_42')
    expect(terminal.runId).toBe('run_xyz')
    expect(terminal.status).toBe('success')
    expect(typeof terminal.durationMs).toBe('number')
    expect(terminal.durationMs).toBeGreaterThanOrEqual(0)
    expect(terminal.inputMetadataKeys).toEqual(['path', 'apiKey'])
  })

  it('never leaks raw input VALUES through canonical events', async () => {
    const bus = createEventBus()
    const events = captureToolEvents(bus)

    const tool = mockTool('login', 'ok')
    const secret = 'sk-live-1234567890-DO-NOT-LEAK'
    const model = createMockModel([
      aiWithToolCalls([
        { name: 'login', args: { username: 'alice', password: secret } },
      ]),
      new AIMessage('done'),
    ])

    await runToolLoop(model, [new HumanMessage('go')], [tool], {
      maxIterations: 5,
      eventBus: bus,
      agentId: 'agent_secrets',
      runId: 'run_secrets',
    })

    for (const e of events) {
      if (e.type !== 'tool:called') continue
      // inputMetadataKeys must hold KEYS only.
      expect(e.inputMetadataKeys).toEqual(['username', 'password'])
      expect(e).not.toHaveProperty('input')
      const keysJson = JSON.stringify(e.inputMetadataKeys)
      expect(keysJson).not.toContain(secret)
      expect(keysJson).not.toContain('alice')
    }

    for (const e of events) {
      const serialized = JSON.stringify(e)
      expect(serialized).not.toContain(secret)
      expect(serialized).not.toContain('alice')
    }
  })

  it('emits tool:called + tool:error with status=error and errorCode/errorMessage on failure', async () => {
    const bus = createEventBus()
    const events = captureToolEvents(bus)

    const tool = failingTool('flaky_tool', 'underlying failure')
    const model = createMockModel([
      aiWithToolCalls([{ name: 'flaky_tool', args: { jobId: 'j1' } }]),
      new AIMessage('giving up'),
    ])

    await runToolLoop(model, [new HumanMessage('go')], [tool], {
      maxIterations: 5,
      eventBus: bus,
      agentId: 'agent_99',
      runId: 'run_fail',
    })

    expect(events).toHaveLength(2)

    const called = events[0]!
    expect(called.type).toBe('tool:called')
    if (called.type !== 'tool:called') throw new Error('unreachable')
    expect(called.toolName).toBe('flaky_tool')
    expect(called.inputMetadataKeys).toEqual(['jobId'])
    expect(called.toolCallId).toBe('tc_0')

    const terminal = events[1]!
    expect(terminal.type).toBe('tool:error')
    if (terminal.type !== 'tool:error') throw new Error('unreachable')
    expect(terminal.toolName).toBe('flaky_tool')
    expect(terminal.toolCallId).toBe('tc_0')
    expect(terminal.agentId).toBe('agent_99')
    expect(terminal.runId).toBe('run_fail')
    expect(terminal.status).toBe('error')
    expect(terminal.errorCode).toBe('TOOL_EXECUTION_FAILED')
    expect(terminal.message).toBe('underlying failure')
    expect(terminal.errorMessage).toBe('underlying failure')
    expect(terminal.inputMetadataKeys).toEqual(['jobId'])
    expect(typeof terminal.durationMs).toBe('number')
  })

  it('labels timeout errors with status=timeout and errorCode=TOOL_TIMEOUT', async () => {
    const bus = createEventBus()
    const events = captureToolEvents(bus)

    const tool = {
      name: 'slow_tool',
      description: 'slow',
      schema: {} as never,
      lc_namespace: [] as string[],
      invoke: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 100))
        return 'too late'
      }),
    } as unknown as StructuredToolInterface

    const model = createMockModel([
      aiWithToolCalls([{ name: 'slow_tool', args: { url: 'x' } }]),
      new AIMessage('done'),
    ])

    await runToolLoop(model, [new HumanMessage('go')], [tool], {
      maxIterations: 5,
      eventBus: bus,
      agentId: 'agent_t',
      runId: 'run_t',
      toolTimeouts: { slow_tool: 10 },
    })

    const errEvent = events.find((e) => e.type === 'tool:error')
    expect(errEvent).toBeDefined()
    if (errEvent?.type !== 'tool:error') throw new Error('unreachable')
    expect(errEvent.status).toBe('timeout')
    expect(errEvent.errorCode).toBe('TOOL_TIMEOUT')
  })

  it('emits tool:error with status=denied when a tool is permission-blocked', async () => {
    const bus = createEventBus()
    const events = captureToolEvents(bus)

    const tool = mockTool('write_disk')
    const model = createMockModel([
      aiWithToolCalls([{ name: 'write_disk', args: { path: '/tmp/x' } }]),
      new AIMessage('giving up'),
    ])

    // Permission policy denies the call before invocation.
    const policy = {
      hasPermission: () => false,
    }

    await expect(
      runToolLoop(model, [new HumanMessage('go')], [tool], {
        maxIterations: 5,
        eventBus: bus,
        agentId: 'agent_no_perm',
        runId: 'run_denied',
        toolPermissionPolicy: policy,
      }),
    ).rejects.toThrow(/TOOL_PERMISSION_DENIED|not accessible/i)

    const errEvent = events.find((e) => e.type === 'tool:error')
    expect(errEvent).toBeDefined()
    if (errEvent?.type !== 'tool:error') throw new Error('unreachable')
    expect(errEvent.status).toBe('denied')
    expect(errEvent.errorCode).toBe('TOOL_PERMISSION_DENIED')
    expect(errEvent.toolName).toBe('write_disk')
    expect(errEvent.inputMetadataKeys).toEqual(['path'])
    expect(errEvent.agentId).toBe('agent_no_perm')
    expect(errEvent.runId).toBe('run_denied')
  })

  it('bridges to ToolGovernance.audit / auditResult on success', async () => {
    const onToolCall = vi.fn()
    const onToolResult = vi.fn()

    // Lazy-import the actual class so the test verifies the real bridge.
    const { ToolGovernance } = await import('@dzupagent/core')
    const gov = new ToolGovernance({
      auditHandler: { onToolCall, onToolResult },
    })

    const tool = mockTool('safe_tool', 'fine')
    const model = createMockModel([
      aiWithToolCalls([{ name: 'safe_tool', args: { foo: 1 } }]),
      new AIMessage('done'),
    ])

    await runToolLoop(model, [new HumanMessage('go')], [tool], {
      maxIterations: 5,
      agentId: 'agent_gov',
      runId: 'run_gov',
      toolGovernance: gov,
    })

    // Allow microtasks queued by void promises to settle.
    await new Promise((r) => setTimeout(r, 5))

    expect(onToolCall).toHaveBeenCalledTimes(1)
    expect(onToolCall.mock.calls[0]![0]).toMatchObject({
      toolName: 'safe_tool',
      callerAgent: 'agent_gov',
      inputMetadataKeys: ['foo'],
      allowed: true,
    })
    expect(onToolCall.mock.calls[0]![0].input).toBeUndefined()

    expect(onToolResult).toHaveBeenCalledTimes(1)
    expect(onToolResult.mock.calls[0]![0]).toMatchObject({
      toolName: 'safe_tool',
      callerAgent: 'agent_gov',
      success: true,
    })
  })
})

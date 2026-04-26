/**
 * RF-AGENT-04 — approval-required tool gating in the ReAct loop.
 *
 * These tests pin the hard-gate behaviour for approval-required tools
 * (decision recorded inline in `tool-loop.ts`):
 *
 *  - `approval:requested` is emitted with the durable `runId` when the
 *    config supplies one (falling back to the local `tool_call_id`).
 *  - The loop stops with `stopReason === 'approval_pending'` and the
 *    underlying tool is NEVER invoked.
 *  - Tools that do NOT require approval execute normally.
 *  - A tool listed in `approvalRequired` is gated even when the deny list
 *    is empty (defends against the "approval enforced only when also
 *    blocked" failure mode).
 *  - The same gate applies in the parallel execution path.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { createEventBus, ToolGovernance } from '@dzupagent/core'
import { runToolLoop } from '../agent/tool-loop.js'

// ---------- Helpers ----------

function mockTool(name: string, result = 'ok') {
  const invokeFn = vi.fn(async (_args: Record<string, unknown>) => result)
  return {
    tool: {
      name,
      description: `Mock ${name}`,
      schema: {} as never,
      lc_namespace: [] as string[],
      invoke: invokeFn,
    } as unknown as StructuredToolInterface,
    invokeFn,
  }
}

function createMockModel(responses: AIMessage[]): BaseChatModel {
  let i = 0
  return {
    invoke: vi.fn(async (_msgs: BaseMessage[]) => {
      const r = responses[i] ?? new AIMessage('done')
      i++
      return r
    }),
  } as unknown as BaseChatModel
}

function aiWithToolCall(name: string, args: Record<string, unknown>, id = 'call_0') {
  const msg = new AIMessage({ content: '' })
  ;(msg as AIMessage & { tool_calls: unknown[] }).tool_calls = [{ id, name, args }]
  return msg
}

function aiWithToolCalls(
  calls: Array<{ id?: string; name: string; args: Record<string, unknown> }>,
) {
  const msg = new AIMessage({ content: '' })
  ;(msg as AIMessage & { tool_calls: unknown[] }).tool_calls = calls.map((c, i) => ({
    id: c.id ?? `call_${i}`,
    name: c.name,
    args: c.args,
  }))
  return msg
}

// ==========================================================================
// Approval gate
// ==========================================================================

describe('Approval-required tool gating (RF-AGENT-04)', () => {
  it('emits approval:requested with the durable runId and does NOT execute the tool', async () => {
    const { tool, invokeFn } = mockTool('deploy', 'deployed!')
    const model = createMockModel([
      aiWithToolCall('deploy', { env: 'prod' }, 'tc_42'),
      // The loop should NEVER reach a follow-up turn — but if it did, this
      // would also be a `tool_calls` response. Use a final string to make
      // failures visibly louder.
      new AIMessage('should-not-be-reached'),
    ])
    const bus = createEventBus()
    const events: unknown[] = []
    bus.on('approval:requested', (e) => events.push(e))

    const governance = new ToolGovernance({
      approvalRequired: ['deploy'],
    })

    const result = await runToolLoop(
      model,
      [new HumanMessage('please deploy')],
      [tool],
      {
        maxIterations: 5,
        toolGovernance: governance,
        eventBus: bus,
        runId: 'durable-run-123',
      },
    )

    // Tool was NOT invoked
    expect(invokeFn).not.toHaveBeenCalled()

    // Loop stopped with the approval_pending stop reason
    expect(result.stopReason).toBe('approval_pending')

    // Exactly one approval:requested event was emitted, carrying the
    // DURABLE run id (not the per-call tool_call_id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'approval:requested',
      runId: 'durable-run-123',
      plan: { toolName: 'deploy', args: { env: 'prod' } },
    })

    // The conversation contains an [approval_pending] tool message so the
    // model can be re-prompted after resume.
    const pendingMsg = result.messages.find(
      (m) =>
        m._getType() === 'tool'
        && typeof m.content === 'string'
        && m.content.startsWith('[approval_pending]'),
    )
    expect(pendingMsg).toBeDefined()
  })

  it('falls back to the tool_call_id when no runId is configured', async () => {
    const { tool, invokeFn } = mockTool('deploy')
    const model = createMockModel([aiWithToolCall('deploy', {}, 'tc_local_id')])
    const bus = createEventBus()
    const events: { runId: string }[] = []
    bus.on('approval:requested', (e) => events.push(e as { runId: string }))

    const governance = new ToolGovernance({ approvalRequired: ['deploy'] })

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      {
        maxIterations: 3,
        toolGovernance: governance,
        eventBus: bus,
        // runId intentionally omitted
      },
    )

    expect(invokeFn).not.toHaveBeenCalled()
    expect(result.stopReason).toBe('approval_pending')
    expect(events[0]?.runId).toBe('tc_local_id')
  })

  it('non-approval-required tools execute normally and the loop completes', async () => {
    const { tool, invokeFn } = mockTool('read_file', 'contents')
    const model = createMockModel([
      aiWithToolCall('read_file', { path: 'a.ts' }),
      new AIMessage('done'),
    ])
    const bus = createEventBus()
    const events: unknown[] = []
    bus.on('approval:requested', (e) => events.push(e))

    // Governance configured but read_file is NOT in approvalRequired
    const governance = new ToolGovernance({
      approvalRequired: ['deploy'],
    })

    const result = await runToolLoop(
      model,
      [new HumanMessage('read it')],
      [tool],
      {
        maxIterations: 5,
        toolGovernance: governance,
        eventBus: bus,
        runId: 'run-1',
      },
    )

    expect(invokeFn).toHaveBeenCalledTimes(1)
    expect(invokeFn).toHaveBeenCalledWith({ path: 'a.ts' })
    expect(result.stopReason).toBe('complete')
    expect(events).toHaveLength(0)
  })

  it('blocks an approval-required tool even when the deny list is empty', async () => {
    // Verifies the gate is independent of `blockedTools`. A tool listed
    // ONLY in `approvalRequired` must still be suspended.
    const { tool, invokeFn } = mockTool('migrate_db', 'migrated')
    const model = createMockModel([aiWithToolCall('migrate_db', { dryRun: false })])
    const bus = createEventBus()
    const events: unknown[] = []
    bus.on('approval:requested', (e) => events.push(e))

    const governance = new ToolGovernance({
      // No blockedTools — approval is the only restriction
      approvalRequired: ['migrate_db'],
    })

    const result = await runToolLoop(
      model,
      [new HumanMessage('migrate')],
      [tool],
      {
        maxIterations: 3,
        toolGovernance: governance,
        eventBus: bus,
        runId: 'run-mig',
      },
    )

    expect(invokeFn).not.toHaveBeenCalled()
    expect(result.stopReason).toBe('approval_pending')
    expect(events).toHaveLength(1)
  })

  it('hard-gates the parallel execution path as well', async () => {
    // Two independent tool calls in a single LLM turn. The parallel
    // executor must apply the gate in its pre-validation loop so the
    // approval-required tool is suspended without being invoked.
    const { tool: dangerous, invokeFn: dangerousInvoke } = mockTool('deploy')
    const { tool: safe, invokeFn: safeInvoke } = mockTool('read_file', 'contents')
    const model = createMockModel([
      aiWithToolCalls([
        { id: 'tc_safe', name: 'read_file', args: { path: 'a.ts' } },
        { id: 'tc_dangerous', name: 'deploy', args: { env: 'prod' } },
      ]),
      new AIMessage('should-not-be-reached'),
    ])
    const bus = createEventBus()
    const events: unknown[] = []
    bus.on('approval:requested', (e) => events.push(e))

    const governance = new ToolGovernance({ approvalRequired: ['deploy'] })

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [dangerous, safe],
      {
        maxIterations: 5,
        parallelTools: true,
        toolGovernance: governance,
        eventBus: bus,
        runId: 'run-parallel',
      },
    )

    // The dangerous tool was suspended and NEVER ran...
    expect(dangerousInvoke).not.toHaveBeenCalled()
    // ...the loop halted with approval_pending...
    expect(result.stopReason).toBe('approval_pending')
    // ...and the approval event carried the durable runId.
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ runId: 'run-parallel' })

    // The safe call still ran in parallel (it was executed before the
    // approval-pending result was inspected by the outer loop).
    expect(safeInvoke).toHaveBeenCalledTimes(1)
  })
})

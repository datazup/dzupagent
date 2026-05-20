import { describe, expect, it } from 'vitest'
import { ToolMessage } from '@langchain/core/messages'
import { scheduleToolCalls } from '../agent/tool-loop/tool-scheduler-kernel.js'
import type { ToolCall, ToolCallResult } from '../agent/tool-loop/contracts.js'
import type { ToolGovernance } from '@dzupagent/core/tools'

function tc(name: string, id: string): ToolCall {
  return { id, name, args: {} } as ToolCall
}

function ok(name: string, id: string): ToolCallResult {
  return {
    message: new ToolMessage({ content: 'ok', tool_call_id: id, name }),
  }
}

describe('scheduleToolCalls — parallel error aggregation (AGENT-109)', () => {
  it('rethrows the original error when exactly one tool fails', async () => {
    const calls = [tc('a', '1'), tc('b', '2'), tc('c', '3')]
    const onlyError = new Error('b boom')

    const promise = scheduleToolCalls(
      calls,
      { parallelTools: true, maxParallelTools: 5 },
      async (call) => {
        if (call.name === 'b') throw onlyError
        return ok(call.name, call.id ?? 'x')
      },
    )

    await expect(promise).rejects.toBe(onlyError)
  })

  it('downgrades to serial when any tool in the batch requires approval (AGENT-H-02)', async () => {
    // Three tool calls. The middle one requires approval; the others do not.
    // The parallel path must NOT execute the side-effecting siblings before
    // the approval-required call short-circuits the batch.
    const calls = [tc('a', '1'), tc('needs-approval', '2'), tc('c', '3')]

    const governance = {
      checkAccess(toolName: string) {
        if (toolName === 'needs-approval') {
          return { allowed: true, requiresApproval: true }
        }
        return { allowed: true }
      },
    } as unknown as ToolGovernance

    const invocations: Array<{ name: string; index: number }> = []

    const results = await scheduleToolCalls(
      calls,
      {
        parallelTools: true,
        maxParallelTools: 5,
        toolGovernance: governance,
      },
      async (call, index) => {
        invocations.push({ name: call.name, index })
        // Simulate the policy-checks layer: for approval-required tools the
        // executor returns approvalPending=true WITHOUT side-effecting.
        if (call.name === 'needs-approval') {
          return {
            message: new ToolMessage({
              content: '[approval_pending]',
              tool_call_id: call.id ?? 'x',
              name: call.name,
            }),
            approvalPending: true,
          }
        }
        return ok(call.name, call.id ?? 'x')
      },
    )

    // Defense-in-depth: when an approval gate is detected in the pre-scan,
    // the kernel must downgrade to serial scheduling. The serial path then
    // short-circuits on approvalPending=true, leaving the tail of the batch
    // un-executed. Concretely: position 0 may run, position 1 (approval)
    // returns approvalPending, and position 2 (side-effecting) NEVER runs.
    const sideEffectingAfterGate = invocations.filter(
      (inv) => inv.index > 1,
    )
    expect(sideEffectingAfterGate).toHaveLength(0)

    // The approval-required call's result must be present so the outer loop
    // can recognize approvalPending and halt with stopReason=approval_pending.
    const approvalResult = results.find((r) => r.approvalPending === true)
    expect(approvalResult).toBeDefined()
  })

  it('keeps parallel scheduling when no tool requires approval (AGENT-H-02 happy path)', async () => {
    const calls = [tc('a', '1'), tc('b', '2'), tc('c', '3')]
    const governance = {
      checkAccess() {
        return { allowed: true }
      },
    } as unknown as ToolGovernance

    // Track concurrency by recording observed running count at each entry.
    let running = 0
    let peak = 0
    const results = await scheduleToolCalls(
      calls,
      {
        parallelTools: true,
        maxParallelTools: 5,
        toolGovernance: governance,
      },
      async (call) => {
        running++
        peak = Math.max(peak, running)
        await new Promise((r) => setTimeout(r, 5))
        running--
        return ok(call.name, call.id ?? 'x')
      },
    )

    expect(results).toHaveLength(3)
    // When no approval is required, the kernel must remain in parallel
    // mode — at least two calls overlap.
    expect(peak).toBeGreaterThan(1)
  })

  it('throws AggregateError containing all errors when multiple tools fail', async () => {
    const calls = [tc('a', '1'), tc('b', '2'), tc('c', '3')]
    const errA = new Error('a fail')
    const errC = new Error('c fail')

    const promise = scheduleToolCalls(
      calls,
      { parallelTools: true, maxParallelTools: 5 },
      async (call) => {
        if (call.name === 'a') throw errA
        if (call.name === 'c') throw errC
        return ok(call.name, call.id ?? 'x')
      },
    )

    await expect(promise).rejects.toBeInstanceOf(AggregateError)
    try {
      await promise
    } catch (e) {
      const agg = e as AggregateError
      expect(agg.message).toBe('Tool batch failed')
      expect(agg.errors).toHaveLength(2)
      expect(agg.errors).toContain(errA)
      expect(agg.errors).toContain(errC)
    }
  })
})

import { describe, it, expect } from 'vitest'
import { createEventBus, type DzupEvent } from '@dzupagent/core/events'
import type { ToolGovernance } from '@dzupagent/core/tools'
import {
  emitToolCalled,
  emitToolResult,
  emitToolError,
  type ToolLifecyclePolicyContext,
} from '../agent/tool-lifecycle-policy.js'

/**
 * QF-03 / ERR-C-06 (agent side): a rejecting tool-governance audit sink must
 * be surfaced via the `audit:sink_failure` event (mirroring the LLM-call audit
 * sink) rather than being swallowed by an empty `.catch(() => {})`.
 */
describe('tool-lifecycle-policy — audit sink failure (QF-03 / ERR-C-06)', () => {
  /** A governance stub whose audit writes always reject. */
  function rejectingGovernance(message: string): ToolGovernance {
    return {
      audit: async () => {
        throw new Error(message)
      },
      auditResult: async () => {
        throw new Error(message)
      },
    } as unknown as ToolGovernance
  }

  function context(): {
    ctx: ToolLifecyclePolicyContext
    failures: Array<Extract<DzupEvent, { type: 'audit:sink_failure' }>>
  } {
    const eventBus = createEventBus()
    const failures: Array<Extract<DzupEvent, { type: 'audit:sink_failure' }>> = []
    eventBus.on('audit:sink_failure', (e) => {
      failures.push(e)
    })
    return {
      ctx: {
        eventBus,
        toolGovernance: rejectingGovernance('sink down'),
        agentId: 'agent-1',
        runId: 'run-1',
      },
      failures,
    }
  }

  it('emitToolCalled emits audit:sink_failure when the audit sink rejects', async () => {
    const { ctx, failures } = context()

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      emitToolCalled(ctx, {
        toolName: 'git_status',
        toolCallId: 'call-1',
        input: { a: 1 },
        inputMetadataKeys: ['a'],
      })

      // Allow the fire-and-forget audit().catch(...) to settle.
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(failures).toHaveLength(1)
      expect(failures[0]!.sink).toBe('tool-governance')
      expect(failures[0]!.agentId).toBe('agent-1')
      expect(failures[0]!.runId).toBe('run-1')
      expect(failures[0]!.message).toContain('git_status')
      expect(failures[0]!.message).toContain('sink down')
      expect(unhandled).toHaveLength(0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('emitToolResult and emitToolError also route rejecting audits to the event', async () => {
    const { ctx, failures } = context()

    emitToolResult(ctx, {
      toolName: 'read_file',
      toolCallId: 'call-2',
      durationMs: 5,
      inputMetadataKeys: [],
      output: 'ok',
    })
    emitToolError(ctx, {
      toolName: 'write_file',
      toolCallId: 'call-3',
      durationMs: 7,
      inputMetadataKeys: [],
      errorCode: 'TOOL_EXECUTION_FAILED',
      errorMessage: 'boom',
      status: 'error',
    })

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(failures).toHaveLength(2)
    expect(failures.map((f) => f.sink)).toEqual(['tool-governance', 'tool-governance'])
    expect(failures[0]!.message).toContain('read_file')
    expect(failures[1]!.message).toContain('write_file')
  })
})

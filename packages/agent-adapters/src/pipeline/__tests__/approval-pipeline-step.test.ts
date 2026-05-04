import { describe, it, expect, vi } from 'vitest'
import { createEventBus } from '@dzupagent/core'

import { AdapterApprovalGate } from '../../approval/adapter-approval.js'
import { ApprovalPipelineStep } from '../approval-pipeline-step.js'
import type { AdapterProviderId, AgentEvent } from '../../types.js'

async function* makeStream(): AsyncGenerator<AgentEvent, void, undefined> {
  yield {
    type: 'adapter:started',
    providerId: 'codex' as AdapterProviderId,
    sessionId: 's',
    timestamp: Date.now(),
  }
  yield {
    type: 'adapter:completed',
    providerId: 'codex' as AdapterProviderId,
    sessionId: 's',
    result: 'done',
    durationMs: 1,
    timestamp: Date.now(),
  }
}

describe('ApprovalPipelineStep', () => {
  it('reports disabled when no gate is configured', () => {
    const step = new ApprovalPipelineStep(undefined)
    expect(step.enabled).toBe(false)
  })

  it('reports enabled when a gate is configured', () => {
    const gate = new AdapterApprovalGate({ mode: 'auto' })
    const step = new ApprovalPipelineStep(gate)
    expect(step.enabled).toBe(true)
  })

  it('returns the source stream untouched when no gate is set', async () => {
    const step = new ApprovalPipelineStep(undefined)
    const wrapped = step.wrap(makeStream(), {
      prompt: 'p',
      requireApproval: true,
    })
    const out: AgentEvent[] = []
    for await (const e of wrapped) out.push(e)
    expect(out.map((e) => e.type)).toEqual(['adapter:started', 'adapter:completed'])
  })

  it('returns the source stream untouched when requireApproval is falsy', async () => {
    const gate = new AdapterApprovalGate({ mode: 'required' })
    const step = new ApprovalPipelineStep(gate)
    const wrapped = step.wrap(makeStream(), {
      prompt: 'p',
      requireApproval: undefined,
    })
    const out: AgentEvent[] = []
    for await (const e of wrapped) out.push(e)
    expect(out.length).toBe(2)
  })

  it('builds an ApprovalContext with provided fields', () => {
    const step = new ApprovalPipelineStep(undefined)
    const ctx = step.buildContext({
      prompt: 'a'.repeat(500),
      providerId: 'claude' as AdapterProviderId,
      approvalRunId: 'run-1',
      tags: ['x'],
    })
    expect(ctx.runId).toBe('run-1')
    expect(ctx.providerId).toBe('claude')
    expect(ctx.tags).toEqual(['x'])
    expect(ctx.description.length).toBeLessThanOrEqual(200)
  })

  it('falls back to a generated runId and "auto" providerId when not provided', () => {
    const step = new ApprovalPipelineStep(undefined)
    const ctx = step.buildContext({ prompt: 'p' })
    expect(ctx.runId).toMatch(/[0-9a-f-]{36}/i)
    expect(ctx.providerId).toBe('auto')
  })

  it('wraps stream through gate.guard when enabled and required', async () => {
    const bus = createEventBus()
    const gate = new AdapterApprovalGate({ mode: 'auto', eventBus: bus })
    const guardSpy = vi.spyOn(gate, 'guard')
    const step = new ApprovalPipelineStep(gate)
    const wrapped = step.wrap(makeStream(), {
      prompt: 'p',
      requireApproval: true,
    })
    const out: AgentEvent[] = []
    for await (const e of wrapped) out.push(e)
    expect(guardSpy).toHaveBeenCalledTimes(1)
    expect(out.length).toBeGreaterThan(0)
  })
})

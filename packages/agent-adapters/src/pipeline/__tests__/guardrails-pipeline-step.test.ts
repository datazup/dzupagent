import { describe, it, expect, vi } from 'vitest'
import { createEventBus } from '@dzupagent/core'

import { CostTrackingMiddleware } from '../../middleware/cost-tracking.js'
import { AdapterGuardrails } from '../../guardrails/adapter-guardrails.js'
import { GuardrailsPipelineStep } from '../guardrails-pipeline-step.js'
import type { AdapterProviderId, AgentStreamEvent } from '../../types.js'
import { POLICY_GUARDRAILS_OPTION_KEY } from '../policy-enforcement-pipeline.js'

async function* sample(): AsyncGenerator<AgentStreamEvent, void, undefined> {
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
    usage: { inputTokens: 5, outputTokens: 5 },
  }
}

describe('GuardrailsPipelineStep', () => {
  it('reports disabled when nothing is configured', () => {
    const step = new GuardrailsPipelineStep(undefined, undefined)
    expect(step.enabled).toBe(false)
  })

  it('reports enabled when only cost tracking is configured', () => {
    const cost = new CostTrackingMiddleware({ eventBus: createEventBus() })
    const step = new GuardrailsPipelineStep(cost, undefined)
    expect(step.enabled).toBe(true)
  })

  it('reports enabled when only guardrails are configured', () => {
    const guardrails = new AdapterGuardrails({})
    const step = new GuardrailsPipelineStep(undefined, guardrails)
    expect(step.enabled).toBe(true)
  })

  it('returns the source stream untouched when nothing is configured', async () => {
    const step = new GuardrailsPipelineStep(undefined, undefined)
    const out: AgentStreamEvent[] = []
    for await (const e of step.wrap(sample())) out.push(e)
    expect(out.map((e) => e.type)).toEqual(['adapter:started', 'adapter:completed'])
  })

  it('invokes cost tracking wrap when present', async () => {
    const cost = new CostTrackingMiddleware({ eventBus: createEventBus() })
    const wrapSpy = vi.spyOn(cost, 'wrap')
    const step = new GuardrailsPipelineStep(cost, undefined)
    const out: AgentStreamEvent[] = []
    for await (const e of step.wrap(sample())) out.push(e)
    expect(wrapSpy).toHaveBeenCalledTimes(1)
    expect(out.length).toBe(2)
  })

  it('invokes guardrails wrap when present', async () => {
    const guardrails = new AdapterGuardrails({})
    const wrapSpy = vi.spyOn(guardrails, 'wrap')
    const step = new GuardrailsPipelineStep(undefined, guardrails)
    const out: AgentStreamEvent[] = []
    for await (const e of step.wrap(sample())) out.push(e)
    expect(wrapSpy).toHaveBeenCalledTimes(1)
    expect(out.length).toBe(2)
  })

  it('applies cost-tracking before guardrails (guardrails as the outer wrapper)', async () => {
    const cost = new CostTrackingMiddleware({ eventBus: createEventBus() })
    const guardrails = new AdapterGuardrails({})
    const costSpy = vi.spyOn(cost, 'wrap')
    const grSpy = vi.spyOn(guardrails, 'wrap')
    const step = new GuardrailsPipelineStep(cost, guardrails)
    const out: AgentStreamEvent[] = []
    for await (const e of step.wrap(sample())) out.push(e)
    expect(costSpy).toHaveBeenCalledTimes(1)
    expect(grSpy).toHaveBeenCalledTimes(1)
    // Cost-tracking is invoked first; guardrails wraps the cost-wrapped stream.
    expect(costSpy.mock.invocationCallOrder[0]!).toBeLessThan(
      grSpy.mock.invocationCallOrder[0]!,
    )
  })

  it('adds per-run guardrail overlay from typed policy context', async () => {
    const step = new GuardrailsPipelineStep(undefined, undefined)

    const input = {
      prompt: 'p',
      policyContext: {
        projectedGuardrails: {
          blockedTools: ['dangerous_tool'],
          maxIterations: 2,
        },
      },
    }

    async function* toolCallStream(): AsyncGenerator<AgentStreamEvent, void, undefined> {
      yield {
        type: 'adapter:started',
        providerId: 'codex' as AdapterProviderId,
        sessionId: 's',
        timestamp: Date.now(),
      }
      yield {
        type: 'adapter:tool_call',
        providerId: 'codex' as AdapterProviderId,
        toolName: 'dangerous_tool',
        input: {},
        timestamp: Date.now(),
      }
    }

    const out: AgentStreamEvent[] = []
    for await (const e of step.wrap(toolCallStream(), input)) out.push(e)

    expect(out.map((e) => e.type)).toEqual(['adapter:started', 'adapter:failed'])
    expect(out[1]).toMatchObject({
      type: 'adapter:failed',
      code: 'GUARDRAIL_VIOLATION',
    })
  })

  it('supports legacy policy guardrail option key for compatibility', async () => {
    const step = new GuardrailsPipelineStep(undefined, undefined)
    const input = {
      prompt: 'p',
      options: {
        [POLICY_GUARDRAILS_OPTION_KEY]: {
          blockedTools: ['dangerous_tool'],
          maxIterations: 2,
        },
      },
    }

    async function* toolCallStream(): AsyncGenerator<AgentStreamEvent, void, undefined> {
      yield {
        type: 'adapter:started',
        providerId: 'codex' as AdapterProviderId,
        sessionId: 's',
        timestamp: Date.now(),
      }
      yield {
        type: 'adapter:tool_call',
        providerId: 'codex' as AdapterProviderId,
        toolName: 'dangerous_tool',
        input: {},
        timestamp: Date.now(),
      }
    }

    const out: AgentStreamEvent[] = []
    for await (const e of step.wrap(toolCallStream(), input)) out.push(e)

    expect(out.map((e) => e.type)).toEqual(['adapter:started', 'adapter:failed'])
  })
})

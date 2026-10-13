import { describe, it, expect, vi } from 'vitest'
import { createEventBus } from '@dzupagent/core'

import { CostTrackingMiddleware } from '../../middleware/cost-tracking.js'
import { AdapterGuardrails } from '../../guardrails/adapter-guardrails.js'
import { GuardrailsPipelineStep } from '../guardrails-pipeline-step.js'
import type { AdapterProviderId, AgentInput, AgentStreamEvent } from '../../types.js'
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

async function withClosureCeiling<T>(pending: Promise<T>, emergencyAbort: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('Iterator closure did not settle before the test ceiling'))
      emergencyAbort()
    }, 500)
  })
  try { return await Promise.race([pending, deadline]) }
  finally { if (timer !== undefined) clearTimeout(timer) }
}

describe('GuardrailsPipelineStep', () => {
  it.each(['cost overrun', 'return', 'throw'] as const)(
    'aborts before awaiting a signal-dependent source finalizer on %s',
    async (mode) => {
      const caller = new AbortController()
      const input: AgentInput = { prompt: 'close safely', signal: caller.signal }
      const step = new GuardrailsPipelineStep(
        new CostTrackingMiddleware({ maxBudgetCents: mode === 'cost overrun' ? 1 : 100 }),
        new AdapterGuardrails({ stuckDetector: false }),
      )
      let abortedAtClosure = false
      let finalized = false
      async function* source(): AsyncGenerator<AgentStreamEvent, void, undefined> {
        try {
          yield { type: 'adapter:started', providerId: 'codex', sessionId: 's', timestamp: Date.now() }
          yield { type: 'adapter:completed', providerId: 'codex', sessionId: 's', result: 'done', durationMs: 0,
            usage: { inputTokens: 1, outputTokens: 1, costCents: 2 }, timestamp: Date.now() }
        } finally {
          const signal = input.signal!
          abortedAtClosure = signal.aborted
          if (!signal.aborted) {
            await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
          }
          finalized = true
        }
      }
      const wrapped = step.wrap(source(), input)
      try {
        expect((await wrapped.next()).value).toMatchObject({ type: 'adapter:started' })
        if (mode === 'cost overrun') {
          await expect(withClosureCeiling(wrapped.next(), () => caller.abort()))
            .rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' })
        } else if (mode === 'return') {
          const closing = wrapped.return(undefined)
          expect(input.signal?.aborted).toBe(true)
          await expect(withClosureCeiling(closing, () => caller.abort())).resolves.toMatchObject({ done: true })
        } else {
          const error = new Error('consumer stopped')
          const closing = wrapped.throw(error)
          expect(input.signal?.aborted).toBe(true)
          await expect(withClosureCeiling(closing, () => caller.abort())).rejects.toBe(error)
        }
        expect(abortedAtClosure).toBe(true)
        expect(finalized).toBe(true)
        expect(caller.signal.aborted).toBe(false)
      } finally {
        caller.abort()
        await wrapped.return(undefined)
      }
    }, 1000,
  )

  it.each(['configured', 'typed overlay', 'legacy overlay'] as const)(
    'aborts the source execution signal on a blocked tool (%s)',
    async (mode) => {
      const caller = new AbortController()
      const input: AgentInput = {
        prompt: 'guarded', signal: caller.signal,
        ...(mode === 'typed overlay' ? { policyContext: { projectedGuardrails: { blockedTools: ['blocked'] } } } : {}),
        ...(mode === 'legacy overlay' ? { options: { [POLICY_GUARDRAILS_OPTION_KEY]: { blockedTools: ['blocked'] } } } : {}),
      }
      const step = new GuardrailsPipelineStep(undefined,
        mode === 'configured' ? new AdapterGuardrails({ blockedTools: ['blocked'] }) : undefined)
      let abortObserved = false
      let closedWithAbortedSignal = false
      let continued = false
      async function* execution(): AsyncGenerator<AgentStreamEvent, void, undefined> {
        const signal = input.signal!
        signal.addEventListener('abort', () => { abortObserved = true }, { once: true })
        try {
          yield { type: 'adapter:tool_call', providerId: 'codex', toolName: 'blocked', input: {}, timestamp: Date.now() }
          continued = true
        } finally {
          closedWithAbortedSignal = signal.aborted
        }
      }
      const out: AgentStreamEvent[] = []
      for await (const event of step.wrap(execution(), input)) out.push(event)
      expect(out).toHaveLength(1)
      expect(out[0]).toMatchObject({ type: 'adapter:failed', code: 'GUARDRAIL_VIOLATION' })
      expect(abortObserved).toBe(true)
      expect(closedWithAbortedSignal).toBe(true)
      expect(continued).toBe(false)
      expect(input.signal?.aborted).toBe(true)
      expect(caller.signal.aborted).toBe(false)
    },
  )

  it('aborts actual source work when configured stuck detection fires', async () => {
    const input: AgentInput = { prompt: 'stuck' }
    const guardrails = new AdapterGuardrails({ stuckDetector: { maxRepeatCalls: 2 } })
    const step = new GuardrailsPipelineStep(undefined, guardrails)
    let cancelled = false
    let continued = false
    async function* execution(): AsyncGenerator<AgentStreamEvent, void, undefined> {
      input.signal!.addEventListener('abort', () => { cancelled = true }, { once: true })
      for (let index = 0; index < 2; index++) {
        yield { type: 'adapter:tool_call', providerId: 'codex', toolName: 'read_file', input: { path: 'same' }, timestamp: Date.now() }
      }
      continued = true
    }
    const out: AgentStreamEvent[] = []
    for await (const event of step.wrap(execution(), input)) out.push(event)
    expect(out.map((event) => event.type)).toEqual(['adapter:tool_call', 'adapter:failed'])
    expect(cancelled).toBe(true)
    expect(continued).toBe(false)
    expect(guardrails.getStatus().stuckStatus.stuck).toBe(true)
  })

  it('aborts the delegation signal on a cost-budget exception', async () => {
    const input: AgentInput = { prompt: 'budget' }
    const cost = new CostTrackingMiddleware({ maxBudgetCents: 1 })
    const step = new GuardrailsPipelineStep(cost, undefined)
    let cancelled = false
    async function* execution(): AsyncGenerator<AgentStreamEvent, void, undefined> {
      input.signal!.addEventListener('abort', () => { cancelled = true }, { once: true })
      yield { type: 'adapter:completed', providerId: 'codex', sessionId: 's', result: 'expensive', durationMs: 0,
        usage: { inputTokens: 1, outputTokens: 1, costCents: 2 }, timestamp: Date.now() }
    }
    const collect = async (): Promise<void> => {
      for await (const _event of step.wrap(execution(), input)) { /* consume */ }
    }
    await expect(collect()).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' })
    expect(cancelled).toBe(true)
    expect(input.signal?.aborted).toBe(true)
  })

  it('forwards caller cancellation to the source signal and keeps other delegations independent', async () => {
    const caller = new AbortController()
    const first: AgentInput = { prompt: 'first', signal: caller.signal }
    const second: AgentInput = { prompt: 'second' }
    const step = new GuardrailsPipelineStep(new CostTrackingMiddleware({}), undefined)
    const firstStream = step.wrap(sample(), first)
    const secondStream = step.wrap(sample(), second)
    caller.abort()
    expect(first.signal?.aborted).toBe(true)
    expect(second.signal?.aborted).toBe(false)
    await firstStream.return(undefined)
    for await (const _event of secondStream) { /* consume */ }
    expect(second.signal?.aborted).toBe(false)
  })

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

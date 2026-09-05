import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GovernanceEmitter } from '../base/governance-emitter.js'
import { createStdinResponder } from '../base/stdin-responder.js'
import { handleApprovalRequest, handleTurnFailedApproval } from '../codex/codex-approval.js'
import type { CodexApprovalContext } from '../codex/codex-approval.js'
import type { CodexThread } from '../codex/codex-types.js'
import { InteractionResolver } from '../interaction/interaction-resolver.js'
import type { AgentEvent, AgentStreamEvent, GovernanceEvent, InteractionPolicy } from '../types.js'

// Keep the actual resolver, generators and governance emitter. Only the native
// provider boundary is a double: these tests must never start a provider.
function approvalFlow(shape: 'request' | 'failed-turn', policy: InteractionPolicy) {
  const resolver = new InteractionResolver(policy)
  const context: CodexApprovalContext = {
    providerId: 'codex', policy, resolver, buildThreadOptions: () => ({}),
  }
  const thread: CodexThread = {
    async runStreamed() { throw new Error('Unexpected native provider execution') },
  }
  const resumeThread = vi.fn(() => thread)
  const generator = shape === 'request'
    ? handleApprovalRequest(
        { type: 'approval_request', id: 'provider-item', message: 'Allow fixture write?', kind: 'permission' },
        { prompt: 'fixture', correlationId: 'fixture-run' }, null, null, context,
      )
    : handleTurnFailedApproval(
        'Fixture approval required', { prompt: 'fixture', correlationId: 'fixture-run' }, 'fixture-session',
        { startThread() { throw new Error('Unexpected provider start') }, resumeThread },
        new AbortController().signal, null, null, context,
        async function* (resumed): AsyncGenerator<AgentStreamEvent, void, undefined> {
          if (resumed !== thread) throw new Error('Wrong resumed thread')
          yield {
            type: 'adapter:completed', providerId: 'codex', sessionId: 'fixture-session',
            result: 'resumed', timestamp: 1, durationMs: 0,
          }
        },
      )
  return { resolver, generator, resumeThread }
}

describe('interaction response registration', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  for (const shape of ['request', 'failed-turn'] as const) {
    it.each(['yes', 'no'])(`accepts an immediate %s answer to a Codex ${shape}`, async (answer) => {
      const { resolver, generator, resumeThread } = approvalFlow(shape, { mode: 'ask-caller' })
      try {
        const first = await generator.next()
        if (first.done || first.value.type !== 'adapter:interaction_required') {
          throw new Error('Expected an interaction request before resolution')
        }
        // The consumer answers before asking the iterator for another event.
        expect(resolver.respond(first.value.interactionId, answer)).toBe(true)
        const remaining: AgentStreamEvent[] = []
        for await (const event of generator) remaining.push(event)
        expect(remaining[0]).toMatchObject({
          type: 'adapter:interaction_resolved', interactionId: first.value.interactionId,
          answer, resolvedBy: 'caller', correlationId: 'fixture-run',
        })
        expect(resolver.respond(first.value.interactionId, 'yes')).toBe(false)
        if (shape === 'failed-turn') {
          expect(resumeThread).toHaveBeenCalledTimes(answer === 'yes' ? 1 : 0)
          if (answer === 'yes') {
            expect(resumeThread).toHaveBeenCalledWith('fixture-session', {})
            expect(remaining.at(-1)).toMatchObject({ type: 'adapter:completed', result: 'resumed' })
          } else {
            expect(remaining.at(-1)).toMatchObject({ type: 'adapter:failed', code: 'INTERACTION_DENIED' })
          }
        }
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        resolver.dispose()
        await generator.return(undefined)
      }
    })

    it(`denies a Codex ${shape} when the caller does not respond`, async () => {
      const { resolver, generator, resumeThread } = approvalFlow(shape, { mode: 'ask-caller' })
      try {
        const first = await generator.next()
        expect(first.value).toMatchObject({ type: 'adapter:interaction_required' })
        // The registered request expires even while iteration is suspended.
        await vi.advanceTimersByTimeAsync(60_000)
        expect((await generator.next()).value).toMatchObject({
          type: 'adapter:interaction_resolved', answer: 'no', resolvedBy: 'timeout-fallback',
        })
        for await (const _event of generator) { /* finish the denial branch */ }
        expect(resumeThread).not.toHaveBeenCalled()
      } finally {
        resolver.dispose()
        await generator.return(undefined)
      }
    })

    it(`preserves explicit auto-approve for a Codex ${shape}`, async () => {
      const { resolver, generator, resumeThread } = approvalFlow(shape, { mode: 'auto-approve' })
      try {
        const events: AgentStreamEvent[] = []
        for await (const event of generator) events.push(event)
        expect(events[0]).toMatchObject({
          type: 'adapter:interaction_resolved', answer: 'yes', resolvedBy: 'auto-approve',
        })
        expect(events.some(event => event.type === 'adapter:interaction_required')).toBe(false)
        expect(resumeThread).toHaveBeenCalledTimes(shape === 'failed-turn' ? 1 : 0)
        expect(vi.getTimerCount()).toBe(0)
      } finally { resolver.dispose() }
    })
  }

  it.each(['yes', 'no'])('accepts an immediate %s answer in the CLI governance callback', async (answer) => {
    const resolver = new InteractionResolver()
    const governance = new GovernanceEmitter('gemini')
    const pendingEvents: AgentEvent[] = []
    const received: GovernanceEvent[] = []
    let accepted: boolean | undefined
    governance.onGovernanceEvent(event => {
      received.push(event)
      if (event.type === 'governance:approval_requested') {
        accepted = resolver.respond(event.interactionId, answer)
      }
    })
    const respond = createStdinResponder({
      providerId: 'gemini', resolver, policy: { mode: 'ask-caller' },
      input: { prompt: 'fixture', correlationId: 'fixture-run' }, sessionId: 'fixture-session',
      pendingEvents, governance,
    })
    const result = respond({}, 'Allow fixture write?', 'permission')
    try {
      // No polling or microtask delay can conceal the synchronous race.
      expect(accepted).toBe(true)
      expect(await result).toBe(answer)
      expect(pendingEvents.map(event => event.type)).toEqual([
        'adapter:interaction_required', 'adapter:interaction_resolved',
      ])
      expect(pendingEvents[1]).toMatchObject({ answer, resolvedBy: 'caller', correlationId: 'fixture-run' })
      expect(received.map(event => event.type)).toEqual([
        'governance:approval_requested', 'governance:approval_resolved',
      ])
      // Keep the existing summary contract; exact caller answer is above.
      expect(received[1]).toMatchObject({ resolution: 'auto' })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      resolver.dispose()
      await result
    }
  })
})

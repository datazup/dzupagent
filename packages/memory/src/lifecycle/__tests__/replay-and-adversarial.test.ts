import { describe, expect, it } from 'vitest'

import { MemoryTransitionError, reduceMemoryCommandV1 } from '../index.js'
import type { MemoryCommandV1 } from '../types.js'
import {
  makeCaptureCommand,
  makeCapturedRecord,
  makeCommand,
  time,
} from './fixtures.js'

describe('Memory lifecycle replay and fail-closed admission', () => {
  it('returns the original receipt for an exactly equal replay without another event', () => {
    const command = makeCaptureCommand()
    const first = reduceMemoryCommandV1(undefined, command)
    const serialized = JSON.parse(JSON.stringify(command)) as MemoryCommandV1
    const replay = reduceMemoryCommandV1(first.state, serialized)

    expect(replay.replayed).toBe(true)
    expect(replay.receipt).toEqual(first.receipt)
    expect(replay.event).toBeUndefined()
    expect(replay.records).toEqual([])
    expect(replay.state).toEqual(first.state)
    expect(replay.state.events).toHaveLength(1)
    expect(reduceMemoryCommandV1(replay.state, serialized).receipt).toEqual(first.receipt)
  })

  it('recovers an earlier receipt from a later causal state without duplicating history', () => {
    const captured = makeCapturedRecord()
    const capture = reduceMemoryCommandV1(undefined, makeCaptureCommand(captured))
    const assessCommand = makeCommand('assess', capture.state, captured)
    const assess = reduceMemoryCommandV1(capture.state, assessCommand)
    const promote = reduceMemoryCommandV1(
      assess.state,
      makeCommand('promote', assess.state, assess.records[0]!),
    )

    const replay = reduceMemoryCommandV1(promote.state, assessCommand)
    expect(replay.replayed).toBe(true)
    expect(replay.receipt).toEqual(assess.receipt)
    expect(replay.state).toEqual(promote.state)
    expect(replay.state.events).toHaveLength(3)
  })

  it('is stable across command property insertion order', () => {
    const command = makeCaptureCommand()
    const reversed = Object.fromEntries(
      Object.entries(command).reverse(),
    ) as unknown as MemoryCommandV1

    expect(reduceMemoryCommandV1(undefined, reversed)).toEqual(
      reduceMemoryCommandV1(undefined, command),
    )
  })

  it('rejects an idempotency key reused for different canonical input', () => {
    const firstCommand = makeCaptureCommand()
    const first = reduceMemoryCommandV1(undefined, firstCommand)
    const conflict = makeCaptureCommand(firstCommand.record, {
      reasonCode: 'application-observation',
    })

    expectCode(() => reduceMemoryCommandV1(first.state, conflict), 'idempotency-conflict')
  })

  it('rejects sequence gaps, reorder, duplicate identities, and stale generations', () => {
    const captured = makeCapturedRecord()
    const first = reduceMemoryCommandV1(undefined, makeCaptureCommand(captured))

    expectCode(() => reduceMemoryCommandV1(
      first.state,
      makeCommand('assess', first.state, captured, { expectedSequence: 2 }),
    ), 'sequence-gap')
    expectCode(() => reduceMemoryCommandV1(
      first.state,
      makeCommand('assess', first.state, captured, { expectedSequence: 0 }),
    ), 'sequence-reorder')
    expectCode(() => reduceMemoryCommandV1(
      first.state,
      makeCommand('assess', first.state, captured, { generation: 2 }),
    ), 'stale-generation')
    expectCode(() => reduceMemoryCommandV1(
      first.state,
      makeCommand('assess', first.state, captured, {
        commandId: first.receipt.commandId,
      }),
    ), 'idempotency-conflict')
    expectCode(() => reduceMemoryCommandV1(
      first.state,
      makeCommand('assess', first.state, captured, { memoryId: 'memory-other' }),
    ), 'identity-mismatch')
  })

  it('rejects stale versions, stale digests, time reversal, and illegal transitions', () => {
    const captured = makeCapturedRecord()
    const first = reduceMemoryCommandV1(undefined, makeCaptureCommand(captured))

    expectCode(() => reduceMemoryCommandV1(
      first.state,
      makeCommand('assess', first.state, captured, { expectedVersionId: 'version-stale' }),
    ), 'stale-version')
    expectCode(() => reduceMemoryCommandV1(
      first.state,
      makeCommand('assess', first.state, captured, {
        expectedRecordDigest: `sha256:${'f'.repeat(64)}`,
      }),
    ), 'stale-digest')
    expectCode(() => reduceMemoryCommandV1(
      first.state,
      makeCommand('assess', first.state, captured, { transitionAt: time(0) }),
    ), 'time-reversal')
    expectCode(() => reduceMemoryCommandV1(
      first.state,
      makeCommand('promote', first.state, captured),
    ), 'illegal-transition')
  })

  it('rejects confidence-only promotion, unknown fields, reason codes, and schemas', () => {
    const captured = makeCapturedRecord()
    const first = reduceMemoryCommandV1(undefined, makeCaptureCommand(captured))
    const promotedByConfidence = {
      ...makeCommand('promote', first.state, captured),
      confidence: 1,
    } as unknown as MemoryCommandV1
    const unknownReason = {
      ...makeCommand('assess', first.state, captured),
      reasonCode: 'model-says-so',
    } as MemoryCommandV1
    const unknownSchema = {
      ...makeCommand('assess', first.state, captured),
      schema: 'datazup.memory.command/v2',
    } as unknown as MemoryCommandV1

    expectCode(() => reduceMemoryCommandV1(first.state, promotedByConfidence), 'invalid-command')
    expectCode(() => reduceMemoryCommandV1(first.state, unknownReason), 'invalid-command')
    expectCode(() => reduceMemoryCommandV1(first.state, unknownSchema), 'invalid-command')
  })

  it('rejects conflicting digests for one evidence identity', () => {
    const command = makeCaptureCommand()
    const evidence = command.evidenceRefs[0]!
    expectCode(() => reduceMemoryCommandV1(undefined, {
      ...command,
      evidenceRefs: [evidence, {
        ...evidence,
        digest: `sha256:${'e'.repeat(64)}`,
      }],
    }), 'invalid-command')
  })

  it('rejects getters, proxies, cycles, excessive depth, and non-finite numbers', () => {
    const getterCommand = { ...makeCaptureCommand() } as Record<string, unknown>
    Object.defineProperty(getterCommand, 'decisionRef', {
      enumerable: true,
      get: () => {
        throw new Error('getter executed')
      },
    })
    expectCode(
      () => reduceMemoryCommandV1(undefined, getterCommand as unknown as MemoryCommandV1),
      'unsafe-input',
    )

    const proxy = new Proxy(makeCaptureCommand(), {})
    expectCode(() => reduceMemoryCommandV1(undefined, proxy), 'unsafe-input')

    const cyclic = { ...makeCaptureCommand() } as Record<string, unknown>
    cyclic['cycle'] = cyclic
    expectCode(
      () => reduceMemoryCommandV1(undefined, cyclic as unknown as MemoryCommandV1),
      'unsafe-input',
    )

    let deep: Record<string, unknown> = {}
    const root = deep
    for (let index = 0; index < 20; index += 1) {
      deep['child'] = {}
      deep = deep['child'] as Record<string, unknown>
    }
    expectCode(
      () => reduceMemoryCommandV1(undefined, {
        ...makeCaptureCommand(),
        evidenceRefs: [root],
      } as unknown as MemoryCommandV1),
      'limit-exceeded',
    )
    expectCode(
      () => reduceMemoryCommandV1(undefined, {
        ...makeCaptureCommand(),
        generation: Number.POSITIVE_INFINITY,
      } as MemoryCommandV1),
      'unsafe-input',
    )

    expectCode(
      () => reduceMemoryCommandV1(undefined, {
        ...makeCaptureCommand(),
        evidenceRefs: Array.from({ length: 17 }, () => ({})),
      } as unknown as MemoryCommandV1),
      'limit-exceeded',
    )
    expectCode(
      () => reduceMemoryCommandV1(undefined, {
        ...makeCaptureCommand(),
        reasonCode: 'x'.repeat(70_000),
      } as MemoryCommandV1),
      'limit-exceeded',
    )
    const wide = Object.fromEntries(Array.from(
      { length: 129 },
      (_, index) => [`field${index}`, index],
    ))
    expectCode(
      () => reduceMemoryCommandV1(undefined, {
        ...makeCaptureCommand(),
        ...wide,
      } as unknown as MemoryCommandV1),
      'limit-exceeded',
    )
  })

  it('returns detached state and value-free errors', () => {
    const mutable = JSON.parse(JSON.stringify(makeCaptureCommand())) as MemoryCommandV1
    const result = reduceMemoryCommandV1(undefined, mutable)
    ;(mutable as unknown as Record<string, unknown>)['actorRef'] = 'changed'
    expect(result.event?.actorRef).toBe('forge://sample/memory-writer')
    expect(Reflect.set(
      result.state as unknown as Record<string, unknown>,
      'status',
      'revoked',
    )).toBe(false)
    expect(result.state.status).toBe('captured')

    try {
      reduceMemoryCommandV1(undefined, {
        ...makeCaptureCommand(),
        reasonCode: 'sensitive-value-must-not-appear',
      } as MemoryCommandV1)
      throw new Error('expected reducer failure')
    } catch (cause) {
      expect(cause).toBeInstanceOf(MemoryTransitionError)
      expect((cause as Error).message).not.toContain('sensitive-value-must-not-appear')
    }
  })
})

function expectCode(operation: () => unknown, code: MemoryTransitionError['code']): void {
  try {
    operation()
    throw new Error(`expected ${code}`)
  } catch (cause) {
    expect(cause).toBeInstanceOf(MemoryTransitionError)
    expect((cause as MemoryTransitionError).code).toBe(code)
  }
}

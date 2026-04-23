import { describe, it, expect, vi } from 'vitest'
import { createEventBus } from '../events/event-bus.js'
import type { DzupEvent } from '../events/event-types.js'

/**
 * Wave 11 §4 — flow-compiler lifecycle events must flow through the
 * existing `DzupEventBus` with full type discrimination.
 */
describe('DzupEventBus — flow compiler events', () => {
  it('delivers flow:compile_started to a typed listener', () => {
    const bus = createEventBus()
    const handler = vi.fn()

    bus.on('flow:compile_started', handler)
    bus.emit({ type: 'flow:compile_started', compileId: 'c1', inputKind: 'object' })

    expect(handler).toHaveBeenCalledWith({
      type: 'flow:compile_started',
      compileId: 'c1',
      inputKind: 'object',
    })
  })

  it('delivers compile lifecycle and result events in emission order via onAny', () => {
    const bus = createEventBus()
    const captured: DzupEvent[] = []
    bus.onAny((e) => { captured.push(e) })

    const compileId = 'c-xyz'
    bus.emit({ type: 'flow:compile_started', compileId, inputKind: 'json-string' })
    bus.emit({ type: 'flow:compile_parsed', compileId, astNodeType: 'sequence', errorCount: 0 })
    bus.emit({ type: 'flow:compile_shape_validated', compileId, errorCount: 0 })
    bus.emit({
      type: 'flow:compile_semantic_resolved',
      compileId,
      resolvedCount: 4,
      personaCount: 1,
      errorCount: 0,
    })
    bus.emit({
      type: 'flow:compile_lowered',
      compileId,
      target: 'pipeline',
      nodeCount: 7,
      edgeCount: 8,
      warningCount: 0,
    })
    bus.emit({
      type: 'flow:compile_completed',
      compileId,
      target: 'pipeline',
      durationMs: 12,
    })
    bus.emit({
      type: 'flow:compile_result',
      compileId,
      target: 'pipeline',
      artifact: { nodes: [], edges: [] },
      warnings: [],
      reasons: [{ code: 'FOR_EACH_PRESENT', message: 'Loop semantics are present; routed to pipeline.' }],
    })

    expect(captured.map((e) => e.type)).toEqual([
      'flow:compile_started',
      'flow:compile_parsed',
      'flow:compile_shape_validated',
      'flow:compile_semantic_resolved',
      'flow:compile_lowered',
      'flow:compile_completed',
      'flow:compile_result',
    ])
    for (const e of captured) {
      // Each flow event carries the correlating compileId.
      if (e.type.startsWith('flow:compile_')) {
        expect((e as { compileId: string }).compileId).toBe(compileId)
      }
    }
  })

  it('delivers flow:compile_failed with the terminal payload shape', () => {
    const bus = createEventBus()
    const handler = vi.fn()
    bus.on('flow:compile_failed', handler)

    bus.emit({
      type: 'flow:compile_failed',
      compileId: 'c-fail',
      stage: 3,
      errorCount: 2,
      durationMs: 4,
    })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({
      type: 'flow:compile_failed',
      compileId: 'c-fail',
      stage: 3,
      errorCount: 2,
      durationMs: 4,
    })
  })

  it('narrows astNodeType to null on parse-unreachable input', () => {
    const bus = createEventBus()
    const handler = vi.fn()
    bus.on('flow:compile_parsed', handler)

    bus.emit({
      type: 'flow:compile_parsed',
      compileId: 'c-null',
      astNodeType: null,
      errorCount: 1,
    })

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ astNodeType: null, errorCount: 1 }),
    )
  })
})

/**
 * Tests for Wave 11 `flow:compile_*` lifecycle event forwarding.
 *
 * Covers:
 *   - All 7 events fire in correct order for a clean compile
 *   - Shared `compileId` across every event in one compile() call
 *   - Stage 1 failure path (started → parsed → failed; no shape/semantic/lowered)
 *   - Stage 3 failure path (started → parsed → shape_validated → semantic_resolved → failed)
 *   - `forwardInnerEvents: false` + bus provided → zero events emitted
 *   - `forwardInnerEvents: undefined` + no bus → zero events emitted, no throw
 *   - Concurrent compile() calls produce distinct compileId streams
 */

import type { ResolvedTool, ToolResolver } from '@dzupagent/flow-ast'
import { createEventBus, type DzupEvent } from '@dzupagent/core'
import { describe, expect, it } from 'vitest'

import { createFlowCompiler } from '../src/index.js'

function makeResolver(names: string[]): ToolResolver {
  const set = new Set(names)
  return {
    resolve(ref) {
      if (!set.has(ref)) return null
      const rt: ResolvedTool = { ref, kind: 'skill', inputSchema: {}, handle: {} }
      return rt
    },
    listAvailable: () => Array.from(set),
  }
}

// Capture all `flow:compile_*` events via the wildcard subscriber.
interface CapturedEvent {
  type: string
  compileId?: string
  payload: Record<string, unknown>
}

function captureEvents(bus: ReturnType<typeof createEventBus>): {
  captured: CapturedEvent[]
  // Promise that resolves on next microtask drain so tests can observe
  // handlers that the bus schedules microtask-asynchronously.
  drained(): Promise<void>
} {
  const captured: CapturedEvent[] = []
  bus.onAny((e: DzupEvent) => {
    if (e.type.startsWith('flow:compile_')) {
      const { type, ...rest } = e as unknown as { type: string; compileId?: string }
      captured.push({
        type,
        compileId: rest.compileId,
        payload: rest as unknown as Record<string, unknown>,
      })
    }
  })
  return {
    captured,
    drained: async () => {
      // Multiple ticks flush any nested microtasks from the bus dispatcher.
      for (let i = 0; i < 4; i++) {
        await Promise.resolve()
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Happy path — full 7-event sequence
// ---------------------------------------------------------------------------

describe('flow-compiler event bus — happy path', () => {
  it('fires all seven events in order with a shared compileId', async () => {
    const bus = createEventBus()
    const { captured, drained } = captureEvents(bus)
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(['pm.run']),
      forwardInnerEvents: true,
      eventBus: bus,
    })

    const result = await compiler.compile({ type: 'action', toolRef: 'pm.run', input: {} })
    await drained()

    expect('errors' in result).toBe(false)
    const success = result as { compileId: string; target: string }
    expect(typeof success.compileId).toBe('string')
    expect(success.compileId.length).toBeGreaterThan(0)

    const types = captured.map((c) => c.type)
    expect(types).toEqual([
      'flow:compile_started',
      'flow:compile_parsed',
      'flow:compile_shape_validated',
      'flow:compile_semantic_resolved',
      'flow:compile_lowered',
      'flow:compile_completed',
    ])

    // Every event shares the same compileId.
    const ids = new Set(captured.map((c) => c.compileId))
    expect(ids.size).toBe(1)
    expect(ids.has(success.compileId)).toBe(true)
  })

  it('emits compile_lowered with target + counts on the success path', async () => {
    const bus = createEventBus()
    const { captured, drained } = captureEvents(bus)
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(['pm.run']),
      forwardInnerEvents: true,
      eventBus: bus,
    })

    await compiler.compile({ type: 'action', toolRef: 'pm.run', input: {} })
    await drained()

    const lowered = captured.find((c) => c.type === 'flow:compile_lowered')
    expect(lowered).toBeDefined()
    expect(lowered?.payload.target).toBe('skill-chain')
    expect(typeof lowered?.payload.nodeCount).toBe('number')
    expect(typeof lowered?.payload.warningCount).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

describe('flow-compiler event bus — failure paths', () => {
  it('stage 1 failure: started → parsed (errorCount>0) → failed; no shape/semantic/lowered', async () => {
    const bus = createEventBus()
    const { captured, drained } = captureEvents(bus)
    const compiler = createFlowCompiler({
      toolResolver: makeResolver([]),
      forwardInnerEvents: true,
      eventBus: bus,
    })

    // Invalid JSON → parseFlow returns ast=null with errors.
    await compiler.compile('{{not-valid-json')
    await drained()

    const types = captured.map((c) => c.type)
    expect(types).toContain('flow:compile_started')
    expect(types).toContain('flow:compile_parsed')
    expect(types).toContain('flow:compile_failed')
    expect(types).not.toContain('flow:compile_shape_validated')
    expect(types).not.toContain('flow:compile_semantic_resolved')
    expect(types).not.toContain('flow:compile_lowered')
    expect(types).not.toContain('flow:compile_completed')

    const parsed = captured.find((c) => c.type === 'flow:compile_parsed')
    expect((parsed?.payload.errorCount as number) > 0).toBe(true)

    const failed = captured.find((c) => c.type === 'flow:compile_failed')
    expect(failed?.payload.stage).toBe(1)
  })

  it('stage 3 failure: semantic_resolved (errorCount>0) → failed; no lowered/completed', async () => {
    const bus = createEventBus()
    const { captured, drained } = captureEvents(bus)
    const compiler = createFlowCompiler({
      toolResolver: makeResolver([]),   // empty — nothing resolves
      forwardInnerEvents: true,
      eventBus: bus,
    })

    await compiler.compile({ type: 'action', toolRef: 'pm.missing', input: {} })
    await drained()

    const types = captured.map((c) => c.type)
    expect(types).toEqual([
      'flow:compile_started',
      'flow:compile_parsed',
      'flow:compile_shape_validated',
      'flow:compile_semantic_resolved',
      'flow:compile_failed',
    ])

    const semantic = captured.find((c) => c.type === 'flow:compile_semantic_resolved')
    expect((semantic?.payload.errorCount as number) > 0).toBe(true)

    const failed = captured.find((c) => c.type === 'flow:compile_failed')
    expect(failed?.payload.stage).toBe(3)
  })

  it('stage 2 failure: shape_validated (errorCount>0) → failed; no semantic/lowered', async () => {
    const bus = createEventBus()
    const { captured, drained } = captureEvents(bus)
    const compiler = createFlowCompiler({
      toolResolver: makeResolver([]),
      forwardInnerEvents: true,
      eventBus: bus,
    })

    // Empty sequence body triggers EMPTY_BODY (stage 2).
    await compiler.compile({ type: 'sequence', nodes: [] })
    await drained()

    const types = captured.map((c) => c.type)
    expect(types).toEqual([
      'flow:compile_started',
      'flow:compile_parsed',
      'flow:compile_shape_validated',
      'flow:compile_failed',
    ])
    const failed = captured.find((c) => c.type === 'flow:compile_failed')
    expect(failed?.payload.stage).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Off path
// ---------------------------------------------------------------------------

describe('flow-compiler event bus — off path', () => {
  it('forwardInnerEvents:false + bus provided → zero events emitted', async () => {
    const bus = createEventBus()
    const { captured, drained } = captureEvents(bus)
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(['pm.run']),
      forwardInnerEvents: false,
      eventBus: bus,
    })

    await compiler.compile({ type: 'action', toolRef: 'pm.run', input: {} })
    await drained()

    expect(captured).toEqual([])
  })

  it('forwardInnerEvents omitted + no bus → zero events emitted, no throw', async () => {
    const compiler = createFlowCompiler({ toolResolver: makeResolver(['pm.run']) })

    // No bus wiring at all — should just compile cleanly.
    const result = await compiler.compile({ type: 'action', toolRef: 'pm.run', input: {} })
    expect('errors' in result).toBe(false)
    expect(typeof (result as { compileId: string }).compileId).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe('flow-compiler event bus — concurrency', () => {
  it('two concurrent compiles produce distinct compileId streams', async () => {
    const bus = createEventBus()
    const { captured, drained } = captureEvents(bus)
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(['pm.a', 'pm.b']),
      forwardInnerEvents: true,
      eventBus: bus,
    })

    const [r1, r2] = await Promise.all([
      compiler.compile({ type: 'action', toolRef: 'pm.a', input: {} }),
      compiler.compile({ type: 'action', toolRef: 'pm.b', input: {} }),
    ])
    await drained()

    const id1 = (r1 as { compileId: string }).compileId
    const id2 = (r2 as { compileId: string }).compileId
    expect(id1).not.toBe(id2)

    const ids = new Set(captured.map((c) => c.compileId))
    expect(ids.has(id1)).toBe(true)
    expect(ids.has(id2)).toBe(true)
    expect(ids.size).toBe(2)

    // Each stream is internally ordered. Filter per compileId, assert order.
    const stream1 = captured.filter((c) => c.compileId === id1).map((c) => c.type)
    const stream2 = captured.filter((c) => c.compileId === id2).map((c) => c.type)
    const expected = [
      'flow:compile_started',
      'flow:compile_parsed',
      'flow:compile_shape_validated',
      'flow:compile_semantic_resolved',
      'flow:compile_lowered',
      'flow:compile_completed',
    ]
    expect(stream1).toEqual(expected)
    expect(stream2).toEqual(expected)
  })
})

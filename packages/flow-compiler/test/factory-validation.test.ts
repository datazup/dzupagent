/**
 * Wave 11 factory-time validation of `forwardInnerEvents` + `eventBus` pair.
 *
 * Covers the four combinations from ADR §7.3.
 */

import type { ResolvedTool, ToolResolver } from '@dzupagent/flow-ast'
import { createEventBus } from '@dzupagent/core'
import { describe, expect, it } from 'vitest'

import { createFlowCompiler } from '../src/index.js'

function emptyResolver(): ToolResolver {
  return {
    resolve: (): ResolvedTool | null => null,
    listAvailable: () => [],
  }
}

describe('createFlowCompiler — forwardInnerEvents + eventBus validation', () => {
  it('throws when forwardInnerEvents=true and eventBus is undefined', () => {
    expect(() =>
      createFlowCompiler({
        toolResolver: emptyResolver(),
        forwardInnerEvents: true,
      }),
    ).toThrow(/forwardInnerEvents.*eventBus|eventBus.*forwardInnerEvents/)
  })

  it('does not throw when forwardInnerEvents=true and eventBus is provided', () => {
    expect(() =>
      createFlowCompiler({
        toolResolver: emptyResolver(),
        forwardInnerEvents: true,
        eventBus: createEventBus(),
      }),
    ).not.toThrow()
  })

  it('does not throw when forwardInnerEvents=false and eventBus is undefined', () => {
    expect(() =>
      createFlowCompiler({
        toolResolver: emptyResolver(),
        forwardInnerEvents: false,
      }),
    ).not.toThrow()
  })

  it('does not throw when forwardInnerEvents=false and eventBus is provided (bus unused)', () => {
    expect(() =>
      createFlowCompiler({
        toolResolver: emptyResolver(),
        forwardInnerEvents: false,
        eventBus: createEventBus(),
      }),
    ).not.toThrow()
  })

  it('error message mentions both forwardInnerEvents and eventBus', () => {
    try {
      createFlowCompiler({
        toolResolver: emptyResolver(),
        forwardInnerEvents: true,
      })
      throw new Error('expected throw')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      expect(msg).toContain('forwardInnerEvents')
      expect(msg).toContain('eventBus')
    }
  })
})

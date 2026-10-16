import { expect, test } from 'vitest'
import { resolveAgentHandlerEffectClass, AgentHandlerEffectMappingError } from '../agent-blueprint.js'

test('coarse effects cannot silently authorize a different execution effect', () => {
  expect(resolveAgentHandlerEffectClass('none')).toEqual({ handlerEffectClass: 'none', executionEffectClass: 'compute' })
  expect(resolveAgentHandlerEffectClass('read', 'read').executionEffectClass).toBe('read')
  for (const effect of ['write', 'external'] as const) {
    expect(() => resolveAgentHandlerEffectClass(effect)).toThrow(AgentHandlerEffectMappingError)
    expect(resolveAgentHandlerEffectClass(effect, 'file_write').executionEffectClass).toBe('file_write')
  }
  expect(() => resolveAgentHandlerEffectClass('none', 'file_write')).toThrow(/maps exactly/)
  expect(() => resolveAgentHandlerEffectClass('read', 'compute')).toThrow(/maps exactly/)
  expect(() => resolveAgentHandlerEffectClass('write', 'read')).toThrow(/non-mutating/)
})

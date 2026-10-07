import { expect, test } from 'vitest'
import { resolveAgentHandlerEffectClass, AgentHandlerEffectMappingError } from '../agent-blueprint.js'
import { validateMessages, validateArtifact, nonEmptyStrings, uniqueEnumValues } from '../ai-execution-validation-primitives.js'
import type { AiExecutionDiagnostic } from '../ai-execution.js'

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
test('execution boundary diagnostics reject empty messages, malformed artifacts and duplicate enums', () => {
  const diagnostics: AiExecutionDiagnostic[] = []
  validateMessages([{ role: 'user', content: 'fixture' }], 'messages', diagnostics)
  validateArtifact({ uri: 'artifact:fixture', digest: 'sha256:fixture', contentClass: 'fixture' }, 'artifact', diagnostics)
  nonEmptyStrings(['valid'], 'values', diagnostics)
  expect(diagnostics).toEqual([])
  validateMessages([], 'messages', diagnostics)
  validateMessages([null, { role: 'unknown', content: '' }], 'messages', diagnostics)
  validateArtifact(null, 'artifact', diagnostics)
  nonEmptyStrings([], 'values', diagnostics)
  nonEmptyStrings([null, ''], 'values', diagnostics)
  uniqueEnumValues(['one', 'one', 2], ['one'], 'enum', diagnostics)
  expect(diagnostics.some(issue => issue.code === 'AI_DUPLICATE_VALUE')).toBe(true)
  expect(diagnostics.filter(issue => issue.code === 'AI_INVALID_VALUE').length).toBeGreaterThan(4)
})

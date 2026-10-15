import { expect, test } from 'vitest'
import { validateMessages, validateArtifact, nonEmptyStrings, uniqueEnumValues, uniqueStrings, sumTokens, jsonEqual } from '../ai-execution-validation-primitives.js'
import type { AiExecutionDiagnostic } from '../ai-execution.js'

test('execution boundary diagnostics reject empty messages, malformed artifacts and duplicate enums', () => {
  const diagnostics: AiExecutionDiagnostic[] = []
  validateMessages([{ role: 'user', content: 'fixture' }], 'messages', diagnostics)
  validateArtifact({ uri: 'artifact:fixture', digest: 'sha256:fixture', contentClass: 'fixture' }, 'artifact', diagnostics)
  nonEmptyStrings(['valid'], 'values', diagnostics)
  expect(diagnostics).toEqual([])
  validateMessages([], 'messages', diagnostics)
  validateMessages([null, { role: 'unknown', content: '' }], 'messages', diagnostics)
  validateArtifact(null, 'artifact', diagnostics)
  for (const artifact of [{}, { uri: ' ', digest: ' ', contentClass: ' ' }, { uri: 1, digest: 1, contentClass: 1 }]) validateArtifact(artifact, 'artifact', diagnostics)
  nonEmptyStrings([], 'values', diagnostics)
  nonEmptyStrings([null, ''], 'values', diagnostics)
  uniqueEnumValues(['one', 'one', 2], ['one'], 'enum', diagnostics)
  uniqueEnumValues(null, ['one'], 'enum', diagnostics)
  uniqueStrings(null, 'strings', diagnostics)
  uniqueStrings(['one', 'one', 2], 'strings', diagnostics)
  expect(sumTokens([null, { input: 2, output: 3, reasoning: 1 }, { input: 2, output: 4, reasoning: 1 }])).toEqual({ input: 4, output: 7, reasoning: 2 })
  expect(jsonEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true)
  expect(jsonEqual({ value: 1n }, {})).toBe(false)
  expect(diagnostics.some(issue => issue.code === 'AI_DUPLICATE_VALUE')).toBe(true)
  expect(diagnostics.filter(issue => issue.code === 'AI_INVALID_VALUE').length).toBeGreaterThan(4)
})

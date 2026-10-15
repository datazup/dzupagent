import { test, expect } from 'vitest'
import { composeValidators, passingResult, failingResult } from '../contracts/validation.js'

test('composed preflight checks retain every issue while preventing execution on any failure', async () => {
  const warning = { code: 'warning', message: 'fixture', severity: 'warning' as const }
  const result = await composeValidators('all', { name: 'first', validate: () => passingResult(warning) }, { name: 'second', validate: async () => failingResult(warning) }).validate({ prompt: 'fixture' }, { providerId: 'codex' })
  expect(result.ok).toBe(false)
  expect(result.issues.map(issue => issue.severity)).toEqual(['warning', 'error'])
})

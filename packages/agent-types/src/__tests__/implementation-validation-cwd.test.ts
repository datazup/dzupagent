import { test, expect } from 'vitest'
import { validateImplementationPlan, IMPLEMENTATION_ORCHESTRATION_SCHEMA_VERSION, type ImplementationPlan } from '../implementation.js'

test('validation cwd permits normalized relative paths while rejecting escapes and drive paths', () => {
  const plan: ImplementationPlan = { schemaVersion: IMPLEMENTATION_ORCHESTRATION_SCHEMA_VERSION, id: 'fixture', goal: 'fixture', repos: [{ id: 'repo', path: 'repo' }], batches: [{ id: 'batch', title: 'fixture', mode: 'serial', taskIds: ['task'] }], tasks: [{ id: 'task', repoId: 'repo', title: 'fixture', prompt: 'fixture', scopeFiles: [], acceptanceCriteria: ['fixture'], validationCommands: [] }], policy: { maxAttemptsPerTask: 1, repoConcurrency: 1, highRiskRequiresApproval: true } }
  for (const path of ['src/../safe.ts', './src//safe.ts', 'src\\..\\safe.ts']) {
    plan.tasks[0]!.validationCommands = [{ command: 'fixture', cwd: path, scope: 'task' }]
    expect(validateImplementationPlan(plan).issues.some(issue => issue.code === 'validation-cwd-escapes-repo')).toBe(false)
  }
  for (const path of ['../escape', 'C:\\escape', '/escape', 'src/../../escape']) {
    plan.tasks[0]!.validationCommands = [{ command: 'fixture', cwd: path, scope: 'task' }]
    expect(validateImplementationPlan(plan).issues.some(issue => issue.code === 'validation-cwd-escapes-repo')).toBe(true)
  }
})

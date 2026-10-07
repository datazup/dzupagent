import { test, expect } from 'vitest'
import { DeployConfidenceCalculator } from '../deploy/confidence-calculator.js'
import { DeploymentHistory, resetIdCounter } from '../deploy/deployment-history.js'

test('confidence decisions honor thresholds, stale evidence, and recovery readiness', () => {
  const calc = new DeployConfidenceCalculator({ environment: 'fixture' })
  expect(calc.compute().decision).toBe('block')
  for (const [score, decision] of [[100, 'auto_deploy'], [75, 'deploy_with_warnings'], [55, 'require_approval'], [10, 'block']] as const) {
    calc.reset()
    calc.addCustomSignal({ name: 'fixture', score, weight: 1, source: 'fixture', stale: false, timestamp: new Date() })
    expect(calc.compute().decision).toBe(decision)
  }
  calc.reset()
  calc.addDoctorSignal({ categories: [], summary: { passed: 9, failures: 1, warnings: 0, total: 10 }, timestamp: '2020-01-01T00:00:00Z' })
    .addScorecardSignal({ generatedAt: new Date(), overallScore: 100, grade: 'A', categories: [], recommendations: [] })
    .addTestCoverageSignal(95).addGuardrailSignal(false, 1, 1)
    .addHistoricalSignal(0.9, 20).addChangeRiskSignal(2, 100, true).addRecoverySignal(true, false)
  const result = calc.compute()
  expect(result.signals).toHaveLength(7)
  expect(result.signals.find(s => s.name === 'doctorHealth')).toMatchObject({ score: 80, stale: true })
  expect(result.explanation).toContain('stale')
  expect(result.explanation).toContain('Weak signals')
  calc.reset()
  calc.addGuardrailSignal(true, 0, 0).addHistoricalSignal(0.8, 1).addRecoverySignal(false, true)
  expect(calc.compute().signals.map(s => s.score)).toEqual([100, 70, 50])
})

test('deployment history excludes unrelated, unfinished and expired outcomes', () => {
  resetIdCounter()
  const history = new DeploymentHistory()
  const confidence = new DeployConfidenceCalculator({ environment: 'fixture' }).compute()
  const first = history.createRecord(confidence, 'block')
  const second = history.createRecord(confidence, 'block')
  expect(first.id).not.toBe(second.id)
  history.complete(first.id, 'success')
  history.complete(second.id, 'rollback')
  history.record({ ...first, id: 'old', deployedAt: new Date(0) })
  history.record({ ...first, id: 'other', environment: 'other' })
  expect(history.complete('missing', 'failure')).toBeUndefined()
  expect(history.getSuccessRate('fixture')).toBe(0.5)
  expect(history.getSuccessRate('empty')).toBe(0)
  expect(history.getRecent('fixture', 1)).toHaveLength(1)
  expect(history.getTotalDeployments('fixture')).toBe(3)
  expect(history.getAll()).toHaveLength(4)
  history.clear()
  expect(history.getAll()).toEqual([])
})

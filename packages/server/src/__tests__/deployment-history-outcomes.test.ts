import { test, expect } from 'vitest'
import { DeployConfidenceCalculator } from '../deploy/confidence-calculator.js'
import { DeploymentHistory, resetIdCounter } from '../deploy/deployment-history.js'

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

import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { TEST_QUALITY_BASELINE, TEST_QUALITY_BASELINE_COUNTS } from '../../eslint.baseline.js'
import {
  baselineWarningBudget,
  classifyTestQualityMessage,
  collectTestQualityCounts,
  diffTestQualityCounts,
  TEST_QUALITY_RULE_IDS,
} from '../test-quality-baseline.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const STATELESS_MESSAGE
  = 'Stateless memory double: a spy cannot observe what the store holds, only that it was called.'
const VACUOUS_MESSAGE = 'Vacuous on an empty array: [].every() is true, so this passes when empty.'
const TIMEOUT_MESSAGE = 'Avoid real setTimeout in tests. Use vi.useFakeTimers() instead.'

function lintResult(file, messages) {
  return { filePath: path.join(repoRoot, file), messages }
}

function warning(message) {
  return { ruleId: 'no-restricted-syntax', severity: 1, message }
}

test('every baseline entry records at least one counted violation', () => {
  assert.equal(TEST_QUALITY_BASELINE.length > 0, true)
  assert.deepEqual(TEST_QUALITY_BASELINE, Object.keys(TEST_QUALITY_BASELINE_COUNTS))
  for (const [file, counts] of Object.entries(TEST_QUALITY_BASELINE_COUNTS)) {
    const ids = Object.keys(counts)
    assert.equal(ids.length > 0, true, `${file} records no rule`)
    for (const id of ids) {
      assert.equal(TEST_QUALITY_RULE_IDS.includes(id), true, `${file} records unknown rule ${id}`)
      assert.equal(Number.isInteger(counts[id]) && counts[id] > 0, true, `${file} ${id} must be a positive integer`)
    }
  }
})

test('messages classify to stable rule ids and unknown ones fail closed', () => {
  assert.equal(classifyTestQualityMessage(STATELESS_MESSAGE), 'stateless-memory-double')
  assert.equal(classifyTestQualityMessage(VACUOUS_MESSAGE), 'vacuous-every')
  assert.equal(classifyTestQualityMessage(TIMEOUT_MESSAGE), 'real-set-timeout')
  assert.equal(classifyTestQualityMessage('Some other restricted syntax'), null)
})

test('a rising count in an already-listed file is a failure', () => {
  const file = 'packages/demo/src/__tests__/a.test.ts'
  const measured = collectTestQualityCounts(
    [lintResult(file, [warning(TIMEOUT_MESSAGE), warning(TIMEOUT_MESSAGE)])],
    { root: repoRoot },
  )
  assert.deepEqual(measured.counts, { [file]: { 'real-set-timeout': 2 } })

  const { problems } = diffTestQualityCounts({
    observed: measured.counts,
    baseline: { [file]: { 'real-set-timeout': 1 } },
    scope: 'packages/demo/',
    lintedFiles: measured.lintedFiles,
  })
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, 'count-increased')
  assert.equal(problems[0].expected, 1)
  assert.equal(problems[0].actual, 2)
})

test('a violation of a second rule in a listed file is a failure', () => {
  const file = 'packages/demo/src/__tests__/a.test.ts'
  const measured = collectTestQualityCounts(
    [lintResult(file, [warning(TIMEOUT_MESSAGE), warning(VACUOUS_MESSAGE)])],
    { root: repoRoot },
  )
  const { problems } = diffTestQualityCounts({
    observed: measured.counts,
    baseline: { [file]: { 'real-set-timeout': 1 } },
    scope: 'packages/demo/',
    lintedFiles: measured.lintedFiles,
  })
  assert.deepEqual(problems.map((problem) => problem.ruleId), ['vacuous-every'])
})

test('a fixed violation must lower the recorded count, not silently pass', () => {
  const file = 'packages/demo/src/__tests__/a.test.ts'
  const measured = collectTestQualityCounts([lintResult(file, [warning(TIMEOUT_MESSAGE)])], {
    root: repoRoot,
  })
  const { problems } = diffTestQualityCounts({
    observed: measured.counts,
    baseline: { [file]: { 'real-set-timeout': 3 } },
    scope: 'packages/demo/',
    lintedFiles: measured.lintedFiles,
  })
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, 'baseline-stale')
  assert.match(problems[0].message, /lint:baseline:update/)
})

test('an unlisted file with violations is a failure, and a clean listed file is not', () => {
  const listed = 'packages/demo/src/__tests__/listed.test.ts'
  const fresh = 'packages/demo/src/__tests__/fresh.test.ts'
  const measured = collectTestQualityCounts(
    [lintResult(listed, []), lintResult(fresh, [warning(STATELESS_MESSAGE)])],
    { root: repoRoot },
  )
  const { problems } = diffTestQualityCounts({
    observed: measured.counts,
    baseline: {},
    scope: 'packages/demo/',
    lintedFiles: measured.lintedFiles,
  })
  assert.deepEqual(problems.map((problem) => problem.kind), ['unbaselined-file'])
})

test('files outside the linted scope are never judged', () => {
  const { problems } = diffTestQualityCounts({
    observed: {},
    baseline: { 'packages/other/src/__tests__/a.test.ts': { 'real-set-timeout': 4 } },
    scope: 'packages/demo/',
    lintedFiles: [],
  })
  assert.deepEqual(problems, [])
})

test('a baselined file that was not linted in this run is not called stale', () => {
  const { problems } = diffTestQualityCounts({
    observed: {},
    baseline: { 'packages/demo/src/__tests__/a.test.ts': { 'real-set-timeout': 4 } },
    scope: 'packages/demo/',
    lintedFiles: [],
  })
  assert.deepEqual(problems, [])
})

test('the --max-warnings=baseline budget is the recorded total for the scope', () => {
  const baseline = {
    'packages/demo/src/__tests__/a.test.ts': { 'real-set-timeout': 2, 'vacuous-every': 1 },
    'packages/other/src/__tests__/b.test.ts': { 'real-set-timeout': 5 },
  }
  assert.equal(baselineWarningBudget(baseline, 'packages/demo/'), 3)
  assert.equal(baselineWarningBudget(baseline, 'packages/other/'), 5)
  assert.equal(baselineWarningBudget(baseline), 8)
})

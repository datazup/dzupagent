import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

const REPO_ROOT = resolve(import.meta.dirname, '../..')
const JSON_PATH = resolve(
  REPO_ROOT,
  'docs/generated/MEMORY_CONFORMANCE_BASELINE.v1.json',
)
const MARKDOWN_PATH = resolve(
  REPO_ROOT,
  'docs/generated/MEMORY_CONFORMANCE_BASELINE.v1.md',
)

test('MEM-P007-A baseline is current, content-free, and qualification-bounded', () => {
  execFileSync(
    'yarn',
    ['tsx', 'scripts/generate-memory-conformance-baseline.ts', '--check'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' },
  )

  const jsonBytes = readFileSync(JSON_PATH, 'utf8')
  const markdown = readFileSync(MARKDOWN_PATH, 'utf8')
  const result = JSON.parse(jsonBytes)

  assert.equal(result.schema, 'datazup.memory.conformance-baseline/v1')
  assert.equal(result.status, 'passed')
  assert.equal(result.harnessVersion, 'mem-p007a-v1')
  assert.deepEqual(result.counts, {
    total: 57,
    passed: 57,
    failed: 0,
    expectedRed: 0,
    unexpectedPass: 0,
  })
  assert.equal(result.qualification.providerFree, 'passed')
  assert.equal(result.qualification.aggregate, 'not-evaluated-by-this-artifact')
  assert.equal(result.qualification.liveProvider, 'not-run')
  assert.equal(result.qualification.productionEnablement, 'not-enabled')
  assert.match(result.source.digest, /^sha256:[a-f0-9]{64}$/)
  assert.equal(
    result.reports.every(report => report.sourceDigest === result.source.digest),
    true,
  )
  assert.equal(
    result.reports.some(report =>
      report.suiteId === 'memory-worker-conformance'
      && report.domain === 'worker'
      && report.counts.passed === 15),
    true,
  )
  assert.equal(
    result.supplementalGates.some(gate =>
      gate.id === 'memory-projection-conformance' && gate.expectedTests === 4),
    true,
  )
  assert.equal(
    result.metricDistributions.some(metric =>
      metric.name === 'reclaimed-tokens'
      && metric.threshold === 1
      && metric.comparison === 'at-least'),
    true,
  )
  assert.equal(jsonBytes.includes('INVENTED_CANARY_'), false)
  assert.equal(markdown.includes('INVENTED_CANARY_'), false)
})

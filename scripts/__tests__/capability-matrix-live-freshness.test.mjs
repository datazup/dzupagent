import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { checkCapabilityMatrixFreshness } from '../check-capability-matrix-freshness.mjs'

/**
 * DZUPAGENT-CODE-M-18: check:capability-matrix was red at HEAD for a week because
 * nothing outside the verify chains asserted the LIVE matrix (the existing
 * freshness tests use fixture repositories only). A packet that widens a public
 * barrel must regenerate docs/CAPABILITY_MATRIX.md (yarn docs:capability-matrix)
 * in the same commit, or this test fails under test:scripts.
 */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CHECK_SCRIPT = fileURLToPath(new URL('../check-capability-matrix-freshness.mjs', import.meta.url))

test('the committed capability matrix matches the rendered public surface', () => {
  assert.deepEqual(checkCapabilityMatrixFreshness(REPO_ROOT), { ok: true, code: 'FRESH' })
})

test('the freshness gate CLI reports up to date and exits 0', () => {
  const run = spawnSync(process.execPath, [CHECK_SCRIPT], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /CAPABILITY_MATRIX\.md is up to date\./)
})

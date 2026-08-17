/**
 * The blocking build gate must be invoked through Yarn.
 *
 * `turbo` is a Yarn-managed binary and is NOT on PATH. Every other gate is
 * built by `asGate` as `yarn <script>`, so Yarn supplies node_modules/.bin.
 * The build step is the one gate written as a raw command string, and when it
 * was spawned with bare `node` it died instantly with
 * "build-custody: spawn turbo ENOENT".
 *
 * That failure was expensive out of proportion to its size: the gate is
 * `blocking: true`, so the profile aborted and the four gates after it never
 * ran -- reported as "1 of 18 failed" while 4 more were simply unknown.
 *
 * These assertions used to scrape run-gates.mjs as source text, because the
 * module exported nothing and importing it ran the whole profile. It now has an
 * entrypoint guard and real exports, so they read the gate object directly:
 * a source regex silently stops matching the moment the literal is refactored
 * into a constant, and a test that cannot find its subject reports a broken
 * regex rather than a broken build step.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BUILD_GATE_NAME, PROFILES } from '../run-gates.mjs'

const buildStep = PROFILES['strict-ci'].find((gate) => gate.name === BUILD_GATE_NAME)

test('the build step is defined with a run command', () => {
  assert.ok(buildStep, `no gate named ${BUILD_GATE_NAME} in the strict-ci profile`)
  assert.equal(typeof buildStep.run, 'string')
  assert.ok(buildStep.run.length > 0)
})

test('the build step invokes turbo through yarn, not bare node', () => {
  const run = buildStep.run
  assert.match(run, /^yarn /, `build step must start with "yarn " so turbo resolves; got: ${run}`)
  assert.doesNotMatch(
    run,
    /^node /,
    'bare `node` leaves turbo off PATH and fails with spawn turbo ENOENT',
  )
})

test('the build step still runs the full turbo task set under build custody', () => {
  const run = buildStep.run
  // Guards the fix from being "corrected" by dropping custody or tasks.
  assert.match(run, /run-with-build-custody\.mjs/)
  assert.match(run, /turbo run build:verify typecheck lint test/)
})

test('the build step remains blocking', () => {
  // Later gates read this build's output; running them on a failed build
  // reports noise, so the blocking flag is load-bearing.
  assert.equal(buildStep.blocking, true)
})

test('the build step is the only gate carrying a raw command', () => {
  // Every other gate must go through `asGate`, which is what guarantees the
  // `yarn ` prefix. A second hand-written gate would bypass that guarantee.
  const raw = PROFILES['strict-ci'].filter((gate) => gate.run !== `yarn ${gate.name}`)

  assert.deepEqual(
    raw.map((gate) => gate.name),
    [BUILD_GATE_NAME],
  )
})

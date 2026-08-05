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
 * ran — reported as "1 of 18 failed" while 4 more were simply unknown.
 *
 * Asserted against source text because run-gates.mjs exports nothing.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(
  fileURLToPath(new URL('../run-gates.mjs', import.meta.url)),
  'utf8',
)

const buildStepRun = /name:\s*"build\+typecheck\+lint\+test",[\s\S]*?run:\s*"([^"]+)"/.exec(source)

test('the build step is defined with a run command', () => {
  assert.ok(buildStepRun, 'could not find the build step run command')
})

test('the build step invokes turbo through yarn, not bare node', () => {
  const run = buildStepRun[1]
  assert.match(run, /^yarn /, `build step must start with "yarn " so turbo resolves; got: ${run}`)
  assert.doesNotMatch(
    run,
    /^node /,
    'bare `node` leaves turbo off PATH and fails with spawn turbo ENOENT',
  )
})

test('the build step still runs the full turbo task set under build custody', () => {
  const run = buildStepRun[1]
  // Guards the fix from being "corrected" by dropping custody or tasks.
  assert.match(run, /run-with-build-custody\.mjs/)
  assert.match(run, /turbo run build:verify typecheck lint test/)
})

test('the build step remains blocking', () => {
  // Later gates read this build's output; running them on a failed build
  // reports noise, so the blocking flag is load-bearing.
  assert.match(
    source,
    /name:\s*"build\+typecheck\+lint\+test",[\s\S]*?blocking:\s*true/,
  )
})

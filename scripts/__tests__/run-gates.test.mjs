import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  BUILD_GATE_NAME,
  PROFILES,
  compareProfileToChain,
  parseChainGates,
} from '../run-gates.mjs'

const CHAIN_SCRIPT = 'verify:strict:ci:no-circular'
const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
)

const gate = (name) => ({ name, run: `yarn ${name}` })

// The build clause is written out inline in the chain rather than as a
// `yarn <script>` indirection, so the parser has to recognise it by content.
const BUILD_CLAUSE =
  'node scripts/run-with-build-custody.mjs turbo run build:verify typecheck lint test --concurrency=4 --output-logs=new-only'

test('the strict-ci profile runs exactly the gates the verify chain declares', () => {
  // This is the load-bearing assertion. CI runs `yarn verify:gates`, which runs
  // the PROFILE. `verify:strict:ci:no-circular` is what a human reads to learn
  // which gates exist. When they disagree, the chain lies and CI is weaker than
  // it appears -- which is exactly what happened: three gates sat in the chain
  // and never once ran in CI, and two of them had rotted red.
  const result = compareProfileToChain(
    PROFILES['strict-ci'],
    packageJson.scripts[CHAIN_SCRIPT]
  )

  assert.deepEqual(result.messages, [])
  assert.equal(result.ok, true)
})

test('a chain gate missing from the profile is reported as never running', () => {
  // The exact historical defect, reproduced: check:memory-api-census was in the
  // chain and absent from the profile for 13 days.
  const chain = 'yarn check:one && yarn check:two'
  const result = compareProfileToChain([gate('check:one')], chain)

  assert.equal(result.ok, false)
  assert.equal(result.messages.length, 1)
  assert.match(result.messages[0], /check:two/)
  assert.match(result.messages[0], /never runs/)
})

test('a profile gate absent from the chain is reported too', () => {
  const result = compareProfileToChain(
    [gate('check:one'), gate('check:ghost')],
    'yarn check:one'
  )

  assert.equal(result.ok, false)
  assert.equal(result.messages.length, 1)
  assert.match(result.messages[0], /check:ghost/)
  assert.match(result.messages[0], /NOT in the verify chain/)
})

test('the same gates in a different order are reported, not accepted', () => {
  // The workflow comment promises the gates run "in the same order"; set
  // equality alone would let that promise rot.
  const result = compareProfileToChain(
    [gate('check:two'), gate('check:one')],
    'yarn check:one && yarn check:two'
  )

  assert.equal(result.ok, false)
  assert.equal(result.messages.length, 1)
  assert.match(result.messages[0], /different order/)
})

test('an agreeing profile and chain produce no messages', () => {
  const result = compareProfileToChain(
    [gate('check:one'), gate('check:two')],
    'yarn check:one && yarn check:two'
  )

  assert.deepEqual(result.messages, [])
  assert.equal(result.ok, true)
})

test('the inline build clause is recognised as the build gate', () => {
  // If the parser missed this, the build step would look like a profile-only
  // gate AND a chain-only gate, and the real comparison would be pure noise.
  assert.deepEqual(parseChainGates(`yarn check:one && ${BUILD_CLAUSE}`), [
    'check:one',
    BUILD_GATE_NAME,
  ])
})

test('every gate the profile names is a script that exists', () => {
  // A gate whose script was renamed would fail at spawn time inside CI, after
  // the run has already spent its build. Catch it statically instead.
  const missing = PROFILES['strict-ci']
    .map((g) => g.name)
    .filter((name) => name !== BUILD_GATE_NAME)
    .filter((name) => !Object.hasOwn(packageJson.scripts, name))

  assert.deepEqual(missing, [])
})

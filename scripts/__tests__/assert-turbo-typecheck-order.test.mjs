import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  checkBuildOrdering,
  checkGateScriptOrdering,
  checkNoTopologicalDepsOnRootTasks,
  checkTurboTypecheckOrder,
} from '../assert-turbo-typecheck-order.mjs'

const AGENT_ADAPTERS_DEPS = [
  '@dzupagent/adapter-rules#build:verify',
  '@dzupagent/adapter-types#build:verify',
  '@dzupagent/agent#build:verify',
  '@dzupagent/agent-types#build:verify',
  '@dzupagent/core#build:verify',
  '@dzupagent/runtime-contracts#build:verify',
  '@dzupagent/security#build:verify',
  '@dzupagent/subagents#build:verify',
]

function validTurbo(overrides = {}) {
  return {
    tasks: {
      typecheck: { dependsOn: ['^build:verify', '^typecheck'] },
      test: { dependsOn: ['^build:verify'] },
      'test:integration': { dependsOn: ['^build:verify'] },
      'test:coverage': { dependsOn: ['^build:verify'] },
      '@dzupagent/agent-adapters#typecheck': { dependsOn: AGENT_ADAPTERS_DEPS },
      ...overrides,
    },
  }
}

function validPackageJson(overrides = {}) {
  return {
    scripts: {
      'check:test-typecheck':
        'node scripts/run-with-build-custody.mjs turbo run build:verify && node scripts/check-test-typecheck.mjs',
      'verify:strict': 'yarn check:test-typecheck && yarn test:coverage && yarn check:workspace:coverage',
      ...overrides,
    },
  }
}

test('a fully ordered config passes', () => {
  const result = checkTurboTypecheckOrder(validTurbo(), validPackageJson())

  assert.deepEqual(result.messages, [])
  assert.equal(result.ok, true)
})

test('a dist-consuming task with no build edge is rejected', () => {
  const messages = checkBuildOrdering(validTurbo({ 'test:coverage': { dependsOn: [] } }))

  assert.equal(messages.length, 1)
  assert.match(messages[0], /test:coverage.*no "\*build:verify" edge/)
})

test('a package override that drops the topological build edge is rejected', () => {
  // The exact shape that let @dzupagent/memory#typecheck run against unbuilt
  // siblings: an override REPLACES the generic entry rather than merging, so
  // listing only an unrelated edge silently discards ^build:verify.
  const messages = checkBuildOrdering(
    validTurbo({ '@dzupagent/memory#typecheck': { dependsOn: ['^typecheck'] } })
  )

  assert.equal(messages.length, 1)
  assert.match(messages[0], /@dzupagent\/memory#typecheck/)
})

test('an override keeping an explicit build edge is accepted', () => {
  const messages = checkBuildOrdering(
    validTurbo({
      '@dzupagent/memory#typecheck': { dependsOn: ['@dzupagent/memory-ipc#build:verify'] },
    })
  )

  assert.deepEqual(messages, [])
})

test('dependsOn that is not an array is reported rather than skipped', () => {
  const messages = checkBuildOrdering(validTurbo({ test: { dependsOn: '^build:verify' } }))

  assert.equal(messages.length, 1)
  assert.match(messages[0], /must be an array/)
})

test('a root task using "^" is rejected because it silently resolves to nothing', () => {
  // Verified against turbo 2.10.0: `turbo run //#x --dry=json` reports the task
  // with ZERO dependencies rather than erroring, so this mistake is invisible
  // at runtime and has to be caught statically.
  const messages = checkNoTopologicalDepsOnRootTasks({
    tasks: { '//#check:test-typecheck': { dependsOn: ['^build:verify'] } },
  })

  assert.equal(messages.length, 1)
  assert.match(messages[0], /resolves to no dependencies at all/)
})

test('a root task naming an explicit package task is accepted', () => {
  const messages = checkNoTopologicalDepsOnRootTasks({
    tasks: { '//#check:test-typecheck': { dependsOn: ['@dzupagent/core#build:verify'] } },
  })

  assert.deepEqual(messages, [])
})

test('the gate script must build before it measures', () => {
  const messages = checkGateScriptOrdering(
    validPackageJson({ 'check:test-typecheck': 'node scripts/check-test-typecheck.mjs' })
  )

  assert.equal(messages.length, 1)
  assert.match(messages[0], /BEFORE/)
})

test('a build that runs after the gate is rejected, not just an absent one', () => {
  const messages = checkGateScriptOrdering(
    validPackageJson({
      'check:test-typecheck': 'node scripts/check-test-typecheck.mjs && turbo run build:verify',
    })
  )

  assert.equal(messages.length, 1)
})

test('reading the coverage gate without producing coverage is rejected', () => {
  const messages = checkGateScriptOrdering(
    validPackageJson({ 'verify:strict': 'yarn check:workspace:coverage' })
  )

  assert.equal(messages.length, 1)
  assert.match(messages[0], /no coverage summary exists/)
})

test('a chain that does not run the coverage gate at all is not flagged', () => {
  const messages = checkGateScriptOrdering(validPackageJson({ 'verify:strict': 'yarn test' }))

  assert.deepEqual(messages, [])
})

test('the original agent-adapters assertions still fire', () => {
  const turbo = validTurbo({
    '@dzupagent/agent-adapters#typecheck': { dependsOn: ['@dzupagent/core#build:verify'] },
  })

  const result = checkTurboTypecheckOrder(turbo, validPackageJson())

  assert.equal(result.ok, false)
  assert.equal(
    result.messages.filter((m) => m.includes('dependsOn to include')).length,
    AGENT_ADAPTERS_DEPS.length - 1
  )
})

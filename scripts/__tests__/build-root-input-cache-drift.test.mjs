import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ROOT_BUILD_INPUTS } from '../build-artifact-integrity.mjs'
import {
  assertDrift,
  dryRunIdentity,
  driftedRootInputBytes,
  GOVERNED_ROOT_CACHE_INPUTS,
  governedRootCacheInputs,
} from '../qualify-build-root-input-cache-drift.mjs'

test('campaign binds every governed root configuration input', () => {
  assert.deepEqual(governedRootCacheInputs(), GOVERNED_ROOT_CACHE_INPUTS)
  assert.throws(
    () => governedRootCacheInputs(ROOT_BUILD_INPUTS.filter((input) => input !== 'yarn.lock')),
    /not bound to every governed root cache input/,
  )
})

test('drift mutations change bytes while preserving JSON syntax', () => {
  for (const inputPath of GOVERNED_ROOT_CACHE_INPUTS) {
    const original = inputPath.endsWith('.json')
      ? Buffer.from('{"fixture":true}\n')
      : Buffer.from('fixture: true\n')
    const drifted = driftedRootInputBytes(inputPath, original)
    assert.equal(drifted.equals(original), false, inputPath)
    if (inputPath.endsWith('.json')) {
      assert.deepEqual(JSON.parse(drifted.toString('utf8')), { fixture: true })
    }
  }
  assert.throws(
    () => driftedRootInputBytes('scripts/unknown.mjs', Buffer.from('fixture')),
    /unsupported governed root cache input/,
  )
})

test('dry-run identity requires both governed file and target task hashes', () => {
  const dryRun = {
    globalCacheInputs: { files: { 'package.json': 'file-a' } },
    tasks: [{ taskId: '@dzupagent/memory#build', hash: 'task-a' }],
  }
  assert.deepEqual(
    dryRunIdentity(dryRun, {
      inputPath: 'package.json',
      taskId: '@dzupagent/memory#build',
    }),
    { globalFileHash: 'file-a', taskHash: 'task-a' },
  )
  assert.throws(
    () => dryRunIdentity(dryRun, {
      inputPath: 'yarn.lock',
      taskId: '@dzupagent/memory#build',
    }),
    /omitted governed global input/,
  )
})

test('drift requires a changed file identity and target task hash', () => {
  const baseline = { globalFileHash: 'file-a', taskHash: 'task-a' }
  assert.doesNotThrow(() => assertDrift(
    'package.json',
    baseline,
    { globalFileHash: 'file-b', taskHash: 'task-b' },
  ))
  assert.throws(
    () => assertDrift(
      'package.json',
      baseline,
      { globalFileHash: 'file-a', taskHash: 'task-b' },
    ),
    /did not change Turbo's global file identity/,
  )
  assert.throws(
    () => assertDrift(
      'package.json',
      baseline,
      { globalFileHash: 'file-b', taskHash: 'task-a' },
    ),
    /did not invalidate the target build task hash/,
  )
})

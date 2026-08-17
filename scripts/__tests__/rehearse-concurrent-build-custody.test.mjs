import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createTypecheckArgs,
  DEFAULT_TASK_CONCURRENCY,
  rehearseConcurrentBuildCustody,
} from '../rehearse-concurrent-build-custody.mjs'

test('bounds each competing graph to one task by default', () => {
  assert.equal(DEFAULT_TASK_CONCURRENCY, 1)
  assert.deepEqual(createTypecheckArgs('@dzupagent/evals'), [
    'typecheck',
    '--filter=@dzupagent/evals',
    '--force',
    '--concurrency=1',
    '--output-logs=hash-only',
  ])
})

test('rejects unbounded or invalid task concurrency', () => {
  assert.throws(
    () => createTypecheckArgs('@dzupagent/evals', 0),
    /positive integer/,
  )
  assert.throws(
    () => createTypecheckArgs('@dzupagent/evals', Number.POSITIVE_INFINITY),
    /positive integer/,
  )
})

test('still launches two competing graphs concurrently', async () => {
  let active = 0
  let maxActive = 0
  let release
  const bothStarted = new Promise((resolve) => { release = resolve })
  const calls = []

  const runGraph = async (packageName, taskConcurrency) => {
    calls.push({ packageName, taskConcurrency })
    active += 1
    maxActive = Math.max(maxActive, active)
    if (active === 2) release()
    await bothStarted
    active -= 1
  }

  const result = await rehearseConcurrentBuildCustody(
    '@dzupagent/evals',
    { runGraph },
  )

  assert.equal(maxActive, 2)
  assert.deepEqual(calls, [
    { packageName: '@dzupagent/evals', taskConcurrency: 1 },
    { packageName: '@dzupagent/evals', taskConcurrency: 1 },
  ])
  assert.deepEqual(result, {
    packageName: '@dzupagent/evals',
    runCount: 2,
    taskConcurrency: 1,
  })
})

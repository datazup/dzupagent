import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  acquireBuildCustody,
  BUILD_CUSTODY_SCHEMA_VERSION,
  processDescendsFrom,
  validateBuildCustody,
} from '../build-custody.mjs'

async function withRoot(callback) {
  const root = await mkdtemp(path.join(tmpdir(), 'dzup-build-custody-'))
  try {
    await callback(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('serializes competing build graphs and releases custody cleanly', async () => {
  await withRoot(async (root) => {
    const first = await acquireBuildCustody({ root, retryDelayMs: 5 })
    let secondAcquired = false
    const secondPromise = acquireBuildCustody({ root, retryDelayMs: 5 })
      .then((custody) => {
        secondAcquired = true
        return custody
      })

    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(secondAcquired, false)
    await first.release()

    const second = await secondPromise
    assert.equal(second.inherited, false)
    await second.release()
  })
})

test('records only bounded, repository-relative custody metadata', async () => {
  await withRoot(async (root) => {
    const custody = await acquireBuildCustody({ root, retryDelayMs: 5 })
    const text = await readFile(
      path.join(root, '.turbo', 'build-custody-owner.json'),
      'utf8',
    )
    const owner = JSON.parse(text)
    assert.equal(owner.schemaVersion, BUILD_CUSTODY_SCHEMA_VERSION)
    assert.equal(owner.token, custody.token)
    assert.equal(text.includes(root), false)
    await custody.release()
  })
})

test('validates inherited custody and rejects a forged token', async () => {
  await withRoot(async (root) => {
    const custody = await acquireBuildCustody({ root, retryDelayMs: 5 })
    const owner = await validateBuildCustody({ root, token: custody.token })
    assert.equal(owner.pid, process.pid)
    await assert.rejects(
      validateBuildCustody({ root, token: 'forged-token' }),
      /not owned by this build graph/,
    )
    await custody.release()
  })
})

test('recognizes the current process ancestry without treating itself as a child', async () => {
  if (process.platform !== 'linux') return
  assert.equal(await processDescendsFrom(process.ppid), true)
  assert.equal(await processDescendsFrom(process.pid), false)
})

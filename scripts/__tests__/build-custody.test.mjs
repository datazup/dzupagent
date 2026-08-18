import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  acquireBuildCustody,
  BUILD_CUSTODY_SCHEMA_VERSION,
  ownerProcessIsAlive,
  processDescendsFrom,
  processStartTicks,
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

test('records the owning process start time so a recycled pid cannot pass', async () => {
  if (process.platform !== 'linux') return
  await withRoot(async (root) => {
    const custody = await acquireBuildCustody({ root, retryDelayMs: 5 })
    const owner = JSON.parse(await readFile(
      path.join(root, '.turbo', 'build-custody-owner.json'),
      'utf8',
    ))
    assert.equal(owner.pidStartTicks, await processStartTicks(process.pid))
    assert.equal(await ownerProcessIsAlive(owner), true)
    // The same live pid with a different start time is a recycled pid, not the
    // process that took custody.
    assert.equal(
      await ownerProcessIsAlive({ ...owner, pidStartTicks: owner.pidStartTicks + 1 }),
      false,
    )
    await custody.release()
  })
})

test('does not steal custody from a live holder starved past the old stale window', async () => {
  await withRoot(async (root) => {
    const custody = await acquireBuildCustody({ root, retryDelayMs: 5 })
    // Simulate the holder being descheduled long enough to miss several
    // heartbeats: 60s of silence used to exceed the 30s stale window and let a
    // competing graph declare this live holder dead.
    const lockDir = path.join(root, '.turbo', 'build-custody.lock')
    const backdated = new Date(Date.now() - 60_000)
    await utimes(lockDir, backdated, backdated)

    let stolen = false
    const competitor = acquireBuildCustody({ root, retryDelayMs: 5 })
      .then((second) => {
        stolen = true
        return second
      })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(stolen, false, 'a starved but live holder must keep custody')

    await custody.release()
    await (await competitor).release()
  })
})

test('reclaims custody abandoned by a dead owner instead of waiting out the stale window', async () => {
  await withRoot(async (root) => {
    const abandoned = await acquireBuildCustody({ root, retryDelayMs: 5 })
    const ownerFile = path.join(root, '.turbo', 'build-custody-owner.json')
    const owner = JSON.parse(await readFile(ownerFile, 'utf8'))
    // Rewrite the record to name a process that cannot be running: pid 2 is
    // kthreadd, which no build graph is ever a descendant of, and the start
    // time is deliberately wrong so the identity check fails.
    await writeFile(ownerFile, JSON.stringify({
      ...owner,
      pid: 2,
      pidStartTicks: -1,
    }))

    // Fresh, non-stale mtime: only the liveness check can release this.
    const lockDir = path.join(root, '.turbo', 'build-custody.lock')
    assert.ok((await stat(lockDir)).isDirectory())

    const reclaimed = await acquireBuildCustody({ root, retryDelayMs: 5 })
    assert.equal(reclaimed.inherited, false)
    assert.notEqual(reclaimed.token, owner.token)
    await reclaimed.release()
    await abandoned.release().catch(() => {})
  })
})

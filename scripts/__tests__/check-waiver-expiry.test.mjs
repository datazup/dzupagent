import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'

import {
  loadWaivers,
  checkWaivers,
  formatReport,
} from '../check-waiver-expiry.mjs'

function writeTempConfig(packages) {
  const dir = mkdtempSync(join(tmpdir(), 'waiver-test-'))
  const configPath = join(dir, 'coverage-thresholds.json')
  writeFileSync(
    configPath,
    JSON.stringify({ defaultThresholds: {}, trackedPackages: [], packages }, null, 2),
  )
  return { dir, configPath }
}

// --- loadWaivers ---

test('loadWaivers extracts waiver entries and ignores threshold entries', () => {
  const { dir, configPath } = writeTempConfig({
    alpha: { thresholds: { statements: 80 } },
    beta: { waiver: { reason: 'needs work', until: '2099-01-01' } },
    gamma: { waiver: { reason: 'legacy', until: '2020-01-01' } },
  })

  try {
    const waivers = loadWaivers(configPath)
    assert.equal(waivers.length, 2)
    assert.equal(waivers[0].pkg, 'beta')
    assert.equal(waivers[1].pkg, 'gamma')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadWaivers handles missing until field', () => {
  const { dir, configPath } = writeTempConfig({
    alpha: { waiver: { reason: 'perpetual' } },
  })

  try {
    const waivers = loadWaivers(configPath)
    assert.equal(waivers.length, 1)
    assert.equal(waivers[0].until, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadWaivers returns empty array when no packages have waivers', () => {
  const { dir, configPath } = writeTempConfig({
    alpha: { thresholds: { statements: 80 } },
  })

  try {
    const waivers = loadWaivers(configPath)
    assert.equal(waivers.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- checkWaivers ---

test('checkWaivers marks past dates as expired', () => {
  const today = new Date('2026-04-05')
  const waivers = [
    { pkg: 'alpha', reason: 'old', until: '2026-01-01' },
    { pkg: 'beta', reason: 'recent', until: '2026-04-04' },
  ]

  const result = checkWaivers(waivers, today)
  assert.equal(result.expired.length, 2)
  assert.equal(result.active.length, 0)
  assert.equal(result.noExpiry.length, 0)
})

test('checkWaivers marks future dates as active', () => {
  const today = new Date('2026-04-05')
  const waivers = [
    { pkg: 'alpha', reason: 'future', until: '2026-07-31' },
    { pkg: 'beta', reason: 'also future', until: '2099-12-31' },
  ]

  const result = checkWaivers(waivers, today)
  assert.equal(result.expired.length, 0)
  assert.equal(result.active.length, 2)
})

test('checkWaivers marks today as active (not expired)', () => {
  const today = new Date('2026-04-05')
  const waivers = [{ pkg: 'alpha', reason: 'edge', until: '2026-04-05' }]

  const result = checkWaivers(waivers, today)
  assert.equal(result.expired.length, 0)
  assert.equal(result.active.length, 1)
})

test('checkWaivers puts missing-until entries in noExpiry', () => {
  const today = new Date('2026-04-05')
  const waivers = [{ pkg: 'alpha', reason: 'perpetual', until: undefined }]

  const result = checkWaivers(waivers, today)
  assert.equal(result.noExpiry.length, 1)
  assert.equal(result.expired.length, 0)
  assert.equal(result.active.length, 0)
  assert.equal(result.noExpiry[0].status, 'NO EXPIRY')
})

test('checkWaivers handles mixed expired, active, and noExpiry', () => {
  const today = new Date('2026-04-05')
  const waivers = [
    { pkg: 'a', reason: 'old', until: '2025-01-01' },
    { pkg: 'b', reason: 'future', until: '2027-01-01' },
    { pkg: 'c', reason: 'forever', until: undefined },
  ]

  const result = checkWaivers(waivers, today)
  assert.equal(result.expired.length, 1)
  assert.equal(result.active.length, 1)
  assert.equal(result.noExpiry.length, 1)
})

// --- formatReport ---

test('formatReport returns "no waivers" message when empty', () => {
  const result = formatReport({ expired: [], active: [], noExpiry: [] })
  assert.match(result, /No waivers found/)
})

test('formatReport includes all entries in table format', () => {
  const results = {
    expired: [{ pkg: 'alpha', until: '2025-01-01', status: 'EXPIRED', reason: 'old' }],
    active: [{ pkg: 'beta', until: '2099-01-01', status: 'ACTIVE', reason: 'ok' }],
    noExpiry: [{ pkg: 'gamma', until: undefined, status: 'NO EXPIRY', reason: 'forever' }],
  }

  const report = formatReport(results)
  assert.match(report, /alpha/)
  assert.match(report, /beta/)
  assert.match(report, /gamma/)
  assert.match(report, /EXPIRED/)
  assert.match(report, /ACTIVE/)
  assert.match(report, /NO EXPIRY/)
  assert.match(report, /Package/)
  assert.match(report, /Until/)
  assert.match(report, /Status/)
  assert.match(report, /Reason/)
})

// --- Integration: real coverage-thresholds.json current waivers all active ---

test('current waivers are all active as of 2026-04-05', () => {
  const { dir, configPath } = writeTempConfig({
    codegen: { waiver: { reason: 'baseline', until: '2026-07-31' } },
    context: { waiver: { reason: 'baseline', until: '2026-07-31' } },
    'create-dzupagent': { waiver: { reason: 'baseline', until: '2026-06-30' } },
    playground: { waiver: { reason: 'baseline', until: '2026-06-30' } },
    'test-utils': { waiver: { reason: 'baseline', until: '2026-06-30' } },
    testing: { waiver: { reason: 'baseline', until: '2026-06-30' } },
  })

  try {
    const waivers = loadWaivers(configPath)
    const result = checkWaivers(waivers, new Date('2026-04-05'))
    assert.equal(result.expired.length, 0, 'Expected no expired waivers')
    assert.equal(result.active.length, 6)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

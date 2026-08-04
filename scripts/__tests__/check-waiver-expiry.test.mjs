import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  loadWaivers,
  checkWaivers,
  formatReport,
  resolveWarnDays,
} from '../check-waiver-expiry.mjs'

const SCRIPT_PATH = fileURLToPath(new URL('../check-waiver-expiry.mjs', import.meta.url))

function writeTempConfig(packages) {
  const dir = mkdtempSync(join(tmpdir(), 'waiver-test-'))
  const configPath = join(dir, 'coverage-thresholds.json')
  writeFileSync(
    configPath,
    JSON.stringify({ defaultThresholds: {}, trackedPackages: [], packages }, null, 2),
  )
  return { dir, configPath }
}

// --- loadWaivers: legacy `waiver.until` shape ---

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
    assert.equal(waivers[0].source, 'waiver')
    assert.equal(waivers[0].expiresOn, '2099-01-01')
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
    assert.equal(waivers[0].expiresOn, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadWaivers returns empty array when no packages have waivers or baselines', () => {
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

// --- loadWaivers: `baseline.reviewBy` shape (DZUPAGENT-TEST-C-15 ratchet baselines) ---

test('loadWaivers extracts baseline entries via reviewBy', () => {
  const { dir, configPath } = writeTempConfig({
    agent: {
      baseline: {
        reason: 'Ratchet renewal',
        since: '2026-08-04',
        reviewBy: '2026-12-01',
        thresholds: { statements: 91.42 },
      },
    },
  })

  try {
    const waivers = loadWaivers(configPath)
    assert.equal(waivers.length, 1)
    assert.equal(waivers[0].pkg, 'agent')
    assert.equal(waivers[0].source, 'baseline')
    assert.equal(waivers[0].expiresOn, '2026-12-01')
    assert.equal(waivers[0].reason, 'Ratchet renewal')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadWaivers extracts both waiver and baseline entries for the same package', () => {
  const { dir, configPath } = writeTempConfig({
    mixed: {
      waiver: { reason: 'legacy waiver', until: '2026-01-01' },
      baseline: { reason: 'ratchet floor', reviewBy: '2026-12-01' },
    },
  })

  try {
    const waivers = loadWaivers(configPath)
    assert.equal(waivers.length, 2)
    const sources = waivers.map((w) => w.source).sort()
    assert.deepEqual(sources, ['baseline', 'waiver'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- checkWaivers ---

test('checkWaivers marks past dates as expired', () => {
  const today = new Date('2026-04-05')
  const waivers = [
    { pkg: 'alpha', source: 'waiver', reason: 'old', expiresOn: '2026-01-01' },
    { pkg: 'beta', source: 'waiver', reason: 'recent', expiresOn: '2026-04-04' },
  ]

  const result = checkWaivers(waivers, today, 0)
  assert.equal(result.expired.length, 2)
  assert.equal(result.active.length, 0)
  assert.equal(result.warning.length, 0)
  assert.equal(result.noExpiry.length, 0)
})

test('checkWaivers marks far-future dates as active (outside warn window)', () => {
  const today = new Date('2026-04-05')
  const waivers = [
    { pkg: 'alpha', source: 'waiver', reason: 'future', expiresOn: '2026-07-31' },
    { pkg: 'beta', source: 'waiver', reason: 'also future', expiresOn: '2099-12-31' },
  ]

  const result = checkWaivers(waivers, today, 21)
  assert.equal(result.expired.length, 0)
  assert.equal(result.active.length, 2)
  assert.equal(result.warning.length, 0)
})

test('checkWaivers marks today as not-expired (warning, since it is within the 0-day boundary)', () => {
  const today = new Date('2026-04-05')
  const waivers = [{ pkg: 'alpha', source: 'waiver', reason: 'edge', expiresOn: '2026-04-05' }]

  const result = checkWaivers(waivers, today, 0)
  assert.equal(result.expired.length, 0)
  assert.equal(result.warning.length, 1)
})

test('checkWaivers puts missing-expiresOn entries in noExpiry', () => {
  const today = new Date('2026-04-05')
  const waivers = [{ pkg: 'alpha', source: 'waiver', reason: 'perpetual', expiresOn: undefined }]

  const result = checkWaivers(waivers, today, 21)
  assert.equal(result.noExpiry.length, 1)
  assert.equal(result.expired.length, 0)
  assert.equal(result.active.length, 0)
  assert.equal(result.noExpiry[0].status, 'NO EXPIRY')
})

test('checkWaivers handles mixed expired, active, and noExpiry', () => {
  const today = new Date('2026-04-05')
  const waivers = [
    { pkg: 'a', source: 'waiver', reason: 'old', expiresOn: '2025-01-01' },
    { pkg: 'b', source: 'waiver', reason: 'future', expiresOn: '2027-01-01' },
    { pkg: 'c', source: 'waiver', reason: 'forever', expiresOn: undefined },
  ]

  const result = checkWaivers(waivers, today, 21)
  assert.equal(result.expired.length, 1)
  assert.equal(result.active.length, 1)
  assert.equal(result.noExpiry.length, 1)
})

// --- checkWaivers: warn window (the core of this fix) ---

test('checkWaivers puts a reviewBy date inside the warn window into "warning", not "expired"', () => {
  // Mirrors the real scenario: today=2026-08-04, nearest reviewBy=2026-09-01 (28 days out),
  // warn window=21 days -> should NOT be flagged yet on this exact date...
  const today = new Date('2026-08-04')
  const waivers = [
    { pkg: 'agent', source: 'baseline', reason: 'ratchet', expiresOn: '2026-09-01' },
  ]
  const resultBefore = checkWaivers(waivers, today, 21)
  assert.equal(resultBefore.warning.length, 0)
  assert.equal(resultBefore.active.length, 1)

  // ...but once within 21 days of 2026-09-01 (e.g. 2026-08-12), it must warn, and
  // critically must NOT be expired (a warning must never redden CI).
  const laterToday = new Date('2026-08-12')
  const resultDuring = checkWaivers(waivers, laterToday, 21)
  assert.equal(resultDuring.warning.length, 1)
  assert.equal(resultDuring.expired.length, 0)
  assert.equal(resultDuring.warning[0].status, 'EXPIRING SOON')
})

test('checkWaivers: a baseline reviewBy date in the past is EXPIRED regardless of warn window', () => {
  const today = new Date('2026-08-04')
  const waivers = [
    { pkg: 'stale-pkg', source: 'baseline', reason: 'missed review', expiresOn: '2026-07-01' },
  ]
  const result = checkWaivers(waivers, today, 21)
  assert.equal(result.expired.length, 1)
  assert.equal(result.warning.length, 0)
  assert.equal(result.expired[0].status, 'EXPIRED')
})

// --- resolveWarnDays ---

test('resolveWarnDays reads --warn-days flag', () => {
  assert.equal(resolveWarnDays(['--warn-days=7']), 7)
})

test('resolveWarnDays falls back to default when nothing set', () => {
  const original = process.env.WAIVER_WARN_DAYS
  delete process.env.WAIVER_WARN_DAYS
  try {
    assert.equal(resolveWarnDays([]), 21)
  } finally {
    if (original !== undefined) process.env.WAIVER_WARN_DAYS = original
  }
})

test('resolveWarnDays reads WAIVER_WARN_DAYS env when no flag given', () => {
  const original = process.env.WAIVER_WARN_DAYS
  process.env.WAIVER_WARN_DAYS = '5'
  try {
    assert.equal(resolveWarnDays([]), 5)
  } finally {
    if (original === undefined) delete process.env.WAIVER_WARN_DAYS
    else process.env.WAIVER_WARN_DAYS = original
  }
})

// --- formatReport ---

test('formatReport returns "no waivers" message when empty', () => {
  const result = formatReport({ expired: [], warning: [], active: [], noExpiry: [] })
  assert.match(result, /No waivers found/)
})

test('formatReport includes all entries in table format', () => {
  const results = {
    expired: [
      { pkg: 'alpha', source: 'waiver', expiresOn: '2025-01-01', status: 'EXPIRED', reason: 'old' },
    ],
    warning: [
      {
        pkg: 'delta',
        source: 'baseline',
        expiresOn: '2026-08-20',
        status: 'EXPIRING SOON',
        reason: 'soon',
      },
    ],
    active: [
      { pkg: 'beta', source: 'waiver', expiresOn: '2099-01-01', status: 'ACTIVE', reason: 'ok' },
    ],
    noExpiry: [
      { pkg: 'gamma', source: 'waiver', expiresOn: undefined, status: 'NO EXPIRY', reason: 'forever' },
    ],
  }

  const report = formatReport(results)
  assert.match(report, /alpha/)
  assert.match(report, /beta/)
  assert.match(report, /gamma/)
  assert.match(report, /delta/)
  assert.match(report, /EXPIRED/)
  assert.match(report, /ACTIVE/)
  assert.match(report, /NO EXPIRY/)
  assert.match(report, /EXPIRING SOON/)
  assert.match(report, /Package/)
  assert.match(report, /Expires/)
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
    const result = checkWaivers(waivers, new Date('2026-04-05'), 0)
    assert.equal(result.expired.length, 0, 'Expected no expired waivers')
    assert.equal(result.active.length, 6)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- Acceptance criterion: a fixture with an expired baseline exits 1 ---

test('CLI exits 1 when a fixture coverage-thresholds.json has an expired baseline', () => {
  const { dir, configPath } = writeTempConfig({
    'expired-pkg': {
      baseline: {
        reason: 'DZUPAGENT-TEST-H-16 fixture: intentionally expired reviewBy',
        since: '2026-01-01',
        reviewBy: '2026-02-01',
        thresholds: { statements: 80 },
      },
    },
  })

  try {
    assert.throws(
      () => {
        execFileSync('node', [SCRIPT_PATH, configPath], { encoding: 'utf-8' })
      },
      (err) => {
        assert.equal(err.status, 1)
        assert.match(err.stdout, /FAIL:.*expired/i)
        assert.match(err.stdout, /expired-pkg/)
        return true
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI exits 0 (not 1) when a fixture has a baseline expiring soon but not yet expired', () => {
  const soon = new Date()
  soon.setUTCDate(soon.getUTCDate() + 5)
  const soonStr = soon.toISOString().slice(0, 10)

  const { dir, configPath } = writeTempConfig({
    'soon-pkg': {
      baseline: {
        reason: 'expiring soon fixture',
        since: '2026-01-01',
        reviewBy: soonStr,
        thresholds: { statements: 80 },
      },
    },
  })

  try {
    const stdout = execFileSync('node', [SCRIPT_PATH, configPath, '--warn-days=21'], {
      encoding: 'utf-8',
    })
    assert.match(stdout, /EXPIRING SOON/)
    assert.match(stdout, /OK:/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI exits 0 on the real repo coverage-thresholds.json (no expired entries today)', () => {
  const stdout = execFileSync('node', [SCRIPT_PATH], { encoding: 'utf-8' })
  assert.match(stdout, /OK:/)
})

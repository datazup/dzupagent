/**
 * Fast CI gate: fails if any coverage-thresholds.json waiver/baseline `reviewBy` (or
 * legacy `until`) date has passed, and warns when one is approaching.
 * Runs in < 100ms — no test execution needed.
 *
 * Understands two dated-entry shapes in coverage-thresholds.json:
 *   - `packages.<pkg>.waiver.{reason, until}`      (legacy waiver shape)
 *   - `packages.<pkg>.baseline.{reason, reviewBy}`  (ratchet baseline shape, DZUPAGENT-TEST-C-15)
 *
 * Usage:
 *   node scripts/check-waiver-expiry.mjs [configPath] [--warn-days=N]
 *
 * Env:
 *   WAIVER_WARN_DAYS — overrides the default warn window (in days). CLI flag wins.
 *
 * Exit codes:
 *   0 — all entries are active, or approaching expiry within the warn window (or no entries exist)
 *   1 — one or more entries have expired (reviewBy/until date has passed)
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_CONFIG_PATH = join(__dirname, '..', 'coverage-thresholds.json')

// Nearest real reviewBy in the repo as of 2026-08-04 is 2026-09-01 (28 days out).
// A 21-day warn window surfaces it now, with a week of margin before the window
// itself opens, and would have caught the original 2026-08-15 single-cliff waiver
// with several days of runway had this check existed at commit time. Configurable
// because different repos/waiver cadences may want a shorter or longer heads-up.
const DEFAULT_WARN_DAYS = 21

/**
 * Reads coverage-thresholds.json and returns an array of dated entries.
 * Each entry has: { pkg, source, reason, expiresOn } where `expiresOn` may be undefined.
 * `source` is 'waiver' or 'baseline', identifying which block the entry came from.
 * @param {string} configPath
 * @returns {{ pkg: string, source: string, reason: string, expiresOn: string | undefined }[]}
 */
export function loadWaivers(configPath) {
  const raw = readFileSync(configPath, 'utf-8')
  const config = JSON.parse(raw)
  const packages = config.packages ?? {}
  const waivers = []

  for (const [pkg, entry] of Object.entries(packages)) {
    if (entry.waiver) {
      waivers.push({
        pkg,
        source: 'waiver',
        reason: entry.waiver.reason ?? '(no reason given)',
        expiresOn: entry.waiver.until,
      })
    }
    if (entry.baseline) {
      waivers.push({
        pkg,
        source: 'baseline',
        reason: entry.baseline.reason ?? '(no reason given)',
        expiresOn: entry.baseline.reviewBy,
      })
    }
  }

  return waivers
}

/**
 * Checks each waiver/baseline entry against a reference date and warn window.
 * @param {{ pkg: string, source: string, reason: string, expiresOn: string | undefined }[]} waivers
 * @param {Date} today
 * @param {number} warnDays
 * @returns {{ expired: object[], warning: object[], active: object[], noExpiry: object[] }}
 */
export function checkWaivers(waivers, today, warnDays = DEFAULT_WARN_DAYS) {
  const todayStr = today.toISOString().slice(0, 10)
  const warnBoundary = new Date(today)
  warnBoundary.setUTCDate(warnBoundary.getUTCDate() + warnDays)
  const warnBoundaryStr = warnBoundary.toISOString().slice(0, 10)

  const expired = []
  const warning = []
  const active = []
  const noExpiry = []

  for (const w of waivers) {
    if (!w.expiresOn) {
      noExpiry.push({ ...w, status: 'NO EXPIRY' })
    } else if (w.expiresOn < todayStr) {
      expired.push({ ...w, status: 'EXPIRED' })
    } else if (w.expiresOn <= warnBoundaryStr) {
      warning.push({ ...w, status: 'EXPIRING SOON' })
    } else {
      active.push({ ...w, status: 'ACTIVE' })
    }
  }

  return { expired, warning, active, noExpiry }
}

/**
 * Formats results as a human-readable table string.
 * @param {{ expired: object[], warning: object[], active: object[], noExpiry: object[] }} results
 * @returns {string}
 */
export function formatReport(results) {
  const all = [
    ...results.expired,
    ...results.warning,
    ...results.noExpiry,
    ...results.active,
  ]
  if (all.length === 0) {
    return 'No waivers found in coverage-thresholds.json.'
  }

  const lines = []
  const header = ['Package', 'Source', 'Expires', 'Status', 'Reason']
  const rows = all.map((w) => [
    w.pkg,
    w.source ?? 'waiver',
    w.expiresOn ?? '(none)',
    w.status,
    w.reason,
  ])

  // Compute column widths
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  )

  const pad = (str, width) => str.padEnd(width)
  const sep = widths.map((w) => '-'.repeat(w)).join('  ')

  lines.push(header.map((h, i) => pad(h, widths[i])).join('  '))
  lines.push(sep)
  for (const row of rows) {
    lines.push(row.map((cell, i) => pad(cell, widths[i])).join('  '))
  }

  return lines.join('\n')
}

/**
 * Parses `--warn-days=N` from argv, falling back to WAIVER_WARN_DAYS env, then default.
 * @param {string[]} argv
 * @returns {number}
 */
export function resolveWarnDays(argv) {
  const flag = argv.find((a) => a.startsWith('--warn-days='))
  if (flag) {
    const n = Number(flag.split('=')[1])
    if (Number.isFinite(n) && n >= 0) return n
  }
  const envValue = Number(process.env.WAIVER_WARN_DAYS)
  if (Number.isFinite(envValue) && envValue >= 0) return envValue
  return DEFAULT_WARN_DAYS
}

// --- CLI entry point ---
const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/^.*[\\/]/, ''))

if (isMain) {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const configPath = positional[0] ?? DEFAULT_CONFIG_PATH
  const warnDays = resolveWarnDays(process.argv.slice(2))

  const waivers = loadWaivers(configPath)
  const results = checkWaivers(waivers, new Date(), warnDays)
  const report = formatReport(results)

  console.log('\n=== Coverage Waiver / Baseline Expiry Check ===\n')
  console.log(`Warn window: ${warnDays} day(s) before reviewBy/until.\n`)
  console.log(report)
  console.log()

  if (results.noExpiry.length > 0) {
    console.log(
      `WARNING: ${results.noExpiry.length} entr(y/ies) have no expiry date set.`,
    )
  }

  if (results.warning.length > 0) {
    console.log(
      `WARNING: ${results.warning.length} entr(y/ies) expiring within ${warnDays} day(s):`,
    )
    for (const w of results.warning) {
      console.log(`  - [${w.source}] ${w.pkg}: expires ${w.expiresOn} — ${w.reason}`)
    }
  }

  if (results.expired.length > 0) {
    console.log(
      `FAIL: ${results.expired.length} entr(y/ies) have expired. Add coverage thresholds or extend the review date.`,
    )
    for (const w of results.expired) {
      console.log(`  - [${w.source}] ${w.pkg}: expired ${w.expiresOn} — ${w.reason}`)
    }
    process.exit(1)
  }

  console.log(
    `OK: ${results.active.length} active, ${results.warning.length} expiring soon, ${results.expired.length} expired.`,
  )
  process.exit(0)
}

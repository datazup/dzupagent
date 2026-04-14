/**
 * Fast CI gate: fails if any coverage-thresholds.json waiver's `until` date has passed.
 * Runs in < 100ms — no test execution needed.
 *
 * Usage:
 *   node scripts/check-waiver-expiry.mjs
 *
 * Exit codes:
 *   0 — all waivers are still active (or no waivers exist)
 *   1 — one or more waivers have expired
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_CONFIG_PATH = join(__dirname, '..', 'coverage-thresholds.json')

/**
 * Reads coverage-thresholds.json and returns an array of waiver entries.
 * Each entry has: { pkg, reason, until } where `until` may be undefined.
 * @param {string} configPath
 * @returns {{ pkg: string, reason: string, until: string | undefined }[]}
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
        reason: entry.waiver.reason ?? '(no reason given)',
        until: entry.waiver.until,
      })
    }
  }

  return waivers
}

/**
 * Checks each waiver against a reference date.
 * @param {{ pkg: string, reason: string, until: string | undefined }[]} waivers
 * @param {Date} today
 * @returns {{ expired: object[], active: object[], noExpiry: object[] }}
 */
export function checkWaivers(waivers, today) {
  const todayStr = today.toISOString().slice(0, 10)
  const expired = []
  const active = []
  const noExpiry = []

  for (const w of waivers) {
    if (!w.until) {
      noExpiry.push({ ...w, status: 'NO EXPIRY' })
    } else if (w.until < todayStr) {
      expired.push({ ...w, status: 'EXPIRED' })
    } else {
      active.push({ ...w, status: 'ACTIVE' })
    }
  }

  return { expired, active, noExpiry }
}

/**
 * Formats results as a human-readable table string.
 * @param {{ expired: object[], active: object[], noExpiry: object[] }} results
 * @returns {string}
 */
export function formatReport(results) {
  const all = [...results.expired, ...results.noExpiry, ...results.active]
  if (all.length === 0) {
    return 'No waivers found in coverage-thresholds.json.'
  }

  const lines = []
  const header = ['Package', 'Until', 'Status', 'Reason']
  const rows = all.map((w) => [
    w.pkg,
    w.until ?? '(none)',
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

// --- CLI entry point ---
const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/^.*[\\/]/, ''))

if (isMain) {
  const configPath = process.argv[2] ?? DEFAULT_CONFIG_PATH
  const waivers = loadWaivers(configPath)
  const results = checkWaivers(waivers, new Date())
  const report = formatReport(results)

  console.log('\n=== Coverage Waiver Expiry Check ===\n')
  console.log(report)
  console.log()

  if (results.noExpiry.length > 0) {
    console.log(
      `WARNING: ${results.noExpiry.length} waiver(s) have no expiry date set.`,
    )
  }

  if (results.expired.length > 0) {
    console.log(
      `FAIL: ${results.expired.length} waiver(s) have expired. Add coverage thresholds or extend the waiver date.`,
    )
    process.exit(1)
  }

  console.log(
    `OK: ${results.active.length} active waiver(s), ${results.expired.length} expired.`,
  )
  process.exit(0)
}

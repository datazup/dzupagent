/**
 * check-circular-deps.mjs
 *
 * Detects circular imports within each @dzupagent/* package src/ directory
 * using madge. Fails when cycles exceed the checked-in baseline.
 *
 * Usage:
 *   node scripts/check-circular-deps.mjs
 *   node scripts/check-circular-deps.mjs --pkg core
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(__dirname, '..')
const PACKAGES_DIR = join(ROOT, 'packages')
const BASELINE_PATH = join(ROOT, 'config', 'circular-deps-baseline.json')
const MADGE_CLI = join(ROOT, 'node_modules', 'madge', 'bin', 'cli.js')

const args = process.argv.slice(2)
const pkgFilter = args.includes('--pkg') ? args[args.indexOf('--pkg') + 1] : null

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return {}
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Baseline must be an object at ${relative(ROOT, BASELINE_PATH)}`)
  }
  const packages = parsed.packages
  if (packages === null || typeof packages !== 'object' || Array.isArray(packages)) {
    throw new Error(`Baseline must contain a packages object at ${relative(ROOT, BASELINE_PATH)}`)
  }
  return packages
}

function normalizeCycle(cycle) {
  if (!Array.isArray(cycle) || cycle.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Invalid cycle entry: ${JSON.stringify(cycle)}`)
  }
  return cycle.join(' > ')
}

function getBaselineForPackage(baseline, pkg) {
  const entry = baseline[pkg]
  if (entry === undefined) return new Set()
  if (!Array.isArray(entry)) {
    throw new Error(`Baseline entry for ${pkg} must be an array`)
  }
  return new Set(entry.map(normalizeCycle))
}

async function getPackageSrcDirs() {
  const entries = await readdir(PACKAGES_DIR)
  const results = []
  for (const entry of entries.sort()) {
    if (pkgFilter && entry !== pkgFilter) continue
    const srcDir = join(PACKAGES_DIR, entry, 'src')
    try {
      const s = await stat(srcDir)
      if (s.isDirectory()) results.push({ pkg: entry, srcDir })
    } catch {
      // no src/ directory
    }
  }
  return results
}

function runMadge(srcDir) {
  if (!existsSync(MADGE_CLI)) {
    throw new Error(`madge is not installed at ${relative(ROOT, MADGE_CLI)}; run yarn install`)
  }

  try {
    const stdout = execFileSync(
      process.execPath,
      [MADGE_CLI, '--circular', '--json', '--no-spinner', '--no-color', '--extensions', 'ts', srcDir],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return parseMadgeJson(stdout)
  } catch (err) {
    const stdout = toText(err.stdout)
    if (stdout.trim().length > 0) return parseMadgeJson(stdout)
    const stderr = toText(err.stderr).trim()
    throw new Error(stderr || err.message)
  }
}

function toText(value) {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return ''
}

function parseMadgeJson(raw) {
  const trimmed = raw.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed)
  if (!Array.isArray(parsed)) {
    throw new Error(`Unexpected madge JSON output: ${trimmed}`)
  }
  return parsed
}

async function checkPackage(pkg, srcDir, baseline) {
  const cycles = runMadge(srcDir)
  const normalizedCycles = new Set(cycles.map(normalizeCycle))
  const allowedCycles = getBaselineForPackage(baseline, pkg)
  const unexpected = [...normalizedCycles].filter((cycle) => !allowedCycles.has(cycle)).sort()
  const resolved = [...allowedCycles].filter((cycle) => !normalizedCycles.has(cycle)).sort()

  return {
    pkg,
    cycleCount: normalizedCycles.size,
    baselineCount: allowedCycles.size,
    unexpected,
    resolved,
  }
}

async function main() {
  const baseline = readBaseline()
  const pkgDirs = await getPackageSrcDirs()

  if (pkgDirs.length === 0) {
    console.error(`[check-circular-deps] No packages found${pkgFilter ? ` matching --pkg ${pkgFilter}` : ''}`)
    process.exit(1)
  }

  const results = []
  for (const { pkg, srcDir } of pkgDirs) {
    try {
      results.push(await checkPackage(pkg, srcDir, baseline))
    } catch (err) {
      console.error(`[check-circular-deps] Error scanning ${pkg}: ${err.message}`)
      process.exit(2)
    }
  }

  const unexpected = results.filter((result) => result.unexpected.length > 0)
  const resolved = results.filter((result) => result.resolved.length > 0)
  const packagesWithCycles = results.filter((result) => result.cycleCount > 0)

  console.log(`\n[check-circular-deps] Scanned ${results.length} package(s)`)
  console.log(`  Packages with cycles: ${packagesWithCycles.length}`)
  console.log(`  Unexpected cycles: ${unexpected.reduce((sum, result) => sum + result.unexpected.length, 0)}`)
  console.log(`  Resolved baseline cycles: ${resolved.reduce((sum, result) => sum + result.resolved.length, 0)}`)

  if (resolved.length > 0) {
    console.log('\nResolved baseline cycles. Remove these from config/circular-deps-baseline.json:')
    for (const result of resolved) {
      console.log(`\n  @dzupagent/${result.pkg}:`)
      for (const cycle of result.resolved) console.log(`    ${cycle}`)
    }
  }

  if (unexpected.length > 0) {
    console.error('\nUnexpected circular imports detected:\n')
    for (const result of unexpected) {
      console.error(`  @dzupagent/${result.pkg}:`)
      for (const cycle of result.unexpected) console.error(`    ${cycle}`)
    }
    console.error('\nBreak the new cycles or add an intentional baseline entry with review context.\n')
    process.exit(1)
  }

  console.log('\nNo unexpected circular imports found.\n')
}

main().catch((err) => {
  console.error('[check-circular-deps] Unexpected error:', err)
  process.exit(2)
})

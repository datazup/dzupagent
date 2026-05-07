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

import { existsSync, readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import madge from 'madge'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(__dirname, '..')
const PACKAGES_DIR = join(ROOT, 'packages')
const BASELINE_PATH = join(ROOT, 'config', 'circular-deps-baseline.json')
const MADGE_PACKAGE = join(ROOT, 'node_modules', 'madge', 'package.json')

const args = process.argv.slice(2)
const pkgArgIndex = args.findIndex((arg) => arg === '--pkg' || arg.startsWith('--pkg='))
const pkgFilter =
  pkgArgIndex === -1
    ? null
    : args[pkgArgIndex].startsWith('--pkg=')
      ? args[pkgArgIndex].slice('--pkg='.length)
      : args[pkgArgIndex + 1] ?? null

if (pkgArgIndex !== -1 && (!pkgFilter || pkgFilter.startsWith('--'))) {
  console.error('[check-circular-deps] --pkg requires a package directory name, for example --pkg agent-adapters')
  process.exit(2)
}

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

function rotations(cycle) {
  return cycle.map((_, index) => [...cycle.slice(index), ...cycle.slice(0, index)])
}

function canonicalCycle(cycle) {
  const candidates = [...rotations(cycle), ...rotations([...cycle].reverse())]
  return candidates.map((candidate) => candidate.join(' > ')).sort()[0]
}

function normalizeCycle(cycle) {
  if (!Array.isArray(cycle) || cycle.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Invalid cycle entry: ${JSON.stringify(cycle)}`)
  }
  return canonicalCycle(cycle)
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

async function runMadge(srcDir) {
  if (!existsSync(MADGE_PACKAGE)) {
    throw new Error(`madge is not installed at ${relative(ROOT, MADGE_PACKAGE)}; run yarn install`)
  }

  const srcPrefix = `${relative(ROOT, srcDir).replaceAll('\\', '/')}/`
  const result = await madge(relative(ROOT, srcDir), {
    fileExtensions: ['ts'],
  })
  return result.circular().map((cycle) =>
    cycle.map((entry) => {
      const normalized = entry.replaceAll('\\', '/')
      return normalized.startsWith(srcPrefix) ? normalized.slice(srcPrefix.length) : normalized
    }),
  )
}

async function checkPackage(pkg, srcDir, baseline) {
  const cycles = await runMadge(srcDir)
  const normalizedCycles = new Set(cycles.map(normalizeCycle))
  const allowedCycles = getBaselineForPackage(baseline, pkg)
  const unexpected = [...normalizedCycles].filter((cycle) => !allowedCycles.has(cycle)).sort()
  const resolved = [...allowedCycles].filter((cycle) => !normalizedCycles.has(cycle)).sort()

  return {
    pkg,
    cycleCount: normalizedCycles.size,
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

  if (resolved.length > 0) {
    console.error('\nRefresh config/circular-deps-baseline.json before merging.\n')
    process.exit(1)
  }

  console.log('\nNo unexpected circular imports found.\n')
}

main().catch((err) => {
  console.error('[check-circular-deps] Unexpected error:', err)
  process.exit(2)
})

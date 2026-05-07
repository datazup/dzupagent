/**
 * check-circular-deps.mjs
 *
 * Detects circular imports within each @dzupagent/* package src/ directory
 * using madge. Fails when cycles exceed the checked-in baseline.
 *
 * Usage:
 *   node scripts/check-circular-deps.mjs
 *   node scripts/check-circular-deps.mjs --pkg core
 *   node scripts/check-circular-deps.mjs --concurrency 4
 *   node scripts/check-circular-deps.mjs --shard-index 0 --shard-count 4
 *   node scripts/check-circular-deps.mjs --include-tests
 */

import { existsSync, readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import madge from 'madge'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(__dirname, '..')
const PACKAGES_DIR = join(ROOT, 'packages')
const BASELINE_PATH = join(ROOT, 'config', 'circular-deps-baseline.json')
const MADGE_PACKAGE = join(ROOT, 'node_modules', 'madge', 'package.json')

const args = process.argv.slice(2)
const pkgFilter = readStringOption('--pkg')
const shardIndex = readIntegerOption('--shard-index')
const shardCount = readIntegerOption('--shard-count')
const includeTests = args.includes('--include-tests')
const concurrency = readPositiveIntegerOption(
  '--concurrency',
  process.env['CIRCULAR_DEPS_CONCURRENCY'],
) ?? Math.min(4, Math.max(1, availableParallelism()))

validateOptions()

function readStringOption(name) {
  const index = args.findIndex((arg) => arg === name || arg.startsWith(`${name}=`))
  if (index === -1) return null

  const value = args[index].startsWith(`${name}=`)
    ? args[index].slice(name.length + 1)
    : args[index + 1] ?? null

  if (!value || value.startsWith('--')) {
    console.error(`[check-circular-deps] ${name} requires a value`)
    process.exit(2)
  }
  return value
}

function readIntegerOption(name) {
  const value = readStringOption(name)
  if (value === null) return null

  const parsed = Number(value)
  if (!Number.isInteger(parsed)) {
    console.error(`[check-circular-deps] ${name} must be an integer`)
    process.exit(2)
  }
  return parsed
}

function readPositiveIntegerOption(name, envValue) {
  const value = readStringOption(name) ?? envValue ?? null
  if (value === null || value === '') return null

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error(`[check-circular-deps] ${name} must be a positive integer`)
    process.exit(2)
  }
  return parsed
}

function validateOptions() {
  if ((shardIndex === null) !== (shardCount === null)) {
    console.error('[check-circular-deps] --shard-index and --shard-count must be provided together')
    process.exit(2)
  }
  if (shardCount !== null && shardCount < 1) {
    console.error('[check-circular-deps] --shard-count must be at least 1')
    process.exit(2)
  }
  if (shardIndex !== null && (shardIndex < 0 || shardIndex >= shardCount)) {
    console.error('[check-circular-deps] --shard-index must be between 0 and --shard-count - 1')
    process.exit(2)
  }
  if (pkgFilter && shardCount !== null) {
    console.error('[check-circular-deps] --pkg cannot be combined with --shard-index/--shard-count')
    process.exit(2)
  }
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
  return shardCount === null
    ? results
    : results.filter((_, index) => index % shardCount === shardIndex)
}

async function runMadge(srcDir) {
  if (!existsSync(MADGE_PACKAGE)) {
    throw new Error(`madge is not installed at ${relative(ROOT, MADGE_PACKAGE)}; run yarn install`)
  }

  const srcPrefix = `${relative(ROOT, srcDir).replaceAll('\\', '/')}/`
  const result = await madge(relative(ROOT, srcDir), {
    fileExtensions: ['ts'],
    ...(includeTests
      ? {}
      : {
          excludeRegExp: [
            '(^|/)__tests__/',
            '\\.test\\.ts$',
            '\\.spec\\.ts$',
          ],
        }),
  })
  return result.circular().map((cycle) =>
    cycle.map((entry) => {
      const normalized = entry.replaceAll('\\', '/')
      return normalized.startsWith(srcPrefix) ? normalized.slice(srcPrefix.length) : normalized
    }),
  )
}

async function checkPackage(pkg, srcDir, baseline) {
  const start = Date.now()
  const cycles = await runMadge(srcDir)
  const normalizedCycles = new Set(cycles.map(normalizeCycle))
  const allowedCycles = getBaselineForPackage(baseline, pkg)
  const unexpected = [...normalizedCycles].filter((cycle) => !allowedCycles.has(cycle)).sort()
  const resolved = [...allowedCycles].filter((cycle) => !normalizedCycles.has(cycle)).sort()

  return {
    pkg,
    cycleCount: normalizedCycles.size,
    durationMs: Date.now() - start,
    unexpected,
    resolved,
  }
}

async function checkPackages(pkgDirs, baseline) {
  const results = new Array(pkgDirs.length)
  let nextIndex = 0
  const workerCount = Math.min(concurrency, pkgDirs.length)

  async function worker() {
    while (nextIndex < pkgDirs.length) {
      const index = nextIndex
      nextIndex += 1
      const { pkg, srcDir } = pkgDirs[index]
      console.error(`[check-circular-deps] Scanning @dzupagent/${pkg} (${index + 1}/${pkgDirs.length})`)
      try {
        const result = await checkPackage(pkg, srcDir, baseline)
        results[index] = result
        console.error(
          `[check-circular-deps] Done @dzupagent/${pkg}: ${result.cycleCount} cycle(s), ${result.durationMs}ms`,
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`Error scanning ${pkg}: ${message}`)
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

async function main() {
  const baseline = readBaseline()
  const pkgDirs = await getPackageSrcDirs()

  if (pkgDirs.length === 0) {
    console.error(`[check-circular-deps] No packages found${pkgFilter ? ` matching --pkg ${pkgFilter}` : ''}`)
    process.exit(1)
  }

  console.error(
    `[check-circular-deps] Checking ${pkgDirs.length} package(s) with concurrency ${Math.min(concurrency, pkgDirs.length)}`,
  )
  if (!includeTests) {
    console.error('[check-circular-deps] Excluding test files; pass --include-tests to scan tests too')
  }
  if (shardCount !== null) {
    console.error(`[check-circular-deps] Shard ${shardIndex + 1}/${shardCount}`)
  }

  let results
  try {
    results = await checkPackages(pkgDirs, baseline)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[check-circular-deps] ${message}`)
    process.exit(2)
  }

  const unexpected = results.filter((result) => result.unexpected.length > 0)
  const resolved = results.filter((result) => result.resolved.length > 0)
  const packagesWithCycles = results.filter((result) => result.cycleCount > 0)
  const slowest = [...results].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5)

  console.log(`\n[check-circular-deps] Scanned ${results.length} package(s)`)
  console.log(`  Packages with cycles: ${packagesWithCycles.length}`)
  console.log(`  Unexpected cycles: ${unexpected.reduce((sum, result) => sum + result.unexpected.length, 0)}`)
  console.log(`  Resolved baseline cycles: ${resolved.reduce((sum, result) => sum + result.resolved.length, 0)}`)
  console.log('  Slowest packages:')
  for (const result of slowest) {
    console.log(`    @dzupagent/${result.pkg}: ${result.durationMs}ms`)
  }

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

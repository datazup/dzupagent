#!/usr/bin/env node
/**
 * check-test-typecheck.mjs
 *
 * Ratchet guard for test-file type errors. `yarn build` typechecks src but
 * NOT the `__tests__` trees (tsconfig.json excludes them), so a test file can
 * accumulate type errors while every gate stays green — the exact blind spot
 * that let this count reach 903. `tsconfig.flipcheck.json` includes the tests;
 * this script runs it and fails when the count exceeds the checked-in baseline.
 *
 * The baseline records a total AND a per-file map. Per-file matters because a
 * bare total lets a regression hide behind an unrelated fix: fix one error in
 * a.ts, introduce one in b.ts, and the total is unchanged. Any file exceeding
 * its own recorded count fails even when the total holds steady.
 *
 * Scope: EVERY package carrying a tsconfig.flipcheck.json, not just
 * @dzupagent/agent. Measured 2026-07-31, the blind spot was workspace-wide —
 * 2,453 errors across 17 packages, of which this guard covered only 205 (8%).
 * server (661), agent-adapters (428) and core (387) each individually exceeded
 * the one package being watched. Packages ratchet independently so a cleanup in
 * one cannot mask a regression in another — the same reason per-file budgets
 * exist within a package.
 *
 * Usage:
 *   node scripts/check-test-typecheck.mjs                  # fail if over baseline
 *   node scripts/check-test-typecheck.mjs --report-only    # print counts, exit 0
 *   node scripts/check-test-typecheck.mjs --update-baseline # rewrite baseline to current
 *   node scripts/check-test-typecheck.mjs --package core   # restrict to one package
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const PACKAGES_DIR = join(ROOT, 'packages')
const BASELINE_FILE = join(__dirname, 'check-test-typecheck.baseline.json')

/**
 * A package opts into this guard by carrying a tsconfig.flipcheck.json. That
 * makes enrolment explicit and reviewable: adding the file is the act of
 * enrolling, so no package is silently dropped by a glob that stops matching.
 */
export function discoverPackages() {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(PACKAGES_DIR, name, 'tsconfig.flipcheck.json')))
    .sort()
}

// tsc error lines look like:
//   src/__tests__/foo.test.ts(27,16): error TS2339: Property 'x' does not exist...
const ERROR_LINE_RE = /^(.+?)\((\d+),(\d+)\): error (TS\d+):/

const args = process.argv.slice(2)
const reportOnly = args.includes('--report-only')
const updateBaseline = args.includes('--update-baseline')
const pkgFlagIndex = args.indexOf('--package')
const onlyPackage = pkgFlagIndex === -1 ? null : args[pkgFlagIndex + 1]

function runTypecheck(pkg) {
  const result = spawnSync(
    'yarn',
    ['tsc', '-p', 'tsconfig.flipcheck.json', '--noEmit', '--pretty', 'false'],
    { cwd: join(PACKAGES_DIR, pkg), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )

  if (result.error) {
    throw new Error(`failed to spawn tsc: ${result.error.message}`)
  }

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`

  // tsc exits 0 only when there are zero errors; a non-zero exit with no
  // parseable error lines means the compiler itself failed (bad config,
  // missing dep) and must not be reported as "0 errors, all clear".
  const lines = output.split('\n')
  const errors = []
  for (const line of lines) {
    const match = ERROR_LINE_RE.exec(line)
    if (match) errors.push({ file: match[1], code: match[4] })
  }

  if (result.status !== 0 && errors.length === 0) {
    throw new Error(
      `[${pkg}] tsc exited ${result.status} without emitting parseable errors — ` +
        `the typecheck itself is broken, not merely failing:\n${output.slice(0, 2000)}`
    )
  }

  const perFile = {}
  const perCode = {}
  for (const { file, code } of errors) {
    perFile[file] = (perFile[file] ?? 0) + 1
    perCode[code] = (perCode[code] ?? 0) + 1
  }

  return { total: errors.length, perFile, perCode }
}

function loadBaseline() {
  if (!existsSync(BASELINE_FILE)) return null
  return JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))
}

/**
 * Baseline shape is a per-package map:
 *   { packages: { core: { maxErrors, perCode, perFile }, ... } }
 *
 * The older flat shape ({ maxErrors, perFile }) described @dzupagent/agent
 * alone. It is read as { packages: { agent: <flat> } } so an existing checkout
 * keeps its agent budget instead of silently resetting it to zero — which would
 * either fail every build or, worse, re-baseline 205 real errors as acceptable.
 */
function normalizeBaseline(raw) {
  if (!raw) return null
  if (raw.packages) return raw
  return { packages: { agent: raw } }
}

function writeBaseline(perPackage) {
  const packages = {}
  for (const pkg of Object.keys(perPackage).sort()) {
    const { total, perFile, perCode } = perPackage[pkg]
    packages[pkg] = {
      maxErrors: total,
      perCode: Object.fromEntries(Object.entries(perCode).sort(([, a], [, b]) => b - a)),
      perFile: Object.fromEntries(Object.entries(perFile).sort(([a], [b]) => a.localeCompare(b))),
    }
  }
  const total = Object.values(packages).reduce((n, p) => n + p.maxErrors, 0)
  writeFileSync(
    BASELINE_FILE,
    JSON.stringify(
      {
        totalErrors: total,
        note:
          'Test-file typecheck baseline (tsconfig.flipcheck.json per package). Ratchets ' +
          'down only. Bump only via --update-baseline after FIXING errors, never to ' +
          'accommodate new ones. Enforced per package AND per file, so a fix in one ' +
          'place cannot mask a regression in another. totalErrors and perCode are ' +
          'informational; the per-file budgets are what fail the build.',
        packages,
      },
      null,
      2
    ) + '\n'
  )
}

function main() {
  const targets = onlyPackage ? [onlyPackage] : discoverPackages()

  if (targets.length === 0) {
    console.error('[check-test-typecheck] no packages with tsconfig.flipcheck.json found.')
    process.exitCode = 1
    return
  }
  if (onlyPackage && !discoverPackages().includes(onlyPackage)) {
    console.error(
      `[check-test-typecheck] package '${onlyPackage}' has no tsconfig.flipcheck.json.`
    )
    process.exitCode = 1
    return
  }

  const current = {}
  for (const pkg of targets) {
    current[pkg] = runTypecheck(pkg)
  }

  const baseline = normalizeBaseline(loadBaseline())

  if (updateBaseline) {
    // A single-package run must not erase the other packages' budgets, so the
    // existing baseline is carried forward and only the measured keys replaced.
    const merged = {}
    for (const [pkg, entry] of Object.entries(baseline?.packages ?? {})) {
      merged[pkg] = { total: entry.maxErrors, perFile: entry.perFile ?? {}, perCode: entry.perCode ?? {} }
    }
    Object.assign(merged, current)
    writeBaseline(merged)
    const now = Object.values(merged).reduce((n, p) => n + p.total, 0)
    console.log(`[check-test-typecheck] baseline updated (${now} errors across ${Object.keys(merged).length} packages)`)
    return
  }

  const currentTotal = Object.values(current).reduce((n, p) => n + p.total, 0)
  console.log(
    `[check-test-typecheck] test-file type errors: ${currentTotal} across ${targets.length} package(s)`
  )

  if (!baseline) {
    console.error(
      '[check-test-typecheck] no baseline file — run with --update-baseline to create one.'
    )
    if (!reportOnly) process.exitCode = 1
    return
  }

  const regressions = []
  const overBudget = []
  let unenrolled = false
  for (const pkg of targets) {
    const allowedPkg = baseline.packages?.[pkg]
    // An unenrolled package has no budget. Defaulting it to 0 would fail the
    // build on first enrolment; it is reported instead so the operator adds a
    // baseline deliberately.
    if (!allowedPkg) {
      console.error(
        `[check-test-typecheck] '${pkg}' has no baseline entry — run --update-baseline to enrol it.`
      )
      if (!reportOnly) process.exitCode = 1
      unenrolled = true
      continue
    }
    for (const [file, count] of Object.entries(current[pkg].perFile)) {
      const allowed = allowedPkg.perFile?.[file] ?? 0
      if (count > allowed) regressions.push({ pkg, file, count, allowed })
    }
    if (current[pkg].total > allowedPkg.maxErrors) {
      overBudget.push({ pkg, count: current[pkg].total, allowed: allowedPkg.maxErrors })
    }
  }

  if (reportOnly) {
    for (const pkg of targets) {
      const allowed = baseline.packages?.[pkg]?.maxErrors
      const delta = allowed === undefined ? 'unenrolled' : `baseline ${allowed}`
      console.log(`  ${pkg}: ${current[pkg].total} (${delta})`)
    }
    console.log(
      `[check-test-typecheck] ${regressions.length} file(s) over budget, ` +
        `${overBudget.length} package(s) over budget`
    )
    return
  }

  let failed = unenrolled

  if (regressions.length > 0) {
    failed = true
    console.error('\n[check-test-typecheck] FAIL: files exceed their baseline error budget:')
    for (const { pkg, file, count, allowed } of regressions.slice(0, 20)) {
      console.error(`  [${pkg}] ${file}: ${count} (allowed ${allowed})`)
    }
    if (regressions.length > 20) {
      console.error(`  ... and ${regressions.length - 20} more`)
    }
  }

  for (const { pkg, count, allowed } of overBudget) {
    failed = true
    console.error(
      `\n[check-test-typecheck] FAIL: [${pkg}] ${count} test-file type errors exceeds ` +
        `baseline of ${allowed}.`
    )
  }

  if (failed) {
    console.error(
      '\nFix the type errors rather than raising the baseline. Test files are excluded ' +
        'from `yarn build`, so these errors are invisible to every other gate — that is ' +
        'why they are ratcheted here. Lower the baseline after fixing ' +
        '(node scripts/check-test-typecheck.mjs --update-baseline).'
    )
    process.exitCode = 1
    return
  }

  const baselineTotal = targets.reduce((n, pkg) => n + (baseline.packages?.[pkg]?.maxErrors ?? 0), 0)
  if (currentTotal < baselineTotal) {
    console.log(
      `[check-test-typecheck] OK — ${baselineTotal - currentTotal} below baseline ` +
        `(${baselineTotal}). Run --update-baseline to lock in the improvement.`
    )
    return
  }

  console.log(`[check-test-typecheck] OK (baseline: ${baselineTotal})`)
}

main()

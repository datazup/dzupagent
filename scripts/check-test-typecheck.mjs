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
 * Usage:
 *   node scripts/check-test-typecheck.mjs                  # fail if over baseline
 *   node scripts/check-test-typecheck.mjs --report-only    # print counts, exit 0
 *   node scripts/check-test-typecheck.mjs --update-baseline # rewrite baseline to current
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const AGENT_DIR = join(ROOT, 'packages', 'agent')
const BASELINE_FILE = join(__dirname, 'check-test-typecheck.baseline.json')

// tsc error lines look like:
//   src/__tests__/foo.test.ts(27,16): error TS2339: Property 'x' does not exist...
const ERROR_LINE_RE = /^(.+?)\((\d+),(\d+)\): error (TS\d+):/

const args = process.argv.slice(2)
const reportOnly = args.includes('--report-only')
const updateBaseline = args.includes('--update-baseline')

function runTypecheck() {
  const result = spawnSync(
    'yarn',
    ['tsc', '-p', 'tsconfig.flipcheck.json', '--noEmit', '--pretty', 'false'],
    { cwd: AGENT_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
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
      `tsc exited ${result.status} without emitting parseable errors — ` +
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

function writeBaseline({ total, perFile, perCode }) {
  const sortedFiles = Object.fromEntries(
    Object.entries(perFile).sort(([a], [b]) => a.localeCompare(b))
  )
  const sortedCodes = Object.fromEntries(
    Object.entries(perCode).sort(([, a], [, b]) => b - a)
  )
  writeFileSync(
    BASELINE_FILE,
    JSON.stringify(
      {
        maxErrors: total,
        note:
          'Test-file typecheck baseline (tsconfig.flipcheck.json). Ratchets down only. ' +
          'Bump only via --update-baseline after FIXING errors, never to accommodate new ' +
          'ones. perFile is enforced too, so a fix in one file cannot mask a regression ' +
          'in another. perCode is informational.',
        perCode: sortedCodes,
        perFile: sortedFiles,
      },
      null,
      2
    ) + '\n'
  )
}

function main() {
  const current = runTypecheck()

  if (updateBaseline) {
    const previous = loadBaseline()
    writeBaseline(current)
    const was = previous ? `${previous.maxErrors} -> ` : ''
    console.log(`[check-test-typecheck] baseline updated to ${was}${current.total}`)
    return
  }

  console.log(`[check-test-typecheck] test-file type errors: ${current.total}`)

  const baseline = loadBaseline()
  if (!baseline) {
    console.error(
      '[check-test-typecheck] no baseline file — run with --update-baseline to create one.'
    )
    if (!reportOnly) process.exitCode = 1
    return
  }

  // Files over their recorded budget. An unlisted file has a budget of 0, so a
  // brand-new file carrying errors is caught as a regression.
  const regressions = Object.entries(current.perFile)
    .map(([file, count]) => ({ file, count, allowed: baseline.perFile?.[file] ?? 0 }))
    .filter(({ count, allowed }) => count > allowed)
    .sort((a, b) => b.count - a.count - (b.allowed - a.allowed))

  if (reportOnly) {
    const improvements = Object.entries(baseline.perFile ?? {})
      .map(([file, allowed]) => ({ file, allowed, count: current.perFile[file] ?? 0 }))
      .filter(({ count, allowed }) => count < allowed)
    console.log(
      `[check-test-typecheck] baseline ${baseline.maxErrors}; ` +
        `${regressions.length} file(s) over budget, ${improvements.length} improved`
    )
    return
  }

  let failed = false

  if (regressions.length > 0) {
    failed = true
    console.error('\n[check-test-typecheck] FAIL: files exceed their baseline error budget:')
    for (const { file, count, allowed } of regressions.slice(0, 20)) {
      console.error(`  ${file}: ${count} (allowed ${allowed})`)
    }
    if (regressions.length > 20) {
      console.error(`  ... and ${regressions.length - 20} more`)
    }
  }

  if (current.total > baseline.maxErrors) {
    failed = true
    console.error(
      `\n[check-test-typecheck] FAIL: ${current.total} test-file type errors exceeds ` +
        `baseline of ${baseline.maxErrors}.`
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

  if (current.total < baseline.maxErrors) {
    console.log(
      `[check-test-typecheck] OK — ${baseline.maxErrors - current.total} below baseline ` +
        `(${baseline.maxErrors}). Run --update-baseline to lock in the improvement.`
    )
    return
  }

  console.log(`[check-test-typecheck] OK (baseline: ${baseline.maxErrors})`)
}

main()

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
 *   node scripts/check-test-typecheck.mjs --no-blame       # skip git attribution
 *
 * Unrecognised arguments are rejected. They used to be ignored, which made a
 * mistyped scoping flag widen the run to every package instead of failing.
 *
 * On failure each over-budget file is attributed to the commits that last
 * touched its erroring lines, so a red CI log names the culprit instead of
 * requiring the operator to run git blame by hand.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

// Argument parsing is strict on purpose.
//
// The permissive version of this — `args.includes(...)` with unrecognised
// arguments silently ignored — produced a live cross-lane hazard. `--only <pkg>`
// reads as a scoping flag, but no such flag exists, so the run measured every
// package; two concurrent sessions reported per-package verdicts that were
// actually workspace-wide. Paired with `--update-baseline` it is worse than
// misleading: `targets` is every package, so every package's budget is rewritten
// from a measurement taken while other packages sit mid-edit, which is the
// ratchet accommodating errors instead of ratcheting them down. A typo must fail
// loudly rather than widen the blast radius.
const BOOLEAN_FLAGS = {
  '--report-only': 'reportOnly',
  '--update-baseline': 'updateBaseline',
  // Attribution is on by default on failure: the whole point is that the
  // operator reading a red CI log should not have to re-run anything to learn
  // whose commit caused it. --no-blame exists for checkouts where git is
  // unavailable or slow.
  '--no-blame': 'noBlame',
  // A baseline write that RAISES a budget is the ratchet accommodating errors.
  // It is occasionally legitimate (a deliberate, reviewed widening), so it is
  // possible — but never silent.
  '--allow-raise': 'allowRaise',
}

export function parseArgs(argv) {
  const options = {
    reportOnly: false,
    updateBaseline: false,
    noBlame: false,
    allowRaise: false,
    onlyPackage: null,
  }
  const unknown = []

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === '--package') {
      const value = argv[i + 1]
      // A missing value left onlyPackage `undefined`, which is falsy and so
      // indistinguishable from "no --package given" — `--package` as the final
      // argument silently measured every package. Same defect class as `--only`,
      // same fix: refuse rather than widen.
      if (value === undefined || value.startsWith('--')) {
        return { error: "'--package' requires a package name (for example: --package core)." }
      }
      if (options.onlyPackage !== null) {
        return {
          error:
            "'--package' was given more than once. This guard measures exactly one " +
            'package or all of them, never a subset — only the first was ever honoured.',
        }
      }
      options.onlyPackage = value
      i += 1
      continue
    }

    const field = BOOLEAN_FLAGS[arg]
    if (field) {
      options[field] = true
      continue
    }

    unknown.push(arg)
  }

  if (unknown.length > 0) {
    return {
      error:
        `unrecognised argument(s): ${unknown.join(' ')}. The scoping flag is ` +
        '--package <name>; there is no --only. An ignored scoping flag silently ' +
        'widens the run to every package, and with --update-baseline that rewrites ' +
        "every package's budget from a mid-edit measurement.",
    }
  }

  return { options }
}

/**
 * Human-readable scope, printed BEFORE measuring.
 *
 * The old code printed a package count only in the pass/fail summary, and
 * `--update-baseline` returned before reaching it — so the one command carrying
 * the rewrite-everything hazard was also the one command that never told you
 * what it was about to rewrite.
 */
export function describeScope(targets, onlyPackage) {
  return onlyPackage ? `1 package (${onlyPackage})` : `all ${targets.length} enrolled packages`
}

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
    if (match) errors.push({ file: match[1], line: Number(match[2]), code: match[4] })
  }

  if (result.status !== 0 && errors.length === 0) {
    throw new Error(
      `[${pkg}] tsc exited ${result.status} without emitting parseable errors — ` +
        `the typecheck itself is broken, not merely failing:\n${output.slice(0, 2000)}`
    )
  }

  const perFile = {}
  const perCode = {}
  const linesByFile = {}
  for (const { file, line, code } of errors) {
    perFile[file] = (perFile[file] ?? 0) + 1
    perCode[code] = (perCode[code] ?? 0) + 1
    ;(linesByFile[file] ??= []).push({ line, code })
  }

  return { total: errors.length, perFile, perCode, linesByFile }
}

/**
 * Attribute over-budget files to the commits that last touched their erroring
 * lines.
 *
 * Motivation: this guard fires on real regressions regularly (twice on
 * 2026-08-02 alone, both from an unattended daemon), and each time the operator
 * had to run `git log`/`git blame` by hand to learn whose commit to route it
 * to. CI should name the culprit itself.
 *
 * Precision comes from blaming the ERRORING LINES, not the file. A file-level
 * `git log -1` names whoever last touched the file for any reason — a rename or
 * an import reorder gets blamed for a type error it never introduced. Blaming
 * the exact lines tsc pointed at attributes the error to the change that wrote
 * the offending code.
 *
 * Lines are grouped per commit with a count, so the heaviest contributor sorts
 * first rather than being buried among incidental single-line hits.
 */
export function summarizeBlame(blameLines) {
  const byCommit = new Map()
  for (const entry of blameLines) {
    if (!entry || !entry.sha) continue
    const existing = byCommit.get(entry.sha)
    if (existing) {
      existing.lines += 1
    } else {
      byCommit.set(entry.sha, {
        sha: entry.sha,
        author: entry.author ?? 'unknown',
        summary: entry.summary ?? '',
        lines: 1,
      })
    }
  }
  return [...byCommit.values()].sort((a, b) => b.lines - a.lines || a.sha.localeCompare(b.sha))
}

/**
 * Parse `git blame --line-porcelain` output into {sha, line, author, summary}.
 *
 * Porcelain is used rather than the default format because the default
 * interleaves the source line with the metadata on one line, so an author name
 * or a code line containing brackets or parens can corrupt a regex split.
 * Porcelain puts `author` and `summary` on their own labelled lines.
 */
export function parseBlamePorcelain(output) {
  const records = []
  let current = null
  for (const raw of output.split('\n')) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(raw)
    if (header) {
      if (current) records.push(current)
      current = { sha: header[1].slice(0, 8), line: Number(header[2]) }
      continue
    }
    if (!current) continue
    if (raw.startsWith('author ')) current.author = raw.slice('author '.length).trim()
    else if (raw.startsWith('summary ')) current.summary = raw.slice('summary '.length).trim()
  }
  if (current) records.push(current)
  return records
}

function blameFile(pkg, file, lines) {
  if (lines.length === 0) return []
  // -L is repeatable; one range per erroring line keeps blame narrow instead of
  // walking the whole file.
  const ranges = [...new Set(lines)].sort((a, b) => a - b).flatMap((n) => ['-L', `${n},${n}`])
  const result = spawnSync('git', ['blame', '--line-porcelain', ...ranges, '--', file], {
    cwd: join(PACKAGES_DIR, pkg),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  // Blame is diagnostic sugar. An untracked or newly added file, or a checkout
  // without git, must degrade to "no attribution" rather than failing the guard
  // whose verdict the operator actually needs.
  if (result.error || result.status !== 0) return []
  return parseBlamePorcelain(result.stdout ?? '')
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
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.error) {
    console.error(`[check-test-typecheck] ${parsed.error}`)
    process.exitCode = 1
    return
  }
  const { reportOnly, updateBaseline, noBlame, allowRaise, onlyPackage } = parsed.options

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

  console.log(`[check-test-typecheck] scope: ${describeScope(targets, onlyPackage)}`)

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

    // Fail closed on any budget this write would RAISE.
    //
    // Lowering is the whole point and always proceeds. Raising is the failure
    // mode this guard exists to prevent: a whole-repo --update-baseline
    // measures every package live, so a lane caught between "broke 40 things"
    // and "fixed them" has its transient count recorded as the new allowed
    // budget. Per-file budgets are checked too, because they fail
    // independently by design — one file can rise while another falls and
    // leave the package total unchanged, which is precisely the regression the
    // per-file split exists to catch.
    const raises = []
    for (const [pkg, entry] of Object.entries(current)) {
      const prior = baseline?.packages?.[pkg]
      if (!prior) continue
      if (entry.total > prior.maxErrors) {
        raises.push(`${pkg}: package total ${prior.maxErrors} -> ${entry.total}`)
      }
      for (const [file, count] of Object.entries(entry.perFile ?? {})) {
        const priorCount = prior.perFile?.[file]
        if (priorCount !== undefined && count > priorCount) {
          raises.push(`${pkg}/${file}: ${priorCount} -> ${count}`)
        }
      }
    }
    if (raises.length > 0 && !allowRaise) {
      console.error(
        `[check-test-typecheck] refusing to write a baseline that raises ${raises.length} ` +
          'budget(s). This is how a concurrent lane\'s mid-edit state gets recorded as an ' +
          'allowed budget. Fix the regression, or re-run with --allow-raise if the widening ' +
          'is deliberate.'
      )
      for (const line of raises.slice(0, 20)) console.error(`  ${line}`)
      if (raises.length > 20) console.error(`  ... and ${raises.length - 20} more`)
      process.exitCode = 1
      return
    }

    writeBaseline(merged)
    const now = Object.values(merged).reduce((n, p) => n + p.total, 0)
    // Report the measured scope, not the merged file's size. The old message
    // said "across 18 packages" even for a correctly scoped single-package
    // update, which is indistinguishable from the accident it should surface.
    console.log(
      `[check-test-typecheck] baseline updated for ${describeScope(targets, onlyPackage)} ` +
        `(${now} errors now recorded across ${Object.keys(merged).length} packages)`
    )
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
    const shown = regressions.slice(0, 20)
    for (const { pkg, file, count, allowed } of shown) {
      console.error(`  [${pkg}] ${file}: ${count} (allowed ${allowed})`)
      if (noBlame) continue
      const errorLines = (current[pkg].linesByFile?.[file] ?? []).map((e) => e.line)
      const commits = summarizeBlame(blameFile(pkg, file, errorLines))
      for (const c of commits.slice(0, 3)) {
        console.error(
          `      last touched by ${c.sha} (${c.author}) — ${c.summary} [${c.lines} erroring line(s)]`
        )
      }
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

// Running the guard on import made `yarn test:scripts` execute the entire
// 18-package typecheck as a side effect of loading this module for its unit
// tests — minutes of duplicated work, and worse: main() sets process.exitCode on
// a real regression, so the scripts unit suite would go red for a reason that
// has nothing to do with any script test. Only run when this file IS the entry
// point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

#!/usr/bin/env node
/**
 * safe-codemod.mjs
 *
 * Runs a codemod against the agent test tree and auto-reverts it unless the
 * type-error set strictly improves.
 *
 * Motivation: two exactOptionalPropertyTypes codemods were reverted by hand on
 * 2026-07-30. The first RAISED the count (211 -> 246) by relaxing required
 * keys; the second was correct in isolation yet net-zero, having relocated
 * errors from call sites into helper returns. Both were caught by eyeballing
 * diffs. This wrapper makes that judgement mechanical.
 *
 * The decision keys on the error SET, not the count. A transform that fixes
 * three errors and introduces three others leaves the total unchanged while
 * silently moving the problem — exactly the second failure above. Any newly
 * introduced error (file+code+message, position ignored) is a rejection, even
 * when the net count drops.
 *
 * Positions are excluded from the identity because inserting or deleting a
 * line renumbers every error below it, which would otherwise report an entire
 * file as "new".
 *
 * Usage:
 *   node scripts/safe-codemod.mjs --run "node my-codemod.mjs"
 *   node scripts/safe-codemod.mjs --run "..." --keep      # leave changes applied
 *   node scripts/safe-codemod.mjs --baseline-only         # snapshot, no codemod
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const AGENT_DIR = join(ROOT, 'packages', 'agent')
const TARGET = 'packages/agent/src'

const ERROR_LINE_RE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/

function parseArgs(argv) {
  const args = { keep: false, baselineOnly: false, run: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--keep') args.keep = true
    else if (argv[i] === '--baseline-only') args.baselineOnly = true
    else if (argv[i] === '--run') args.run = argv[++i]
  }
  return args
}

function git(cmdArgs) {
  const r = spawnSync('git', cmdArgs, { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) {
    throw new Error(`git ${cmdArgs.join(' ')} failed: ${r.stderr || r.stdout}`)
  }
  return r.stdout
}

/** Collect type errors keyed by identity that survives line renumbering. */
export function collectErrors() {
  const r = spawnSync(
    'yarn',
    ['tsc', '-p', 'tsconfig.flipcheck.json', '--noEmit', '--pretty', 'false'],
    { cwd: AGENT_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const errors = []
  for (const line of output.split('\n')) {
    const m = ERROR_LINE_RE.exec(line)
    if (m) errors.push({ file: m[1], code: m[4], message: m[5], key: `${m[1]}|${m[4]}|${m[5]}` })
  }
  if (r.status !== 0 && errors.length === 0) {
    throw new Error(`tsc is broken, not merely failing:\n${output.slice(0, 2000)}`)
  }
  return errors
}

/**
 * Compare two error collections by multiset of identity keys. Duplicates
 * matter: three identical errors in a file dropping to two is real progress,
 * and rising to four is a real regression, so counts per key are tracked
 * rather than deduplicated into a Set.
 */
export function diffErrors(before, after) {
  const tally = (errs) => {
    const m = new Map()
    for (const e of errs) m.set(e.key, (m.get(e.key) ?? 0) + 1)
    return m
  }
  const b = tally(before)
  const a = tally(after)

  const introduced = []
  for (const [key, count] of a) {
    const was = b.get(key) ?? 0
    if (count > was) introduced.push({ key, was, now: count })
  }

  const fixed = []
  for (const [key, count] of b) {
    const now = a.get(key) ?? 0
    if (now < count) fixed.push({ key, was: count, now })
  }

  return {
    introduced,
    fixed,
    totalBefore: before.length,
    totalAfter: after.length,
    // Strictly better: something got fixed and nothing new appeared.
    improved: introduced.length === 0 && fixed.length > 0,
  }
}

function assertCleanTarget() {
  const status = git(['status', '--porcelain', '--', TARGET]).trim()
  if (status) {
    throw new Error(
      `${TARGET} has uncommitted changes. safe-codemod reverts via git checkout, ` +
        `which would destroy them. Commit or stash first:\n${status}`
    )
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  if (!args.run && !args.baselineOnly) {
    console.error('usage: safe-codemod.mjs --run "<command>" [--keep]')
    process.exitCode = 1
    return
  }

  console.log('[safe-codemod] snapshotting baseline errors...')
  const before = collectErrors()
  console.log(`[safe-codemod] baseline: ${before.length} errors`)

  if (args.baselineOnly) return

  // Only safe to auto-revert when the target tree is otherwise clean.
  assertCleanTarget()

  console.log(`[safe-codemod] running: ${args.run}`)
  const cm = spawnSync(args.run, { cwd: ROOT, shell: true, stdio: 'inherit' })
  if (cm.status !== 0) {
    console.error(`[safe-codemod] codemod exited ${cm.status}; reverting.`)
    git(['checkout', '--', TARGET])
    process.exitCode = 1
    return
  }

  const changed = git(['status', '--porcelain', '--', TARGET]).trim()
  if (!changed) {
    console.log('[safe-codemod] codemod made no changes; nothing to evaluate.')
    return
  }
  console.log(`[safe-codemod] codemod touched ${changed.split('\n').length} file(s)`)

  console.log('[safe-codemod] re-checking...')
  const after = collectErrors()
  const result = diffErrors(before, after)

  console.log(
    `[safe-codemod] ${result.totalBefore} -> ${result.totalAfter} ` +
      `(${result.fixed.length} fixed, ${result.introduced.length} introduced)`
  )

  if (result.introduced.length > 0) {
    console.error('\n[safe-codemod] REVERTING — codemod introduced new errors:')
    for (const { key, was, now } of result.introduced.slice(0, 15)) {
      const [file, code, message] = key.split('|')
      console.error(`  ${file} ${code} (${was} -> ${now})`)
      console.error(`    ${message.slice(0, 140)}`)
    }
    if (result.introduced.length > 15) {
      console.error(`  ... and ${result.introduced.length - 15} more`)
    }
    git(['checkout', '--', TARGET])
    console.error(
      '\n[safe-codemod] reverted. A lower total is NOT sufficient — this transform ' +
        'moved errors rather than removing them.'
    )
    process.exitCode = 1
    return
  }

  if (!result.improved) {
    console.log('[safe-codemod] no errors fixed and none introduced; reverting as a no-op.')
    git(['checkout', '--', TARGET])
    return
  }

  if (args.keep) {
    console.log(
      `[safe-codemod] ACCEPTED — ${result.fixed.length} error(s) fixed, none introduced. ` +
        'Changes left in the working tree; review the diff before committing.'
    )
    return
  }

  git(['checkout', '--', TARGET])
  console.log(
    `[safe-codemod] would ACCEPT (${result.fixed.length} fixed, 0 introduced) — ` +
      'reverted because --keep was not passed. Re-run with --keep to apply.'
  )
}

// Only run main when invoked directly, so the unit tests can import the
// pure helpers without triggering a full typecheck.
if (process.argv[1] && process.argv[1].endsWith('safe-codemod.mjs')) {
  main()
}

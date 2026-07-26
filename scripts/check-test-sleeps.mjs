#!/usr/bin/env node
/**
 * check-test-sleeps.mjs
 *
 * DZUPAGENT-TEST-L-01 guard: counts real-time sleeps in test files
 * (`await new Promise((resolve) => setTimeout(resolve, N))` and equivalent
 * bare `setTimeout(fn, N)` waits with N >= SLEEP_THRESHOLD_MS) across all
 * "packages/PKG/src/.../__tests__" test files and fails when the total
 * exceeds the checked-in baseline. This stops the bleed the 2026-07-24 audit
 * flagged (196 -> 244 sleeps, no guard) without requiring every offender to
 * be converted to fake timers up front.
 *
 * A line can opt out of the count with a trailing `// sleep-ok: <reason>`
 * comment (or a `// sleep-ok: <reason>` comment on the line immediately
 * above it) — use sparingly, for sleeps that are load-bearing (e.g. genuinely
 * racing a real timer under test) rather than laziness.
 *
 * Usage:
 *   node scripts/check-test-sleeps.mjs             # fail if over baseline
 *   node scripts/check-test-sleeps.mjs --report-only # print counts, exit 0
 *   node scripts/check-test-sleeps.mjs --update-baseline # rewrite baseline to current count
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const PACKAGES_DIR = join(ROOT, 'packages')
const BASELINE_FILE = join(__dirname, 'check-test-sleeps.baseline.json')

const SLEEP_THRESHOLD_MS = 10

// Matches: setTimeout(<anything>, <N>) where N is a numeric literal.
const SLEEP_LINE_RE = /setTimeout\s*\([^)]*?,\s*(\d[\d_]*)\s*\)/g

const args = process.argv.slice(2)
const reportOnly = args.includes('--report-only')
const updateBaseline = args.includes('--update-baseline')

// Recursively find test files under a package's src directory.
function findTestFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      findTestFiles(full, out)
    } else if (/\.(test|spec)\.(ts|tsx|mts)$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

function hasSleepOk(lines, idx) {
  const line = lines[idx]
  if (/sleep-ok\s*:/.test(line)) return true
  const prev = lines[idx - 1]
  return prev !== undefined && /sleep-ok\s*:/.test(prev)
}

function countSleeps() {
  const packages = existsSync(PACKAGES_DIR) ? readdirSync(PACKAGES_DIR) : []
  const perFile = []
  let total = 0

  for (const pkg of packages) {
    const srcDir = join(PACKAGES_DIR, pkg, 'src')
    if (!existsSync(srcDir)) continue
    for (const file of findTestFiles(srcDir)) {
      const content = readFileSync(file, 'utf8')
      const lines = content.split('\n')
      let fileCount = 0
      lines.forEach((line, idx) => {
        SLEEP_LINE_RE.lastIndex = 0
        let match
        while ((match = SLEEP_LINE_RE.exec(line)) !== null) {
          const ms = Number(match[1].replace(/_/g, ''))
          if (ms < SLEEP_THRESHOLD_MS) continue
          if (hasSleepOk(lines, idx)) continue
          fileCount++
        }
      })
      if (fileCount > 0) {
        total += fileCount
        perFile.push({ file: relative(ROOT, file), count: fileCount })
      }
    }
  }

  perFile.sort((a, b) => b.count - a.count)
  return { total, perFile }
}

function loadBaseline() {
  if (!existsSync(BASELINE_FILE)) return { maxSleeps: Infinity }
  return JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))
}

function main() {
  const { total, perFile } = countSleeps()

  if (updateBaseline) {
    writeFileSync(
      BASELINE_FILE,
      JSON.stringify(
        {
          maxSleeps: total,
          note:
            'DZUPAGENT-TEST-L-01 baseline: ratchets down only. Bump only via ' +
            '--update-baseline after converting sleeps to fake timers / vi.waitFor, ' +
            'never to accommodate new sleeps.',
          updatedAt: new Date().toISOString().slice(0, 10),
        },
        null,
        2
      ) + '\n'
    )
    console.log(`[check-test-sleeps] baseline updated to ${total}`)
    return
  }

  console.log(`[check-test-sleeps] total real-time sleeps: ${total}`)
  console.log('[check-test-sleeps] top offenders:')
  for (const { file, count } of perFile.slice(0, 10)) {
    console.log(`  ${count.toString().padStart(3)}  ${file}`)
  }

  if (reportOnly) return

  const baseline = loadBaseline()
  if (total > baseline.maxSleeps) {
    console.error(
      `\n[check-test-sleeps] FAIL: ${total} real-time sleeps exceeds baseline of ${baseline.maxSleeps}.\n` +
        'Convert new/growing sleeps to vi.useFakeTimers()/vi.waitFor(), or annotate a ' +
        'load-bearing sleep with `// sleep-ok: <reason>`. Do not raise the baseline to ' +
        'accommodate new sleeps — only lower it after converting offenders ' +
        '(node scripts/check-test-sleeps.mjs --update-baseline).'
    )
    process.exitCode = 1
    return
  }

  console.log(`[check-test-sleeps] OK (baseline: ${baseline.maxSleeps})`)
}

main()

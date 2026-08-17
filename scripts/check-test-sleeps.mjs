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
 * DZUPAGENT-TEST-H-05: the gate is *fake-timer aware*. A sleep that runs while
 * `vi.useFakeTimers()` is installed for its enclosing scope costs zero wall
 * time, so it is reported separately and does NOT count against the baseline.
 * Scope resolution is lexical (see fakeTimerLines below):
 *   - `vi.useFakeTimers()` inside a `beforeEach`/`beforeAll` hook governs the
 *     whole enclosing `describe` (or the file, for a top-level hook).
 *   - `vi.useFakeTimers()` written inline in a test body governs only the rest
 *     of that body, from its own line onward.
 *   - `vi.useRealTimers()` is tracked the same way and flips the mode back, so
 *     the innermost, most recent declaration wins.
 *
 * Known limits (deliberate — this is a lint, not a type checker):
 *   - Brace matching is textual over comment/string-stripped source. It cannot
 *     see timers installed indirectly (a shared `installFakeTimers()` helper,
 *     a timer set up in an imported setup file, or `vi.useFakeTimers()` behind
 *     a conditional). Those sleeps are counted as real — the gate errs toward
 *     over-counting, never under-counting.
 *   - It does not verify the fake clock is ever advanced. A fake-timer sleep
 *     that nothing advances hangs the test; that is a test bug the suite
 *     catches, not something this gate can see.
 *
 * Usage:
 *   node scripts/check-test-sleeps.mjs             # fail if over baseline
 *   node scripts/check-test-sleeps.mjs --report-only # print counts, exit 0
 *   node scripts/check-test-sleeps.mjs --update-baseline # rewrite baseline to current count
 *   node scripts/check-test-sleeps.mjs --list-fake   # show the sleeps excluded as fake-timer
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
const listFake = args.includes('--list-fake')

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

// Setup hooks: their body governs the *enclosing* suite rather than themselves.
const SETUP_RE = /\b(?:beforeEach|beforeAll)\s*\(/
// Teardown hooks run *after* the test body, so a `vi.useRealTimers()` in one is
// cleanup — it must never be read as the mode the tests ran under.
const TEARDOWN_RE = /\b(?:afterEach|afterAll)\s*\(/
const FAKE_TIMERS_RE = /\bvi\s*\.\s*useFakeTimers\s*\(/
const REAL_TIMERS_RE = /\bvi\s*\.\s*useRealTimers\s*\(/

/**
 * Strip line comments, block comments and string/template literal bodies so
 * braces inside them never open or close a scope.
 */
function stripNonCode(content) {
  let out = ''
  let i = 0
  let state = 'code' // code | line | block | single | double | template
  while (i < content.length) {
    const c = content[i]
    const next = content[i + 1]
    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'line'
        i += 2
        continue
      }
      if (c === '/' && next === '*') {
        state = 'block'
        i += 2
        continue
      }
      if (c === "'") state = 'single'
      else if (c === '"') state = 'double'
      else if (c === '`') state = 'template'
      out += c
      i++
      continue
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code'
        out += c
      }
      i++
      continue
    }
    if (state === 'block') {
      if (c === '*' && next === '/') {
        state = 'code'
        i += 2
        continue
      }
      if (c === '\n') out += c
      i++
      continue
    }
    // inside a string/template: drop everything but newlines and the closer
    if (c === '\\') {
      i += 2
      continue
    }
    if (
      (state === 'single' && c === "'") ||
      (state === 'double' && c === '"') ||
      (state === 'template' && c === '`')
    ) {
      state = 'code'
      out += c
      i++
      continue
    }
    if (c === '\n') out += c
    i++
  }
  return out
}

/**
 * Returns a Set of 0-based line indexes on which a sleep would execute under
 * fake timers.
 *
 * Model: a stack of lexical frames, each carrying an ordered list of timer-mode
 * events `{ line, fake }`. For a given line, walk the stack innermost-outward
 * and take the last event at or before that line; the first frame with an
 * applicable event wins. No event anywhere => real timers.
 */
function fakeTimerLines(content) {
  const code = stripNonCode(content).split('\n')
  const raw = content.split('\n')
  const stack = [{ kind: 'root', startLine: 0, events: [] }]
  const fake = new Set()

  const modeAt = (lineIdx) => {
    for (let f = stack.length - 1; f >= 0; f--) {
      const events = stack[f].events
      for (let e = events.length - 1; e >= 0; e--) {
        if (events[e].line <= lineIdx) return events[e].fake
      }
    }
    return false
  }

  for (let idx = 0; idx < code.length; idx++) {
    const codeLine = code[idx]

    // 1. Record timer events, resolved against the stack as it stands *before*
    //    this line's braces are applied.
    const isFake = FAKE_TIMERS_RE.test(codeLine)
    const isReal = REAL_TIMERS_RE.test(codeLine)
    const inTeardown =
      TEARDOWN_RE.test(codeLine) || stack.some((f) => f.kind === 'teardown')
    if ((isFake || isReal) && !inTeardown) {
      // A setup-hook body governs its enclosing suite, from that suite's first
      // line, so it applies to every test in the suite.
      const inSetup =
        SETUP_RE.test(codeLine) || stack.some((f) => f.kind === 'setup')
      let target = stack[stack.length - 1]
      let line = idx
      if (inSetup) {
        let f = stack.length - 1
        while (f > 0 && stack[f].kind === 'setup') f--
        target = stack[f]
        line = target.startLine
      }
      // Later declarations on the same governing line must still win.
      target.events.push({ line, fake: isFake && !isReal })
    }

    // 2. Classify this line's sleeps (also before applying braces).
    if (/setTimeout/.test(raw[idx]) && modeAt(idx)) fake.add(idx)

    // 3. Apply this line's brace deltas in character order.
    const kind = TEARDOWN_RE.test(codeLine)
      ? 'teardown'
      : SETUP_RE.test(codeLine)
        ? 'setup'
        : 'block'
    for (const ch of codeLine) {
      if (ch === '{') stack.push({ kind, startLine: idx, events: [] })
      else if (ch === '}' && stack.length > 1) stack.pop()
    }
  }

  return fake
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
  let fakeTotal = 0
  const fakeSites = []

  for (const pkg of packages) {
    const srcDir = join(PACKAGES_DIR, pkg, 'src')
    if (!existsSync(srcDir)) continue
    for (const file of findTestFiles(srcDir)) {
      const content = readFileSync(file, 'utf8')
      const lines = content.split('\n')
      const fakeLines = fakeTimerLines(content)
      let fileCount = 0
      let fileFake = 0
      lines.forEach((line, idx) => {
        SLEEP_LINE_RE.lastIndex = 0
        let match
        while ((match = SLEEP_LINE_RE.exec(line)) !== null) {
          const ms = Number(match[1].replace(/_/g, ''))
          if (ms < SLEEP_THRESHOLD_MS) continue
          if (hasSleepOk(lines, idx)) continue
          // Zero wall-cost: the enclosing scope has fake timers installed.
          if (fakeLines.has(idx)) {
            fileFake++
            fakeSites.push(`${relative(ROOT, file)}:${idx + 1}: ${line.trim()}`)
            continue
          }
          fileCount++
        }
      })
      fakeTotal += fileFake
      if (fileCount > 0) {
        total += fileCount
        perFile.push({ file: relative(ROOT, file), count: fileCount, fake: fileFake })
      }
    }
  }

  perFile.sort((a, b) => b.count - a.count)
  return { total, fakeTotal, perFile, fakeSites }
}

function loadBaseline() {
  if (!existsSync(BASELINE_FILE)) return { maxSleeps: Infinity }
  return JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))
}

function main() {
  const { total, fakeTotal, perFile, fakeSites } = countSleeps()

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
    console.log(
      `[check-test-sleeps] baseline updated to ${total} (+${fakeTotal} fake-timer sleeps ignored)`
    )
    return
  }

  console.log(`[check-test-sleeps] total real-time sleeps: ${total}`)
  console.log(
    `[check-test-sleeps] ignored (zero-cost under vi.useFakeTimers): ${fakeTotal}`
  )
  if (listFake) {
    console.log('[check-test-sleeps] fake-timer sleeps excluded from the count:')
    for (const site of fakeSites) console.log(`  ${site}`)
  }
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

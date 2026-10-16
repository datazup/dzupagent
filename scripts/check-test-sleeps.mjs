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
 * DZUPAGENT-TEST-H-07: sleeps are found by scanning balanced parentheses over
 * the comment/string-stripped source, so an arrow callback such as
 * `setTimeout(() => r(), 50)` (whose inner `()` defeated the old `[^)]*?` line
 * regex) is counted, and a call split across lines is counted on the line where
 * `setTimeout` appears. The delay is the call's second top-level argument.
 * A missing baseline file fails the gate (it used to mean "no limit"), and
 * --update-baseline refuses to RAISE the ceiling unless --allow-raise is given.
 *
 * Usage:
 *   node scripts/check-test-sleeps.mjs             # fail if over baseline
 *   node scripts/check-test-sleeps.mjs --report-only # print counts, exit 0
 *   node scripts/check-test-sleeps.mjs --update-baseline # lower (or keep) the baseline to the current count
 *   node scripts/check-test-sleeps.mjs --update-baseline --allow-raise # raise it (needs a reason in review)
 *   node scripts/check-test-sleeps.mjs --list-fake   # show the sleeps excluded as fake-timer
 *   node scripts/check-test-sleeps.mjs --root=<dir> --baseline-file=<path>  # fixture runs
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { join, relative, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = join(__dirname, '..')
const DEFAULT_BASELINE_FILE = join(__dirname, 'check-test-sleeps.baseline.json')

export const SLEEP_THRESHOLD_MS = 10

const SET_TIMEOUT_CALL_RE = /\bsetTimeout\s*\(/g
const NUMERIC_DELAY_RE = /^(\d[\d_]*)$/

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

/**
 * Finds every `setTimeout(...)` call in comment/string-stripped source by
 * walking balanced parentheses, and returns the 0-based line of the
 * `setTimeout` token plus the numeric delay (its second top-level argument)
 * when that argument is a numeric literal.
 * @param {string} content raw file content
 * @returns {{ line: number, ms: number }[]}
 */
export function findSleepCalls(content) {
  const code = stripNonCode(content)
  const calls = []
  SET_TIMEOUT_CALL_RE.lastIndex = 0
  let match
  while ((match = SET_TIMEOUT_CALL_RE.exec(code)) !== null) {
    const open = match.index + match[0].length - 1
    let depth = 0
    let argIndex = 0
    let argStart = open + 1
    let delayText
    for (let i = open; i < code.length; i++) {
      const ch = code[i]
      if (ch === '(' || ch === '[' || ch === '{') depth++
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth--
        if (depth === 0) {
          if (argIndex === 1) delayText = code.slice(argStart, i)
          break
        }
      } else if (ch === ',' && depth === 1) {
        if (argIndex === 1) {
          delayText = code.slice(argStart, i)
          break
        }
        argIndex++
        argStart = i + 1
      }
    }
    if (delayText === undefined) continue
    const delay = NUMERIC_DELAY_RE.exec(delayText.trim())
    if (!delay) continue
    const line = code.slice(0, match.index).split('\n').length - 1
    calls.push({ line, ms: Number(delay[1].replace(/_/g, '')) })
  }
  return calls
}

/**
 * Counts real-time and fake-timer sleeps in one test file's content.
 * @param {string} content
 * @returns {{ count: number, fake: number, fakeLines: number[] }}
 */
export function countSleepsInContent(content) {
  const lines = content.split('\n')
  const fakeLines = fakeTimerLines(content)
  let count = 0
  const fakeHits = []
  for (const { line, ms } of findSleepCalls(content)) {
    if (ms < SLEEP_THRESHOLD_MS) continue
    if (hasSleepOk(lines, line)) continue
    // Zero wall-cost: the enclosing scope has fake timers installed.
    if (fakeLines.has(line)) {
      fakeHits.push(line)
      continue
    }
    count++
  }
  return { count, fake: fakeHits.length, fakeLines: fakeHits }
}

export function countSleeps(root = DEFAULT_ROOT) {
  const packagesDir = join(root, 'packages')
  const packages = existsSync(packagesDir) ? readdirSync(packagesDir) : []
  const perFile = []
  let total = 0
  let fakeTotal = 0
  const fakeSites = []

  for (const pkg of packages) {
    const srcDir = join(packagesDir, pkg, 'src')
    if (!existsSync(srcDir)) continue
    for (const file of findTestFiles(srcDir)) {
      const content = readFileSync(file, 'utf8')
      const lines = content.split('\n')
      const result = countSleepsInContent(content)
      fakeTotal += result.fake
      for (const idx of result.fakeLines) {
        fakeSites.push(`${relative(root, file)}:${idx + 1}: ${lines[idx].trim()}`)
      }
      if (result.count > 0) {
        total += result.count
        perFile.push({ file: relative(root, file), count: result.count, fake: result.fake })
      }
    }
  }

  perFile.sort((a, b) => b.count - a.count)
  return { total, fakeTotal, perFile, fakeSites }
}

/**
 * Reads the baseline. A missing or malformed baseline is an error, never an
 * unlimited ceiling (it used to return `maxSleeps: Infinity`).
 * @returns {{ ok: true, maxSleeps: number } | { ok: false, reason: string }}
 */
export function loadBaseline(baselineFile = DEFAULT_BASELINE_FILE) {
  if (!existsSync(baselineFile)) {
    return { ok: false, reason: `baseline file ${baselineFile} is missing` }
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(baselineFile, 'utf8'))
  } catch (error) {
    return { ok: false, reason: `baseline file ${baselineFile} is not valid JSON: ${error.message}` }
  }
  const maxSleeps = parsed?.maxSleeps
  if (typeof maxSleeps !== 'number' || !Number.isInteger(maxSleeps) || maxSleeps < 0) {
    return { ok: false, reason: `baseline file ${baselineFile} has no non-negative integer maxSleeps` }
  }
  return { ok: true, maxSleeps }
}

function parseArgs(argv) {
  const valueOf = (name) => {
    const flag = argv.find((a) => a.startsWith(`--${name}=`))
    return flag === undefined ? undefined : flag.slice(name.length + 3)
  }
  return {
    reportOnly: argv.includes('--report-only'),
    updateBaseline: argv.includes('--update-baseline'),
    allowRaise: argv.includes('--allow-raise'),
    listFake: argv.includes('--list-fake'),
    root: resolve(valueOf('root') ?? DEFAULT_ROOT),
    baselineFile: resolve(valueOf('baseline-file') ?? DEFAULT_BASELINE_FILE),
  }
}

/** @returns {number} the process exit code */
export function runCli(argv) {
  const options = parseArgs(argv)
  const { total, fakeTotal, perFile, fakeSites } = countSleeps(options.root)

  if (options.updateBaseline) {
    const baseline = loadBaseline(options.baselineFile)
    const previous = baseline.ok ? baseline.maxSleeps : undefined
    if ((previous === undefined || total > previous) && !options.allowRaise) {
      console.error(
        `[check-test-sleeps] FAIL: refusing to ${previous === undefined ? 'create' : 'raise'} the baseline `
          + `(${previous ?? 'none'} -> ${total}) without --allow-raise. The baseline ratchets down only; `
          + 'convert the new sleeps instead, or pass --allow-raise and justify the raise in review.',
      )
      return 1
    }
    writeFileSync(
      options.baselineFile,
      JSON.stringify(
        {
          maxSleeps: total,
          note:
            'DZUPAGENT-TEST-L-01 baseline: ratchets down only. Lower it via ' +
            '--update-baseline after converting sleeps to fake timers / vi.waitFor; ' +
            'raising it needs --allow-raise and must never accommodate new sleeps.',
          updatedAt: new Date().toISOString().slice(0, 10),
        },
        null,
        2
      ) + '\n'
    )
    console.log(
      `[check-test-sleeps] baseline updated ${previous ?? 'none'} -> ${total} (+${fakeTotal} fake-timer sleeps ignored)`
    )
    return 0
  }

  console.log(`[check-test-sleeps] total real-time sleeps: ${total}`)
  console.log(
    `[check-test-sleeps] ignored (zero-cost under vi.useFakeTimers): ${fakeTotal}`
  )
  if (options.listFake) {
    console.log('[check-test-sleeps] fake-timer sleeps excluded from the count:')
    for (const site of fakeSites) console.log(`  ${site}`)
  }
  console.log('[check-test-sleeps] top offenders:')
  for (const { file, count } of perFile.slice(0, 10)) {
    console.log(`  ${count.toString().padStart(3)}  ${file}`)
  }

  if (options.reportOnly) return 0

  const baseline = loadBaseline(options.baselineFile)
  if (!baseline.ok) {
    console.error(
      `\n[check-test-sleeps] FAIL: ${baseline.reason}. A missing baseline is not an unlimited ` +
        'ceiling; restore the checked-in baseline file.'
    )
    return 1
  }
  if (total > baseline.maxSleeps) {
    console.error(
      `\n[check-test-sleeps] FAIL: ${total} real-time sleeps exceeds baseline of ${baseline.maxSleeps}.\n` +
        'Convert new/growing sleeps to vi.useFakeTimers()/vi.waitFor(), or annotate a ' +
        'load-bearing sleep with `// sleep-ok: <reason>`. Do not raise the baseline to ' +
        'accommodate new sleeps — only lower it after converting offenders ' +
        '(node scripts/check-test-sleeps.mjs --update-baseline).'
    )
    return 1
  }

  console.log(`[check-test-sleeps] OK (baseline: ${baseline.maxSleeps})`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(process.argv.slice(2))
}

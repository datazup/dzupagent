#!/usr/bin/env node
/**
 * triage-exact-optional.mjs
 *
 * Classifies exactOptionalPropertyTypes errors (TS2375 / TS2379 / TS2412) into
 * the two fixes, which are OPPOSITE and therefore cannot be codemodded as one
 * transform. Two blanket attempts were reverted on 2026-07-30 proving this: a
 * widening pass relaxed genuinely-required keys (211 -> 246 errors), and a
 * correct-in-isolation `TestOverrides<T>` merely relocated 40 errors from call
 * sites into helper returns for a net zero.
 *
 * The three fixes:
 *
 *   OMIT_KEY    The site writes a key whose value is only incidentally
 *               undefined (a spread, an optional lookup). The key was never
 *               meant to be set. Fix: do not write the key.
 *
 *   WIDEN_PARAM The site passes `undefined` DELIBERATELY — it is asserting
 *               "this field is absent" as the point of the test. Fix: widen
 *               the target property to `T | undefined`.
 *
 *   NARROW_CAST The site casts through an indexed access into an optional
 *               property (`x as T["opt"]`), which resolves to `V | undefined`
 *               and so re-adds the undefined the destination rejects. Neither
 *               the value nor the target is wrong — the cast is. Fix: wrap in
 *               NonNullable<>. Safest of the three: no signature, import or
 *               assertion changes.
 *
 * The discriminator is whether the literal token `undefined` appears as the
 * written value at the call site. `{ timeoutMs: undefined }` is a deliberate
 * assertion; `{ tokenUsage: {...} | undefined }` arising from a spread is not.
 * That is a heuristic, not a proof, so every row carries the evidence that
 * produced it and a confidence, and the output is a REVIEW queue rather than
 * an edit. Anything ambiguous is reported UNCLEAR instead of guessed.
 *
 * Usage:
 *   node scripts/triage-exact-optional.mjs                 # agent, table
 *   node scripts/triage-exact-optional.mjs --package core
 *   node scripts/triage-exact-optional.mjs --json          # machine-readable
 */

import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const EXACT_OPTIONAL_CODES = new Set(['TS2375', 'TS2379', 'TS2412'])
const ERROR_LINE_RE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/

export function parseArgs(argv) {
  const args = { package: 'agent', json: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--package') args.package = argv[++i]
    else if (argv[i] === '--json') args.json = true
  }
  return args
}

/**
 * Extract the object-literal body from the source type in a tsc message.
 *
 * Two parsing traps, both of which silently produced UNCLEAR verdicts and were
 * measured on 2026-08-02 as the cause of 14 of 19 unclassified agent rows:
 *
 *  1. CASE. TS2379 reads "Argument of type '{...}'" (lowercase t, mid-sentence)
 *     but TS2375 reads "Type '{...}' is not assignable" — sentence-initial, so
 *     capital T. A /type '\{/ regex matched none of the TS2375 corpus, which is
 *     why that code dominated the UNCLEAR bucket.
 *
 *  2. NESTING. A non-greedy `(.+?)\}` stops at the FIRST closing brace, so
 *     `{ nodeId: string; output: {}; error: string | undefined; }` truncates to
 *     `nodeId: string; output: {` and the `error` prop that actually caused the
 *     error is never seen. Brace-matching from the opening `{` is required.
 *
 * Returns the inner body without the surrounding braces, or null if the message
 * carries no object literal (e.g. 'PipelineStuckDetector | undefined').
 */
export function extractTypeBody(message) {
  const start = message.search(/\btype '\{/i)
  if (start === -1) return null
  const open = message.indexOf('{', start)
  let depth = 0
  for (let i = open; i < message.length; i++) {
    const ch = message[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return message.slice(open + 1, i)
    }
  }
  // Unbalanced: tsc truncates very long types with '...'. Treat as unparseable
  // rather than returning a half-type that would misclassify the row.
  return null
}

/**
 * Pull the property names the compiler named in the offending object literal.
 * The message embeds the source type, e.g.
 *   Argument of type '{ timeoutMs: undefined; }' is not assignable ...
 * Properties written as literal `undefined` are the deliberate ones.
 */
export function extractUndefinedProps(message) {
  const body = extractTypeBody(message)
  if (body === null) return { explicit: [], all: [] }

  const explicit = []
  const all = []
  // Split on ';' at depth 0 so nested object/generic types stay intact.
  let depth = 0
  let current = ''
  for (const ch of body) {
    if (ch === '{' || ch === '<' || ch === '(') depth++
    else if (ch === '}' || ch === '>' || ch === ')') depth--
    if (ch === ';' && depth === 0) {
      if (current.trim()) all.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) all.push(current.trim())

  for (const prop of all) {
    const [name, ...rest] = prop.split(':')
    const valueType = rest.join(':').trim()
    // Exactly `undefined` means the site wrote the literal; `X | undefined`
    // means the value merely might be absent, which is a different fix.
    if (valueType === 'undefined') explicit.push(name.trim())
  }
  return { explicit, all }
}

/**
 * Detect a cast whose TARGET is an indexed access into an optional property,
 * e.g. `x as unknown as TeamRuntimeMemoryService["store"]`.
 *
 * This is a third fix, opposite in spirit to both others: nothing about the
 * value or the target property is wrong — the CAST is. `T["store"]` on an
 * optional `store?: S` resolves to `S | undefined`, so the assertion widens the
 * value to include the very `undefined` the destination slot forbids. The cast
 * manufactures the error it then trips over.
 *
 * Fix: `NonNullable<T["store"]>`. No signature, import, or assertion changes —
 * which is what makes it safe where widening and omitting are not. Confirmed by
 * hand on 2026-08-02: three TS2375 errors in team-runtime-memory.test.ts
 * cleared with 12/12 tests still passing.
 */
export function detectIndexedAccessCast(sourceLine) {
  if (!sourceLine) return null
  // Matches `as Foo["bar"]` / `as unknown as Foo['bar']`, but not an already
  // wrapped `NonNullable<Foo["bar"]>`.
  const m = /\bas\s+(?:unknown\s+as\s+)?([A-Za-z_$][\w$]*)\s*\[\s*['"]([^'"]+)['"]\s*\]/.exec(
    sourceLine
  )
  if (!m) return null
  if (new RegExp(`NonNullable<\\s*${m[1]}\\s*\\[`).test(sourceLine)) return null
  return { type: m[1], prop: m[2] }
}

export function classify({ message, sourceLine }) {
  const { explicit, all } = extractUndefinedProps(message)

  // Checked before the property-based branches: the message for these rows
  // names the indexed access as the source type (`TeamPolicies["memory"]`),
  // which the prop heuristics would otherwise read as an ordinary widening.
  const indexed = detectIndexedAccessCast(sourceLine)
  if (indexed) {
    return {
      verdict: 'NARROW_CAST',
      confidence: 'high',
      props: [indexed.prop],
      why:
        `cast target ${indexed.type}["${indexed.prop}"] is an indexed access into an ` +
        `optional prop, so it resolves to 'T | undefined' and re-adds the undefined the ` +
        `slot rejects — wrap it in NonNullable<>`,
    }
  }

  // A site that writes `key: undefined` in the source is asserting absence.
  const writesLiteralUndefined =
    sourceLine && explicit.some((p) => new RegExp(`\\b${p}\\s*:\\s*undefined\\b`).test(sourceLine))

  if (explicit.length > 0 && writesLiteralUndefined) {
    return {
      verdict: 'WIDEN_PARAM',
      confidence: 'high',
      props: explicit,
      why: `site writes ${explicit.map((p) => `${p}: undefined`).join(', ')} literally — the absence is the assertion`,
    }
  }

  if (explicit.length > 0) {
    return {
      verdict: 'WIDEN_PARAM',
      confidence: 'medium',
      props: explicit,
      why: `compiler saw ${explicit.join(', ')} as exactly undefined, but the literal is not on this line (multi-line object or a helper)`,
    }
  }

  const optional = all
    .filter((p) => / \| undefined$/.test(p.split(':').slice(1).join(':').trim()))
    .map((p) => p.split(':')[0].trim())

  if (optional.length > 0) {
    return {
      verdict: 'OMIT_KEY',
      confidence: 'medium',
      props: optional,
      why: `${optional.join(', ')} is 'T | undefined' from a spread or optional lookup — the key was never meant to be written`,
    }
  }

  return {
    verdict: 'UNCLEAR',
    confidence: 'low',
    props: [],
    why: 'could not attribute the mismatch to a specific property from the message alone',
  }
}

function collect(pkg) {
  const pkgDir = join(ROOT, 'packages', pkg)
  if (!existsSync(join(pkgDir, 'tsconfig.flipcheck.json'))) {
    throw new Error(`package '${pkg}' has no tsconfig.flipcheck.json (not enrolled)`)
  }
  const r = spawnSync(
    'yarn',
    ['tsc', '-p', 'tsconfig.flipcheck.json', '--noEmit', '--pretty', 'false'],
    { cwd: pkgDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const rows = []
  for (const line of output.split('\n')) {
    const m = ERROR_LINE_RE.exec(line)
    if (!m) continue
    const [, file, lineNo, col, code, message] = m
    if (!EXACT_OPTIONAL_CODES.has(code)) continue
    rows.push({ file, line: Number(lineNo), col: Number(col), code, message })
  }
  if (r.status !== 0 && rows.length === 0 && !output.includes('error TS')) {
    throw new Error(`tsc is broken, not merely failing:\n${output.slice(0, 1500)}`)
  }
  return { rows, pkgDir }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const { rows, pkgDir } = collect(args.package)

  const sourceCache = new Map()
  const readSourceLine = (file, lineNo) => {
    if (!sourceCache.has(file)) {
      const abs = join(pkgDir, file)
      sourceCache.set(file, existsSync(abs) ? readFileSync(abs, 'utf8').split('\n') : [])
    }
    return sourceCache.get(file)[lineNo - 1] ?? ''
  }

  const triaged = rows.map((r) => ({
    ...r,
    ...classify({ message: r.message, sourceLine: readSourceLine(r.file, r.line) }),
  }))

  if (args.json) {
    console.log(JSON.stringify({ package: args.package, total: triaged.length, rows: triaged }, null, 2))
    return
  }

  const byVerdict = { NARROW_CAST: [], WIDEN_PARAM: [], OMIT_KEY: [], UNCLEAR: [] }
  for (const t of triaged) byVerdict[t.verdict].push(t)

  console.log(
    `\n[triage-exact-optional] ${args.package}: ${triaged.length} exactOptional error(s)\n`
  )
  for (const verdict of ['NARROW_CAST', 'WIDEN_PARAM', 'OMIT_KEY', 'UNCLEAR']) {
    const group = byVerdict[verdict]
    if (group.length === 0) continue
    console.log(`── ${verdict} (${group.length}) ${'─'.repeat(Math.max(0, 50 - verdict.length))}`)
    for (const t of group) {
      console.log(`  ${t.file}:${t.line}  ${t.code}  [${t.confidence}]`)
      console.log(`      ${t.why}`)
    }
    console.log()
  }

  console.log(
    'NARROW_CAST: wrap the cast target in NonNullable<> — the cast itself adds the\n' +
      '             undefined. Safest of the three: changes no signature or assertion.\n' +
      'WIDEN_PARAM: add `| undefined` to the target property — the test asserts absence.\n' +
      'OMIT_KEY   : stop writing the key; its undefined is incidental.\n' +
      'UNCLEAR    : open the site. Do not guess — the fixes are opposite, and a\n' +
      '             blanket pass in either direction has already been reverted twice.\n' +
      '\nThis is a REVIEW QUEUE, not an edit list. An OMIT_KEY verdict was wrong on\n' +
      'inspection once (the test asserted the key was present-and-undefined). Never\n' +
      'auto-apply.'
  )
}

if (process.argv[1] && process.argv[1].endsWith('triage-exact-optional.mjs')) {
  main()
}

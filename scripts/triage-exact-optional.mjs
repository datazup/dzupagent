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
 * The two fixes:
 *
 *   OMIT_KEY    The site writes a key whose value is only incidentally
 *               undefined (a spread, an optional lookup). The key was never
 *               meant to be set. Fix: do not write the key.
 *
 *   WIDEN_PARAM The site passes `undefined` DELIBERATELY — it is asserting
 *               "this field is absent" as the point of the test. Fix: widen
 *               the target property to `T | undefined`.
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
 * Pull the property names the compiler named in the offending object literal.
 * The message embeds the source type, e.g.
 *   Argument of type '{ timeoutMs: undefined; }' is not assignable ...
 * Properties written as literal `undefined` are the deliberate ones.
 */
export function extractUndefinedProps(message) {
  const typeMatch = message.match(/type '\{(.+?)\}'/)
  if (!typeMatch) return { explicit: [], all: [] }

  const body = typeMatch[1]
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

export function classify({ message, sourceLine }) {
  const { explicit, all } = extractUndefinedProps(message)

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

  const byVerdict = { WIDEN_PARAM: [], OMIT_KEY: [], UNCLEAR: [] }
  for (const t of triaged) byVerdict[t.verdict].push(t)

  console.log(
    `\n[triage-exact-optional] ${args.package}: ${triaged.length} exactOptional error(s)\n`
  )
  for (const verdict of ['WIDEN_PARAM', 'OMIT_KEY', 'UNCLEAR']) {
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
    'WIDEN_PARAM: add `| undefined` to the target property — the test asserts absence.\n' +
      'OMIT_KEY   : stop writing the key; its undefined is incidental.\n' +
      'UNCLEAR    : open the site. Do not guess — the two fixes are opposite, and a\n' +
      '             blanket pass in either direction has already been reverted twice.'
  )
}

if (process.argv[1] && process.argv[1].endsWith('triage-exact-optional.mjs')) {
  main()
}

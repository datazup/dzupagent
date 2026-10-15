#!/usr/bin/env node
/**
 * check-dead-exports.mjs
 *
 * DZUPAGENT-CODE-H-04 guard: a shrink-only ratchet on dead runtime exports.
 *
 * A "dead runtime export" is an `export function|class|const|let|var|enum`
 * declared in `packages/<pkg>/src/**` (non-test source) whose name appears in
 * no other file under `packages/` and whose file is not part of a published
 * surface. A file is part of the published surface when it is a package entry
 * (a `package.json` `exports` target mapped from `dist/` back to `src/`) or is
 * reachable from one through `export * from` chains — names re-exported by
 * name already appear in the barrel, so they are never counted as dead.
 *
 * Types and interfaces are deliberately out of scope: an exported options
 * type used only by its own file is a normal signature pattern, not dead
 * runtime code.
 *
 * Known limits (deliberate — this is a lint, not a type checker):
 *   - Reference detection is textual (identifier tokens, comments included),
 *     so a name mentioned anywhere else counts as used. The gate errs toward
 *     under-reporting, never toward flagging a live export.
 *   - Dynamic access (`mod[name]`) is invisible to it.
 *
 * The checked-in baseline lists every dead export known when the gate landed.
 * The gate fails when a dead export appears that is not in the baseline. A
 * baseline entry that is no longer dead is reported as stale; remove it with
 * --update-baseline, which only ever shrinks the baseline unless --allow-raise
 * is given.
 *
 * Usage:
 *   node scripts/check-dead-exports.mjs                    # fail on a new dead export
 *   node scripts/check-dead-exports.mjs --report-only      # print findings, exit 0
 *   node scripts/check-dead-exports.mjs --update-baseline  # drop stale baseline entries
 *   node scripts/check-dead-exports.mjs --update-baseline --allow-raise  # also add new ones
 *   node scripts/check-dead-exports.mjs --root=<dir> --baseline-file=<path>  # fixture runs
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(__dirname, '..')
const DEFAULT_BASELINE_FILE = join(__dirname, 'check-dead-exports.baseline.json')

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.turbo', '.git'])
const REFERENCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|vue)$/
const SOURCE_EXTENSIONS = /\.(?:[cm]?ts|tsx)$/
const TEST_FILE = /(?:\.test|\.spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\/|(?:^|\/)__fixtures__\//
const RUNTIME_EXPORT =
  /^export\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var|enum|const\s+enum)\s+([A-Za-z_$][\w$]*)/gm
const EXPORT_STAR = /^export\s+\*\s+(?:as\s+[A-Za-z_$][\w$]*\s+)?from\s+['"]([^'"]+)['"]/gm
const IDENTIFIER = /[A-Za-z_$][\w$]*/g

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out)
    } else if (entry.isFile() && REFERENCE_EXTENSIONS.test(entry.name)) {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

/** Map a `./dist/x.js` export target back to its `src/x.ts` source, if present. */
function distTargetToSource(pkgDir, target) {
  if (typeof target !== 'string' || !target.startsWith('./dist/')) return undefined
  const stem = target.slice('./dist/'.length).replace(/\.(?:d\.ts|[cm]?js)$/, '')
  for (const ext of ['.ts', '.tsx', '.mts']) {
    const candidate = join(pkgDir, 'src', stem + ext)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function collectTargets(value, out) {
  if (typeof value === 'string') out.push(value)
  else if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) collectTargets(nested, out)
  }
  return out
}

/** Entry source files for one package: every `exports` target plus `main`/`types`. */
export function packageEntrySources(pkgDir) {
  const manifestPath = join(pkgDir, 'package.json')
  if (!existsSync(manifestPath)) return []
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const targets = collectTargets(manifest.exports, [])
  for (const field of ['main', 'module', 'types']) {
    if (typeof manifest[field] === 'string') targets.push(manifest[field])
  }
  const sources = new Set()
  for (const target of targets) {
    const source = distTargetToSource(pkgDir, target)
    if (source) sources.add(source)
  }
  return [...sources]
}

function resolveRelativeModule(fromFile, specifier) {
  if (!specifier.startsWith('.')) return undefined
  const base = resolve(dirname(fromFile), specifier)
  const stem = base.replace(/\.(?:[cm]?js)$/, '')
  for (const candidate of [stem + '.ts', stem + '.tsx', stem + '.mts', join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Files whose every export is published: entries plus `export *` closure. */
export function publishedSurfaceFiles(entries, readText) {
  const published = new Set()
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.pop()
    if (published.has(file)) continue
    published.add(file)
    const text = readText(file)
    for (const match of text.matchAll(EXPORT_STAR)) {
      const target = resolveRelativeModule(file, match[1])
      if (target && !published.has(target)) queue.push(target)
    }
  }
  return published
}

export function findDeadExports({ root = DEFAULT_ROOT } = {}) {
  const packagesDir = join(root, 'packages')
  const files = walk(packagesDir)
  const cache = new Map()
  const readText = (file) => {
    let text = cache.get(file)
    if (text === undefined) {
      text = existsSync(file) ? readFileSync(file, 'utf8') : ''
      cache.set(file, text)
    }
    return text
  }

  // name -> number of distinct files mentioning it
  const fileCount = new Map()
  for (const file of files) {
    const seen = new Set(readText(file).match(IDENTIFIER) ?? [])
    for (const name of seen) fileCount.set(name, (fileCount.get(name) ?? 0) + 1)
  }

  const entries = []
  for (const pkg of readdirSync(packagesDir)) {
    const pkgDir = join(packagesDir, pkg)
    if (statSync(pkgDir).isDirectory()) entries.push(...packageEntrySources(pkgDir))
  }
  const published = publishedSurfaceFiles(entries, readText)

  const dead = []
  for (const file of files) {
    const rel = relative(root, file).split('\\').join('/')
    if (!/^packages\/[^/]+\/src\//.test(rel)) continue
    if (!SOURCE_EXTENSIONS.test(rel) || rel.endsWith('.d.ts') || TEST_FILE.test(rel)) continue
    if (published.has(file)) continue
    for (const match of readText(file).matchAll(RUNTIME_EXPORT)) {
      const name = match[1]
      if ((fileCount.get(name) ?? 0) <= 1) dead.push(`${rel}#${name}`)
    }
  }
  return [...new Set(dead)].sort()
}

export function loadBaseline(baselineFile = DEFAULT_BASELINE_FILE) {
  if (!existsSync(baselineFile)) {
    throw new Error(`dead-export baseline not found: ${baselineFile}`)
  }
  const parsed = JSON.parse(readFileSync(baselineFile, 'utf8'))
  if (!Array.isArray(parsed.deadExports) || !parsed.deadExports.every((e) => typeof e === 'string')) {
    throw new Error(`dead-export baseline is malformed (expected { deadExports: string[] }): ${baselineFile}`)
  }
  return parsed.deadExports
}

export function compareToBaseline(current, baseline) {
  const baselineSet = new Set(baseline)
  const currentSet = new Set(current)
  return {
    added: current.filter((entry) => !baselineSet.has(entry)),
    stale: baseline.filter((entry) => !currentSet.has(entry)),
  }
}

function parseArgs(argv) {
  const opts = { reportOnly: false, update: false, allowRaise: false, root: DEFAULT_ROOT, baselineFile: DEFAULT_BASELINE_FILE }
  for (const arg of argv) {
    if (arg === '--report-only') opts.reportOnly = true
    else if (arg === '--update-baseline') opts.update = true
    else if (arg === '--allow-raise') opts.allowRaise = true
    else if (arg.startsWith('--root=')) opts.root = resolve(arg.slice('--root='.length))
    else if (arg.startsWith('--baseline-file=')) opts.baselineFile = resolve(arg.slice('--baseline-file='.length))
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv)
  const current = findDeadExports({ root: opts.root })

  if (opts.reportOnly) {
    for (const entry of current) console.log(entry)
    console.log(`check-dead-exports: ${current.length} dead runtime export(s)`)
    return 0
  }

  const baseline = existsSync(opts.baselineFile) || !opts.update ? loadBaseline(opts.baselineFile) : []
  const { added, stale } = compareToBaseline(current, baseline)

  if (opts.update) {
    if (added.length > 0 && !opts.allowRaise) {
      console.error(`check-dead-exports: refusing to add ${added.length} new dead export(s) to the baseline without --allow-raise:`)
      for (const entry of added) console.error(`  + ${entry}`)
      return 1
    }
    const next = opts.allowRaise ? current : baseline.filter((entry) => !stale.includes(entry))
    writeFileSync(opts.baselineFile, `${JSON.stringify({ deadExports: next }, null, 2)}\n`)
    console.log(`check-dead-exports: baseline now ${next.length} (removed ${stale.length} stale)`)
    return 0
  }

  for (const entry of stale) {
    console.log(`check-dead-exports: stale baseline entry (no longer dead; shrink with --update-baseline): ${entry}`)
  }
  if (added.length > 0) {
    console.error(`check-dead-exports: ${added.length} new dead runtime export(s) — delete them, make them module-private, or use them:`)
    for (const entry of added) console.error(`  + ${entry}`)
    return 1
  }
  console.log(`check-dead-exports: OK (${current.length} dead, baseline ${baseline.length})`)
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main()
  } catch (err) {
    console.error(`check-dead-exports: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 2
  }
}

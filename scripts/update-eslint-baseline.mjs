/**
 * Regenerate the per-violation counts in eslint.baseline.js from the current
 * tree: `yarn lint:baseline:update`.
 *
 * The ratchet in scripts/run-package-lint.mjs fails `yarn lint` when a recorded
 * count rises AND when one falls without being re-recorded, so this script is
 * how you bank a fix. It only ever rewrites the data block; the prose header of
 * eslint.baseline.js is read from the file and preserved verbatim.
 *
 * Use --dry-run to print the diff summary without writing.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { ESLint } from 'eslint'

import { TEST_QUALITY_BASELINE_COUNTS } from '../eslint.baseline.js'
import {
  TEST_QUALITY_RULE_IDS,
  collectTestQualityCounts,
} from './test-quality-baseline.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_FILE = path.join(repoRoot, 'eslint.baseline.js')
const DATA_MARKER = 'export const TEST_QUALITY_BASELINE_COUNTS'

async function lintablePackageDirs(root) {
  const packagesDir = path.join(root, 'packages')
  const entries = await fs.readdir(packagesDir, { withFileTypes: true })
  const dirs = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const packageDir = path.join(packagesDir, entry.name)
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8'))
      if (manifest.scripts?.lint) dirs.push(packageDir)
    } catch {
      // no package.json (or unreadable) — not a workspace we lint
    }
  }
  return dirs.sort()
}

/**
 * Only test files can carry these rules, and the type-aware config block ignores
 * test files — so linting the test globs alone measures the same violations the
 * full lint would, without paying for project-based parsing of every source file.
 */
const TEST_GLOBS = ['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/**/__tests__/**/*.ts']

export async function measureBaseline({ root = repoRoot } = {}) {
  const counts = {}
  const unclassified = []
  for (const packageDir of await lintablePackageDirs(root)) {
    const eslint = new ESLint({ cwd: packageDir, errorOnUnmatchedPattern: false })
    const results = await eslint.lintFiles(TEST_GLOBS)
    const measured = collectTestQualityCounts(results, { root })
    Object.assign(counts, measured.counts)
    unclassified.push(...measured.unclassified)
  }
  return { counts, unclassified }
}

export function renderBaselineFile(header, counts) {
  const files = Object.keys(counts).sort()
  const lines = [header.trimEnd(), '', `${DATA_MARKER} = {`]
  for (const file of files) {
    const entries = TEST_QUALITY_RULE_IDS.filter((id) => (counts[file][id] ?? 0) > 0)
      .map((id) => `"${id}": ${counts[file][id]}`)
      .join(', ')
    lines.push(`  ${JSON.stringify(file)}: { ${entries} },`)
  }
  lines.push('}')
  lines.push('')
  lines.push('/** File list for ESLint `files`/`ignores` globs — derived, never hand-edited. */')
  lines.push('export const TEST_QUALITY_BASELINE = Object.keys(TEST_QUALITY_BASELINE_COUNTS)')
  lines.push('')
  return lines.join('\n')
}

function summarise(previous, next) {
  const files = new Set([...Object.keys(previous), ...Object.keys(next)])
  const changes = []
  for (const file of [...files].sort()) {
    for (const ruleId of TEST_QUALITY_RULE_IDS) {
      const before = previous[file]?.[ruleId] ?? 0
      const after = next[file]?.[ruleId] ?? 0
      if (before !== after) changes.push(`  ${file} ${ruleId}: ${before} -> ${after}`)
    }
  }
  return changes
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const source = await fs.readFile(BASELINE_FILE, 'utf8')
  const markerIndex = source.indexOf(DATA_MARKER)
  if (markerIndex === -1) {
    throw new Error(`eslint.baseline.js is missing "${DATA_MARKER}" — cannot regenerate safely`)
  }
  const header = source.slice(0, markerIndex)

  const { counts, unclassified } = await measureBaseline()
  if (unclassified.length > 0) {
    const sample = unclassified.slice(0, 3).map((item) => `${item.file}: ${item.message}`)
    throw new Error(
      `${unclassified.length} no-restricted-syntax message(s) match no rule id in `
      + `scripts/test-quality-baseline.mjs. Add the rule there before regenerating:\n${sample.join('\n')}`,
    )
  }

  const changes = summarise(TEST_QUALITY_BASELINE_COUNTS, counts)
  const rendered = renderBaselineFile(header, counts)
  if (dryRun) {
    process.stdout.write(changes.length ? `${changes.join('\n')}\n` : 'eslint.baseline.js is up to date\n')
    return
  }
  await fs.writeFile(BASELINE_FILE, rendered, 'utf8')
  process.stdout.write(
    changes.length
      ? `Updated eslint.baseline.js:\n${changes.join('\n')}\n`
      : 'eslint.baseline.js is already up to date\n',
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}

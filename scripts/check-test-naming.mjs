#!/usr/bin/env node
/**
 * check-test-naming.mjs
 *
 * DZUPAGENT-TEST-L-05 guard: bans new work-item/ticket-named test files
 * (e.g. `w15-h4-branch-coverage.test.ts`, `w26-c-orchestrator-coverage.test.ts`)
 * so the pattern of mega "coverage suite" files named after a work item
 * instead of the module they cover stops growing. The 18 files that already
 * exist are grandfathered in an explicit allowlist — splitting them by
 * module is tracked separately (see the L-05 implementation notes); this
 * guard only stops the count from growing further.
 *
 * A test filename is flagged when it matches /^w\d+/i (optionally with a
 * letter/dash suffix, e.g. `w15-h4-...`, `w1-w3-...`).
 *
 * Usage:
 *   node scripts/check-test-naming.mjs               # fail on new violations
 *   node scripts/check-test-naming.mjs --report-only  # print, exit 0
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const PACKAGES_DIR = join(ROOT, 'packages')
const ALLOWLIST_FILE = join(__dirname, 'check-test-naming.allowlist.json')

const WORK_ITEM_RE = /^w\d+/i

const reportOnly = process.argv.includes('--report-only')

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

function main() {
  const allowlist = new Set(
    existsSync(ALLOWLIST_FILE) ? JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf8')).files : []
  )

  const packages = existsSync(PACKAGES_DIR) ? readdirSync(PACKAGES_DIR) : []
  const violations = []
  const grandfathered = []

  for (const pkg of packages) {
    const srcDir = join(PACKAGES_DIR, pkg, 'src')
    if (!existsSync(srcDir)) continue
    for (const file of findTestFiles(srcDir)) {
      const name = basename(file)
      if (!WORK_ITEM_RE.test(name)) continue
      const rel = relative(ROOT, file)
      if (allowlist.has(rel)) {
        grandfathered.push(rel)
      } else {
        violations.push(rel)
      }
    }
  }

  console.log(
    `[check-test-naming] ${grandfathered.length} grandfathered work-item-named test files (do not add more).`
  )

  if (violations.length > 0) {
    console.error(
      `\n[check-test-naming] FAIL: ${violations.length} NEW work-item-named test file(s) found:\n` +
        violations.map((f) => `  ${f}`).join('\n') +
        '\n\nName test files after the module/behavior they cover (e.g. ' +
        '`message-manager-compression.test.ts`), not after a ticket/work-item ' +
        '(e.g. `w15-h4-...`). If this is deliberately a new coverage file, ' +
        'give it a descriptive name instead of adding it to the allowlist.'
    )
    if (!reportOnly) process.exitCode = 1
    return
  }

  console.log('[check-test-naming] OK — no new work-item-named test files.')
}

main()

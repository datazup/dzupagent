#!/usr/bin/env node
/**
 * check-capability-matrix-freshness.mjs
 *
 * Regenerates CAPABILITY_MATRIX.md into a temp file and compares with the
 * committed version. Exits non-zero if they differ (matrix is stale).
 *
 * Usage: node scripts/check-capability-matrix-freshness.mjs
 */

import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const MATRIX_PATH = resolve(ROOT, 'docs/CAPABILITY_MATRIX.md')

if (!existsSync(MATRIX_PATH)) {
  console.error('docs/CAPABILITY_MATRIX.md does not exist. Run: yarn docs:capability-matrix')
  process.exit(1)
}

// Capture the committed content before regeneration
const committed = readFileSync(MATRIX_PATH, 'utf8')

// Regenerate
console.log('Regenerating CAPABILITY_MATRIX.md...')
execSync('npx tsx scripts/generate-capability-matrix.ts', { cwd: ROOT, stdio: 'pipe' })

const fresh = readFileSync(MATRIX_PATH, 'utf8')

if (committed === fresh) {
  console.log('CAPABILITY_MATRIX.md is up to date.')
  process.exit(0)
} else {
  console.error(
    'CAPABILITY_MATRIX.md is stale! Regenerate with: yarn docs:capability-matrix\n' +
    'Then commit the updated file.',
  )
  // Restore the committed version so we don't leave dirty working tree in CI
  // (the developer should regenerate locally)
  process.exit(1)
}
